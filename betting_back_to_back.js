'use strict';
// Per-market previous-day score gate for Pressboxd. Mount BEFORE mountBetting.
const crypto = require('crypto');
const model = require('./betting_lines');
const sync = require('./dci_sync');
const { openingForEvent } = require('./betting_window');
const judgeScores = require('./betting_caption_scores');
const DAY = 86400;
const PREFIX = /^Matchup vs\s+/i;
const key = s => model.canonicalCorps(s);
const nowTs = () => Math.floor(Date.now()/1000);
function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pb_betting_previous_day_releases (
    market_id TEXT PRIMARY KEY, event_id TEXT NOT NULL, dependency_key TEXT NOT NULL,
    released_ts INTEGER NOT NULL, line REAL NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_pb_previous_day_event ON pb_betting_previous_day_releases(event_id);`);
}
function previousDate(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day||'')) return null;
  const t=Date.parse(day+'T12:00:00Z');
  return Number.isFinite(t)?new Date(t-DAY*1000).toISOString().slice(0,10):null;
}
function parseLineup(raw) {
  try { const a=JSON.parse(raw||'[]'); return Array.isArray(a)?a.map(x=>typeof x==='string'?{corps:x,cls:''}:x).filter(x=>x?.corps):[]; }
  catch { return []; }
}
function slugOf(row) {
  try { const u=new URL(row.source_url); if(['dci.org','www.dci.org'].includes(u.hostname))return u.pathname.split('/').filter(Boolean).pop(); } catch {}
  return /^dci_20\d\d-/.test(row.id||'')?row.id.slice(4):null;
}
function context(db,event) {
  const day=event.local_date||db.prepare('SELECT local_date FROM pb_dci_event_dates WHERE event_id=?').get(event.id)?.local_date;
  const prev=previousDate(day), dependencies=new Map(), actuals=new Map();
  if(!prev)return {event,day,dependencies,actuals};
  // Exact event, class and corps are required. An unrelated score on the same date is not enough.
  const prior=db.prepare(`SELECT e.id,e.source_url,s.lineup_json FROM pb_betting_events e
    JOIN pb_dci_event_dates d ON d.event_id=e.id
    LEFT JOIN pb_dci_event_sources s ON s.event_id=e.id
    WHERE e.id<>? AND e.season=? AND e.status<>'canceled' AND d.local_date=?`).all(event.id,event.season,prev);
  const add=(corps,dep)=>{const k=key(corps);if(!k)return;if(!dependencies.has(k))dependencies.set(k,[]);
    const a=dependencies.get(k);if(!a.some(x=>x.slug===dep.slug&&x.cls===dep.cls&&x.id===dep.id))a.push(dep);};
  for(const p of prior)for(const c of parseLineup(p.lineup_json))add(c.corps,{slug:slugOf(p),cls:String(c.cls||''),id:p.id});
  const verified=db.prepare(`SELECT event_slug,corps,corps_key,cls,total,groups_json,captions_json FROM pb_dci_verified_scores WHERE season=? AND date=?`).all(event.season,prev);
  for(const s of verified){
    const k=key(s.corps_key||s.corps);
    let row;try{row={...s,groups:JSON.parse(s.groups_json),captions:JSON.parse(s.captions_json)};}catch{continue;}
    if(!actuals.has(k))actuals.set(k,[]);actuals.get(k).push(row);
    // Verified result may be present even if an older event's lineup is unavailable.
    if(!(dependencies.get(k)||[]).some(x=>x.slug===s.event_slug))add(s.corps_key||s.corps,{slug:s.event_slug,cls:s.cls,id:'dci_'+s.event_slug});
  }
  return {event,day,dependencies,actuals};
}
function participants(m) {
  const list=[{corps:m.corps,metric:PREFIX.test(m.caption)?'Overall':m.caption}];
  if(PREFIX.test(m.caption))list.push({corps:String(m.caption).replace(PREFIX,''),metric:'Overall'});
  return list;
}
function requirements(ctx,m) {
  const deps=[]; let ready=true;
  for(const p of participants(m)){
    const k=key(p.corps);
    for(const d of ctx.dependencies.get(k)||[]){
      deps.push([k,d.slug||d.id,d.cls]);
      const matches=(ctx.actuals.get(k)||[]).filter(x=>d.slug&&x.event_slug===d.slug&&(!d.cls||x.cls===d.cls));
      // Incomplete recaps cannot unlock a missing caption. Overall must exist too.
      if(matches.length!==1||!Number.isFinite(matches[0].total)||!Number.isFinite(model.metricValue(matches[0],p.metric)))ready=false;
    }
  }
  if(!deps.length)return {waiting:false,ready:true,signature:null};
  deps.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {waiting:true,ready,signature:crypto.createHash('sha256').update(JSON.stringify(deps)).digest('hex')};
}
function releaseExists(db,m,r) {
  if(!r.waiting)return true;
  if(!r.ready)return false;
  const row=db.prepare('SELECT dependency_key,line FROM pb_betting_previous_day_releases WHERE market_id=?').get(m.id);
  return row?.dependency_key===r.signature&&Number(row.line)===Number(m.line);
}
function lineToken(m,r) {
  return crypto.createHash('sha256').update(JSON.stringify([m.id,m.corps,m.caption,m.kind,m.line,m.odds,r.signature])).digest('hex');
}
function marketKey(m) {
  if(PREFIX.test(m.caption))return 'pair|'+[key(m.corps),key(String(m.caption).replace(PREFIX,''))].sort().join('|');
  return key(m.corps)+'|'+String(m.caption).toLowerCase()+'|'+m.kind;
}
function eventRow(db,id) {
  return db.prepare(`SELECT e.*,d.local_date,s.lineup_json FROM pb_betting_events e
    LEFT JOIN pb_dci_event_dates d ON d.event_id=e.id
    LEFT JOIN pb_dci_event_sources s ON s.event_id=e.id WHERE e.id=?`).get(id);
}
function eventOpen(db,e,now) {
  return !!e&&e.status==='scheduled'&&e.start_ts!=null&&now<e.start_ts&&now>=openingForEvent(db,e);
}
function judgeMarket(m){return judgeScores.isJudgeCaption(m.caption);}
function hasWager(db,id){return !!db.prepare(`SELECT 1 FROM pb_betting_bets WHERE market_id=?
  UNION ALL SELECT 1 FROM pb_betting_entry_legs WHERE market_id=? LIMIT 1`).get(id,id);}
function refreshEvent(db,id,now=nowTs()) {
  // The write transaction covers score reads, projection creation, market changes,
  // matchup metadata, and the release marker. No partial release is observable.
  return db.transaction(()=>{
    const e=eventRow(db,id);if(!eventOpen(db,e,now))return 0;
    const ctx=context(db,e),lineup=parseLineup(e.lineup_json).filter(x=>x.cls);
    if(!lineup.length||!ctx.day||!ctx.dependencies.size)return 0;
    const affected=lineup.filter(c=>ctx.dependencies.has(key(c.corps)));
    if(!affected.length)return 0;
    const current=db.prepare('SELECT * FROM pb_betting_markets WHERE event_id=?').all(id);
    const existing=new Map(current.map(m=>[marketKey(m),m]));
    const readyCorps=affected.filter(c=>requirements(ctx,{corps:c.corps,caption:'Overall'}).ready);
    if(!readyCorps.length)return 0;
    // Avoid expensive re-projections on ordinary page loads. After a successful
    // attempt the score contents and schedule fingerprint are recorded; retries
    // happen when those inputs change (or after 5 min if a caption was missing).
    const snapshot=JSON.stringify({deps:[...ctx.dependencies.entries()],scores:[...ctx.actuals.entries()].map(([k,v])=>[k,v.map(r=>[r.event_slug,r.cls,r.total,r.groups_json,r.captions_json])]),lineup});
    const hash=crypto.createHash('sha256').update(snapshot).digest('hex');
    db.exec(`CREATE TABLE IF NOT EXISTS pb_betting_previous_day_attempts(event_id TEXT PRIMARY KEY,input_key TEXT NOT NULL,attempted_ts INTEGER NOT NULL)`);
    const attempt=db.prepare('SELECT * FROM pb_betting_previous_day_attempts WHERE event_id=?').get(id);
    if(attempt?.input_key===hash&&now-attempt.attempted_ts<300)return 0;
    const projection=model.makeMarkets({eventId:id,startTs:e.start_ts,season:e.season,lineup,db,eventDate:ctx.day})
      .filter(m=>!judgeMarket(m)&&Number.isFinite(m.line));
    // A matchup uses the updated overall for the returning corps and the already
    // posted overall for a rested corps, if its line has opened. Do not move the
    // rested corps' other public lines. Preserve existing class restrictions.
    let fresh=projection.filter(m=>!PREFIX.test(m.caption));
    const overalls=fresh.filter(m=>m.caption==='Overall'&&m.kind==='absolute').map(m=>{
      const old=existing.get(marketKey(m));const r=requirements(ctx,m);
      return old?.status==='active'&&(!r.waiting||releaseExists(db,old,r))?{...m,line:old.line}:m;
    });
    let pairs=projection.filter(m=>PREFIX.test(m.caption));
    if(pairs.length){const matchups=require('./betting_matchups');pairs=matchups.pairMarkets(id,overalls,lineup);}
    fresh=fresh.concat(pairs);
    const mark=db.prepare(`INSERT INTO pb_betting_previous_day_releases(market_id,event_id,dependency_key,released_ts,line)
      VALUES(?,?,?,?,?) ON CONFLICT(market_id) DO UPDATE SET dependency_key=excluded.dependency_key,released_ts=excluded.released_ts,line=excluded.line`);
    const update=db.prepare(`UPDATE pb_betting_markets SET corps=?,caption=?,line=?,odds=? WHERE id=? AND status='active'
      AND NOT EXISTS(SELECT 1 FROM pb_betting_bets WHERE market_id=pb_betting_markets.id)
      AND NOT EXISTS(SELECT 1 FROM pb_betting_entry_legs WHERE market_id=pb_betting_markets.id)`);
    let released=0;
    for(const p of fresh){
      const r=requirements(ctx,p);if(!r.waiting||!r.ready)continue;
      // A matchup cannot release until both required overall projections exist.
      if(PREFIX.test(p.caption)&&participants(p).some(x=>!overalls.some(o=>key(o.corps)===key(x.corps))))continue;
      const old=existing.get(marketKey(p));
      if(old){
        if(old.status!=='active'||releaseExists(db,old,r)||hasWager(db,old.id))continue;
        if(update.run(p.corps,p.caption,p.line,p.odds,old.id).changes!==1)continue;
        if(p.matchup){
          require('./betting_matchups').init(db);
          db.prepare(`INSERT INTO pb_betting_matchups(market_id,event_id,favorite,opponent,class_name,opponent_class)
            VALUES(?,?,?,?,?,?) ON CONFLICT(market_id) DO UPDATE SET favorite=excluded.favorite,opponent=excluded.opponent,
            class_name=excluded.class_name,opponent_class=excluded.opponent_class`).run(old.id,id,p.matchup.favorite,p.matchup.opponent,p.matchup.cls,p.matchup.opponentCls);
        }
        mark.run(old.id,id,r.signature,now,p.line);released++;
      }else{
        // Keep original IDs and metadata hooks from the installed betting model.
        model.saveMarkets(db,e,[p]);
        const saved=db.prepare('SELECT * FROM pb_betting_markets WHERE id=?').get(p.id);
        if(saved?.status!=='active'||saved.line!==p.line||hasWager(db,saved.id))continue;
        mark.run(saved.id,id,r.signature,now,saved.line);released++;
      }
    }
    db.prepare(`INSERT INTO pb_betting_previous_day_attempts(event_id,input_key,attempted_ts) VALUES(?,?,?)
      ON CONFLICT(event_id) DO UPDATE SET input_key=excluded.input_key,attempted_ts=excluded.attempted_ts`).run(id,hash,now);
    return released;
  }).immediate();
}
function refreshUpcoming(db,now=nowTs()) {
  init(db);let released=0;
  // A previous-day performance cannot have taken place more than 48h before
  // the second competition. Include manually opened events as well.
  const events=db.prepare(`SELECT e.* FROM pb_betting_events e WHERE e.status='scheduled' AND e.start_ts>?
    AND (e.start_ts<=? OR EXISTS(SELECT 1 FROM pb_betting_manual_open o WHERE o.event_id=e.id))`).all(now,now+2*DAY);
  for(const e of events){try{released+=refreshEvent(db,e.id,now);}catch(err){console.error('[Previous-day betting]',e.id,err.message);}}
  return released;
}
function boardState(db,markets,events,now=nowTs()) {
  const contexts=new Map(); const get=id=>{if(!contexts.has(id)){const e=eventRow(db,id);contexts.set(id,e?context(db,e):null);}return contexts.get(id);};
  const tokens=Object.create(null);
  const allowed=markets.filter(m=>{const c=get(m.event_id);if(!c||judgeMarket(m))return false;
    const r=requirements(c,m);if(!releaseExists(db,m,r))return false;
    if(r.waiting)tokens[m.id]=lineToken(m,r);return true;});
  const allowedIds=new Set(allowed.map(m=>m.id));
  const available=new Set(allowed.filter(m=>m.caption==='Overall'&&m.kind==='absolute').map(m=>m.event_id+'|'+key(m.corps)));
  const waits={};
  for(const e of events){if(!eventOpen(db,e,now))continue;const c=get(e.id);if(!c)continue;
    const waiting=parseLineup(e.lineup_json||JSON.stringify(e.lineup||[])).filter(x=>c.dependencies.has(key(x.corps))&&!available.has(e.id+'|'+key(x.corps))).map(x=>x.corps);
    const partial=markets.filter(m=>m.event_id===e.id&&!judgeMarket(m)&&!allowedIds.has(m.id)).flatMap(m=>participants(m).filter(p=>c.dependencies.has(key(p.corps))).map(p=>p.corps));
    const names=[...new Set([...waiting,...partial])];if(names.length)waits[e.id]={name:e.name,corps:names};
  }
  return {allowed,waits,tokens};
}
function assertPick(db,id,now=nowTs(),token,requireToken=false) {
  const m=db.prepare('SELECT * FROM pb_betting_markets WHERE id=?').get(String(id||''));
  if(!m||judgeMarket(m))throw Error('Market unavailable. Refresh the betting board.');
  const e=eventRow(db,m.event_id);if(!eventOpen(db,e,now)||m.status!=='active')throw Error('Market is closed. Refresh the betting board.');
  const r=requirements(context(db,e),m);
  if(!releaseExists(db,m,r))throw Error('Previous-day scores or refreshed projections are still pending. Refresh the betting board.');
  if(r.waiting&&requireToken&&token!==lineToken(m,r))throw Error('This line has been refreshed after the previous competition. Refresh the betting board before submitting.');
}
function attachNotice(html,waits,tokens){
  if(typeof html!=='string'||(!Object.keys(waits).length&&!Object.keys(tokens).length))return html;
  const encode=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  const safe=encode(waits),safeTokens=encode(tokens);
  return html.replace(/<\/body>/i,`<script>(()=>{const waits=${safe},tokens=${safeTokens};
    // Bind submitted picks to the line displayed on this page, including the
    // favorite/opponent direction. Older tabs cannot silently submit stale odds.
    if(Object.keys(tokens).length){const original=window.fetch;window.fetch=function(resource,init){
      try{const url=new URL(typeof resource==='string'?resource:resource.url,location.href);
        if(url.origin===location.origin&&['/api/betting/bets','/api/betting/entries'].includes(url.pathname)&&String(init?.method||'').toUpperCase()==='POST'&&typeof init.body==='string'){
          const data=JSON.parse(init.body);const sign=p=>{if(p&&Object.hasOwn(tokens,p.market_id))p._pb_line_token=tokens[p.market_id];};
          if(url.pathname.endsWith('/bets'))sign(data);else for(const entry of data.entries||[])for(const p of entry.picks||[])sign(p);
          return original.call(this,resource,{...init,body:JSON.stringify(data)});
        }
      }catch(err){}return original.apply(this,arguments);};}
    const tabs=document.getElementById('eventTabs');if(!tabs||!Object.keys(waits).length)return;
    const note=document.createElement('p');note.style.cssText='margin:12px 0;color:#e4ba72;font-size:13px;line-height:1.5';note.setAttribute('role','status');
    const target=document.getElementById('selectedEventLineup')||tabs;target.insertAdjacentElement('afterend',note);
    function show(){const id=tabs.querySelector('button.on[data-id]')?.dataset.id||'all';const entries=id==='all'?Object.values(waits):waits[id]?[waits[id]]:[];note.hidden=!entries.length;note.textContent=entries.length?'Awaiting previous-day scores or updated projections: '+entries.map(x=>(id==='all'?x.name+': ':'')+x.corps.join(', ')).join(' | ')+'. Other eligible markets are open. Refresh this page for new lines.':'';}
    tabs.addEventListener('click',()=>queueMicrotask(show));show();})();</script>\n</body>`);
}
let hooked=false;
function mount(app,getConn){
  if(!hooked){hooked=true;const original=sync.checkScores;sync.checkScores=async function(db,options){const result=await original.call(this,db,options);
    if(!options?.dryRun){try{result.previousDayReleased=refreshUpcoming(db);}catch(err){console.error('[Previous-day betting] score refresh',err.message);}}return result;};}
  // Must be registered before the existing betting routes. The original route
  // still enforces authentication, wallet balance, opening/closing, and payouts.
  app.use((req,res,next)=>{
    if(!req.session?.uid)return next();
    if(req.method==='POST'&&['/api/betting/bets','/api/betting/entries'].includes(req.path)){
      let db;try{db=getConn();init(db);
        const picks=req.path.endsWith('/bets')?[req.body]:(Array.isArray(req.body?.entries)?req.body.entries.flatMap(e=>Array.isArray(e?.picks)?e.picks:[]):[]);
        if(picks.length>600)throw Error('Too many picks.');for(const p of picks)assertPick(db,p?.market_id,nowTs(),p?._pb_line_token,true);
      }catch(err){return res.status(400).json({error:err.message});}finally{if(db)db.close();}
    }
    if(req.method==='GET'&&req.path==='/betting'){
      let db;try{db=getConn();refreshUpcoming(db);}catch(err){console.error('[Previous-day betting] board refresh',err.message);}finally{if(db)db.close();}
      const render=res.render.bind(res),send=res.send.bind(res);let waits={},tokens={};
      res.send=function(body){return send(attachNotice(body,waits,tokens));};
      res.render=function(view,options,callback){if(view!=='betting'||!Array.isArray(options?.markets))return render(view,options,callback);
        let conn;try{conn=getConn();init(conn);const s=boardState(conn,options.markets,options.events||[],options.now||nowTs());waits=s.waits;tokens=s.tokens;return render(view,{...options,markets:s.allowed},callback);}
        catch(err){console.error('[Previous-day betting] filter',err.message);return render(view,{...options,markets:[]},callback);}finally{if(conn)conn.close();}
      };
    }
    next();
  });
}
module.exports={mount,init,context,requirements,releaseExists,refreshEvent,refreshUpcoming,boardState,assertPick,marketKey,previousDate,attachNotice};
