'use strict';
// Pressboxd DCI head-to-head spreads.
// Loads from gems.js before betting.js; shares existing market, parlay and wallet tables.
// A favorite -4.525 selection wins if its final score exceeds its opponent by >4.525.
const crypto = require('crypto');
const lines = require('./betting_lines');
const dci = require('./dci_sync');
const parlays = require('./betting_parlays');
const CAPTION_PREFIX = 'Matchup vs ';
let installed = false;

function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pb_betting_matchups (
      market_id TEXT PRIMARY KEY REFERENCES pb_betting_markets(id),
      event_id TEXT NOT NULL,
      favorite TEXT NOT NULL,
      opponent TEXT NOT NULL,
      class_name TEXT NOT NULL,
      opponent_class TEXT,
      created_ts INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_pb_betting_matchups_event
      ON pb_betting_matchups(event_id);
  `);
  // Upgrade installations that already have the original head-to-head table.
  const cols=db.prepare('PRAGMA table_info(pb_betting_matchups)').all().map(x=>x.name);
  if(!cols.includes('opponent_class')) db.exec('ALTER TABLE pb_betting_matchups ADD COLUMN opponent_class TEXT');
}
function canonical(name) { return lines.canonicalCorps(String(name || '')); }
function classGroup(cls) {
  const name=String(cls||'').trim().toLowerCase().replace(/[\s_-]+/g,'');
  if(name.includes('soundsport'))return 'soundsport';
  if(name.includes('allage'))return 'all-age';
  if(name==='world'||name==='worldclass'||name==='open'||name==='openclass')return 'world-open';
  return ''; // Do not cross unknown classes.
}
function marketId(eventId, cls, a, b) {
  const pair = [canonical(a), canonical(b)].sort();
  return 'h2h_' + crypto.createHash('sha256')
    .update([eventId, cls, ...pair].join('|')).digest('hex').slice(0, 24);
}
function pairMarkets(eventId, originals, lineup) {
  // Use the existing model's OVERALL projections, not invented betting odds.
  const classByCorps = new Map();
  for(const item of (lineup || [])) {
    if(!item || typeof item !== 'object' || !item.corps || !item.cls) continue;
    classByCorps.set(canonical(item.corps), String(item.cls));
  }
  const overall = originals.filter(m =>
    m.kind === 'absolute' && m.caption === 'Overall' &&
    Number.isFinite(m.line) && classByCorps.has(canonical(m.corps))
  );
  const out=[];
  for(let i=0;i<overall.length;i++)for(let j=i+1;j<overall.length;j++) {
    const left=overall[i],right=overall[j];
    const cls=classByCorps.get(canonical(left.corps));
    const otherCls=classByCorps.get(canonical(right.corps));
    if(!classGroup(cls)||classGroup(cls)!==classGroup(otherCls))continue;
    if(canonical(left.corps)===canonical(right.corps))continue;
    // Each listed pair is offered once, with the model-favored corps first.
    const favorite = left.line >= right.line ? left : right;
    const other = favorite===left ? right : left;
    const spread = Math.round(Math.abs(left.line-right.line)/0.025)*0.025;
    const line = Math.round(spread*1000)/1000;
    // Retain IDs of existing same-class matchups to avoid double listings.
    const matchupId = marketId(eventId,cls===otherCls?cls:'World+Open',left.corps,right.corps);
    out.push({
      id:matchupId,corps:favorite.corps,caption:CAPTION_PREFIX+other.corps,
      kind:'absolute',line,odds:1.90,
      matchup:{favorite:favorite.corps,opponent:other.corps,
        cls:classByCorps.get(canonical(favorite.corps)),
        opponentCls:classByCorps.get(canonical(other.corps))}
    });
  }
  return out;
}
function saveMetadata(db,event,markets) {
  init(db);
  const stmt=db.prepare(`INSERT INTO pb_betting_matchups
    (market_id,event_id,favorite,opponent,class_name,opponent_class)
    VALUES(?,?,?,?,?,?) ON CONFLICT(market_id) DO UPDATE SET
    opponent_class=COALESCE(pb_betting_matchups.opponent_class,excluded.opponent_class)`);
  for(const m of markets) {
    if(!m.matchup)continue;
    stmt.run(m.id,event.id,m.matchup.favorite,m.matchup.opponent,
      m.matchup.cls,m.matchup.opponentCls);
  }
}
function backfillUpcoming(db) {
  init(db);
  const now=Math.floor(Date.now()/1000);
  const events=db.prepare(`SELECT e.*,d.local_date,s.lineup_json
    FROM pb_betting_events e
    JOIN pb_dci_event_sources s ON s.event_id=e.id
    LEFT JOIN pb_dci_event_dates d ON d.event_id=e.id
    WHERE e.status='scheduled' AND e.start_ts>? AND
          e.source_url LIKE 'https://www.dci.org/%'
    ORDER BY e.start_ts LIMIT 250`).all(now);
  let created=0,checked=0;
  for(const event of events){
    let lineup;
    try{ lineup=JSON.parse(event.lineup_json||'[]'); }catch{continue;}
    if(!Array.isArray(lineup)||lineup.length<2)continue;
    // INSERT OR IGNORE adds only newly allowed World/Open pairs, preserving
    // the lines and IDs of every market already on the board.
    try {
      const markets=lines.makeMarkets({
        eventId:event.id,startTs:event.start_ts,season:event.season,
        lineup:lineup.filter(x=>x&&x.cls),db,eventDate:event.local_date||undefined
      }).filter(m=>m.matchup);
      if(!markets.length)continue;
      const result=lines.saveMarkets(db,event,markets);
      created+=result.inserted; checked++;
    }catch(error){
      console.error('[GEM Matchups] Event backfill:',event.id,error.message);
    }
  }
  return {events:checked,created};
}
function eventSlug(url){
  try{
    const u=new URL(url);
    if(u.hostname!=='www.dci.org'&&u.hostname!=='dci.org')return null;
    return u.pathname.split('/').filter(Boolean).pop()||null;
  }catch{return null;}
}
// Uses verified scores from the same event, matching each corps to its own class.
function settleVerified(db) {
  init(db);
  const candidates=db.prepare(`SELECT m.id,m.event_id,m.line,m.actual,m.status,
      x.favorite,x.opponent,x.class_name,x.opponent_class,e.season,e.source_url
    FROM pb_betting_matchups x
    JOIN pb_betting_markets m ON m.id=x.market_id
    JOIN pb_betting_events e ON e.id=m.event_id
    WHERE m.status='active' AND e.start_ts<=unixepoch()
    ORDER BY e.start_ts,m.id LIMIT 3000`).all();
  const scoreStmt=db.prepare(`SELECT corps_key,total,cls FROM pb_dci_verified_scores
    WHERE event_slug=? AND season=?`);
  const cache=new Map(),changedEvents=new Set();
  let markets=0,bets=0,gems=0;
  const tx=db.transaction(()=>{
    for(const m of candidates){
      const slug=eventSlug(m.source_url);
      if(!slug)continue;
      const key=[slug,m.season].join('|');
      if(!cache.has(key)){
        const rows=scoreStmt.all(slug,m.season);
        cache.set(key,new Map(rows.map(r=>[r.cls+'|'+r.corps_key,Number(r.total)])));
      }
      const scores=cache.get(key);
      const a=scores.get(m.class_name+'|'+canonical(m.favorite));
      const b=scores.get((m.opponent_class||m.class_name)+'|'+canonical(m.opponent));
      if(!Number.isFinite(a)||!Number.isFinite(b))continue;
      const difference=Math.round((a-b)*1000)/1000;
      if(db.prepare(`UPDATE pb_betting_markets
           SET status='settled',actual=? WHERE id=? AND status='active'`)
           .run(difference,m.id).changes!==1)continue;
      changedEvents.add(m.event_id);markets++;
      const placed=db.prepare(`SELECT id,user_id,stake,line,odds,choice
        FROM pb_betting_bets WHERE market_id=? AND result='pending'`).all(m.id);
      for(const bet of placed){
        const outcome=Math.abs(difference-bet.line)<0.0000001?'push':
          ((difference>bet.line?'over':'under')===bet.choice?'won':'lost');
        const payout=outcome==='won'?Math.round(bet.stake*bet.odds):
          outcome==='push'?bet.stake:0;
        if(db.prepare(`UPDATE pb_betting_bets SET result=?,payout=?
              WHERE id=? AND result='pending'`).run(outcome,payout,bet.id).changes!==1)continue;
        bets++;
        if(payout){
          db.prepare(`INSERT OR IGNORE INTO pb_betting_wallets(user_id,balance)
            VALUES (?,200)`).run(bet.user_id);
          db.prepare(`UPDATE pb_betting_wallets SET balance=balance+?
            WHERE user_id=?`).run(payout,bet.user_id);
          db.prepare(`INSERT INTO pb_betting_ledger(user_id,bet_id,delta,reason)
            VALUES(?,?,?,?)`).run(bet.user_id,bet.id,payout,'matchup_'+outcome);
          gems+=payout;
        }
      }
    }
    // Grade Power/Flex after the head-to-head legs have been updated.
    if(markets)parlays.settlePending(db);
    for(const id of changedEvents){
      const pending=db.prepare(`SELECT 1 FROM pb_betting_markets
        WHERE event_id=? AND status='active' LIMIT 1`).get(id);
      if(!pending)db.prepare(`UPDATE pb_betting_events SET status='completed'
        WHERE id=? AND status='scheduled'`).run(id);
    }
  });
  tx();
  return {markets,bets,gems};
}

// Within one Power/Flex entry, allow picks from EVERY scoring division.
// The only cross-pick rule is that the same corps at the same contest cannot
// appear twice, including either side of a head-to-head matchup.
function validateCombinedEntries(db,items) {
  if(!Array.isArray(items))return;
  init(db);
  const sql=db.prepare(`SELECT m.corps,m.event_id,x.favorite,x.opponent
    FROM pb_betting_markets m
    LEFT JOIN pb_betting_matchups x ON x.market_id=m.id
    WHERE m.id=?`);
  for(const item of items){
    const used=new Set();
    for(const pick of (Array.isArray(item?.picks)?item.picks:[])){
      const market=sql.get(String(pick?.market_id||''));
      if(!market)continue; // Original market validator handles unknown IDs.
      for(const corps of [market.favorite||market.corps,market.opponent].filter(Boolean)){
        const key=market.event_id+'|'+canonical(corps);
        if(used.has(key))throw Error('Only one pick involving each corps per competition is allowed in an entry.');
        used.add(key);
      }
    }
  }
}

const ui=String.raw`<style>
/* Head-to-head market controls reuse the site's original betting cards. */
.bt-card.pb-matchup-card{border-color:rgba(129,169,255,.46)}
.bt-card.pb-matchup-card .bt-caption{color:#9cb9ff;letter-spacing:.035em}
.bt-card.pb-matchup-card .bt-line strong{font-size:16px;white-space:normal}
.bt-card.pb-matchup-card .bt-choices button{font-size:11px;line-height:1.35;white-space:normal;min-height:50px}
</style>
<script>
(()=>{
  'use strict';
  function setup(){
    if(typeof MARKETS==='undefined')return;
    const markets=MARKETS.filter(m=>String(m.caption||'').startsWith('Matchup vs '));
    if(!markets.length)return;
    const byId=new Map(markets.map(m=>[m.id,m]));
    const cat=document.getElementById('captionTabs');
    if(cat && !cat.querySelector('[data-pb-matchups]')){
      const b=document.createElement('button');
      b.type='button';b.dataset.cat='other';b.dataset.pbMatchups='1';
      b.textContent='Corps Matchups';
      cat.appendChild(b);
    }
    const grid=document.getElementById('marketGrid');
    if(!grid)return;
    function decorate(){
      grid.querySelectorAll('.bt-card:not(.pb-matchup-card)').forEach(card=>{
        const button=card.querySelector('button[data-id]');
        const m=button&&byId.get(button.dataset.id);
        if(!m)return;
        const opposite=String(m.caption).slice('Matchup vs '.length);
        const spread=Number(m.line).toFixed(3);
        card.classList.add('pb-matchup-card');
        const name=card.querySelector('.bt-corps');
        if(name)name.textContent=m.corps+' vs '+opposite;
        const caption=card.querySelector('.bt-caption');
        if(caption)caption.textContent='HEAD TO HEAD · OVERALL SCORE';
        const line=card.querySelector('.bt-line strong');
        if(line)line.textContent=m.corps+' (-'+spread+')';
        const small=card.querySelector('.bt-line small');
        if(small)small.textContent='Projected winning margin';
        const more=card.querySelector('button[data-choice="over"]');
        if(more)more.textContent=m.corps+' (-'+spread+')';
        const less=card.querySelector('button[data-choice="under"]');
        if(less)less.textContent=opposite+' (+'+spread+')';
      });
    }
    const observer=new MutationObserver(decorate);
    observer.observe(grid,{childList:true});
    decorate();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup,{once:true});
  else setup();
})();
</script>`;
function injectUi(html){
  if(typeof html!=='string'||html.includes('pb-matchup-card'))return html;
  return html.replace(/<\/body>/i,ui+'\n</body>');
}
function install(){
  if(installed)return;installed=true;
  const make=lines.makeMarkets,save=lines.saveMarkets;
  lines.makeMarkets=function(args){
    const base=make(args);
    if(!args?.eventId||!Array.isArray(args.lineup))return base;
    return base.concat(pairMarkets(args.eventId,base,args.lineup));
  };
  lines.saveMarkets=function(db,event,markets){
    const result=save(db,event,markets);
    saveMetadata(db,event,markets);
    return result;
  };
  const originalPlace=parlays.placeEntries;
  parlays.placeEntries=function(db,uid,items,now){
    validateCombinedEntries(db,items);
    return originalPlace(db,uid,items,now);
  };
  const check=dci.checkScores;
  dci.checkScores=async function(db,options){
    const outcome=await check(db,options);
    if(options?.dryRun!==true && process.env.DCI_AUTO_SETTLE_ENABLED==='true'){
      outcome.matchups=settleVerified(db);
    }
    return outcome;
  };
  const ejs=require('ejs');
  const original=ejs.renderFile;
  const render=function(filename){
    const args=Array.from(arguments),callback=args[args.length-1];
    if(typeof callback==='function'&&/[\\/]betting\.ejs$/i.test(String(filename))){
      args[args.length-1]=(err,html)=>callback(err,err?html:injectUi(html));
    }
    return original.apply(this,args);
  };
  ejs.renderFile=render;ejs.__express=render;
  // Existing events may have their normal lines already; generate pairs now.
  setImmediate(()=>{
    let db;
    try{
      const dbx=require('./db');
      db=dbx.connect(process.env.DB_PATH||'/data/site.db');
      const result=backfillUpcoming(db);
      console.log('[GEM Matchups] Existing-event generation:',result);
      if(process.env.DCI_AUTO_SETTLE_ENABLED==='true'){
        console.log('[GEM Matchups] Verified score settlement:',settleVerified(db));
      }
    }catch(e){console.error('[GEM Matchups] Startup:',e);}
    finally{if(db)db.close();}
  });
  console.log('[GEM Matchups] Head-to-head odds and result hooks installed');
}
module.exports={install,init,pairMarkets,settleVerified,backfillUpcoming,validateCombinedEntries};
