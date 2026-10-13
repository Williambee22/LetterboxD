'use strict';
// DCI public HTML polling. No third-party HTML parser required. Conservative by design:
// missing/ambiguous data never creates or settles a real-money-like wager.
const crypto = require('crypto');
const lines = require('./betting_lines');
const HISTORY = require('./pressboxd_history_2022.json').records;
const ROOT = 'https://www.dci.org';
const YEAR_MIN = 2022;
const isoDay = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const hash = x => crypto.createHash('sha256').update(x).digest('hex').slice(0, 18);
const decode = x => String(x).replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&#(\d+);/g,(_,v)=>String.fromCodePoint(Number(v)));
function textFromHtml(html) {
  return decode(String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<br\s*\/?>/gi,'\n').replace(/<\/(?:div|p|h[1-6]|li|tr|td|section)>/gi,'\n').replace(/<[^>]*>/g,' ').replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n'));
}
function urls(html, prefix) {
  const set = new Set(); const re = /href\s*=\s*["']([^"']+)["']/gi; let m;
  while ((m=re.exec(html))) {
    try {const u = new URL(decode(m[1]), ROOT); if(u.origin===ROOT && u.pathname.startsWith(prefix))set.add(u.href.split('?')[0]);}catch{}
  }
  return [...set];
}
async function fetchOfficial(url) {
  const u = new URL(url);
  if (u.origin!==ROOT) throw Error('Only official DCI URLs are allowed');
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),16000);
  try {
    const r=await fetch(u.href,{signal:controller.signal,headers:{'User-Agent':'Pressboxd-EventSync/1.0 (public schedule and results checks)','Accept':'text/html'}});
    if(!r.ok)throw Error(`DCI HTTP ${r.status} for ${u.pathname}`);
    const type=r.headers.get('content-type')||'';
    if(!type.includes('html'))throw Error('Unexpected DCI content type');
    const body=await r.text(); if(body.length>4000000)throw Error('DCI document too large');
    return body;
  } finally {clearTimeout(timer);}
}
function eventSlug(url) {return new URL(url).pathname.split('/').filter(Boolean).pop();}
function localTimestamp(y,m,d,h,min,zone){
  // Iteratively solve local wall clock for IANA zone, including daylight saving.
  const guess=Date.UTC(y,m-1,d,h,min)/1000;
  let ts=guess;
  for(let k=0;k<4;k++){
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ts*1000));
    const o=Object.fromEntries(parts.map(p=>[p.type,p.value]));
    const actual=Date.UTC(+o.year,+o.month-1,+o.day,+o.hour,+o.minute)/1000;
    ts+=guess-actual;
  }
  return Math.round(ts);
}
function parseEventPage(html,url){
  const slug=eventSlug(url), match=slug.match(/^(20\d\d)-/);
  if(!match)return null;
  const season=+match[1];
  const txt=textFromHtml(html);
  const titleMatch=txt.match(/(?:^|\n)\s*([^\n]{3,110})\s*\n[^\n]{1,100}\s*\n(?:view all events|watch live|BUY TICKETS)/i);
  const name=(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)||[])[1];
  const eventName=decode(name?textFromHtml(name).trim():titleMatch?.[1]||slug.slice(5).replace(/-/g,' ')).trim();
  // Page headline: Sunday, July 19, 2026 7:00 PM. Use official time zone notation from lineup when present.
  const dm=txt.match(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d\d)\s+(\d{1,2}):(\d\d)\s*(AM|PM)/i);
  if(!dm) return {slug,season,name:eventName,source_url:url,lineup:[],warning:'No unambiguous event date/time'};
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const mo=months.indexOf(dm[1].toLowerCase())+1, day=+dm[2], year=+dm[3];let hour=(+dm[4]%12)+(dm[6].toUpperCase()==='PM'?12:0);
  if(year!==season) return {slug,season,name:eventName,source_url:url,lineup:[],warning:'Season and date disagree'};
  const z=(txt.match(/All times\s+(ET|CT|MT|PT)\b/i)||[])[1]?.toUpperCase();
  if(!z)return {slug,season,name:eventName,source_url:url,lineup:[],warning:'Timezone missing; refusing to guess'};
  const tz={ET:'America/New_York',CT:'America/Chicago',MT:'America/Denver',PT:'America/Los_Angeles'}[z];
  const start_ts=localTimestamp(year,mo,day,hour,+dm[5],tz);
  const region=txt.split(/Lineup\s*&\s*Times/i)[1]?.split(/View full lineup/i)[0]||'';
  const performances=[];
  for(const m of region.matchAll(/(?:^|\n)\s*(\d{1,2}:\d\d\s*(?:AM|PM))\s*\|\s*([^\n]+)/gi)){
    const c=m[2].trim().replace(/\s+-\s+[^-\n]*,\s*[A-Z]{2}\s*$/,'').trim();
    if(!c||/Gates Open|Welcome|Anthem|Intermission|Scores Announced|LIVE|Awards|Encore|Exhibition/i.test(c))continue;
    performances.push(c);
  }
  const lineup=[...new Set(performances)].map(corps=>({corps,cls:'World Class'}));
  return {slug,season,name:eventName,start_ts,source_url:url,lineup,timezone:z,warning:lineup.length?'': 'Official lineup not published or not readable'};
}
function scoreEntries(html){
  // Only accept unique scores from structured score rows. DCI pages sometimes repeat header/teaser scores.
  const txt=textFromHtml(html).replace(/\r/g,'');
  const candidates=[];
  const section=txt.split(/World Class/i).slice(1).join('World Class').split(/View full recap/i)[0];
  // Rows in official site are usually place -> corps -> score on separate lines.
  const lines=section.split('\n').map(x=>x.trim()).filter(Boolean);
  for(let i=0;i<lines.length-2;i++){
    const rank=lines[i],corps=lines[i+1],score=lines[i+2];
    if(!/^\d{1,2}$/.test(rank)||!/^\d{1,3}\.\d{1,3}$/.test(score)||!/^[A-Za-z][\w '&().-]{1,100}$/.test(corps))continue;
    const n=+score;if(n<1||n>100)continue;
    candidates.push({corps,score:n});
  }
  const grouped=new Map(); for(const c of candidates){const k=c.corps.toLowerCase();if(!grouped.has(k))grouped.set(k,new Set());grouped.get(k).add(c.score);}
  const result=[];for(const [key,values] of grouped) if(values.size===1)result.push({corps:candidates.find(c=>c.corps.toLowerCase()===key).corps,score:[...values][0]});
  return result;
}
function init(db){db.exec(`
 CREATE TABLE IF NOT EXISTS pb_dci_sync_log(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,status TEXT NOT NULL,details TEXT,created_ts INTEGER NOT NULL DEFAULT (unixepoch()));
 CREATE TABLE IF NOT EXISTS pb_dci_event_sources(event_id TEXT PRIMARY KEY,source_url TEXT NOT NULL,lineup_json TEXT NOT NULL,timezone TEXT,updated_ts INTEGER NOT NULL DEFAULT (unixepoch()));
 CREATE TABLE IF NOT EXISTS pb_dci_sync_state(key TEXT PRIMARY KEY,last_ts INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS pb_dci_sandbox_bets(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,event_id TEXT NOT NULL,market_id TEXT NOT NULL,corps TEXT NOT NULL,caption TEXT NOT NULL,kind TEXT NOT NULL,line REAL NOT NULL,choice TEXT NOT NULL,stake INTEGER NOT NULL,actual REAL,result TEXT NOT NULL DEFAULT 'pending',payout INTEGER NOT NULL DEFAULT 0,created_ts INTEGER NOT NULL DEFAULT (unixepoch()));
 CREATE TABLE IF NOT EXISTS pb_dci_sandbox_wallets(user_id INTEGER PRIMARY KEY,balance INTEGER NOT NULL DEFAULT 2000);
 CREATE TABLE IF NOT EXISTS pb_dci_sandbox_events(id TEXT PRIMARY KEY,name TEXT NOT NULL,original_date TEXT NOT NULL,lineup_json TEXT NOT NULL,source_url TEXT NOT NULL,markets_json TEXT NOT NULL,results_json TEXT NOT NULL,created_ts INTEGER NOT NULL DEFAULT (unixepoch()));
`);}
function log(db,kind,status,details){db.prepare('INSERT INTO pb_dci_sync_log(kind,status,details) VALUES(?,?,?)').run(kind,status,String(details||'').slice(0,1000));}
function stamp(db,key){db.prepare('INSERT INTO pb_dci_sync_state(key,last_ts) VALUES(?,unixepoch()) ON CONFLICT(key) DO UPDATE SET last_ts=excluded.last_ts').run(key);}
function allowRefresh(db,key,period){const last=db.prepare('SELECT last_ts FROM pb_dci_sync_state WHERE key=?').get(key)?.last_ts||0;return Math.floor(Date.now()/1000)-last>=period;}
async function discover(db,{dryRun=false,year=new Date().getFullYear(),limit=100}={}){
  const html=await fetchOfficial(`${ROOT}/events/`);
  const links=urls(html,'/events/').filter(x=>/\/events\/20\d\d-[^/]+\/?$/.test(new URL(x).pathname)).filter(x=>eventSlug(x).startsWith(String(year)+'-')).slice(0,limit);
  if(!links.length){log(db,'events','warning',`No ${year} event links visible in public schedule`);return {found:0,imported:0,markets:0,errors:[],warning:'No matching events in official schedule; nothing was created'};}
  let imported=0,marketCount=0;const errors=[];
  for(const url of links){try{
    const ev=parseEventPage(await fetchOfficial(url),url);
    if(!ev?.start_ts||ev.warning||!ev.lineup.length){errors.push(`${eventSlug(url)}: ${ev?.warning||'unusable schedule'}`);continue;}
    const id='dci_'+ev.slug;
    if(!dryRun){
      const existing=db.prepare('SELECT start_ts,status FROM pb_betting_events WHERE id=?').get(id);
      // Do not rewrite dates on already-opened or previously bet events.
      const hasBets=db.prepare('SELECT 1 FROM pb_betting_bets b JOIN pb_betting_markets m ON m.id=b.market_id WHERE m.event_id=? LIMIT 1').get(id);
      if(existing && (hasBets||existing.start_ts-86400<=Math.floor(Date.now()/1000)) && existing.start_ts!==ev.start_ts){errors.push(`${ev.slug}: event time changed after market opening; manual review required`);continue;}
      db.prepare(`INSERT INTO pb_betting_events(id,name,start_ts,season,status,source_url) VALUES(?,?,?,?,'scheduled',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,start_ts=excluded.start_ts,source_url=excluded.source_url,updated_ts=unixepoch()`).run(id,ev.name,ev.start_ts,ev.season,url);
      db.prepare(`INSERT INTO pb_dci_event_sources(event_id,source_url,lineup_json,timezone) VALUES(?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET lineup_json=excluded.lineup_json,source_url=excluded.source_url,timezone=excluded.timezone,updated_ts=unixepoch()`).run(id,url,JSON.stringify(ev.lineup),ev.timezone);
      imported++;
      if(ev.start_ts-86400>Math.floor(Date.now()/1000)){
        const mk=lines.makeMarkets({eventId:id,startTs:ev.start_ts,season:ev.season,lineup:ev.lineup});
        marketCount+=lines.saveMarkets(db,{id},mk).inserted;
      }
    }else imported++;
  }catch(e){errors.push(`${eventSlug(url)}: ${e.message}`);}}
  log(db,'events',errors.length?'warning':'ok',`found=${links.length} imported=${imported} markets=${marketCount} errors=${errors.slice(0,3).join('; ')}`);
  if(!dryRun)stamp(db,'events');return {found:links.length,imported,markets:marketCount,errors};
}
function settleTotalMarkets(db,eventId,results){
  const lookup=new Map(results.map(x=>[x.corps.toLowerCase(),x.score]));let settled=0,betsPaid=0;
  const rows=db.prepare(`SELECT * FROM pb_betting_markets WHERE event_id=? AND kind='absolute' AND caption='Overall' AND status='active'`).all(eventId);
  for(const m of rows){const actual=lookup.get(m.corps.toLowerCase());if(!Number.isFinite(actual))continue;
    db.transaction(()=>{
      db.prepare("UPDATE pb_betting_markets SET status='settled',actual=? WHERE id=? AND status='active'").run(actual,m.id);
      const bets=db.prepare("SELECT * FROM pb_betting_bets WHERE market_id=? AND result='pending'").all(m.id);
      for(const b of bets){const outcome=actual===b.line?'push':(actual>b.line?'over':'under')===b.choice?'won':'lost';const payout=outcome==='won'?Math.round(b.stake*b.odds):outcome==='push'?b.stake:0;
        db.prepare('UPDATE pb_betting_bets SET result=?,payout=? WHERE id=?').run(outcome,payout,b.id);
        if(payout){db.prepare('UPDATE pb_betting_wallets SET balance=balance+? WHERE user_id=?').run(payout,b.user_id);db.prepare('INSERT INTO pb_betting_ledger(user_id,bet_id,delta,reason) VALUES(?,?,?,?)').run(b.user_id,b.id,payout,outcome);betsPaid++;}
      }
      settled++;
    })();
  }
  return {settled,betsPaid};
}
async function checkScores(db,{dryRun=false}={}){
  const now=Math.floor(Date.now()/1000);
  const events=db.prepare(`SELECT * FROM pb_betting_events WHERE status='scheduled' AND start_ts<=? AND start_ts>? AND source_url LIKE 'https://www.dci.org/%' ORDER BY start_ts LIMIT 50`).all(now,now-30*86400);
  const scoreIndex=await fetchOfficial(`${ROOT}/scores/`);
  const links=urls(scoreIndex,'/scores/final-scores/');
  let matched=0,settled=0;const errors=[];
  for(const ev of events){
    const slug=new URL(ev.source_url).pathname.split('/').filter(Boolean).pop();
    // The official score slug MUST match this event slug exactly; otherwise abstain.
    const candidate=links.find(u=>eventSlug(u)===slug) || `${ROOT}/scores/final-scores/${slug}/`;
    // Exact deterministic official URL fallback when the scores index is JavaScript-rendered.
    try{const html=await fetchOfficial(candidate);const rows=scoreEntries(html);
      if(!rows.length){errors.push(`${slug}: no unambiguous World Class rows`);continue;}
      matched++;
      if(!dryRun){const out=settleTotalMarkets(db,ev.id,rows);settled+=out.settled;
        const remaining=db.prepare("SELECT count(*) n FROM pb_betting_markets WHERE event_id=? AND status='active'").get(ev.id).n;
        // Caption / change lines are deliberately left active until verified official recap data is available.
        if(remaining===0)db.prepare("UPDATE pb_betting_events SET status='completed' WHERE id=?").run(ev.id);
      }
    }catch(e){errors.push(`${slug}: ${e.message}`);}
  }
  log(db,'scores',errors.length?'warning':'ok',`checked=${events.length} matched=${matched} settled_overall=${settled} errors=${errors.slice(0,3).join('; ')}`);
  if(!dryRun)stamp(db,'scores');return {checked:events.length,matched,settled_overall: settled,errors,notice:'Caption and score-change markets require official detailed recap verification and are NOT automatically settled yet.'};
}
function replay(db,{year=2026,slug='2026-dci-dallas'}={}){
  const rows=HISTORY.filter(r=>r.year===year && r.event_id===slug && Number.isFinite(r.total));
  if(!rows.length)throw Error('No historical event found in the bundled 2022+ workbook');
  const date=rows[0].date, name=rows[0].event;
  const lineup=[...new Map(rows.map(r=>[r.corps.toLowerCase(),{corps:r.corps,cls:r.cls}])).values()];
  const start=Date.parse(date+'T23:00:00Z')/1000;
  const eventId='sandbox_'+slug;
  const markets=lines.makeMarkets({eventId,startTs:start,season:year,lineup,asOfDate:date});
  // Only the workbook's own historical scores are used; no future rows enter the projections.
  const finals=rows.map(r=>({corps:r.corps,score:r.total,groups:r.groups,captions:r.captions}));
  db.prepare(`INSERT INTO pb_dci_sandbox_events(id,name,original_date,lineup_json,source_url,markets_json,results_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET markets_json=excluded.markets_json,results_json=excluded.results_json,lineup_json=excluded.lineup_json`).run(eventId,name,date,JSON.stringify(lineup),`${ROOT}/events/${slug}/`,JSON.stringify(markets),JSON.stringify(finals));
  return {eventId,name,date,lineup:lineup.length,markets:markets.length,marketSample:markets.slice(0,6)};
}
function sandboxWallet(db,uid){db.prepare('INSERT OR IGNORE INTO pb_dci_sandbox_wallets(user_id,balance) VALUES(?,2000)').run(uid);return db.prepare('SELECT balance FROM pb_dci_sandbox_wallets WHERE user_id=?').get(uid).balance;}
function sandboxBet(db,uid,{event_id,market_id,choice,stake}){
  if(!['over','under'].includes(choice)||!Number.isSafeInteger(stake)||stake<1||stake>1000)throw Error('Invalid sandbox choice or stake');
  return db.transaction(()=>{
    const ev=db.prepare('SELECT * FROM pb_dci_sandbox_events WHERE id=?').get(event_id);if(!ev)throw Error('Run historical replay first');
    const m=JSON.parse(ev.markets_json).find(x=>x.id===market_id);if(!m)throw Error('Unknown replay market');
    sandboxWallet(db,uid);
    const paid=db.prepare('UPDATE pb_dci_sandbox_wallets SET balance=balance-? WHERE user_id=? AND balance>=?').run(stake,uid,stake);
    if(paid.changes!==1)throw Error('Not enough test Gems');
    return Number(db.prepare('INSERT INTO pb_dci_sandbox_bets(user_id,event_id,market_id,corps,caption,kind,line,choice,stake) VALUES(?,?,?,?,?,?,?,?,?)').run(uid,event_id,market_id,m.corps,m.caption,m.kind,m.line,choice,stake).lastInsertRowid);
  })();
}
function replaySettle(db,uid,eventId){return db.transaction(()=>{
  const ev=db.prepare('SELECT * FROM pb_dci_sandbox_events WHERE id=?').get(eventId);if(!ev)throw Error('Replay event missing');
  const results=JSON.parse(ev.results_json), all=JSON.parse(ev.markets_json);
  const map=new Map(results.map(x=>[x.corps.toLowerCase(),x]));let processed=0,paid=0;
  for(const b of db.prepare("SELECT * FROM pb_dci_sandbox_bets WHERE event_id=? AND user_id=? AND result='pending'").all(eventId,uid)){
    const r=map.get(b.corps.toLowerCase());const m=all.find(x=>x.id===b.market_id);if(!r||!m)continue;
    let actual=b.caption==='Overall'?r.score:r.groups?.[b.caption]??r.captions?.[b.caption];
    if(b.kind==='change'){
      const previous=HISTORY.filter(x=>x.corps.toLowerCase()===b.corps.toLowerCase()&&x.year===Number(ev.original_date.slice(0,4))&&x.date<ev.original_date).sort((a,b)=>b.date.localeCompare(a.date))[0];
      const prior=previous?(b.caption==='Overall'?previous.total:previous.groups?.[b.caption]??previous.captions?.[b.caption]):null;
      if(!Number.isFinite(prior)||!Number.isFinite(actual))continue;
      actual=actual-prior;
    }
    if(!Number.isFinite(actual))continue;
    const result=Math.abs(actual-b.line)<0.0000001?'push':(actual>b.line?'over':'under')===b.choice?'won':'lost';
    const payout=result==='won'?Math.round(b.stake*1.9):result==='push'?b.stake:0;
    db.prepare('UPDATE pb_dci_sandbox_bets SET actual=?,result=?,payout=? WHERE id=?').run(actual,result,payout,b.id);
    if(payout){db.prepare('UPDATE pb_dci_sandbox_wallets SET balance=balance+? WHERE user_id=?').run(payout,uid);paid+=payout;}
    processed++;
  }
  return {processed,paid,balance:sandboxWallet(db,uid)};
})();}
module.exports={init,discover,checkScores,replay,sandboxWallet,sandboxBet,replaySettle,parseEventPage,scoreEntries,allowRefresh,log,stamp,fetchOfficial};
