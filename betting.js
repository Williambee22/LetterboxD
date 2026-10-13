'use strict';
const gems = require('./gems');
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
  function wallet(db, uid) { db.prepare('INSERT OR IGNORE INTO pb_betting_wallets(user_id,balance) VALUES (?,200)').run(uid); return db.prepare('SELECT balance FROM pb_betting_wallets WHERE user_id=?').get(uid).balance; }
  // Existing wallets are intentionally retained; only NEW wallets begin with 200 Gems.
  const loggedIn=(req,res,next)=>req.session?.uid?next():res.redirect('/login?next=%2Fbetting');
  const admin=(req,res,next)=>Number(res.locals.me?.is_admin)===1?next():res.sendStatus(403);
  function validOrigin(req) { const o=req.get('origin'); if (!o) return true; try { return new URL(o).host===req.get('host'); } catch {return false;} }
  function write(req,res,next){ if(!validOrigin(req))return res.status(403).json({error:'Invalid request origin'}); next(); }
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
  // Admin-managed balance adjustments. All changes are atomic and audited.
  app.post('/api/admin/gems/adjust', loggedIn, admin, write, (req,res)=>{
    try {
      const data=withDb(db=>db.transaction(()=>{
        const identifier=String(req.body.username||'').trim();
        const delta=Number(req.body.delta);
        const note=String(req.body.note||'').trim();
        if(!identifier || identifier.length>100) throw Error('Enter a username.');
        if(!Number.isSafeInteger(delta) || delta===0 || Math.abs(delta)>1000000) throw Error('Enter a nonzero whole number between -1,000,000 and 1,000,000.');
        if(!note || note.length>250) throw Error('An adjustment reason (max 250 characters) is required.');
        const user=db.prepare('SELECT id,username FROM users WHERE LOWER(username)=LOWER(?) LIMIT 1').get(identifier);
        if(!user) throw Error('User not found.');
        wallet(db,Number(user.id));
        const change=db.prepare('UPDATE pb_betting_wallets SET balance=balance+? WHERE user_id=? AND balance+?>=0').run(delta,user.id,delta);
        if(change.changes!==1) throw Error('Cannot remove more Gems than the user owns.');
        const adminId=Number(req.session.uid);
        db.prepare('INSERT INTO pb_betting_ledger(user_id,delta,reason) VALUES(?,?,?)').run(user.id,delta,'admin:'+adminId+':'+note);
        return {ok:true,username:user.username,delta,balance:wallet(db,Number(user.id))};
      })());
      return res.json(data);
    } catch(e) {return res.status(400).json({error:e.message||'Adjustment failed'});}
  });
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
