'use strict';
// Admin-only event override and read-only previews of model projections.
const lines = require('./betting_lines');
const {openingForEvent} = require('./betting_window');

function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pb_betting_manual_open (
    event_id TEXT PRIMARY KEY REFERENCES pb_betting_events(id),
    opened_ts INTEGER NOT NULL,
    opened_by INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pb_betting_bet_projection_snapshots (
    bet_id INTEGER PRIMARY KEY REFERENCES pb_betting_bets(id),
    projection REAL,
    captured_ts INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
}
function seasonOpener(db,event) {
  if (!event || event.source_url?.startsWith('https://www.dci.org/') !== true) return false;
  const first=db.prepare(`SELECT id FROM pb_betting_events
    WHERE season=? AND status<>'canceled' AND source_url LIKE 'https://www.dci.org/%'
    ORDER BY start_ts,id LIMIT 1`).get(event.season);
  return first?.id === event.id;
}
function openFirstCompetition(db,eventId,adminId) {
  init(db);
  const id=String(eventId||'');
  const uid=Number(adminId);
  if (!Number.isSafeInteger(uid)||uid<=0) throw Error('Invalid administrator.');
  const event=db.prepare('SELECT * FROM pb_betting_events WHERE id=?').get(id);
  if (!event || !seasonOpener(db,event)) throw Error('Only the first scheduled DCI competition of a season can be manually opened.');
  if (event.status!=='scheduled'||event.start_ts<=Math.floor(Date.now()/1000)) throw Error('Competition is no longer upcoming.');
  const lineup=db.prepare('SELECT lineup_json FROM pb_dci_event_sources WHERE event_id=?').get(id);
  let participantCount=0;
  try {const entries=JSON.parse(lineup?.lineup_json||'[]');participantCount=Array.isArray(entries)?entries.length:0;} catch {}
  if (!participantCount) throw Error('Import the official lineup before manually opening betting.');
  const count=db.prepare("SELECT count(*) AS n FROM pb_betting_markets WHERE event_id=? AND status='active'").get(id).n;
  if (!count) throw Error('Generate and review the event lines before manually opening betting.');
  const existing=db.prepare('SELECT opened_ts FROM pb_betting_manual_open WHERE event_id=?').get(id);
  if (existing) return {already_open:true,opened_ts:existing.opened_ts,event};
  const now=Math.floor(Date.now()/1000);
  db.prepare('INSERT INTO pb_betting_manual_open(event_id,opened_ts,opened_by) VALUES(?,?,?)').run(id,now,uid);
  return {already_open:false,opened_ts:now,event};
}
// Preserve all posted and wagered lines. Recompute previews only, from data available today.
function projections(db,event,markets) {
  const source=db.prepare('SELECT lineup_json FROM pb_dci_event_sources WHERE event_id=?').get(event.id);
  if (!source) return new Map();
  let lineup;
  try {lineup=JSON.parse(source.lineup_json);} catch {return new Map();}
  if (!Array.isArray(lineup)||!lineup.length) return new Map();
  const metadata=db.prepare('SELECT local_date FROM pb_dci_event_dates WHERE event_id=?').get(event.id);
  const eventDate=metadata?.local_date || new Date(event.start_ts*1000).toISOString().slice(0,10);
  const tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const cutoff=tomorrow<eventDate?tomorrow:eventDate;
  const predictions=lines.makeMarkets({eventId:event.id,startTs:event.start_ts,season:event.season,
    lineup,db,asOfDate:cutoff,eventDate});
  const byId=new Map(predictions.map(p=>[p.id,p]));
  const result=new Map();
  for (const m of markets) {
    const p=byId.get(m.id);
    result.set(m.id,p ? {value:p.line,delta:Math.round((p.line-m.line)*1000)/1000} : null);
  }
  return result;
}
function refreshUnopenedSeason(db,season) {
  let updated=0;
  const events=db.prepare(`SELECT * FROM pb_betting_events WHERE season=? AND status='scheduled' AND start_ts>unixepoch()
    AND source_url LIKE 'https://www.dci.org/%' ORDER BY start_ts,id`).all(season);
  const now=Math.floor(Date.now()/1000);
  for(const event of events) {
    if(openingForEvent(db,event)<=now)continue; // posted lines freeze at opening
    const used=db.prepare(`SELECT 1 FROM pb_betting_bets b JOIN pb_betting_markets m ON m.id=b.market_id WHERE m.event_id=? LIMIT 1`).get(event.id);
    if(used)continue;
    const source=db.prepare('SELECT lineup_json FROM pb_dci_event_sources WHERE event_id=?').get(event.id);
    if(!source)continue;
    let lineup=[];
    try{lineup=JSON.parse(source.lineup_json)}catch{}
    if(!Array.isArray(lineup)||!lineup.length)continue;
    const localDate=db.prepare('SELECT local_date FROM pb_dci_event_dates WHERE event_id=?').get(event.id)?.local_date;
    const projected=lines.makeMarkets({eventId:event.id,startTs:event.start_ts,season:event.season,
      lineup,db,eventDate:localDate});
    const set=db.prepare(`UPDATE pb_betting_markets SET line=? WHERE id=? AND status='active'
      AND NOT EXISTS(SELECT 1 FROM pb_betting_bets WHERE market_id=pb_betting_markets.id)`);
    for(const p of projected)updated+=set.run(p.line,p.id).changes;
  }
  return updated;
}
module.exports={init,seasonOpener,openFirstCompetition,projections,refreshUnopenedSeason};
