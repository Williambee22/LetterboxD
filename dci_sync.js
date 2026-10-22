'use strict';
// Official DCI read-only schedule/score importer. Never guess times or settle uncertain recaps.
const crypto = require('crypto');
const cheerio = require('cheerio');
const lines = require('./betting_lines');
const HISTORY = require('./pressboxd_history_2022.json').records;
const ROOT = 'https://www.dci.org';
const NOW = () => Math.floor(Date.now()/1000);
const hash = x => crypto.createHash('sha256').update(String(x)).digest('hex').slice(0,18);
const CLASS_NAMES = ['World Class','Open Class','All-Age - World Class','All Age Class','All-Age Class','All-Age - Open Class'];
const simplify = s => String(s||'').replace(/\s+/g,' ').trim();
const unescapeHtml = s => cheerio.load(`<p>${s||''}</p>`)('p').text();
function textFromHtml(html) {
  return unescapeHtml(String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ')
    .replace(/<br\s*\/?>/gi,'\n')
    .replace(/<\/(?:div|p|h[1-6]|li|tr|td|section|article|time)>/gi,'\n')
    .replace(/<[^>]*>/g,' ')).replace(/[ \t]+/g,' ').replace(/\n\s*\n/g,'\n');
}
function officialUrl(raw) {
  try {const u = new URL(unescapeHtml(raw),ROOT);if(u.origin!==ROOT || !['http:','https:'].includes(u.protocol))return null;
    u.search='';u.hash='';return u.href;
  }catch{return null;}
}
function urls(html,prefix){
  const found=new Set();
  for(const m of String(html).matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)){
    const url=officialUrl(m[1]);if(url&&new URL(url).pathname.startsWith(prefix))found.add(url);
  }
  return [...found];
}
function eventSlug(url){return new URL(url).pathname.split('/').filter(Boolean).pop();}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fetchOfficial(url,{method='GET',form,timeoutMs=16000}={}){
  const u=new URL(url);if(u.origin!==ROOT)throw Error('Official dci.org URL required');
  const headers={'User-Agent':'Pressboxd/2.0 (+https://www.pressboxd.com; event/score sync)','Accept':'text/html,application/json;q=0.9,*/*;q=0.6'};
  let body;
  if(form){headers['Content-Type']='application/x-www-form-urlencoded;charset=UTF-8';body=new URLSearchParams(form).toString();}
  for(let attempt=0;attempt<3;attempt++){
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const r=await fetch(u.href,{method,body,headers,signal:controller.signal,redirect:'follow'});
      if([429,500,502,503,504].includes(r.status)&&attempt<2){await sleep(600*(attempt+1));continue;}
      if(!r.ok)throw Error(`DCI HTTP ${r.status} for ${u.pathname}`);
      if(new URL(r.url).origin!==ROOT)throw Error('Unexpected redirect away from dci.org');
      const type=r.headers.get('content-type')||'';
      if(!/html|json|text\/plain/.test(type))throw Error(`Unexpected content type: ${type}`);
      const txt=await r.text();
      if(txt.length>5000000)throw Error('DCI response too large');
      if(/just a moment|cf-challenge|enable javascript and cookies/i.test(txt)&&txt.length<200000)throw Error('DCI anti-bot challenge; use admin diagnostics, do not guess');
      return txt;
    }finally{clearTimeout(timer);}
  }
  throw Error('DCI fetch failed after retries');
}
// The schedule is often loaded by WordPress AJAX instead of containing event anchors in initial HTML.
function collectEventUrls(payload,{year}={}){
  const out=new Set();
  function visit(v,depth=0){
    if(depth>12||v==null)return;
    if(Array.isArray(v)){for(const x of v)visit(x,depth+1);return;}
    if(typeof v==='object'){for(const x of Object.values(v))visit(x,depth+1);return;}
    const s=String(v).replace(/\\\//g,'/');
    for(const link of urls(s,'/events/'))out.add(link);
    for(const m of s.matchAll(/(?:https?:\/\/www\.dci\.org)?\/events\/(20\d\d-[a-z0-9-]+)\/?/gi)){
      const url=officialUrl(`/events/${m[1]}/`);if(url)out.add(url);
    }
    if(s.startsWith('{')||s.startsWith('['))try{visit(JSON.parse(s),depth+1);}catch{}
  }
  visit(payload);
  return [...out].filter(u=>/^20\d\d-[a-z0-9-]+$/i.test(eventSlug(u))&&(!year||eventSlug(u).startsWith(`${year}-`)));
}
async function scheduleLinks({year,limit=150}={}){
  let home, links=[], source='html', warning=null;
  home=await fetchOfficial(`${ROOT}/events/`);
  links=collectEventUrls(home,{year});
  if(links.length>=limit)return {links:links.slice(0,limit),source,warning};
  let ajaxError=null, consecutiveEmpty=0, pagesLoaded=0;
  for(let page=1;page<=12 && links.length<limit;page++){
    try {
      const result=await fetchOfficial(`${ROOT}/wp-admin/admin-ajax.php`,{
        method:'POST',form:{action:'load_events',page:String(page),'filters[corps]':'',
          'filters[location_state]':'','filters[start_date]':'','filters[end_date]':''}});
      pagesLoaded++;
      const next=collectEventUrls(result,{year});
      const before=links.length;links=[...new Set([...links,...next])];
      if(links.length===before)consecutiveEmpty++;else consecutiveEmpty=0;
      if(consecutiveEmpty>=2||/^\s*0\s*$/.test(result)||!result.trim())break;
    }catch(e){ajaxError=e.message;break;}
  }
  if(pagesLoaded)source='ajax';
  if(!links.length)warning=`No events found for ${year}; ${ajaxError||'schedule has no accessible events'}`;
  else if(ajaxError)warning=`Partial event list; AJAX: ${ajaxError}`;
  return {links:links.slice(0,limit),source,warning};
}
function localTimestamp(y,m,d,h,min,zone){
  const desired=Date.UTC(y,m-1,d,h,min)/1000;let ts=desired;
  for(let k=0;k<5;k++){
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ts*1000));
    const obj=Object.fromEntries(parts.map(p=>[p.type,p.value]));
    const got=Date.UTC(+obj.year,+obj.month-1,+obj.day,+obj.hour,+obj.minute)/1000;
    ts+=desired-got;
  }
  return ts;
}
function getEventDateAndTime(txt,season){
  const months='January February March April May June July August September October November December'.split(' ');
  const dateRe=/(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})/gi;
  const dates=[...txt.matchAll(dateRe)].filter(x=>Number(x[3])===season);
  if(!dates.length)return null;
  const d=dates[0],y=Number(d[3]),month=months.findIndex(m=>m.toLowerCase()===d[1].toLowerCase())+1,day=Number(d[2]);
  const time=txt.slice(d.index+d[0].length,d.index+d[0].length+100).match(/(\d{1,2}):(\d\d)\s*(AM|PM)/i)
    ||txt.match(/\bEvent (?:Start )?Time\s*:?\s*(\d{1,2}):(\d\d)\s*(AM|PM)/i)
    ||txt.match(/\b(?:event (?:getting underway|begins|starts) at)\s*(\d{1,2})\s*(?:\:)?\s*(\d\d)?\s*(p\.?m\.?|a\.?m\.?)/i);
  const zoneMatch=txt.match(/All times\s+(ET|CT|MT|PT)\b/i) || txt.match(/\b(?:\d{1,2}:(?:\d\d)\s*)?(?:AM|PM)\s+(ET|CT|MT|PT)\b/i);
  if(!zoneMatch||!time)return {date:`${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,warning:'Official date found but time/timezone unavailable'};
  const timezone={ET:'America/New_York',CT:'America/Chicago',MT:'America/Denver',PT:'America/Los_Angeles'}[zoneMatch[1].toUpperCase()];
  const hour=(Number(time[1])%12)+(/p/i.test(time[3])?12:0),minute=Number(time[2]||0);
  const date=`${y}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
  return {date,timezone,start_ts:localTimestamp(y,month,day,hour,minute,timezone),zone:zoneMatch[1].toUpperCase()};
}
function inferredClass(corps,season){
  const c=lines.canonicalCorps(corps);
  const hits=HISTORY.filter(x=>x.year<=season && lines.canonicalCorps(x.corps)===c);
  if(!hits.length)return null; // unknown performers must not silently become World Class
  hits.sort((a,b)=>b.year-a.year);
  const latest=hits[0].year;
  const values=[...new Set(hits.filter(x=>x.year===latest).map(x=>x.cls))];
  return values.length===1?values[0]:null;
}
function parseEventPage(html,url){
  const slug=eventSlug(url),match=slug.match(/^(20\d\d)-/);if(!match)return null;
  const season=Number(match[1]),$=cheerio.load(html),txt=textFromHtml(html);
  const eventName=simplify($('h1').first().text()||slug.slice(5).replace(/-/g,' '));
  const date=getEventDateAndTime(txt,season);
  const raw=txt.split(/Lineup\s*&\s*Times/i)[1]?.split(/View full lineup|Get directions|Venue Information|Tickets/i)[0]||'';
  const lineup=[];const seen=new Set();const rejected=[];
  for(const m of raw.matchAll(/(?:^|\n)\s*(\d{1,2}:\d\d\s*(?:AM|PM))\s*\|\s*([^\n]+)/gi)){
    const name=simplify(m[2].replace(/\s+-\s+[^\n]*,\s*[A-Z]{2}(?:\s+\d{5})?$/,'').replace(/\s+-\s+[^\n]*,\s*[A-Z]{2}\b.*$/,''));
    if(!name || /^(Gates Open|Welcome|Anthem|Intermission|Scores|LIVE|Awards|Encore|Exhibition|Break|Event Concludes|National Anthem)/i.test(name)||/\b(?:exhibition|alumni|concludes|ceremony)\b/i.test(name))continue;
    const cls=inferredClass(name,season);
    if(!cls){rejected.push(name);continue;}
    const key=lines.canonicalCorps(name)+'|'+cls;if(seen.has(key))continue;seen.add(key);
    lineup.push({corps:name,cls});
  }
  const warning=!date?.start_ts ? (date?.warning||'Official date not published or unreadable'):
    lineup.length? (rejected.length?`Unmatched performers (not bettable): ${rejected.join(', ').slice(0,170)}`:''):
    'Lineup unpublished or no recognized competitive corps; event saved, markets not generated';
  return {slug,season,name:eventName,source_url:url,start_ts:date?.start_ts,date:date?.date,
    lineup,timezone:date?.timezone||null,warning};
}
function scoreEntries(html){
  // Important: official pages feature a LEADERBOARD TEASER before the actual event table.
  // Split at every independently headed class table, then choose the LAST most complete block.
  const txt=textFromHtml(html).replace(/\r/g,'');
  const sections=txt.split(/\n\s*((?:World|Open|All[- ]Age(?:\s*-\s*(?:World|Open))?) Class)\s*\n/gi);
  const groups=new Map();
  for(let i=1;i<sections.length;i+=2){
    const cls=sections[i].replace(/\s+/g,' ').trim();
    if(!/^(?:World|Open) Class$/i.test(cls))continue; // only known historical classes
    const text=sections[i+1]||'';const words=text.split('\n').map(simplify).filter(Boolean);
    const rows=[];for(let k=0;k<words.length-2;k++){
      if(!/^\d{1,2}$/.test(words[k])||!/^[A-Za-z][A-Za-z0-9 '&().\-]{1,120}$/.test(words[k+1])||!/^\d{1,3}\.\d{1,3}$/.test(words[k+2]))continue;
      const score=Number(words[k+2]);if(score<1||score>100)continue;
      rows.push({corps:words[k+1],cls,score});k+=2;
    }
    if(!groups.has(cls))groups.set(cls,[]);groups.get(cls).push(rows);
  }
  const out=[];
  for(const [cls,blocks] of groups){
    const uniqueSize=b=>new Set(b.map(x=>lines.canonicalCorps(x.corps))).size;
    const winner=blocks.reduce((best,b)=>uniqueSize(b)>=uniqueSize(best)?b:best,[]);
    const uniq=new Map();for(const r of winner){const k=lines.canonicalCorps(r.corps);if(uniq.has(k)&&uniq.get(k).score!==r.score)uniq.delete(k);else uniq.set(k,r);}
    if(winner.length)out.push(...uniq.values());
  }
  return out;
}
function cellScores(cell){
  // A recap's caption score is displayed as Content rank Achievement rank TOTAL rank.
  // Some finals have multiple judges for the same subcaption.
  const t=simplify(cell);
  const captionTotals=[...t.matchAll(/\b\d{1,2}\.\d{1,3}\s+\d{1,2}\s+\d{1,2}\.\d{1,3}\s+\d{1,2}\s+(\d{1,2}\.\d{1,3})\s+\d{1,2}\b/g)].map(x=>Number(x[1]));
  const tail=t.match(/(?:^|\s)(\d{1,2}\.\d{1,3})\s+\d{1,2}\s*$/);
  return {captionTotals,groupTotal:tail?Number(tail[1]):null};
}
function parseRecap(html,{slug,expectedDate}={}){
  const $=cheerio.load(html), txt=textFromHtml(html);
  if(!/General Effect/i.test(txt)||!/Music/i.test(txt)||!/Visual/i.test(txt))return [];
  if(expectedDate){
    const [y,m,d]=expectedDate.split('-').map(Number);
    const month=new Intl.DateTimeFormat('en-US',{month:'long',timeZone:'UTC'}).format(new Date(Date.UTC(y,m-1,1)));
    if(!new RegExp(`${month}\\s+${d},?\\s+${y}`,'i').test(txt))return [];
  }
  function numericCell($cell){
    const text=simplify($cell.find('span').first().text()||$cell.text());
    const m=text.match(/(?:^|\s)(\d{1,3}\.\d{1,3})(?:\s|$)/);
    return m?Number(m[1]):null;
  }
  function extractGroupedRow($row,cls){
    const cells=$row.children('td');if(cells.length<7)return null;
    const corps=simplify($row.find('.sticky-td').first().text()||cells.eq(0).text());
    if(!/^[A-Za-z]/.test(corps)||corps.length>120)return null;
    const entries=[];const groups={};
    for(const [column,group] of [[1,'General Effect'],[2,'Visual'],[3,'Music']]){
      const $cell=cells.eq(column);
      const groupValue=numericCell($cell.find('.data-total').first());
      const judges=$cell.find('table.data').toArray().map(x=>numericCell($(x).find('td').last()));
      if(!Number.isFinite(groupValue)||judges.some(v=>!Number.isFinite(v)))return null;
      groups[group]=groupValue;
      entries.push(judges);
    }
    const total=numericCell(cells.last());
    if(!Number.isFinite(total)||total<1||total>100)return null;
    const subtotal=Object.values(groups).reduce((a,b)=>a+b,0);
    if(Math.abs(subtotal-total)>1.5)return null;
    const captions={};
    const ge=entries[0];
    if(ge.length===4){ge.forEach((v,i)=>{captions[`GE${Math.floor(i/2)+1} ${i%2?'B':'A'}`]=v;});}
    else if(ge.length===2){captions.GE1=ge[0];captions.GE2=ge[1];}
    // Other panels differ by event. Never invent absent subcaption scores.
    ['Visual Proficiency','Visual Analysis','Color Guard'].forEach((key,i)=>{if(Number.isFinite(entries[1][i]))captions[key]=entries[1][i];});
    const musicKeys=entries[2].length===4?['Music Brass','Music Analysis A','Music Analysis B','Music Percussion']:
       ['Music Brass','Music Analysis','Music Percussion'];
    musicKeys.forEach((key,i)=>{if(Number.isFinite(entries[2][i]))captions[key]=entries[2][i];});
    return {corps,cls,total,groups,captions};
  }
  const found=[];
  const blocks=$('.recap-tbl').toArray();
  for(const block of blocks){
    const $block=$(block);
    const heading=simplify($block.prev().find('h2,h3').first().text()||$block.prev().text()||
       $block.parent().prev().find('h2,h3').first().text());
    const cls=/Open Class/i.test(heading)?'Open Class':/World Class/i.test(heading)?'World Class':null;
    if(!cls)continue; // ambiguous All-Age scores cannot be matched to World Class.
    const header=$block.find('> table > tbody > tr.table-top').first();
    if(!header.length)continue;
    if(!/General Effect/i.test(header.text())||!/Visual/i.test(header.text())||!/Music/i.test(header.text()))continue;
    $block.find('> table > tbody > tr').not('.table-top').each((_,tr)=>{
      const result=extractGroupedRow($(tr),cls);if(result)found.push(result);
    });
  }
  // Conservative fallback for a genuinely flat recap table (not nested tables).
  if(!found.length)for(const table of $('table').toArray()){
    const $table=$(table);if($table.find('table').length)continue;
    const head=simplify($table.find('thead').text()||$table.find('tr').first().text());
    if(!/general effect/i.test(head)||!/visual/i.test(head)||!/music/i.test(head)||!/total/i.test(head))continue;
    const heading=simplify($table.prevAll('h2,h3').first().text()||$table.parent().prevAll('h2,h3').first().text());
    const cls=/Open Class/i.test(heading)?'Open Class':/World Class/i.test(heading)?'World Class':null;
    if(!cls)continue;
    $table.find('> tbody > tr').each((_,tr)=>{
      const cells=$(tr).children('td').map((_,td)=>simplify($(td).text())).get();if(cells.length<7)return;
      const ge=cellScores(cells[1]),vis=cellScores(cells[2]),music=cellScores(cells[3]);
      const match=cells[cells.length-1].match(/\b(\d{1,3}\.\d{1,3})\b/),total=match?Number(match[1]):null;
      const groups={'General Effect':ge.groupTotal,Visual:vis.groupTotal,Music:music.groupTotal};
      if(!Number.isFinite(total)||!Object.values(groups).every(Number.isFinite))return;
      if(Math.abs(Object.values(groups).reduce((a,b)=>a+b,0)-total)>1.5)return;
      const captions={};
      const geV=ge.captionTotals,viV=vis.captionTotals,muV=music.captionTotals;
      if(geV.length===4)geV.forEach((v,i)=>{captions[`GE${Math.floor(i/2)+1} ${i%2?'B':'A'}`]=v;});
      else if(geV.length===2){captions.GE1=geV[0];captions.GE2=geV[1];}
      ['Visual Proficiency','Visual Analysis','Color Guard'].forEach((key,i)=>{if(Number.isFinite(viV[i]))captions[key]=viV[i];});
      const keys=muV.length===4?['Music Brass','Music Analysis A','Music Analysis B','Music Percussion']:['Music Brass','Music Analysis','Music Percussion'];
      keys.forEach((key,i)=>{if(Number.isFinite(muV[i]))captions[key]=muV[i];});
      if(/^[A-Za-z]/.test(cells[0]))found.push({corps:cells[0],cls,total,groups,captions});
    });
  }
  const uniq=new Map(),conflicts=new Set();
  for(const r of found){const key=r.cls+'|'+lines.canonicalCorps(r.corps);
    if(uniq.has(key)&&Math.abs(uniq.get(key).total-r.total)>0.001){conflicts.add(key);continue;}
    uniq.set(key,r);
  }
  for(const key of conflicts)uniq.delete(key);
  return [...uniq.values()];
}
function init(db){db.exec(`
 CREATE TABLE IF NOT EXISTS pb_dci_sync_log(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,status TEXT NOT NULL,details TEXT,created_ts INTEGER NOT NULL DEFAULT (unixepoch()));
 CREATE TABLE IF NOT EXISTS pb_dci_event_sources(event_id TEXT PRIMARY KEY,source_url TEXT NOT NULL,lineup_json TEXT NOT NULL,timezone TEXT,updated_ts INTEGER NOT NULL DEFAULT (unixepoch()));
 CREATE TABLE IF NOT EXISTS pb_dci_event_dates(event_id TEXT PRIMARY KEY,local_date TEXT NOT NULL,timezone TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS pb_dci_sync_state(key TEXT PRIMARY KEY,last_ts INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS pb_dci_sync_locks(key TEXT PRIMARY KEY,token TEXT NOT NULL,expires_ts INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS pb_dci_verified_scores(event_slug TEXT NOT NULL,season INTEGER NOT NULL,date TEXT NOT NULL,event_name TEXT NOT NULL,corps TEXT NOT NULL,corps_key TEXT NOT NULL,cls TEXT NOT NULL,total REAL NOT NULL,groups_json TEXT NOT NULL,captions_json TEXT NOT NULL,source_url TEXT NOT NULL,verified_ts INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(event_slug,cls,corps_key));
 CREATE INDEX IF NOT EXISTS idx_dci_verified_corps_date ON pb_dci_verified_scores(season,cls,corps_key,date);
 CREATE TABLE IF NOT EXISTS pb_dci_sandbox_bets(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,event_id TEXT NOT NULL,market_id TEXT NOT NULL,corps TEXT NOT NULL,caption TEXT NOT NULL,kind TEXT NOT NULL,line REAL NOT NULL,choice TEXT NOT NULL,stake INTEGER NOT NULL,actual REAL,result TEXT NOT NULL DEFAULT 'pending',payout INTEGER NOT NULL DEFAULT 0,created_ts INTEGER NOT NULL DEFAULT (unixepoch()));
 CREATE TABLE IF NOT EXISTS pb_dci_sandbox_wallets(user_id INTEGER PRIMARY KEY,balance INTEGER NOT NULL DEFAULT 2000);
 CREATE TABLE IF NOT EXISTS pb_dci_sandbox_events(id TEXT PRIMARY KEY,name TEXT NOT NULL,original_date TEXT NOT NULL,lineup_json TEXT NOT NULL,source_url TEXT NOT NULL,markets_json TEXT NOT NULL,results_json TEXT NOT NULL,created_ts INTEGER NOT NULL DEFAULT (unixepoch()));
`);}
function log(db,kind,status,details){db.prepare('INSERT INTO pb_dci_sync_log(kind,status,details) VALUES(?,?,?)').run(kind,status,String(details||'').slice(0,3000));}
function stamp(db,key){db.prepare('INSERT INTO pb_dci_sync_state(key,last_ts) VALUES(?,unixepoch()) ON CONFLICT(key) DO UPDATE SET last_ts=excluded.last_ts').run(key);}
function allowRefresh(db,key,period){const last=db.prepare('SELECT last_ts FROM pb_dci_sync_state WHERE key=?').get(key)?.last_ts||0;return NOW()-last>=period;}
function acquireLock(db,key,lease=1800){const token=crypto.randomBytes(16).toString('hex');
  const update=db.prepare('INSERT INTO pb_dci_sync_locks(key,token,expires_ts) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET token=excluded.token,expires_ts=excluded.expires_ts WHERE pb_dci_sync_locks.expires_ts<unixepoch()').run(key,token,NOW()+lease);
  return update.changes?token:null;
}
function releaseLock(db,key,token){db.prepare('DELETE FROM pb_dci_sync_locks WHERE key=? AND token=?').run(key,token);}
async function discover(db,{dryRun=false,year=new Date().getUTCFullYear(),limit=150}={}){
  const schedule=await scheduleLinks({year,limit});
  const links=schedule.links;let imported=0,marketCount=0,missingLineups=0;const errors=[];
  for(const url of links){
    try {
      if(!dryRun){
        const prev=db.prepare('SELECT start_ts,status FROM pb_betting_events WHERE id=?').get('dci_'+eventSlug(url));
        if(prev && (['completed','canceled'].includes(prev.status)||prev.start_ts<NOW()-2*86400))continue;
      }
      const ev=parseEventPage(await fetchOfficial(url),url);
      if(!ev?.start_ts||!ev.date){errors.push(`${eventSlug(url)}: ${ev?.warning||'invalid event date'}`);continue;}
      const id='dci_'+ev.slug;
      if(dryRun){imported++;continue;}
      const old=db.prepare('SELECT start_ts,status FROM pb_betting_events WHERE id=?').get(id);
      const hasBets=db.prepare('SELECT 1 FROM pb_betting_bets b JOIN pb_betting_markets m ON m.id=b.market_id WHERE m.event_id=? LIMIT 1').get(id);
      if(old && old.start_ts!==ev.start_ts && (hasBets||old.start_ts-86400<=NOW())){
        errors.push(`${ev.slug}: event time changed after markets opened/bets; admin review`);continue;
      }
      if(old?.status==='completed'||old?.status==='canceled')continue;
      db.transaction(()=>{
        db.prepare(`INSERT INTO pb_betting_events(id,name,start_ts,season,status,source_url)
          VALUES(?,?,?,?,'scheduled',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,start_ts=excluded.start_ts,source_url=excluded.source_url,updated_ts=unixepoch()`)
          .run(id,ev.name,ev.start_ts,ev.season,url);
        db.prepare(`INSERT INTO pb_dci_event_sources(event_id,source_url,lineup_json,timezone)
          VALUES(?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET lineup_json=CASE WHEN excluded.lineup_json='[]' THEN pb_dci_event_sources.lineup_json ELSE excluded.lineup_json END,source_url=excluded.source_url,timezone=excluded.timezone,updated_ts=unixepoch()`)
          .run(id,url,JSON.stringify(ev.lineup),ev.timezone);
        db.prepare(`INSERT INTO pb_dci_event_dates(event_id,local_date,timezone) VALUES(?,?,?) ON CONFLICT(event_id) DO UPDATE SET local_date=excluded.local_date,timezone=excluded.timezone`).run(id,ev.date,ev.timezone);
      })();
      imported++;
      if(!ev.lineup.length)missingLineups++;
      // Produce markets before the 24-hour opening window; never move published lines.
      if(ev.lineup.length && ev.start_ts-86400>NOW()){
        const mk=lines.makeMarkets({eventId:id,startTs:ev.start_ts,season:ev.season,lineup:ev.lineup,db,eventDate:ev.date});
        marketCount+=lines.saveMarkets(db,{id},mk).inserted;
      }
      if(ev.warning && ev.lineup.length)errors.push(`${ev.slug}: ${ev.warning}`);
    }catch(e){errors.push(`${eventSlug(url)}: ${e.message}`);}
  }
  const warning=schedule.warning||undefined;
  const summary={year,found:links.length,imported,markets:marketCount,missingLineups,source:schedule.source,warning,errors};
  log(db,'events',!links.length||errors.length||warning?'warning':'ok',JSON.stringify({...summary,errors:errors.slice(0,8)}));
  if(!dryRun)stamp(db,`events:${year}`);
  return summary;
}
function storeVerified(db,ev,results){
  let count=0;const slug=eventSlug(ev.source_url),meta=db.prepare('SELECT local_date FROM pb_dci_event_dates WHERE event_id=?').get(ev.id);
  if(!meta)return 0;
  const stmt=db.prepare(`INSERT INTO pb_dci_verified_scores(event_slug,season,date,event_name,corps,corps_key,cls,total,groups_json,captions_json,source_url)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_slug,cls,corps_key) DO UPDATE SET total=excluded.total,groups_json=excluded.groups_json,captions_json=excluded.captions_json,verified_ts=unixepoch()`);
  for(const r of results){
    const old=db.prepare('SELECT total FROM pb_dci_verified_scores WHERE event_slug=? AND cls=? AND corps_key=?').get(slug,r.cls,lines.canonicalCorps(r.corps));
    if(old&&Math.abs(old.total-r.total)>0.001 &&
      db.prepare(`SELECT 1 FROM pb_betting_markets WHERE event_id=? AND status='settled' AND corps=? LIMIT 1`).get(ev.id,r.corps)){
      log(db,'scores','warning',`${slug}: ${r.corps} published score changed after settlement; manual reconciliation required`);continue;
    }
    stmt.run(slug,ev.season,meta.local_date,ev.name,r.corps,lines.canonicalCorps(r.corps),r.cls,r.total,JSON.stringify(r.groups),JSON.stringify(r.captions),`${ROOT}/scores/recap/${slug}/`);count++;
  }
  return count;
}
function settleVerifiedMarkets(db,ev,results){
  const index=new Map(results.map(r=>[lines.canonicalCorps(r.corps),r]));
  const source=db.prepare('SELECT lineup_json FROM pb_dci_event_sources WHERE event_id=?').get(ev.id);
  const eventLineup=source?JSON.parse(source.lineup_json):[];
  let settled=0,betsPaid=0,payoutGems=0,unresolved=0;
  const meta=db.prepare('SELECT local_date FROM pb_dci_event_dates WHERE event_id=?').get(ev.id);
  if(!meta)return {settled,betsPaid,payoutGems,unresolved:0};
  const marketRows=db.prepare(`SELECT * FROM pb_betting_markets WHERE event_id=? AND status='active'`).all(ev.id);
  for(const m of marketRows){
    const r=index.get(lines.canonicalCorps(m.corps));
    if(!r){unresolved++;continue;}
    const confirmedLineup=eventLineup.find(x=>lines.canonicalCorps(x.corps)===lines.canonicalCorps(m.corps));
    if(!confirmedLineup||confirmedLineup.cls!==r.cls){unresolved++;continue;}
    let actual=m.caption==='Overall'?r.total:r.groups[m.caption]??r.captions[m.caption];
    if(!Number.isFinite(actual)){unresolved++;continue;}
    if(m.kind==='change'){
      const prev=lines.getPreviousScore(db,{season:ev.season,cls:r.cls,corps:r.corps,date:meta.local_date});
      const p=prev?lines.metricValue(prev,m.caption):null;
      if(!Number.isFinite(p)){unresolved++;continue;}
      actual=Math.round((actual-p)*1000000)/1000000;
    }
    // This atomic transaction makes repeated polling harmless and each ledger entry idempotent.
    db.transaction(()=>{
      const claimed=db.prepare("UPDATE pb_betting_markets SET status='settled',actual=? WHERE id=? AND status='active'").run(actual,m.id);
      if(claimed.changes!==1)return;
      const bets=db.prepare("SELECT * FROM pb_betting_bets WHERE market_id=? AND result='pending'").all(m.id);
      for(const b of bets){
        const outcome=Math.abs(actual-b.line)<0.0000001?'push':(actual>b.line?'over':'under')===b.choice?'won':'lost';
        const payout=outcome==='won'?Math.round(b.stake*b.odds):outcome==='push'?b.stake:0;
        const done=db.prepare("UPDATE pb_betting_bets SET result=?,payout=? WHERE id=? AND result='pending'").run(outcome,payout,b.id);
        if(done.changes!==1)continue;
        if(payout){db.prepare('INSERT OR IGNORE INTO pb_betting_wallets(user_id,balance) VALUES (?,200)').run(b.user_id);
          db.prepare('UPDATE pb_betting_wallets SET balance=balance+? WHERE user_id=?').run(payout,b.user_id);
          db.prepare('INSERT INTO pb_betting_ledger(user_id,bet_id,delta,reason) VALUES(?,?,?,?)').run(b.user_id,b.id,payout,outcome);
          betsPaid++;payoutGems+=payout;
        }
      }
      settled++;
    })();
  }
  return {settled,betsPaid,payoutGems,unresolved};
}
async function checkScores(db,{dryRun=false}={}){
  const now=NOW();
  const events=db.prepare(`SELECT * FROM pb_betting_events WHERE status='scheduled' AND start_ts<=? AND start_ts>? AND source_url LIKE 'https://www.dci.org/%' ORDER BY start_ts LIMIT 60`).all(now,now-45*86400);
  const settlementEnabled=process.env.DCI_AUTO_SETTLE_ENABLED==='true';
  let checked=0,matched=0,verified=0,settled=0,betsPaid=0,payoutGems=0;const errors=[];
  for(const ev of events){
    checked++;const slug=eventSlug(ev.source_url);
    try {
      const html=await fetchOfficial(`${ROOT}/scores/final-scores/${slug}/`);
      const standings=scoreEntries(html);
      const recapHtml=await fetchOfficial(`${ROOT}/scores/recap/${slug}/`);
      const expected=db.prepare('SELECT local_date FROM pb_dci_event_dates WHERE event_id=?').get(ev.id)?.local_date;
      const recap=parseRecap(recapHtml,{slug,expectedDate:expected});
      if(!standings.length||!recap.length){errors.push(`${slug}: incomplete standings or detailed recap; not settled`);continue;}
      matched++;
      const scoreIndex=new Map(standings.map(s=>[s.cls+'|'+lines.canonicalCorps(s.corps),s.score]));
      const agreed=recap.filter(r=>Math.abs((scoreIndex.get(r.cls+'|'+lines.canonicalCorps(r.corps))??-999)-r.total)<0.001);
      if(!agreed.length){errors.push(`${slug}: recap and final scores disagree; no payouts`);continue;}
      verified+=agreed.length;
      if(dryRun)continue;
      const out=db.transaction(()=>{
        storeVerified(db,ev,agreed);
        const results=settlementEnabled?settleVerifiedMarkets(db,ev,agreed):{settled:0,betsPaid:0,payoutGems:0};
        const remaining=db.prepare("SELECT count(*) AS n FROM pb_betting_markets WHERE event_id=? AND status='active'").get(ev.id).n;
        if(!remaining)db.prepare("UPDATE pb_betting_events SET status='completed' WHERE id=?").run(ev.id);
        return results;
      })();
      settled+=out.settled;betsPaid+=out.betsPaid;payoutGems+=out.payoutGems;
    }catch(e){errors.push(`${slug}: ${e.message}`);}
  }
  const summary={checked,matched,verified,settled,betsPaid,payoutGems,settlementEnabled,errors};
  log(db,'scores',errors.length?'warning':'ok',JSON.stringify({...summary,errors:errors.slice(0,8)}));
  if(!dryRun)stamp(db,'scores');return summary;
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
module.exports={init,discover,checkScores,replay,sandboxWallet,sandboxBet,replaySettle,parseEventPage,scoreEntries,parseRecap,collectEventUrls,allowRefresh,log,stamp,fetchOfficial,scheduleLinks,acquireLock,releaseLock,settleVerifiedMarkets};
