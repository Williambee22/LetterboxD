'use strict';
// Builds event markets from the bundled historical DCI_Scores.xlsx dataset (2022+).
// Never fetches official schedules and never posts lines to an event without an explicit lineup.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const HISTORY_PATH = path.join(__dirname, 'pressboxd_history_2022.json');
let cache;
function history() {
  if (!cache) cache = JSON.parse(fs.readFileSync(HISTORY_PATH,'utf8')).records;
  return cache;
}
function median(xs) { if(!xs.length) return null; const a=[...xs].sort((x,y)=>x-y); const n=a.length;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2; }
function clamp(x,lo,hi) {return Math.max(lo,Math.min(hi,x));}
function idFor(parts) {return 'hist_'+crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24);}
function metricValue(r,metric) {return metric==='Overall'?r.total:(r.groups&&r.groups[metric]!=null?r.groups[metric]:r.captions&&r.captions[metric]);}
function trend(rows,season,cls,corps,metric,targetDate,previous) {
  // Compare transitions entirely within their own season. No cross-season Finals-to-June deltas.
  const grouped=new Map();
  for(const r of rows) {
    if(r.cls!==cls || r.date>=targetDate || r.year>season) continue;
    const v=metricValue(r,metric);
    if(!Number.isFinite(v))continue;
    const key=r.year+'|'+r.corps;
    if(!grouped.has(key))grouped.set(key,[]);
    grouped.get(key).push(r);
  }
  const deltas=[];
  for(const [key,records] of grouped) {
    records.sort((a,b)=>a.date.localeCompare(b.date));
    const seen=new Map();
    for(const r of records)if(!seen.has(r.date))seen.set(r.date,r);
    const ordered=[...seen.values()];
    for(let i=1;i<ordered.length;i++){
      const from=ordered[i-1],to=ordered[i];
      const days=Math.round((Date.parse(to.date+'T12:00:00Z')-Date.parse(from.date+'T12:00:00Z'))/86400000);
      if(days<1||days>21)continue;
      const diff=metricValue(to,metric)-metricValue(from,metric);
      if(Math.abs(diff)>(metric==='Overall'?12:5))continue;
      deltas.push({corps:to.corps,days,date:to.date,diff});
    }
  }
  if(!previous)return null;
  const days=clamp(Math.round((Date.parse(targetDate+'T12:00:00Z')-Date.parse(previous.date+'T12:00:00Z'))/86400000),1,21);
  const own=deltas.filter(x=>x.corps.toLowerCase()===corps.toLowerCase()&&Math.abs(x.days-days)<=5).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,12);
  const peers=deltas.filter(x=>Math.abs(x.days-days)<=4).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,100);
  const fallback=deltas.sort((a,b)=>b.date.localeCompare(a.date)).slice(0,150);
  const ownMean=median(own.map(x=>x.diff)); const peerMean=median((peers.length>=5?peers:fallback).map(x=>x.diff))??0;
  const weight=own.length/(own.length+8);
  const growth=clamp(weight*(ownMean??peerMean)+(1-weight)*peerMean,metric==='Overall'?-8:-4,metric==='Overall'?8:4);
  return {value:metricValue(previous,metric)+growth,sample:own.length+(peers.length||fallback.length)};
}
function firstShowEstimate(rows,season,cls,corps,metric,targetDate) {
  // First show of new season: estimate absolute score from historical season OPENERS, never from last year's Finals.
  const openers=new Map();
  for(const r of rows) {
    if(r.year>=season || r.cls!==cls || r.date>=targetDate)continue;
    const v=metricValue(r,metric);
    if(!Number.isFinite(v))continue;
    const key=r.year+'|'+r.corps;
    if(!openers.has(key)||r.date<openers.get(key).date)openers.set(key,r);
  }
  const all=[...openers.values()], own=all.filter(x=>x.corps.toLowerCase()===corps.toLowerCase());
  const pool=own.sort((a,b)=>b.year-a.year).slice(0,4);
  const baseline=median(all.map(x=>metricValue(x,metric)));
  if(baseline==null)return null;
  const ownAvg=median(pool.map(x=>metricValue(x,metric)));
  return {value: (pool.length/(pool.length+3))*(ownAvg??baseline)+(3/(pool.length+3))*baseline,sample:pool.length+all.length};
}
function makeMarkets({eventId,startTs,season,lineup,asOfDate}){
  if(!/^[a-zA-Z0-9_-]{1,120}$/.test(String(eventId)))throw Error('Invalid event ID');
  if(!Number.isSafeInteger(Number(startTs)))throw Error('Invalid start timestamp');
  if(!Number.isInteger(Number(season))||Number(season)<2022)throw Error('Invalid season');
  if(!Array.isArray(lineup)||!lineup.length||lineup.length>100)throw Error('Provide 1–100 corps with optional class.');
  // Event start is the cutoff; the last known score must precede the event date.
  const day=asOfDate||new Date(Number(startTs)*1000).toISOString().slice(0,10);
  const data=history().filter(r=>r.date<day);
  const out=[];
  const used=new Set();
  for(const item of lineup){
    const corps=String(typeof item==='string'?item:item?.corps||'').trim();
    const cls=String(typeof item==='string'?'World Class':item?.cls||item?.class||'World Class').trim();
    const key=corps.toLowerCase()+'|'+cls;
    if(!corps||corps.length>120||used.has(key))continue;
    used.add(key);
    const seasonRows=data.filter(r=>r.year===Number(season)&&r.cls===cls&&r.corps.toLowerCase()===corps.toLowerCase()).sort((a,b)=>b.date.localeCompare(a.date));
    const previous=seasonRows[0]||null;
    // Only captions actually seen this season (or in a historical opener on the first show).
    const metrics=new Set(['Overall']);
    const basis=previous||data.filter(r=>r.year<Number(season)&&r.cls===cls&&r.corps.toLowerCase()===corps.toLowerCase()).sort((a,b)=>a.date.localeCompare(b.date))[0];
    if(basis){for(const k of Object.keys(basis.groups||{}))metrics.add(k);for(const k of Object.keys(basis.captions||{}))metrics.add(k);}
    for(const metric of metrics){
      if(previous&& !Number.isFinite(metricValue(previous,metric)))continue;
      const p=previous?trend(data,Number(season),cls,corps,metric,day,previous):firstShowEstimate(data,Number(season),cls,corps,metric,day);
      if(!p||!Number.isFinite(p.value)||p.sample<3)continue;
      const max=metric==='Overall'?100:metric==='General Effect'?40:['Visual','Music'].includes(metric)?30:20;
      const line=Math.round(clamp(p.value,0,max)*1000)/1000;
      out.push({id:idFor([eventId,cls,corps,metric,'absolute']),corps,caption:metric,kind:'absolute',line,odds:1.90});
      if(previous){
        const prior=metricValue(previous,metric);
        out.push({id:idFor([eventId,cls,corps,metric,'change']),corps,caption:metric,kind:'change',line:Math.round((line-prior)*1000)/1000,odds:1.90});
      }
    }
  }
  return out;
}
function saveMarkets(db,event,markets){
  let inserted=0,skipped=0;
  const insert=db.prepare(`INSERT INTO pb_betting_markets(id,event_id,corps,caption,kind,line,odds)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
  for(const m of markets){
    const row=insert.run(m.id,event.id,m.corps,m.caption,m.kind,m.line,m.odds);
    if(row.changes)inserted++;else skipped++;
  }
  return {generated:markets.length,inserted,existing:skipped};
}
module.exports={makeMarkets,saveMarkets};
