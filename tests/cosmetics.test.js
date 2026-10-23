'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  // Run the same SQLite data-access tests on Node 22+ without npm install.
  const { DatabaseSync } = require('node:sqlite');
  Database = class TestSqliteDatabase extends DatabaseSync {
    pragma(expression) { this.exec('PRAGMA ' + expression); }
    transaction(fn) {
      return (...args) => {
        this.exec('BEGIN IMMEDIATE');
        try {
          const value = fn(...args);
          this.exec('COMMIT');
          return value;
        } catch (error) {
          this.exec('ROLLBACK');
          throw error;
        }
      };
    }
  };
}
const cosmetics = require('../cosmetics');
const gems = require('../gems');

function database() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE)');
  db.prepare('INSERT INTO users(id,username) VALUES(?,?)').run(1,'alpha');
  db.prepare('INSERT INTO users(id,username) VALUES(?,?)').run(2,'beta');
  return db;
}

test('purchasing a frame atomically deducts exactly its cost', () => {
  const db=database();
  try {
    assert.equal(gems.balance(db,1),200);
    const purchase=cosmetics.buy(db,1,'frame_sapphire');
    assert.equal(purchase.balance,75);
    assert.equal(cosmetics.owns(db,1,'frame_sapphire'),true);
    assert.equal(cosmetics.owns(db,2,'frame_sapphire'),false);
    assert.equal(cosmetics.getEquipped(db,1).frame,'frame_sapphire');
    const log=db.prepare("SELECT delta,reason FROM pb_betting_ledger WHERE user_id=1").all().map(r=>({delta:r.delta,reason:r.reason}));
    assert.deepEqual(log,[{delta:-125,reason:'cosmetic:frame_sapphire'}]);
  } finally { db.close(); }
});

test('cannot buy item twice or debit wallet twice', () => {
  const db=database();
  try {
    cosmetics.buy(db,1,'frame_sapphire');
    assert.throws(()=>cosmetics.buy(db,1,'frame_sapphire'),/already own/);
    assert.equal(gems.balance(db,1),75);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pb_betting_ledger WHERE user_id=1').get().n,1);
  } finally {db.close();}
});

test('insufficient funds leave inventory and balances unchanged', () => {
  const db=database();
  try {
    assert.throws(()=>cosmetics.buy(db,1,'frame_prism'),/Not enough Gems/);
    assert.equal(gems.balance(db,1),200);
    assert.equal(cosmetics.owns(db,1,'frame_prism'),false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pb_betting_ledger').get().n,0);
  } finally {db.close();}
});

test('cannot equip unowned items or in the wrong category',()=>{
  const db=database();
  try {
    assert.throws(()=>cosmetics.equip(db,1,'frame','frame_gold'),/must own/);
    cosmetics.buy(db,1,'frame_sapphire');
    assert.throws(()=>cosmetics.equip(db,1,'motion','frame_sapphire'),/cannot be equipped/);
    assert.throws(()=>cosmetics.equip(db,2,'frame','frame_sapphire'),/must own/);
    assert.equal(cosmetics.getEquipped(db,1).frame,'frame_sapphire');
  } finally {db.close();}
});

test('equipping and unequipping does not spend Gems or delete the purchase',()=>{
  const db=database();
  try {
    gems.balance(db,1);
    db.prepare('UPDATE pb_betting_wallets SET balance=1000 WHERE user_id=1').run();
    cosmetics.buy(db,1,'frame_sapphire');
    cosmetics.buy(db,1,'frame_rose');
    assert.equal(gems.balance(db,1),650);
    cosmetics.equip(db,1,'frame','frame_rose');
    assert.equal(cosmetics.getEquipped(db,1).frame,'frame_rose');
    cosmetics.equip(db,1,'frame','none');
    assert.equal(cosmetics.getEquipped(db,1).frame,null);
    assert.equal(cosmetics.owns(db,1,'frame_rose'),true);
    assert.equal(gems.balance(db,1),650);
  } finally {db.close();}
});

test('animated GIF unlock is owned but cannot be equipped as a frame',()=>{
  const db=database();
  try {
    gems.balance(db,1);
    db.prepare('UPDATE pb_betting_wallets SET balance=800 WHERE user_id=1').run();
    cosmetics.buy(db,1,'avatar_gif');
    assert.equal(gems.balance(db,1),50);
    assert.equal(cosmetics.owns(db,1,'avatar_gif'),true);
    assert.throws(()=>cosmetics.equip(db,1,'frame','avatar_gif'),/cannot be equipped/);
  } finally {db.close();}
});
