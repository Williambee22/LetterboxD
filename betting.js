'use strict';
const gems = require('./gems');
const historicalLines = require('./betting_lines');
const dciSync = require('./dci_sync');
// Mount AFTER express-session, body parsing, and res.locals middleware.
module.exports = function mountBetting(app, getConn) {
  function withDb(fn) { const db=getConn(); try {return fn(db);} finally {db.close();} }
  function initialize(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pb_betting_wallets (user_id INTEGER PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 200 CHECK(balance>=0));
      CREATE TABLE IF NOT EXISTS pb_betting_events (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, start_ts INTEGER NOT NULL, season INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','canceled','completed')),
        source_url TEXT, updated_ts INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS pb_betting_markets (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES pb_betting_events(id), corps TEXT NOT NULL,
        caption TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('absolute','change')),
        line REAL NOT NULL, odds REAL NOT NULL DEFAULT 1.90 CHECK(odds>=1.01),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','void','settled')),
        actual REAL, created_ts INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS pb_betting_market_event ON pb_betting_markets(event_id);
      CREATE TABLE IF NOT EXISTS pb_betting_bets (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, market_id TEXT NOT NULL REFERENCES pb_betting_markets(id),
        choice TEXT NOT NULL CHECK(choice IN ('over','under')), stake INTEGER NOT NULL CHECK(stake>0),
        line REAL NOT NULL, odds REAL NOT NULL, placed_ts INTEGER NOT NULL DEFAULT (unixepoch()),
        result TEXT NOT NULL DEFAULT 'pending' CHECK(result IN ('pending','won','lost','push','void')),
        payout INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS pb_betting_bets_user ON pb_betting_bets(user_id,placed_ts);
      CREATE TABLE IF NOT EXISTS pb_gems_daily_claims (user_id INTEGER PRIMARY KEY, last_claim_ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pb_gems_prediction_rewards (season_label TEXT NOT NULL, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(season_label,user_id));
      CREATE TABLE IF NOT EXISTS pb_betting_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL, bet_id INTEGER, delta INTEGER NOT NULL,
        reason TEXT NOT NULL, created_ts INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
  }
  withDb(initialize);
  withDb(dciSync.init);
  function wallet(db, uid) { db.prepare('INSERT OR IGNORE INTO pb_betting_wallets(user_id,balance) VALUES (?,200)').run(uid); return db.prepare('SELECT balance FROM pb_betting_wallets WHERE user_id=?').get(uid).balance; }
  // Existing wallets are intentionally retained; only NEW wallets begin with 200 Gems.
  const loggedIn=(req,res,next)=>req.session?.uid?next():res.redirect('/login?next=%2Fbetting');
  const admin=(req,res,next)=>Number(res.locals.me?.is_admin)===1?next():res.sendStatus(403);
  function validOrigin(req) { const o=req.get('origin'); if (!o) return true; try { return new URL(o).host===req.get('host'); } catch {return false;} }
  function write(req,res,next){ if(!validOrigin(req))return res.status(403).json({error:'Invalid request origin'}); next(); }
  // Standalone Gems management: authenticated admins only.
  const adminLogin=(req,res,next)=>req.session?.uid?next():res.redirect('/login?next=%2Fbetsadmin');
  const csrfToken=(req)=>{
    if(!req.session.betsadmin_csrf)req.session.betsadmin_csrf=require('crypto').randomBytes(32).toString('hex');
    return req.session.betsadmin_csrf;
  };
  function loadAdminPage(req,res,next) {
    try {
      const search=String(req.query.q||'').trim().slice(0,80);
      withDb(db=>{
        initialize(db);
        const users=search?db.prepare("SELECT id,username FROM users WHERE username LIKE ? ESCAPE '!' ORDER BY username LIMIT 30").all('%'+search.replace(/[!%_]/g, ch=>'!'+ch)+'%'):[];
        const results=users.map(u=>({...u,balance:wallet(db,Number(u.id))}));
        const history=db.prepare(`SELECT a.id,a.user_id,a.username,a.admin_id,a.admin_username,a.delta,a.balance_before,a.balance_after,a.reason,a.created_ts FROM pb_gems_admin_adjustments a ORDER BY a.id DESC LIMIT 35`).all();
        res.setHeader('Cache-Control','private, no-store');
        res.render('betsadmin',{me:res.locals.me,accent_color:res.locals.accent_color,search,users:results,history,csrf:csrfToken(req),notice:req.query.ok==='1'?'Gems successfully adjusted.':'',error:String(req.query.error||'').slice(0,120)});
      });
    } catch(e){next(e);}
  }
  withDb(db=>db.exec(`CREATE TABLE IF NOT EXISTS pb_gems_admin_adjustments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,username TEXT NOT NULL,
    admin_id INTEGER NOT NULL,admin_username TEXT NOT NULL,delta INTEGER NOT NULL,
    balance_before INTEGER NOT NULL,balance_after INTEGER NOT NULL,reason TEXT NOT NULL,
    created_ts INTEGER NOT NULL DEFAULT (unixepoch())
  )`));
  // Separate admin-only sync page and sandbox; never uses real wallets for replay.
  app.get('/betsadmin/sync',adminLogin,admin,(req,res,next)=>{
    try{withDb(db=>{
      const logs=db.prepare('SELECT * FROM pb_dci_sync_log ORDER BY id DESC LIMIT 30').all();
      const sandbox=db.prepare('SELECT id,name,original_date,markets_json FROM pb_dci_sandbox_events ORDER BY created_ts DESC LIMIT 10').all().map(x=>{const markets=JSON.parse(x.markets_json);return {id:x.id,name:x.name,original_date:x.original_date,market_count:markets.length,markets:markets.slice(0,250)};});
      const current=Number(req.session.uid),testBalance=dciSync.sandboxWallet(db,current);
      const recent=db.prepare('SELECT * FROM pb_dci_sandbox_bets WHERE user_id=? ORDER BY id DESC LIMIT 20').all(current);
      const events=db.prepare("SELECT id,name,start_ts,season,status FROM pb_betting_events WHERE source_url LIKE 'https://www.dci.org/%' ORDER BY start_ts DESC LIMIT 35").all();
      const states=db.prepare('SELECT key,last_ts FROM pb_dci_sync_state ORDER BY key').all();
      const verifiedCount=db.prepare('SELECT count(*) AS n FROM pb_dci_verified_scores').get().n;
      const pendingMarkets=db.prepare(`SELECT count(*) AS n FROM pb_betting_markets m JOIN pb_betting_events e ON e.id=m.event_id WHERE m.status='active' AND e.start_ts<unixepoch()`).get().n;
      const health={states,verifiedCount,pendingMarkets,autoSync:process.env.DCI_SYNC_ENABLED==='true',autoSettle:process.env.DCI_AUTO_SETTLE_ENABLED==='true'};
      res.setHeader('Cache-Control','private,no-store');
      res.render('betsadmin_sync',{me:res.locals.me,accent_color:res.locals.accent_color,logs,sandbox,events,recent,testBalance,health,csrf:csrfToken(req),notice:String(req.query.notice||'').slice(0,1000)});
    });}catch(e){next(e);}
  });
  function verifySyncAdmin(req,res,next){
    if(!validOrigin(req))return res.sendStatus(403);
    const a=String(req.body.csrf||''),b=String(req.session.betsadmin_csrf||'');
    if(!a||a!==b)return res.sendStatus(403);
    next();
  }
  app.post('/betsadmin/sync/action',adminLogin,admin,verifySyncAdmin,async(req,res,next)=>{
    try{
      const action=String(req.body.action||'');let result;
      if(action==='diagnose'){
        result=withDb(db=>({states:db.prepare('SELECT * FROM pb_dci_sync_state').all(),
          verified:db.prepare('SELECT count(*) AS n FROM pb_dci_verified_scores').get().n,
          logs:db.prepare('SELECT kind,status,details,created_ts FROM pb_dci_sync_log ORDER BY id DESC LIMIT 5').all()}));
      } else if(action==='discover'||action==='discover_preview'){
        const year=Number(req.body.year||new Date().getFullYear());
        if(!Number.isInteger(year)||year<2022||year>2100)throw Error('Invalid season');
        result=await withDbAsync(async db=>dciSync.discover(db,{year,limit:150,dryRun:action==='discover_preview'}));
      } else if(action==='scores'||action==='scores_preview'){
        result=await withDbAsync(async db=>dciSync.checkScores(db,{dryRun:action==='scores_preview'}));
      } else if(action==='replay'){
        // Real historical event from XLSX; no arbitrary fake events.
        const slug=String(req.body.slug||'2026-dci-dallas');
        if(!/^20\d\d-[a-z0-9-]+$/.test(slug))throw Error('Invalid historical slug');
        result=withDb(db=>dciSync.replay(db,{year:Number(slug.slice(0,4)),slug}));
      } else if(action==='testbet'){
        result=withDb(db=>({id:dciSync.sandboxBet(db,Number(req.session.uid),{
          event_id:String(req.body.event_id||''),market_id:String(req.body.market_id||''),choice:String(req.body.choice||''),stake:Number(req.body.stake)
        })}));
      } else if(action==='settle'){
        result=withDb(db=>dciSync.replaySettle(db,Number(req.session.uid),String(req.body.event_id||'')));
      } else throw Error('Unknown action');
      res.redirect(303,'/betsadmin/sync?notice='+encodeURIComponent(JSON.stringify(result).slice(0,290)));
    }catch(e){res.redirect(303,'/betsadmin/sync?notice='+encodeURIComponent('ERROR: '+String(e.message||e).slice(0,280)));}
  });
  async function withDbAsync(fn){const db=getConn();try{return await fn(db);}finally{db.close();}}
  // A single dedicated Railway worker is preferred; SQLite locks also suppress overlaps.
  // DCI_AUTO_SETTLE_ENABLED defaults to false until official recap parsing is validated.
  if(process.env.DCI_SYNC_ENABLED==='true'){
    let busy=false;
    async function tick(){
      if(busy)return;
      busy=true;
      try{
        await withDbAsync(async db=>{
          const token=dciSync.acquireLock(db,'poller',1800);
          if(!token)return;
          try{
            const yr=new Date().getUTCFullYear();
            // Scan current AND next calendar year independently; don't assume September means next season.
            for(const year of [yr,yr+1]){
              if(!dciSync.allowRefresh(db,`events:${year}`,6*3600))continue;
              try{await dciSync.discover(db,{year,limit:150});}
              catch(e){dciSync.log(db,'events','error',`${year}: ${e.message}`);}
            }
            if(dciSync.allowRefresh(db,'scores',15*60)){
              try{await dciSync.checkScores(db);}
              catch(e){dciSync.log(db,'scores','error',e.message);}
            }
          }finally{dciSync.releaseLock(db,'poller',token);}
        });
      }catch(e){console.error('[DCI SYNC]',e);}
      finally{busy=false;}
    }
    const timer=setInterval(tick,15*60*1000);timer.unref();
    setTimeout(tick,20000).unref();
  }
  app.get('/betsadmin',adminLogin,admin,loadAdminPage);
  app.post('/betsadmin/adjust',adminLogin,admin,(req,res,next)=>{
    if(!validOrigin(req))return res.sendStatus(403);
    const supplied=String(req.body.csrf||'');
    const expected=String(req.session.betsadmin_csrf||'');
    const crypto=require('crypto');
    if(!expected||supplied.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return res.sendStatus(403);
    try {
      const username=String(req.body.username||'').trim();
      const amount=Number(req.body.amount);
      const reason=String(req.body.reason||'').trim();
      if(!username||!Number.isSafeInteger(amount)||amount===0||Math.abs(amount)>1000000||reason.length<3||reason.length>300)throw Error('Enter a username, nonzero whole Gems amount, and a reason (3–300 characters).');
      withDb(db=>db.transaction(()=>{
        const user=db.prepare('SELECT id,username FROM users WHERE username=? COLLATE NOCASE LIMIT 1').get(username);
        if(!user)throw Error('Username not found.');
        const before=wallet(db,Number(user.id));
        const after=before+amount;
        if(!Number.isSafeInteger(after)||after<0)throw Error('Cannot subtract more Gems than the user has.');
        db.prepare('UPDATE pb_betting_wallets SET balance=? WHERE user_id=?').run(after,user.id);
        db.prepare('INSERT INTO pb_betting_ledger(user_id,delta,reason) VALUES(?,?,?)').run(user.id,amount,'admin_adjustment');
        db.prepare(`INSERT INTO pb_gems_admin_adjustments(user_id,username,admin_id,admin_username,delta,balance_before,balance_after,reason) VALUES(?,?,?,?,?,?,?,?)`).run(user.id,user.username,Number(req.session.uid),String(res.locals.me.username),amount,before,after,reason);
      })());
      return res.redirect(303,'/betsadmin?ok=1');
    }catch(e){return res.redirect(303,'/betsadmin?error='+encodeURIComponent(String(e.message||'Adjustment failed').slice(0,120)));}
  });
  app.get('/betting', loggedIn, (req,res,next)=>{ try {withDb(db=>{
    gems.creditHistoricalPredictionScores(db);
    const now=Math.floor(Date.now()/1000),uid=Number(req.session.uid);
    const events=db.prepare('SELECT *, (start_ts-86400) AS open_ts FROM pb_betting_events WHERE start_ts>? AND status=? ORDER BY start_ts LIMIT 100').all(now-86400,'scheduled');
    const markets=db.prepare(`SELECT m.*, e.name event_name,e.start_ts,e.season FROM pb_betting_markets m JOIN pb_betting_events e ON e.id=m.event_id WHERE e.status='scheduled' AND m.status='active' AND e.start_ts>? AND e.start_ts-86400<=? ORDER BY e.start_ts,m.corps,m.caption,m.kind`).all(now,now);
    const bets=db.prepare(`SELECT b.*, m.caption,m.corps,e.name event_name FROM pb_betting_bets b JOIN pb_betting_markets m ON m.id=b.market_id JOIN pb_betting_events e ON e.id=m.event_id WHERE b.user_id=? ORDER BY b.id DESC LIMIT 30`).all(uid);
    res.setHeader('Cache-Control','private, no-store');
    const claim=db.prepare('SELECT last_claim_ts FROM pb_gems_daily_claims WHERE user_id=?').get(uid);
    res.render('betting',{ me:res.locals.me,accent_color:res.locals.accent_color,events,markets,bets,balance:wallet(db,uid),now,next_claim_ts:claim?claim.last_claim_ts+86400:0 });
  }); } catch(e){next(e);} });
  app.post('/api/gems/daily',loggedIn,write,(req,res)=>{try{const result=withDb(db=>db.transaction(()=>{
    const uid=Number(req.session.uid), now=Math.floor(Date.now()/1000);
    wallet(db,uid);
    const claim=db.prepare('SELECT last_claim_ts FROM pb_gems_daily_claims WHERE user_id=?').get(uid);
    if(claim && now-claim.last_claim_ts<86400) return {ok:false,next_claim_ts:claim.last_claim_ts+86400,balance:wallet(db,uid)};
    db.prepare('INSERT INTO pb_gems_daily_claims(user_id,last_claim_ts) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_claim_ts=excluded.last_claim_ts').run(uid,now);
    db.prepare('UPDATE pb_betting_wallets SET balance=balance+10 WHERE user_id=?').run(uid);
    db.prepare('INSERT INTO pb_betting_ledger(user_id,delta,reason) VALUES(?,?,?)').run(uid,10,'daily_gems');
    return {ok:true,awarded:10,balance:wallet(db,uid),next_claim_ts:now+86400};
  })());res.status(result.ok?200:429).json(result);}catch(e){res.status(500).json({error:'Could not claim daily Gems'});} });
  app.post('/api/betting/bets',loggedIn,write,(req,res)=>{ try {const result=withDb(db=>{
    const uid=Number(req.session.uid), marketId=String(req.body.market_id||''),choice=String(req.body.choice||''),stake=Number(req.body.stake);
    if(!['over','under'].includes(choice)||!Number.isSafeInteger(stake)||stake<1||stake>10000)throw Error('Invalid selection or stake (1–10,000 Gems).');
    return db.transaction(()=>{
      const m=db.prepare(`SELECT m.*,e.start_ts,e.status event_status FROM pb_betting_markets m JOIN pb_betting_events e ON e.id=m.event_id WHERE m.id=?`).get(marketId);
      const now=Math.floor(Date.now()/1000);
      if(!m||m.status!=='active'||m.event_status!=='scheduled'||now<m.start_ts-86400||now>=m.start_ts)throw Error('This market is not open.');
      wallet(db,uid);
      const paid=db.prepare('UPDATE pb_betting_wallets SET balance=balance-? WHERE user_id=? AND balance>=?').run(stake,uid,stake);
      if(paid.changes!==1)throw Error('Not enough Gems.');
      const b=db.prepare('INSERT INTO pb_betting_bets(user_id,market_id,choice,stake,line,odds) VALUES(?,?,?,?,?,?)').run(uid,marketId,choice,stake,m.line,m.odds);
      db.prepare('INSERT INTO pb_betting_ledger(user_id,bet_id,delta,reason) VALUES(?,?,?,?)').run(uid,b.lastInsertRowid,-stake,'stake');
      return {bet_id:Number(b.lastInsertRowid),balance:wallet(db,uid)};
    })();
  });res.json({ok:true,...result});}catch(e){res.status(400).json({error:e.message});} });
  app.post('/api/admin/betting/import',loggedIn,admin,write,(req,res)=>{try{ const imported=withDb(db=>db.transaction(()=>{
    const items=req.body.events; if(!Array.isArray(items)||items.length>500)throw Error('Supply events array (up to 500).');
    let count=0;for(const ev of items){
      const id=String(ev.id||''),name=String(ev.name||'');const start=Number(ev.start_ts),season=Number(ev.season);
      if(!/^[a-zA-Z0-9_-]{1,120}$/.test(id)||!name||!Number.isSafeInteger(start)||!Number.isInteger(season)||season<2022)throw Error('Invalid event.');
      db.prepare(`INSERT INTO pb_betting_events(id,name,start_ts,season,source_url) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,start_ts=excluded.start_ts,source_url=excluded.source_url,updated_ts=unixepoch()`).run(id,name,start,season,ev.source_url||null);
      if(!Array.isArray(ev.markets))throw Error('Missing markets for '+id);
      for(const m of ev.markets){const mid=String(m.id||''),corps=String(m.corps||''),caption=String(m.caption||''),kind=String(m.kind||''),line=Number(m.line),odds=m.odds==null?1.9:Number(m.odds);
        if(!/^[a-zA-Z0-9_-]{1,160}$/.test(mid)||!corps||!caption||!['absolute','change'].includes(kind)||!Number.isFinite(line)||!Number.isFinite(odds)||odds<1.01||odds>10)throw Error('Invalid market '+mid);
        // Do not move a line once anyone has placed a bet on it.
        const used=db.prepare('SELECT 1 FROM pb_betting_bets WHERE market_id=? LIMIT 1').get(mid);
        if(used)continue;
        db.prepare(`INSERT INTO pb_betting_markets(id,event_id,corps,caption,kind,line,odds) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET event_id=excluded.event_id,corps=excluded.corps,caption=excluded.caption,kind=excluded.kind,line=excluded.line,odds=excluded.odds`).run(mid,id,corps,caption,kind,line,odds);count++;
      }
    }return count;
  })());res.json({ok:true,markets:imported});}catch(e){res.status(400).json({error:e.message});}});
  // Generate lines for a previously imported, verified event and an explicit lineup.
  // Never invents events, never touches settled/used lines, and does not alter wallets.
  app.post('/api/admin/betting/generate-lines', loggedIn, admin, write, (req,res)=>{
    try {
      const result=withDb(db=>db.transaction(()=>{
        const eventId=String(req.body.event_id||'').trim();
        const event=db.prepare('SELECT id,name,start_ts,season,status FROM pb_betting_events WHERE id=?').get(eventId);
        if(!event)throw Error('Event not found. Import the official event first.');
        if(event.status!=='scheduled')throw Error('Only scheduled events can receive new lines.');
        if(event.start_ts<=Math.floor(Date.now()/1000))throw Error('Cannot generate lines for an event that has already started.');
        if(event.start_ts-86400<=Math.floor(Date.now()/1000))throw Error('Generate and review lines BEFORE the 24-hour betting window opens.');
        const markets=historicalLines.makeMarkets({eventId:event.id,startTs:event.start_ts,season:event.season,lineup:req.body.lineup,db,eventDate:db.prepare('SELECT local_date FROM pb_dci_event_dates WHERE event_id=?').get(event.id)?.local_date});
        if(!markets.length)throw Error('No qualifying historical scores for this event lineup; check corps names and classes.');
        return {event_id:event.id,...historicalLines.saveMarkets(db,event,markets)};
      })());
      return res.json({ok:true,...result});
    } catch(e){return res.status(400).json({error:String(e.message||e)});}
  });

  app.post('/api/admin/betting/settle',loggedIn,admin,write,(req,res)=>{try{const result=withDb(db=>db.transaction(()=>{
    const id=String(req.body.market_id||''),voidMarket=req.body.void===true,actual=Number(req.body.actual);
    const m=db.prepare('SELECT m.*,e.start_ts FROM pb_betting_markets m JOIN pb_betting_events e ON e.id=m.event_id WHERE m.id=?').get(id);
    if(!m||m.status!=='active')throw Error('Market not active.');
    if(!voidMarket&&(!Number.isFinite(actual)||Date.now()<m.start_ts*1000))throw Error('A completed event and valid official result are required.');
    db.prepare('UPDATE pb_betting_markets SET status=?,actual=? WHERE id=?').run(voidMarket?'void':'settled',voidMarket?null:actual,id);
    const bets=db.prepare("SELECT * FROM pb_betting_bets WHERE market_id=? AND result='pending'").all(id);
    for(const b of bets){const result=voidMarket?'void':Math.abs(actual-b.line)<0.0000001?'push':(actual>b.line?'over':'under')===b.choice?'won':'lost';const payout=result==='won'?Math.round(b.stake*b.odds):['void','push'].includes(result)?b.stake:0;
      db.prepare('UPDATE pb_betting_bets SET result=?,payout=? WHERE id=?').run(result,payout,b.id);
      if(payout){db.prepare('UPDATE pb_betting_wallets SET balance=balance+? WHERE user_id=?').run(payout,b.user_id);db.prepare('INSERT INTO pb_betting_ledger(user_id,bet_id,delta,reason) VALUES(?,?,?,?)').run(b.user_id,b.id,payout,result);}
    }return bets.length;
  })());res.json({ok:true,settled:result});}catch(e){res.status(400).json({error:e.message});}});
};
