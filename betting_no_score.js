'use strict';
// Refunding absent competition scores is independent of the optional
// DCI_AUTO_SETTLE_ENABLED flag. This is run after the normal score poll.
const dciSync = require('./dci_sync');
const parlays = require('./betting_parlays');
const CUTOFF_SECONDS = 16 * 60 * 60;
const LOOKBACK_SECONDS = 45 * 86400;
const ROOT = 'https://www.dci.org';

function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pb_betting_no_score_events (
    event_id TEXT PRIMARY KEY REFERENCES pb_betting_events(id),
    flagged_ts INTEGER NOT NULL DEFAULT (unixepoch()),
    reason TEXT NOT NULL DEFAULT 'No official scores published within 16 hours'
  );`);
}

function hasVerifiedScores(db, event) {
  let slug;
  try { slug = new URL(event.source_url).pathname.split('/').filter(Boolean).pop(); }
  catch { return true; } // Fail closed if we cannot identify an official event.
  return !!db.prepare('SELECT 1 FROM pb_dci_verified_scores WHERE season=? AND event_slug=? LIMIT 1')
    .get(event.season, slug);
}

// A successful official score-page read with zero parsable scores is negative
// evidence. Network failures other than a genuine 404 are inconclusive and
// MUST NOT trigger a refund.
async function officialScoresAbsent(event) {
  const slug = new URL(event.source_url).pathname.split('/').filter(Boolean).pop();
  if (!/^20\d\d-[a-z0-9-]+$/i.test(slug)) throw Error('Unexpected DCI event slug');
  const expectedDate = event.local_date || undefined;
  const pages = [
    [`${ROOT}/scores/final-scores/${slug}/`, html => dciSync.scoreEntries(html)],
    [`${ROOT}/scores/recap/${slug}/`, html => dciSync.parseRecap(html, { slug, expectedDate })]
  ];
  for (const [url, parser] of pages) {
    let html;
    try { html = await dciSync.fetchOfficial(url); }
    catch (error) {
      if (/DCI HTTP 404\b/.test(String(error.message))) continue;
      throw error; // DCI outage, rate limit, or parsing issue: do NOT refund.
    }
    const scores = parser(html);
    if (Array.isArray(scores) && scores.length > 0) return false;
  }
  return true;
}

// Caller must have checked the official results; this transaction only changes
// pending real bets. Repeated execution has no additional financial effect.
function refundEvent(db, eventId, now = Math.floor(Date.now() / 1000)) {
  init(db);
  return db.transaction(() => {
    const ev = db.prepare('SELECT * FROM pb_betting_events WHERE id=?').get(eventId);
    if (!ev || ev.status !== 'scheduled' || ev.start_ts == null ||
        ev.start_ts + CUTOFF_SECONDS > now) return {refunded:0, gems:0, changed:false};
    if (hasVerifiedScores(db, ev)) return {refunded:0, gems:0, changed:false};
    if (db.prepare('SELECT 1 FROM pb_betting_no_score_events WHERE event_id=?').get(eventId))
      return {refunded:0, gems:0, changed:false};
    // Never reverse already settled payouts automatically.
    if (db.prepare("SELECT 1 FROM pb_betting_markets WHERE event_id=? AND status='settled' LIMIT 1").get(eventId))
      return {refunded:0, gems:0, changed:false};
    if (db.prepare(`SELECT 1 FROM pb_betting_bets b JOIN pb_betting_markets m ON m.id=b.market_id
      WHERE m.event_id=? AND b.result NOT IN ('pending','void') LIMIT 1`).get(eventId))
      return {refunded:0, gems:0, changed:false};

    db.prepare(`INSERT INTO pb_betting_no_score_events(event_id,flagged_ts)
      VALUES(?,?)`).run(eventId, now);
    db.prepare("UPDATE pb_betting_events SET status='completed', updated_ts=unixepoch() WHERE id=?")
      .run(eventId);
    db.prepare("UPDATE pb_betting_markets SET status='void',actual=NULL WHERE event_id=? AND status='active'")
      .run(eventId);
    const bets = db.prepare(`SELECT b.id,b.user_id,b.stake FROM pb_betting_bets b
      JOIN pb_betting_markets m ON m.id=b.market_id
      WHERE m.event_id=? AND b.result='pending'`).all(eventId);
    let refunded = 0, gems = 0;
    for (const bet of bets) {
      const changed = db.prepare(`UPDATE pb_betting_bets SET result='void',payout=?
        WHERE id=? AND result='pending'`).run(bet.stake,bet.id);
      if (changed.changes !== 1) continue;
      db.prepare('INSERT OR IGNORE INTO pb_betting_wallets(user_id,balance) VALUES (?,200)').run(bet.user_id);
      db.prepare('UPDATE pb_betting_wallets SET balance=balance+? WHERE user_id=?').run(bet.stake,bet.user_id);
      db.prepare(`INSERT INTO pb_betting_ledger(user_id,bet_id,delta,reason)
        VALUES(?,?,?,'not_scored_refund')`).run(bet.user_id,bet.id,bet.stake);
      refunded++;gems += bet.stake;
    }
    const multi=parlays.settlePending(db);
    return {refunded,gems,changed:true,multi};
  })();
}

async function processExpired(db,{now=Math.floor(Date.now()/1000), probe=officialScoresAbsent}={}) {
  init(db);
  const due = db.prepare(`SELECT e.*,d.local_date FROM pb_betting_events e
    LEFT JOIN pb_dci_event_dates d ON d.event_id=e.id
    WHERE e.status='scheduled' AND e.start_ts IS NOT NULL
      AND e.start_ts + ? <= ? AND e.start_ts > ?
      AND e.source_url LIKE 'https://www.dci.org/%'
      AND NOT EXISTS(SELECT 1 FROM pb_betting_no_score_events n WHERE n.event_id=e.id)
    ORDER BY e.start_ts LIMIT 60`).all(CUTOFF_SECONDS,now,now-LOOKBACK_SECONDS);
  let checked=0,marked=0,refunded=0,gems=0;const errors=[];
  for(const ev of due) {
    if(hasVerifiedScores(db,ev))continue;
    if(db.prepare("SELECT 1 FROM pb_betting_markets WHERE event_id=? AND status='settled'").get(ev.id))continue;
    try {
      checked++;
      if(!(await probe(ev)))continue;
      const r=refundEvent(db,ev.id,now);
      if(r.changed){marked++;refunded+=r.refunded;gems+=r.gems;}
    } catch(e) {errors.push(`${ev.id}: ${String(e.message||e).slice(0,180)}`);}
  }
  return {checked,marked,refunded,gems,errors};
}
module.exports={init,hasVerifiedScores,officialScoresAbsent,refundEvent,processExpired,CUTOFF_SECONDS};
