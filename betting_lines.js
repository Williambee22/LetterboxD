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

// Judging increment realism. Raw individual caption scores generally use .100,
// while .050 is possible throughout the season and observed more frequently late.
// Group totals and Overall are weighted/computed aggregates, NOT judge entries:
// their precision must not be quantized to .100/.050.
function judgeHalfTenthRate(rows,{season,cls,metric,targetDate}) {
  const target=calendarDay(targetDate);
  if(target==null)return 0;
  let nearby=0,half=0,global=0,globalHalf=0;
  for(const r of rows){
    if(r.year>=season||r.cls!==cls||!r.captions||
       !Object.prototype.hasOwnProperty.call(r.captions,metric))continue;
    const value=r.captions[metric],day=calendarDay(r.date);
    if(!Number.isFinite(value)||day==null)continue;
    // Only authentic .050 scores are evidence. Ignore parsing anomalies.
    const isHalf=Math.abs(value*20-Math.round(value*20))<1e-5 &&
      Math.abs(value*10-Math.round(value*10))>1e-5;
    const recency=Math.pow(.85,Math.max(0,season-r.year-1));
    global+=recency;
    if(isHalf)globalHalf+=recency;
    const gap=Math.abs(day-target);
    if(gap<=21){
      const w=recency/(1+gap/10);
      nearby+=w;
      if(isHalf)half+=w;
    }
  }
  // Smooth sparse early-season samples toward the observed class/metric rate.
  // Keep a small nonzero possibility even when no historical early .050 is in
  // the dataset; the date-local data dominates as coverage grows.
  const globalRate=global>0?globalHalf/global:0.03;
  const priorRate=Math.max(.005,Math.min(.25,globalRate));
  const rate=(half+20*priorRate)/(nearby+20);
  return clamp(rate,.005,.35);
}
function projectedJudgeCaption(value,{eventId,season,cls,corps,metric,targetDate,rows}) {
  if(!Number.isFinite(value))return value;
  const tenth=Math.round(value*10)/10;
  const half=Math.round(value*20)/20;
  // No half-tenth is available closer than the ordinary .100 projection.
  if(Math.abs(half-tenth)<1e-8)return Math.round(tenth*1000)/1000;
  const rate=judgeHalfTenthRate(rows,{season,cls,metric,targetDate});
  // Deterministic draw: refreshed previews don't flicker and market IDs/lines
  // remain stable. No new random number is generated on page views.
  const token=[eventId,season,cls,canonicalCorps(corps),metric,'judge-step-v1'].join('|');
  const draw=parseInt(crypto.createHash('sha256').update(token).digest('hex').slice(0,8),16)/0x100000000;
  // A half-tenth is preferable only when the underlying model is meaningfully
  // nearer to it, and its historically-calibrated draw succeeds.
  const improvement=Math.abs(value-tenth)-Math.abs(value-half);
  return Math.round((improvement>0.004 && draw<rate ? half : tenth)*1000)/1000;
}
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
// Compare a corps' FIRST THREE scheduled performances with its own prior-season
// performances, taking BOTH show sequence and calendar timing into account.
// This is a read-only prior-year anchor; it never replaces an actual current-year
// score or creates a market independently of the existing model.
function priorSeasonEarlyComparison(rows,{season,cls,corps,metric,targetDate,showNumber}){
  if(showNumber<1||showNumber>3)return null;
  const targetDay=calendarDay(targetDate);
  if(targetDay==null)return null;
  const prior=rows.filter(r=>r.year===season-1 && r.cls===cls &&
    canonicalCorps(r.corps)===canonicalCorps(corps) &&
    Number.isFinite(metricValue(r,metric)) && calendarDay(r.date)!=null)
    .sort((a,b)=>a.date.localeCompare(b.date));
  // Multiple event records on the same date count as one performance day.
  const byDate=new Map();
  for(const r of prior)if(!byDate.has(r.date))byDate.set(r.date,r);
  const ordered=[...byDate.values()];
  if(!ordered.length)return null;

  // Match to a similar calendar date AND a similar position in the season.
  // Show number is a preference rather than a mandate: if last year's tour
  // began weeks later, its first recorded show should not be blindly copied.
  let best=null;
  for(let i=0;i<ordered.length;i++){
    const r=ordered[i],gap=calendarDay(r.date)-targetDay;
    const rankGap=Math.abs((i+1)-showNumber);
    const cost=Math.abs(gap)+9*rankGap;
    if(!best||cost<best.cost)best={r,gap,rankGap,cost};
  }
  if(!best||Math.abs(best.gap)>45)return null;

  const slope=historicDailyGrowth(rows.filter(r=>r.year<season),cls,corps,metric);
  if(Math.abs(best.gap)>10&&slope==null)return null;
  const adjusted=metricValue(best.r,metric)-(slope??0)*best.gap;
  if(!Number.isFinite(adjusted))return null;
  // Very distant/ordinal-mismatched records have less influence; the existing
  // date-aware opener or current-season trend remains the dominant baseline.
  const confidence=(1/(1+Math.abs(best.gap)/20))*(1/(1+best.rankGap));
  return {value:adjusted,confidence,lastDate:best.r.date,lastScore:metricValue(best.r,metric),
    lastShowNumber:ordered.indexOf(best.r)+1,dayGap:best.gap};
}

function scheduledShowNumber(db,{eventId,startTs,season,corps,eventDate,rows}){
  if(db&&typeof db.prepare==='function'){
    try{
      const n=staff.competitionNumber(db,{eventId,startTs,season,corps,eventDate});
      if(Number.isInteger(n)&&n>=1)return n;
    }catch(error){ /* No schedule tables in standalone model tests. */ }
  }
  // Fallback is conservative: only observed performances, never fabricated shows.
  const completed=new Set(rows.filter(r=>r.year===season && r.date<eventDate &&
    canonicalCorps(r.corps)===canonicalCorps(corps)).map(r=>r.date));
  return completed.size+1;
}

function applyEarlySeasonComparison(base,reference,showNumber){
  if(!base||!reference)return base;
  const strengths=[0,.55,.42,.30];
  const weight=strengths[showNumber]*reference.confidence;
  return {...base,value:(1-weight)*base.value+weight*reference.value,
    earlyComparison:{...reference,showNumber,weight}};
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
    const showNumber=scheduledShowNumber(db,{eventId,startTs,season:Number(season),corps,eventDate:day,rows:data});
    const metrics=new Set(['Overall']);
    const basis=previous||data.filter(r=>r.year<Number(season)&&r.cls===cls&&canonicalCorps(r.corps)===canonicalCorps(corps)).sort((a,b)=>b.year-a.year||a.date.localeCompare(b.date))[0];
    if(basis){for(const k of Object.keys(basis.groups||{}))metrics.add(k);for(const k of Object.keys(basis.captions||{}))metrics.add(k);}
    for(const metric of metrics){
      if(previous&&!Number.isFinite(metricValue(previous,metric)))continue;
      const base=previous?trend(data,Number(season),cls,corps,metric,day,previous):firstShowEstimate(data,Number(season),cls,corps,metric,day);
      if(!base||!Number.isFinite(base.value)||base.sample<3)continue;
      const reference=showNumber<=3?priorSeasonEarlyComparison(data,{
        season:Number(season),cls,corps,metric,targetDate:day,showNumber}):null;
      const p=applyEarlySeasonComparison(base,reference,showNumber);
      const max=metric==='Overall'?100:metric==='General Effect'?40:['Visual','Music'].includes(metric)?30:20;
      const preseasonEffect=staff.staffEffect(db,{season:Number(season),corps,eventId,
        startTs:Number(startTs),eventDate:day,metric,max});
      const raw=clamp(p.value+preseasonEffect,0,max);
      // Only original individual judge captions follow the .100/.050 scale.
      // Overall and GE/Visual/Music group totals remain full-precision models.
      const line=metric!=='Overall' &&
        Object.prototype.hasOwnProperty.call(basis?.captions||{},metric)
        ? projectedJudgeCaption(raw,{eventId,season:Number(season),cls,corps,metric,targetDate:day,rows:data})
        : Math.round(raw*1000)/1000;
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
