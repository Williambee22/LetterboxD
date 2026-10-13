'use strict';
// Shared virtual Gems ledger. All methods expect a better-sqlite3 connection.
function initialize(db) {
 db.exec(`
 CREATE TABLE IF NOT EXISTS pb_betting_wallets (user_id INTEGER PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 200 CHECK(balance>=0));
 CREATE TABLE IF NOT EXISTS pb_gems_prediction_rewards (season_label TEXT NOT NULL, user_id INTEGER NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY(season_label,user_id));
 CREATE TABLE IF NOT EXISTS pb_betting_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,bet_id INTEGER,delta INTEGER NOT NULL,reason TEXT NOT NULL,created_ts INTEGER NOT NULL DEFAULT (unixepoch()));
 `);
}
function balance(db, userId) {
 initialize(db);
 db.prepare('INSERT OR IGNORE INTO pb_betting_wallets(user_id,balance) VALUES (?,200)').run(Number(userId));
 return db.prepare('SELECT balance FROM pb_betting_wallets WHERE user_id=?').get(Number(userId)).balance;
}
function syncPredictionRewards(db, season) {
 initialize(db);
 return db.transaction(()=>{
  const label=String(season);
  const rows=db.prepare('SELECT user_id,total_points FROM season_prediction_scores WHERE season_label=?').all(label);
  const oldRows=db.prepare('SELECT user_id,amount FROM pb_gems_prediction_rewards WHERE season_label=?').all(label);
  const old=new Map(oldRows.map(r=>[Number(r.user_id),Number(r.amount)]));
  const desired=new Map(rows.map(r=>[Number(r.user_id),Math.max(0,Math.trunc(Number(r.total_points)||0))]));
  for (const uid of new Set([...old.keys(),...desired.keys()])) {
   const prior=old.get(uid)||0, wanted=desired.get(uid)||0, delta=wanted-prior;
   if(delta){
    balance(db,uid);
    // Don't make balances negative if an admin reduces an already spent reward.
    // In that rare case, reject the revision so rewards do not become inconsistent.
    const changed=db.prepare('UPDATE pb_betting_wallets SET balance=balance+? WHERE user_id=? AND balance+?>=0').run(delta,uid,delta);
    if(changed.changes!==1)throw Error('Cannot reduce already-spent prediction Gems for user '+uid);
    db.prepare('INSERT INTO pb_betting_ledger(user_id,delta,reason) VALUES(?,?,?)').run(uid,delta,'prediction:'+label);
   }
   if(desired.has(uid)) db.prepare('INSERT INTO pb_gems_prediction_rewards(season_label,user_id,amount) VALUES(?,?,?) ON CONFLICT(season_label,user_id) DO UPDATE SET amount=excluded.amount').run(label,uid,wanted);
   else db.prepare('DELETE FROM pb_gems_prediction_rewards WHERE season_label=? AND user_id=?').run(label,uid);
  }
  return {users:rows.length};
 })();
}
function gemLeaderboard(db, rows) {
 const enriched=rows.map(row=>({ ...row, prediction_points:row.total_points, total_points:balance(db,Number(row.user_id)) }));
 enriched.sort((a,b)=>Number(b.total_points)-Number(a.total_points)||String(a.username).localeCompare(String(b.username)));
 enriched.forEach((r,i)=>{r.rank=1+enriched.findIndex(x=>x.total_points===r.total_points);});
 return enriched;
}
module.exports={initialize,balance,syncPredictionRewards,gemLeaderboard};
