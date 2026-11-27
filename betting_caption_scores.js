'use strict';
// Canonical, wagerable caption scores. The original judge scores are retained.
const canonicalNames = new Map([
  ['ge1','GE1'], ['ge2','GE2'], ['music analysis','Music Analysis'],
  ['music brass','Music Brass'], ['music percussion','Music Percussion'],
  ['visual proficiency','Visual Proficiency'], ['visual analysis','Visual Analysis'],
  ['color guard','Color Guard']
]);
function canonicalCaption(name) {
  const clean = String(name || '').trim().replace(/\s+/g,' ');
  const key = /^ge\s*[12]$/i.test(clean) ? clean.replace(/\s+/g,'').toLowerCase() : clean.toLowerCase();
  return canonicalNames.get(key) || clean;
}
function judgePart(name) {
  const clean = String(name || '').trim();
  // A corps name ending in A/B (e.g. Matchup vs Blue Devils B) is not a judge.
  if (/^matchup\s+vs\b/i.test(clean)) return null;
  const m = clean.match(/^(.+?)[\s_-]+([AB])$/i) || clean.match(/^(GE\s*[12])([AB])$/i);
  return m ? {base:canonicalCaption(m[1]),judge:m[2].toUpperCase()} : null;
}
const isJudgeCaption = name => !!judgePart(name);
const cache = new WeakMap();
function captionsForBetting(row) {
  const source = row?.captions;
  if (!source || typeof source !== 'object') return Object.create(null);
  if (cache.has(source)) return cache.get(source);
  const result = Object.create(null), pairs = new Map();
  for (const [name,value] of Object.entries(source)) {
    const part = judgePart(name);
    if (!part) {
      if (Number.isFinite(value)) result[canonicalCaption(name)] = value;
      continue;
    }
    const key = part.base.toLowerCase();
    if (!pairs.has(key)) pairs.set(key,{base:part.base});
    const pair = pairs.get(key);
    if (!Number.isFinite(value)) continue;
    if (Object.hasOwn(pair,part.judge) && pair[part.judge] !== value) pair[part.judge] = NaN;
    else pair[part.judge] = value;
  }
  for (const pair of pairs.values()) {
    // Two published judge scores are required. Never double a lone A or B.
    if (Number.isFinite(pair.A) && Number.isFinite(pair.B)) {
      const existing = Object.keys(result).find(k=>k.toLowerCase()===pair.base.toLowerCase());
      if (existing && existing!==pair.base) delete result[existing];
      result[pair.base] = Math.round(((pair.A+pair.B)/2)*1e6)/1e6;
    }
  }
  cache.set(source,result);
  return result;
}
function metricValue(row,metric) {
  if (!row) return undefined;
  if (metric==='Overall') return Number.isFinite(row.total) ? row.total : row.score;
  const part = judgePart(metric);
  if (part) {
    // Read-only admin estimates and previously submitted legacy judge wagers.
    const raw = row.captions || {};
    if (Number.isFinite(raw[metric])) return raw[metric];
    for (const [key,value] of Object.entries(raw)) {
      const candidate = judgePart(key);
      if (candidate && candidate.judge===part.judge && candidate.base.toLowerCase()===part.base.toLowerCase() && Number.isFinite(value)) return value;
    }
    return undefined;
  }
  if (Number.isFinite(row.groups?.[metric])) return row.groups[metric];
  const captions = captionsForBetting(row), name = canonicalCaption(metric);
  if (Number.isFinite(captions[name])) return captions[name];
  const key = Object.keys(captions).find(k=>k.toLowerCase()===name.toLowerCase());
  return key===undefined ? undefined : captions[key];
}
const isCombinedCaption = name => ['GE1','GE2','Music Analysis'].includes(canonicalCaption(name));
// Convert existing future markets without changing locked lines, bets, wallets, or raw recaps.
function reconcileExisting(db,model,openingForEvent) {
  db.exec(`CREATE TABLE IF NOT EXISTS pb_betting_caption_migrations (key TEXT PRIMARY KEY, completed_ts INTEGER NOT NULL)`);
  const migrationKey='combined_judge_captions_v1';
  if(db.prepare('SELECT 1 FROM pb_betting_caption_migrations WHERE key=?').get(migrationKey))return {inserted:0,updated:0,voided:0,errors:[]};
  const now = Math.floor(Date.now()/1000);
  const active = db.prepare(`SELECT m.*,e.start_ts,e.season,e.status AS event_status
    FROM pb_betting_markets m JOIN pb_betting_events e ON e.id=m.event_id
    WHERE m.status='active'`).all();
  const affected = new Map();
  for (const m of active) {
    if (m.event_status!=='scheduled' || m.start_ts==null || m.start_ts<=now) continue;
    if (!isJudgeCaption(m.caption) && !isCombinedCaption(m.caption)) continue;
    if (!affected.has(m.event_id)) affected.set(m.event_id,[]);
    affected.get(m.event_id).push(m);
  }
  const used = db.prepare(`SELECT 1 FROM pb_betting_bets WHERE market_id=?
    UNION ALL SELECT 1 FROM pb_betting_entry_legs WHERE market_id=? LIMIT 1`);
  const voidUnused = db.prepare(`UPDATE pb_betting_markets SET status='void',actual=NULL WHERE id=? AND status='active'
    AND NOT EXISTS(SELECT 1 FROM pb_betting_bets WHERE market_id=pb_betting_markets.id)
    AND NOT EXISTS(SELECT 1 FROM pb_betting_entry_legs WHERE market_id=pb_betting_markets.id)`);
  const setLine = db.prepare(`UPDATE pb_betting_markets SET line=? WHERE id=? AND status='active'
    AND NOT EXISTS(SELECT 1 FROM pb_betting_bets WHERE market_id=pb_betting_markets.id)
    AND NOT EXISTS(SELECT 1 FROM pb_betting_entry_legs WHERE market_id=pb_betting_markets.id)`);
  let inserted=0,updated=0,voided=0;const errors=[];
  const key=(corps,caption,kind)=>model.canonicalCorps(corps)+'|'+canonicalCaption(judgePart(caption)?.base || caption).toLowerCase()+'|'+kind;
  for (const [eventId,markets] of affected) {
    try {
      const event=db.prepare('SELECT * FROM pb_betting_events WHERE id=?').get(eventId);
      const source=db.prepare('SELECT lineup_json FROM pb_dci_event_sources WHERE event_id=?').get(eventId);
      const date=db.prepare('SELECT local_date FROM pb_dci_event_dates WHERE event_id=?').get(eventId)?.local_date;
      const lineup=JSON.parse(source?.lineup_json||'[]').filter(x=>x?.corps&&x?.cls);
      if (!lineup.length || !date) continue;
      const wanted=new Set(markets.map(m=>key(m.corps,m.caption,m.kind)));
      const projected=model.makeMarkets({eventId,startTs:event.start_ts,season:event.season,lineup,db,eventDate:date})
        .filter(m=>!isJudgeCaption(m.caption)&&wanted.has(key(m.corps,m.caption,m.kind)));
      db.transaction(()=>{
        const current=db.prepare('SELECT * FROM pb_betting_events WHERE id=?').get(eventId);
        if (!current || current.status!=='scheduled' || current.start_ts==null || current.start_ts<=Math.floor(Date.now()/1000)) return;
        const unopened=openingForEvent(db,current)>Math.floor(Date.now()/1000);
        const existing=db.prepare('SELECT * FROM pb_betting_markets WHERE event_id=?').all(eventId);
        const byKey=new Map(existing.filter(m=>!isJudgeCaption(m.caption)).map(m=>[key(m.corps,m.caption,m.kind),m]));
        for (const m of projected) {
          const prior=byKey.get(key(m.corps,m.caption,m.kind));
          if (prior) {
            // Never revive void/settled markets, or move already-open/used lines.
            if (unopened && prior.status==='active' && !used.get(prior.id,prior.id)) updated+=setLine.run(m.line,prior.id).changes;
          } else {
            inserted+=model.saveMarkets(db,current,[m]).inserted;
          }
        }
      })();
    } catch (err) {errors.push(`${eventId}: ${err.message}`);}
  }
  // Existing placed judge bets keep their original terms. Only unused judge markets are voided.
  db.transaction(()=>{for(const m of active) if(isJudgeCaption(m.caption)) voided+=voidUnused.run(m.id).changes;})();
  if(!errors.length)db.prepare('INSERT OR IGNORE INTO pb_betting_caption_migrations(key,completed_ts) VALUES(?,?)').run(migrationKey,Math.floor(Date.now()/1000));
  return {inserted,updated,voided,errors};
}
module.exports={canonicalCaption,judgePart,isJudgeCaption,captionsForBetting,metricValue,reconcileExisting};
