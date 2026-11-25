'use strict';
// Admin-defined per-corps/per-season preseason modifiers; never writes real scores.
// Values are overall-score points, and scaled proportionally for caption markets.
const { } = Object;
const ALIASES = {'the cavaliers':'cavaliers','the academy':'academy','scv':'santa clara vanguard','spirit':'spirit of atlanta','seattle cascades':'cascades','the cadets':'cadets'};
function keyFor(name) { const s=String(name||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); return ALIASES[s]||s; }
function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pb_betting_staff_changes (
    season INTEGER NOT NULL,
    corps_key TEXT NOT NULL,
    corps_name TEXT NOT NULL,
    adjustment REAL NOT NULL CHECK(adjustment BETWEEN -10 AND 10),
    updated_by INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY(season,corps_key)
  )`);
}
function value(db, season, corps) {
  init(db);
  const row=db.prepare('SELECT adjustment FROM pb_betting_staff_changes WHERE season=? AND corps_key=?').get(Number(season),keyFor(corps));
  return row?Number(row.adjustment):0;
}
function scheduledEarlier(db, {eventId,startTs,season,corps,eventDate}) {
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pb_dci_event_sources'").get()) return null;
  const day=eventDate || (startTs!=null ? new Date(Number(startTs)*1000).toISOString().slice(0,10) : null);
  if(!day)return [];
  // Date-only imported events count as earlier performances too.
  const rows=db.prepare(`SELECT e.id,s.lineup_json FROM pb_betting_events e
    JOIN pb_dci_event_sources s ON s.event_id=e.id
    LEFT JOIN pb_dci_event_dates d ON d.event_id=e.id
    WHERE e.season=? AND e.id<>? AND e.status<>'canceled'
      AND COALESCE(d.local_date,date(e.start_ts,'unixepoch'))<?
    ORDER BY COALESCE(d.local_date,date(e.start_ts,'unixepoch')),e.id`).all(season,eventId,day);
  const own=keyFor(corps);
  return rows.filter(row=>{
    let lineup=[];
    try{lineup=JSON.parse(row.lineup_json)}catch{}
    return Array.isArray(lineup)&&lineup.some(x=>keyFor(typeof x==='string'?x:x?.corps)===own);
  }).map(row=>row.id);
}
function competitionNumber(db,{eventId,startTs,season,corps,eventDate}) {
  const ids=scheduledEarlier(db,{eventId,startTs,season,corps,eventDate})||[];
  const names=new Set(ids);
  const day=eventDate || (startTs!=null?new Date(Number(startTs)*1000).toISOString().slice(0,10):null);
  let verifiedCount=0;
  if(day&&db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pb_dci_verified_scores'").get()) {
    const rows=db.prepare('SELECT DISTINCT event_slug,date,corps FROM pb_dci_verified_scores WHERE season=? AND date<?').all(season,day);
    const datedScores=new Set(rows.filter(r=>keyFor(r.corps)===keyFor(corps)).map(r=>r.date));
    let knownDates=new Set();
    if(names.size&&db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pb_dci_event_dates'").get()) {
      const details=db.prepare('SELECT event_id,local_date FROM pb_dci_event_dates WHERE local_date<?').all(day);
      knownDates=new Set(details.filter(x=>names.has(x.event_id)).map(x=>x.local_date));
    }
    verifiedCount=[...datedScores].filter(d=>!knownDates.has(d)).length;
  }
  return ids.length+verifiedCount+1;
}
function staffEffect(db,{season,corps,eventId,startTs,eventDate,metric,max}) {
  if(!db||typeof db.prepare!=='function')return 0;
  const adjustment=value(db,season,corps);
  if(!adjustment)return 0;
  if(competitionNumber(db,{eventId,startTs,season,corps,eventDate})>2)return 0;
  return adjustment*(max/100);
}
function update(db,{season,corps,adjustment,adminId}) {
  init(db);
  const a=Number(adjustment),uid=Number(adminId),year=Number(season),name=String(corps||'').trim();
  if(!name||name.length>120||!keyFor(name))throw Error('Select a valid corps.');
  if(!Number.isSafeInteger(uid)||uid<=0)throw Error('Invalid administrator.');
  if(!Number.isInteger(year)||year<2022||year>2100)throw Error('Invalid season.');
  if(!Number.isFinite(a)||Math.abs(a)>10||Math.abs(a*1000-Math.round(a*1000))>1e-7)throw Error('Adjustment must be between -10 and +10 points, in 0.001 increments.');
  if(a===0){db.prepare('DELETE FROM pb_betting_staff_changes WHERE season=? AND corps_key=?').run(year,keyFor(name));return 0;}
  db.prepare(`INSERT INTO pb_betting_staff_changes(season,corps_key,corps_name,adjustment,updated_by)
    VALUES(?,?,?,?,?) ON CONFLICT(season,corps_key) DO UPDATE SET
    corps_name=excluded.corps_name,adjustment=excluded.adjustment,updated_by=excluded.updated_by,updated_ts=unixepoch()`).run(year,keyFor(name),name,a,uid);
  return a;
}
module.exports={init,value,competitionNumber,staffEffect,update,keyFor};
