'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let Database;
try { Database=require('better-sqlite3'); }
catch {
  const {DatabaseSync}=require('node:sqlite');
  Database=class extends DatabaseSync {
    transaction(fn) {return (...args)=>{this.exec('BEGIN IMMEDIATE');try{const result=fn(...args);this.exec('COMMIT');return result;}catch(err){this.exec('ROLLBACK');throw err;}};}
    pragma(exp){this.exec('PRAGMA '+exp);}
  };
}
const cosmetics=require('../cosmetics');
const gems=require('../gems');
const globalCosmetics=require('../global_cosmetics');
function setup(){
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, avatar_url TEXT);
    INSERT INTO users(id,username,avatar_url) VALUES
      (1,'Alice','https://cdn.example.com/pfps/pfp_alice.gif'),
      (2,'Bobby','https://cdn.example.com/pfps/pfp_bobby.png'),
      (3,'Carly',NULL);`);
  return db;
}
test('global API respects equipped ownership and matches case-insensitive usernames',()=>{
  const db=setup();
  try{
    gems.balance(db,1);
    cosmetics.buy(db,1,'frame_sapphire');
    assert.deepEqual(globalCosmetics.lookupAvatarEffects(db,['ALICE','Bobby'],[]),[
      {username:'Alice',avatar_url:'https://cdn.example.com/pfps/pfp_alice.gif',frame:'frame_sapphire',motion:null}
    ]);
    assert.deepEqual(globalCosmetics.lookupAvatarEffects(db,['Bobby'],[]),[]);
    const effects = globalCosmetics.lookupAvatarEffects(db,[],['https://cdn.example.com/pfps/pfp_alice.gif']);
    assert.equal(effects[0].frame,'frame_sapphire');
  } finally {db.close();}
});
test('global cosmetic reads never create wallet credits or deductions',()=>{
  const db=setup();
  try{
    const initial=globalCosmetics.lookupAvatarEffects(db,['Alice'],[]);
    assert.deepEqual(initial,[]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pb_betting_wallets').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM pb_betting_ledger').get().n,0);
  } finally {db.close();}
});
test('unequipped frames disappear across all pages, owned frame remains owned',()=>{
  const db=setup();
  try{
    gems.balance(db,1);
    cosmetics.buy(db,1,'frame_sapphire');
    assert.equal(globalCosmetics.lookupAvatarEffects(db,['Alice'],[])[0].frame,'frame_sapphire');
    cosmetics.equip(db,1,'frame','none');
    assert.deepEqual(globalCosmetics.lookupAvatarEffects(db,['Alice'],[]),[]);
    assert.equal(cosmetics.owns(db,1,'frame_sapphire'),true);
  } finally {db.close();}
});
test('whitelisted cosmetics only; no inventory or Gems data exposed',()=>{
  const db=setup();
  try{
    gems.balance(db,1);
    cosmetics.buy(db,1,'frame_sapphire');
    const row=globalCosmetics.lookupAvatarEffects(db,['Alice'],[])[0];
    assert.deepEqual(Object.keys(row).sort(),['avatar_url','frame','motion','username']);
    assert.equal(row.gem_balance,undefined);
  } finally {db.close();}
});
