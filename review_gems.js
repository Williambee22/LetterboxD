'use strict';
// Pressboxd review rewards. Virtual Gems. This is a conservative spam filter,
// not a language model: suspicious text earns no Gems but can still be saved.
const MAX_REVIEW_LENGTH = 6000;
function characters(s) { return Array.from(String(s || '').trim()).length; }
function rewardForLength(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_REVIEW_LENGTH) {
    throw Error('Review must contain 1–6000 characters.');
  }
  return 10 + (n > 400 ? 5 : 0) + (n > 800 ? 10 : 0)
    + (n > 1600 ? 15 : 0) + (n > 3000 ? 25 : 0);
}
function quality(text) {
  const s = String(text || '').trim();
  if (!s) return {eligible:false, reason:'Write a review to earn Gems.'};
  if (characters(s) > MAX_REVIEW_LENGTH) return {eligible:false,reason:'Review is too long.'};
  const words = s.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
  const letters = (s.match(/[a-z]/gi)||[]).length;
  if (letters < 8 || words.length < 2) return {eligible:false,reason:'Write a little more about the show.'};
  const condensed = s.toLowerCase().replace(/[^a-z]/g,'');
  if (/(.)\1{5,}/.test(condensed)) return {eligible:false,reason:'Repeated letters do not qualify.'};
  if (/(.{3,16})\1{3,}/.test(condensed)) return {eligible:false,reason:'Repeated text does not qualify.'};
  const uniq = new Set(words);
  if (words.length >= 5 && uniq.size / words.length < .35) return {eligible:false,reason:'Repeated words do not qualify.'};
  const singleChar = words.filter(w=>w.length===1).length;
  if (words.length >= 5 && singleChar / words.length > .6) return {eligible:false,reason:'Enter normal review text.'};
  const longUnbroken = words.filter(w=>w.length>=13);
  if (longUnbroken.some(w=>w.length>32)) return {eligible:false,reason:'Long random character strings do not qualify.'};
  // Random keyboard strings tend to be consonant-heavy and unusually long.
  if (longUnbroken.some(w=>{
    const vowelCount=(w.match(/[aeiouy]/g)||[]).length;
    return vowelCount/w.length < .20 || /[^aeiouy]{7,}/.test(w);
  })) return {eligible:false,reason:'Random-looking character strings do not qualify.'};
  // Padded reviews should not pass the length tiers by repeating the same text.
  // Detect unusually low lexical variety only after enough words to evaluate it.
  if (words.length >= 25 && uniq.size < Math.max(7, Math.floor(words.length*.18))) {
    return {eligible:false,reason:'Please add original thoughts instead of repeated text.'};
  }
  return {eligible:true,reason:''};
}
function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pb_review_gems_rewards (
      user_id INTEGER NOT NULL,
      show_id INTEGER NOT NULL,
      total_awarded INTEGER NOT NULL DEFAULT 0 CHECK(total_awarded BETWEEN 0 AND 65),
      longest_review_chars INTEGER NOT NULL DEFAULT 0,
      created_ts INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_ts INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY(user_id, show_id)
    );
    CREATE TABLE IF NOT EXISTS pb_betting_wallets (
      user_id INTEGER PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 200 CHECK(balance>=0)
    );
    CREATE TABLE IF NOT EXISTS pb_betting_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL, bet_id INTEGER, delta INTEGER NOT NULL,
      reason TEXT NOT NULL, created_ts INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}
// Must be called inside same SQLite transaction as upsertReview.
function award(db,userId,showId,text) {
  const uid=Number(userId),sid=Number(showId);
  if (!Number.isSafeInteger(uid)||uid<1||!Number.isSafeInteger(sid)||sid<1) throw Error('Invalid review identity.');
  const length=characters(text);
  rewardForLength(length); // Retain original review-length validation.
  const result=quality(text);
  init(db);
  const prior=db.prepare('SELECT total_awarded,longest_review_chars FROM pb_review_gems_rewards WHERE user_id=? AND show_id=?').get(uid,sid);
  const already=Number(prior?.total_awarded||0);
  if (!result.eligible) return {credited:0,totalForReview:already,length,eligible:false,reason:result.reason};
  const possible=rewardForLength(length);
  const delta=Math.max(0,possible-already);
  db.prepare(`INSERT INTO pb_review_gems_rewards(user_id,show_id,total_awarded,longest_review_chars)
    VALUES(?,?,?,?) ON CONFLICT(user_id,show_id) DO UPDATE SET
    total_awarded=MAX(total_awarded,excluded.total_awarded),
    longest_review_chars=MAX(longest_review_chars,excluded.longest_review_chars),
    updated_ts=unixepoch()`)
    .run(uid,sid,Math.max(already,possible),Math.max(length,Number(prior?.longest_review_chars||0)));
  if(delta){
    db.prepare('INSERT OR IGNORE INTO pb_betting_wallets(user_id,balance) VALUES (?,200)').run(uid);
    db.prepare('UPDATE pb_betting_wallets SET balance=balance+? WHERE user_id=?').run(delta,uid);
    db.prepare('INSERT INTO pb_betting_ledger(user_id,bet_id,delta,reason) VALUES(?,NULL,?,?)')
      .run(uid,delta,'review_reward:'+sid);
  }
  return {credited:delta,totalForReview:Math.max(already,possible),length,eligible:true,reason:''};
}

// One-time, restart-safe migration of qualifying reviews already in the database.
// Uses the same per-user/show reward record as ordinary review submissions.
// Each qualifying award and wallet/ledger update commits in the SAME transaction.
function backfillExistingReviews(db) {
  init(db);
  const cols = db.prepare('PRAGMA table_info(reviews)').all().map(x=>x.name);
  const textCol = cols.includes('review_text') ? 'review_text' :
    cols.includes('text') ? 'text' : null;
  if(!textCol)throw Error('Cannot backfill review Gems: unknown reviews text column');
  const rows = db.prepare(`SELECT show_id,user_id,${textCol} AS review_text FROM reviews`).all();
  let checked=0,eligible=0,credited=0,gems=0,skipped=0;
  const transaction = db.transaction(()=>{
    for(const row of rows){
      checked++;
      const content=String(row.review_text||'').trim();
      if(!content || characters(content)>MAX_REVIEW_LENGTH){skipped++;continue;}
      const result=award(db,row.user_id,row.show_id,content);
      if(!result.eligible){skipped++;continue;}
      eligible++;
      if(result.credited>0){credited++;gems+=result.credited;}
    }
  });
  transaction();
  return {checked,eligible,credited,gems,skipped};
}
module.exports={award,init,rewardForLength,characters,quality,backfillExistingReviews};
