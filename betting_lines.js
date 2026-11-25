'use strict';
// Builds markets from bundled historical scores plus verified DCI score recaps.
// Season-opening forecasts use same-calendar-date historical performances,
// not unadjusted late-July or August scores.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const staff = require('./betting_staff');
const HISTORY_PATH = path.join(__dirname, 'pressboxd_history_2022.json');
let cache;
function history(db) {
  if (!cache) cache = JSON.parse(fs.readFileSync(HISTORY_PATH,'utf8')).records;
  if (!db) return cache;
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pb_dci_verified_scores'").get();
  if (!exists) return cache;
  const records=db.prepare('SELECT season,date,event_slug,event_name,corps,cls,total,groups_json,captions_json FROM pb_dci_verified_scores').all();
  const merged=new Map(cache.map(r=>[`${r.event_id}|${r.cls}|${canonicalCorps(r.corps)}`,r]));
  for(const r of records){
    const row={year:r.season,date:r.date,event_id:r.event_slug,event:r.event_name,corps:r.corps,
      cls:r.cls,total:r.total,groups:JSON.parse(r.groups_json),captions:JSON.parse(r.captions_json)};
    merged.set(`${row.event_id}|${row.cls}|${canonicalCorps(row.corps)}`,row);
  }
  return [...merged.values()];
}
const CORPS_ALIASES = {'the cavaliers':'cavaliers','cavaliers':'cavaliers',
 'the academy':'academy','academy':'academy','scv':'santa clara vanguard',
 'spirit':'spirit of atlanta','seattle cascades':'cascades',
 'cascades':'cascades','the cadets':'cadets','cadets':'cadets',
 'hurricanes':'connecticut hurricanes'};
function canonicalCorps(corps){const s=String(corps||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();return CORPS_ALIASES[s]||s;}
function getPreviousScore(db,{season,cls,corps,date}){
  return history(db).filter(r=>r.year===season && r.date<date && r.cls===cls &&
    canonicalCorps(r.corps)===canonicalCorps(corps))
    .sort((a,b)=>b.date.localeCompare(a.date))[0]||null;
}
function median(xs){if(!xs.length)return null;const a=[...xs].sort((x,y)=>x-y),n=a.length;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2;}
function clamp(x,lo,hi){return Math.max(lo,Math.min(hi,x));}
function idFor(parts){return 'hist_'+crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0,24);}
function metricValue(r,metric){return metric==='Overall'?r.total:(r.groups&&r.groups[metric]!=null?r.groups[metric]:r.captions&&r.captions[metric]);}
function calendarDay(date){ // Normalized non-leap-year calendar day; all target-season dates use the same axis.
  const m=String(date||'').match(/^\d{4}-(\d{2})-(\d{2})$/);
  if(!m)return null;
  const month=Number(m[1]),day=Number(m[2]);
  const n=Date.UTC(2023,month-1,day);
  if(!Number.isFinite(n))return null;
  return Math.round((n-Date.UTC(2023,0,1))/86400000);
}
function trend(rows,season,cls,corps,metric,targetDate,previous){
  // Compare transitions within seasons only, never Finals from one year with June of the next.
  const grouped=new Map();
  for(const r of rows){
    if(r.cls!==cls || r.date>=targetDate || r.year>season)continue;
    const v=metricValue(r,metric);
    if(!Number.isFinite(v))continue;
    const key=r.year+'|'+canonicalCorps(r.corps);
    if(!grouped.has(key))grouped.set(key,[]);
    grouped.get(key).push(r);
  }
  const deltas=[];
  for(const [key,records] of grouped){
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
  const own=deltas.filter(x=>canonicalCorps(x.corps)===canonicalCorps(corps)&&Math.abs(x.days-days)<=5).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,12);
  const peers=deltas.filter(x=>Math.abs(x.days-days)<=4).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,100);
  const fallback=deltas.sort((a,b)=>b.date.localeCompare(a.date)).slice(0,150);
  const ownMean=median(own.map(x=>x.diff));const peerMean=median((peers.length>=5?peers:fallback).map(x=>x.diff))??0;
  const weight=own.length/(own.length+8);
  const growth=clamp(weight*(ownMean??peerMean)+(1-weight)*peerMean,metric==='Overall'?-8:-4,metric==='Overall'?8:4);
  return {value:metricValue(previous,metric)+growth,sample:own.length+(peers.length||fallback.length)};
}

// Estimate a within-season daily slope using pairs of actual scores 7–55 days apart.
// Preference: same corps; fallback: same-class peers. This prevents an August score
// from being treated as a June opener. Values are normalized to metric scale.
function historicDailyGrowth(rows,cls,corps,metric){
  const groups=new Map(),ownKey=canonicalCorps(corps),isOwn=[] ,peers=[];
  for(const r of rows){
    if(r.cls!==cls || !Number.isFinite(metricValue(r,metric)))continue;
    const k=`${r.year}|${canonicalCorps(r.corps)}`;
    if(!groups.has(k))groups.set(k,[]);
    groups.get(k).push(r);
  }
  const scale=metric==='Overall'?1:metric==='General Effect'?.4:['Visual','Music'].includes(metric)?.3:.2;
  for(const [key,values] of groups){
    const ordered=[...new Map(values.sort((a,b)=>a.date.localeCompare(b.date)).map(r=>[r.date,r])).values()];
    for(let i=0;i<ordered.length;i++)for(let j=i+1;j<ordered.length;j++){
      const days=(Date.parse(ordered[j].date+'T12:00:00Z')-Date.parse(ordered[i].date+'T12:00:00Z'))/86400000;
      if(days<7||days>55)continue;
      const perDay=(metricValue(ordered[j],metric)-metricValue(ordered[i],metric))/days;
      if(!Number.isFinite(perDay)||perDay<-.15*scale||perDay>.85*scale)continue;
      const entry={rate:perDay,year:ordered[j].year};
      if(key.split('|').slice(1).join('|')===ownKey)isOwn.push(entry);
      else peers.push(entry);
    }
  }
  const own=median(isOwn.map(x=>x.rate));
  const peer=median(peers.map(x=>x.rate));
  if(own==null&&peer==null)return null;
  const w=isOwn.length/(isOwn.length+3);
  return clamp(w*(own??peer)+(1-w)*(peer??own),0,.65*scale);
}

function firstShowEstimate(rows,season,cls,corps,metric,targetDate){
  const target=calendarDay(targetDate);
  if(target==null)return null;
  const ownKey=canonicalCorps(corps);
  const old=rows.filter(r=>r.year<season&&r.cls===cls&&r.year>=season-5&&Number.isFinite(metricValue(r,metric))&&calendarDay(r.date)!=null);
  if(!old.length)return null;
  const slope=historicDailyGrowth(old,cls,corps,metric);
  // One representative score per corps/season: closest to the target calendar date.
  const byYearCorps=new Map();
  for(const r of old){
    const k=`${r.year}|${canonicalCorps(r.corps)}`;
    const dist=Math.abs(calendarDay(r.date)-target);
    const prior=byYearCorps.get(k);
    if(!prior||dist<prior.dist||(dist===prior.dist&&r.date<prior.r.date))byYearCorps.set(k,{r,dist});
  }
  const all=[...byYearCorps.values()];
  const similar=all.filter(x=>x.dist<=14);
  const peerBaseline=median(similar.map(x=>metricValue(x.r,metric)));
  const own=all.filter(x=>canonicalCorps(x.r.corps)===ownKey).sort((a,b)=>b.r.year-a.r.year);
  // No credible early-season evidence and no observed seasonal growth: abstain.
  if(!own.length && peerBaseline==null)return null;
  if(slope==null && !own.some(x=>x.dist<=14))return null;
  const anchors=[];
  for(const {r,dist} of own.slice(0,5)){
    if(dist>52)continue;
    if(dist>14&&slope==null)continue;
    const gap=calendarDay(r.date)-target;
    const v=metricValue(r,metric)-(slope??0)*gap;
    // Less weight for scores far from the target date, even after adjustment.
    const recency=Math.pow(.75,Math.max(0,season-1-r.year));
    const closeness=1/(1+dist/16);
    anchors.push({value:v,weight:recency*closeness});
  }
  if(!anchors.length)return null;
  const wSum=anchors.reduce((a,x)=>a+x.weight,0);
  const ownEstimate=anchors.reduce((a,x)=>a+x.value*x.weight,0)/wSum;
  // A modest peer shrinkage stabilizes one-season estimates, but cannot override
  // the same-corps early-season evidence with unrelated August championship scores.
  const peerWeight=peerBaseline==null?0:Math.min(.22,1/(anchors.length+5));
  const value=(1-peerWeight)*ownEstimate+peerWeight*(peerBaseline??ownEstimate);
  return {value,sample:Math.max(3,anchors.length+similar.length),model:'calendar_aligned',dailyGrowth:slope};
}
function makeMarkets({eventId,startTs,season,lineup,asOfDate,db,eventDate}){
  if(!/^[a-zA-Z0-9_-]{1,120}$/.test(String(eventId)))throw Error('Invalid event ID');
  if(!Number.isSafeInteger(Number(startTs)))throw Error('Invalid start timestamp');
  if(!Number.isInteger(Number(season))||Number(season)<2022)throw Error('Invalid season');
  if(!Array.isArray(lineup)||!lineup.length||lineup.length>100)throw Error('Provide 1–100 corps with optional class.');
  const day=eventDate||asOfDate||new Date(Number(startTs)*1000).toISOString().slice(0,10);
  const availableThrough=asOfDate&&asOfDate<day?asOfDate:day;
  const data=history(db).filter(r=>r.date<availableThrough);
  const out=[],used=new Set();
  for(const item of lineup){
    const corps=String(typeof item==='string'?item:item?.corps||'').trim();
    const cls=String(typeof item==='string'?'World Class':item?.cls||item?.class||'World Class').trim();
    const key=canonicalCorps(corps)+'|'+cls;
    if(!corps||corps.length>120||used.has(key))continue;
    used.add(key);
    const seasonRows=data.filter(r=>r.year===Number(season)&&r.cls===cls&&canonicalCorps(r.corps)===canonicalCorps(corps)).sort((a,b)=>b.date.localeCompare(a.date));
    const previous=seasonRows[0]||null;
    const metrics=new Set(['Overall']);
    const basis=previous||data.filter(r=>r.year<Number(season)&&r.cls===cls&&canonicalCorps(r.corps)===canonicalCorps(corps)).sort((a,b)=>b.year-a.year||a.date.localeCompare(b.date))[0];
    if(basis){for(const k of Object.keys(basis.groups||{}))metrics.add(k);for(const k of Object.keys(basis.captions||{}))metrics.add(k);}
    for(const metric of metrics){
      if(previous&&!Number.isFinite(metricValue(previous,metric)))continue;
      const p=previous?trend(data,Number(season),cls,corps,metric,day,previous):firstShowEstimate(data,Number(season),cls,corps,metric,day);
      if(!p||!Number.isFinite(p.value)||p.sample<3)continue;
      const max=metric==='Overall'?100:metric==='General Effect'?40:['Visual','Music'].includes(metric)?30:20;
      const preseasonEffect=staff.staffEffect(db,{season:Number(season),corps,eventId,
        startTs:Number(startTs),eventDate:day,metric,max});
      const line=Math.round(clamp(p.value+preseasonEffect,0,max)*1000)/1000;
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
module.exports={makeMarkets,saveMarkets,history,canonicalCorps,metricValue,getPreviousScore};
