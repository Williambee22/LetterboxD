'use strict';
// Virtual-Gems multiple entries, Power and Flex picks. No real-money betting.
const { openingForEvent } = require('./betting_window');
const FLEX = Object.freeze({
  3: {3:3,2:1},
  4: {4:6,3:1.5},
  5: {5:10,4:2,3:0.4},
  6: {6:25,5:2,4:0.4}
});
const POWER = Object.freeze({2:3,3:5,4:10,5:20,6:37.5});
const NOW = () => Math.floor(Date.now()/1000);
function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pb_betting_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      play_type TEXT NOT NULL CHECK(play_type IN ('single','power','flex')),
      stake INTEGER NOT NULL CHECK(stake>0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','won','lost','push','void')),
      payout INTEGER NOT NULL DEFAULT 0,
      created_ts INTEGER NOT NULL DEFAULT (unixepoch()),
      settled_ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pb_betting_entries_user ON pb_betting_entries(user_id,created_ts);
    CREATE TABLE IF NOT EXISTS pb_betting_entry_legs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL REFERENCES pb_betting_entries(id),
      market_id TEXT NOT NULL REFERENCES pb_betting_markets(id),
      choice TEXT NOT NULL CHECK(choice IN ('over','under')),
      line REAL NOT NULL,
      odds REAL NOT NULL,
      UNIQUE(entry_id,market_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pb_betting_entry_legs_market ON pb_betting_entry_legs(market_id);
  `);
}
function payoutMultiplier(type,n,wins) {
  if(type==='single') return n===1&&wins===1 ? 1.9 : 0;
  if(type==='power') return n>=2&&wins===n ? (POWER[n] || 0) : 0;
  if(type==='flex') return (FLEX[n]||{})[wins] || 0;
  return 0;
}
function validateEntry(item) {
  if(!item||typeof item!=='object')throw Error('Invalid entry.');
  const type=String(item.play_type||'');
  const picks=item.picks;
  const stake=Number(item.stake);
  if(!Number.isSafeInteger(stake)||stake<1||stake>10000)throw Error('Each entry needs 1–10,000 whole Gems.');
  if(!Array.isArray(picks))throw Error('Entry must contain picks.');
  if(type==='single'&&picks.length!==1)throw Error('Single entries require one pick.');
  if(type==='power'&&(picks.length<2||picks.length>6))throw Error('Power Plays require 2–6 picks.');
  if(type==='flex'&&(picks.length<3||picks.length>6))throw Error('Flex Plays require 3–6 picks.');
  if(!['single','power','flex'].includes(type))throw Error('Choose Single, Power Play, or Flex Play.');
  return {type,picks,stake};
}
function placeEntries(db,userId,items,now=NOW()) {
  init(db);
  const uid=Number(userId);
  if(!Number.isSafeInteger(uid)||uid<1)throw Error('Sign in to place an entry.');
  if(!Array.isArray(items)||items.length<1||items.length>12)throw Error('Submit 1–12 entries at a time.');
  return db.transaction(()=>{
    const validated=items.map(validateEntry);
    const total=validated.reduce((a,x)=>a+x.stake,0);
    if(!Number.isSafeInteger(total))throw Error('Invalid stake total.');
    const insertEntry=db.prepare('INSERT INTO pb_betting_entries(user_id,play_type,stake) VALUES(?,?,?)');
    const insertLeg=db.prepare('INSERT INTO pb_betting_entry_legs(entry_id,market_id,choice,line,odds) VALUES(?,?,?,?,?)');
    const results=[];
    for(const {type,picks,stake} of validated){
      const selections=[];
      const seen=new Set(),corpsInEvent=new Set();
      for(const pick of picks){
        const marketId=String(pick?.market_id||'');
        const choice=String(pick?.choice||'');
        if(!/^[a-zA-Z0-9_-]{1,160}$/.test(marketId)||!['over','under'].includes(choice))throw Error('Invalid market selection.');
        if(seen.has(marketId))throw Error('A selection cannot appear twice in one entry.');
        seen.add(marketId);
        const m=db.prepare(`SELECT m.id,m.event_id,m.corps,m.caption,m.kind,m.line,m.odds,m.status,
              e.id AS eid,e.start_ts,e.season,e.status AS event_status
              FROM pb_betting_markets m JOIN pb_betting_events e ON e.id=m.event_id
              WHERE m.id=?`).get(marketId);
        if(!m||m.status!=='active'||m.event_status!=='scheduled'||m.start_ts==null||now>=m.start_ts||now<openingForEvent(db,{id:m.event_id,start_ts:m.start_ts,season:m.season}))
          throw Error('A selected market is closed or unavailable. Refresh the board.');
        if(db.prepare('SELECT 1 FROM pb_betting_no_score_events WHERE event_id=?').get(m.event_id))throw Error('A selected event is NOT SCORED.');
        // Prevent correlated markets for the same corps in the same competition.
        const correlated=m.event_id+'|'+String(m.corps).toLowerCase().replace(/[^a-z0-9]/g,'');
        if(corpsInEvent.has(correlated))throw Error('Select at most one caption for each corps in the same competition per entry.');
        corpsInEvent.add(correlated);
        selections.push({market:m,choice});
      }
      const eid=Number(insertEntry.run(uid,type,stake).lastInsertRowid);
      for(const {market,choice} of selections)insertLeg.run(eid,market.id,choice,market.line,market.odds);
      results.push({id:eid,play_type:type,legs:selections.length,stake});
    }
    db.prepare('INSERT OR IGNORE INTO pb_betting_wallets(user_id,balance) VALUES (?,200)').run(uid);
    const debited=db.prepare('UPDATE pb_betting_wallets SET balance=balance-? WHERE user_id=? AND balance>=?').run(total,uid,total);
    if(debited.changes!==1)throw Error('Not enough Gems for these entries.');
    for(const entry of results){
      db.prepare('INSERT INTO pb_betting_ledger(user_id,bet_id,delta,reason) VALUES(?,NULL,?,?)')
        .run(uid,-entry.stake,'multi_entry_stake:'+entry.id);
    }
    const balance=db.prepare('SELECT balance FROM pb_betting_wallets WHERE user_id=?').get(uid).balance;
    return {entries:results,balance,total_staked:total};
  })();
}
function legResult(leg){
  if(leg.status==='void')return 'void';
  if(leg.status!=='settled'||!Number.isFinite(leg.actual))return 'pending';
  if(Math.abs(leg.actual-leg.line)<1e-8)return 'push';
  return (leg.actual>leg.line?'over':'under')===leg.choice?'won':'lost';
}
// Repeat-safe: all leg results must exist before determining final payout.
// A void/push removes a leg; remaining legs regrade using the corresponding
// Power/Flex table. If a play becomes too small, the original stake is refunded.
function settlePending(db) {
  init(db);
  return db.transaction(()=>{
    let settled=0,gems=0;
    const entries=db.prepare(`SELECT e.* FROM pb_betting_entries e
      WHERE e.status='pending'
        AND NOT EXISTS (
          SELECT 1 FROM pb_betting_entry_legs l
          JOIN pb_betting_markets m ON m.id=l.market_id
          WHERE l.entry_id=e.id AND m.status='active'
        )
      ORDER BY e.id LIMIT 1000`).all();
    const legsFor=db.prepare(`SELECT l.*,m.status,m.actual,m.event_id,m.corps,m.caption,e.name AS event_name
      FROM pb_betting_entry_legs l JOIN pb_betting_markets m ON m.id=l.market_id
      JOIN pb_betting_events e ON e.id=m.event_id WHERE l.entry_id=?`);
    for(const entry of entries){
      const legs=legsFor.all(entry.id);
      if(legs.length===0||legs.some(l=>legResult(l)==='pending'))continue;
      const outcomes=legs.map(legResult), live=outcomes.filter(x=>x!=='push'&&x!=='void');
      const won=live.filter(x=>x==='won').length;
      const min=entry.play_type==='single'?1:entry.play_type==='power'?2:3;
      let outcome,paid;
      if(live.length<min){outcome='void';paid=entry.stake;}
      else {
        let mult=0;
        if(entry.play_type==='single'){
          const one=legs[outcomes.findIndex(x=>x!=='push'&&x!=='void')];
          mult=won===1?one.odds:0;
        } else mult=payoutMultiplier(entry.play_type,live.length,won);
        paid=Math.round(entry.stake*mult);
        outcome=paid>0?'won':'lost';
      }
      const change=db.prepare("UPDATE pb_betting_entries SET status=?,payout=?,settled_ts=unixepoch() WHERE id=? AND status='pending'")
        .run(outcome,paid,entry.id);
      if(change.changes!==1)continue;
      if(paid){
        db.prepare('INSERT OR IGNORE INTO pb_betting_wallets(user_id,balance) VALUES (?,200)').run(entry.user_id);
        db.prepare('UPDATE pb_betting_wallets SET balance=balance+? WHERE user_id=?').run(paid,entry.user_id);
        db.prepare('INSERT INTO pb_betting_ledger(user_id,bet_id,delta,reason) VALUES(?,NULL,?,?)')
          .run(entry.user_id,paid,'multi_entry_'+outcome+':'+entry.id);
      }
      settled++;gems+=paid;
    }
    return {settled,gems};
  })();
}
function recent(db,uid,limit=20){
  init(db);
  const entries=db.prepare('SELECT * FROM pb_betting_entries WHERE user_id=? ORDER BY id DESC LIMIT ?').all(uid,limit);
  const stmt=db.prepare(`SELECT l.*,m.corps,m.caption,m.kind,m.event_id,e.name AS event_name,
      m.status AS market_status,m.actual AS actual FROM pb_betting_entry_legs l
      JOIN pb_betting_markets m ON m.id=l.market_id
      JOIN pb_betting_events e ON e.id=m.event_id WHERE l.entry_id=? ORDER BY l.id`);
  return entries.map(e=>({...e,legs:stmt.all(e.id).map(l=>({...l,result:legResult({...l,status:l.market_status})}))}));
}
module.exports={init,placeEntries,settlePending,recent,payoutMultiplier,FLEX,POWER};
