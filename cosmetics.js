'use strict';

// Profile cosmetics: permanent ownership, one equipped item per category,
// and atomic virtual-Gems purchases. Never use this module for real money.
const crypto = require('crypto');
const gems = require('./gems');

const CATALOG = Object.freeze([
  { id:'frame_sapphire', category:'frame', name:'Sapphire Glow', price:1000, rarity:'Common', description:'A crisp, electric-blue avatar ring.' },
  { id:'frame_rose', category:'frame', name:'Rose Quartz', price:1000, rarity:'Common', description:'A soft neon-pink halo.' },
  { id:'frame_inferno', category:'frame', name:'Inferno', price:2000, rarity:'Rare', description:'A fiery orange-red border.' },
  { id:'frame_gold', category:'frame', name:'Golden Hour', price:2000, rarity:'Epic', description:'A warm, luminous gold frame.' },
  { id:'frame_aurora', category:'frame', name:'Aurora', price:5000, rarity:'Epic', description:'An animated northern-lights ring.' },
  { id:'frame_prism', category:'frame', name:'Prismatic', price:10000, rarity:'Legendary', description:'A rotating rainbow border.' },
  { id:'motion_float', category:'motion', name:'Levitate', price:2500, rarity:'Rare', description:'Your profile avatar gently floats.' },
  { id:'motion_pulse', category:'motion', name:'Heartbeat', price:5000, rarity:'Rare', description:'Your avatar gently pulses with energy.' },
  { id:'motion_wobble', category:'motion', name:'Wobble', price:8000, rarity:'Epic', description:'A playful, animated avatar tilt.' },
  { id:'profile_night', category:'background', name:'Midnight', price:300, rarity:'Rare', description:'Deep violet profile atmosphere.' },
  { id:'profile_galaxy', category:'background', name:'Starlight', price:650, rarity:'Epic', description:'A galaxy-like profile header.' },
  { id:'profile_sunset', category:'background', name:'Synthwave', price:900, rarity:'Legendary', description:'Retro neon sunset profile styling.' },
  { id:'name_electric', category:'nameplate', name:'Electric Name', price:5000, rarity:'Rare', description:'Blue glowing username treatment.' },
  { id:'name_gold', category:'nameplate', name:'Royal Name', price:7500, rarity:'Epic', description:'Gold gradient username treatment.' },
  { id:'name_rainbow', category:'nameplate', name:'Spectrum Name', price:10000, rarity:'Legendary', description:'Animated gradient username treatment.' },
  { id:'avatar_gif', category:'unlock', name:'Animated Avatar Upload', price:20000, rarity:'Epic', description:'Unlock GIF uploads for your profile picture. Permanent.' }
]);
const ITEMS = new Map(CATALOG.map(item => [item.id, item]));
const CATEGORIES = Object.freeze(['frame','motion','background','nameplate']);

function initialize(db) {
  gems.initialize(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pb_cosmetics_inventory (
      user_id INTEGER NOT NULL,
      item_id TEXT NOT NULL,
      purchased_ts INTEGER NOT NULL DEFAULT (unixepoch()),
      price_paid INTEGER NOT NULL CHECK (price_paid >= 0),
      PRIMARY KEY (user_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS pb_cosmetics_equipped (
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      item_id TEXT NOT NULL,
      equipped_ts INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (user_id, category),
      FOREIGN KEY (user_id, item_id) REFERENCES pb_cosmetics_inventory(user_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pb_cosmetics_equipped_item ON pb_cosmetics_equipped(item_id);
  `);
}

function owns(db, userId, itemId) {
  initialize(db);
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0 || !ITEMS.has(itemId)) return false;
  return !!db.prepare('SELECT 1 FROM pb_cosmetics_inventory WHERE user_id=? AND item_id=?').get(uid, itemId);
}

function inventory(db, userId) {
  initialize(db);
  const uid = Number(userId);
  if (!Number.isSafeInteger(uid) || uid <= 0) return [];
  return db.prepare('SELECT item_id, purchased_ts, price_paid FROM pb_cosmetics_inventory WHERE user_id=? ORDER BY purchased_ts DESC').all(uid);
}

function getEquipped(db, userId) {
  initialize(db);
  const uid = Number(userId);
  const out = { frame: null, motion: null, background: null, nameplate: null };
  if (!Number.isSafeInteger(uid) || uid <= 0) return out;
  const rows = db.prepare(`
    SELECT e.category, e.item_id
    FROM pb_cosmetics_equipped e
    JOIN pb_cosmetics_inventory i ON i.user_id=e.user_id AND i.item_id=e.item_id
    WHERE e.user_id=?
  `).all(uid);
  for (const row of rows) {
    if (CATEGORIES.includes(row.category) && ITEMS.get(row.item_id)?.category === row.category) {
      out[row.category] = row.item_id;
    }
  }
  return out;
}

function buy(db, userId, itemId) {
  const item = ITEMS.get(String(itemId));
  const uid = Number(userId);
  if (!item) throw new Error('Unknown store item.');
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Sign in to purchase cosmetics.');
  initialize(db);
  return db.transaction(() => {
    if (owns(db, uid, item.id)) throw new Error('You already own this item.');
    gems.balance(db, uid); // Creates a wallet only if one does not already exist.
    const debit = db.prepare('UPDATE pb_betting_wallets SET balance=balance-? WHERE user_id=? AND balance>=?').run(item.price, uid, item.price);
    if (debit.changes !== 1) throw new Error('Not enough Gems for this item.');
    db.prepare('INSERT INTO pb_cosmetics_inventory(user_id,item_id,price_paid) VALUES (?,?,?)').run(uid,item.id,item.price);
    db.prepare('INSERT INTO pb_betting_ledger(user_id,delta,reason) VALUES(?,?,?)').run(uid,-item.price,`cosmetic:${item.id}`);
    // The first item in a category is automatically equipped.
    if (CATEGORIES.includes(item.category)) {
      db.prepare('INSERT OR IGNORE INTO pb_cosmetics_equipped(user_id,category,item_id) VALUES (?,?,?)').run(uid,item.category,item.id);
    }
    return { item, balance: gems.balance(db, uid) };
  })();
}

function equip(db, userId, category, itemId) {
  const uid = Number(userId);
  const type = String(category || '');
  const id = String(itemId || '');
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Sign in first.');
  if (!CATEGORIES.includes(type)) throw new Error('Unknown cosmetic category.');
  initialize(db);
  return db.transaction(() => {
    if (!id || id === 'none') {
      db.prepare('DELETE FROM pb_cosmetics_equipped WHERE user_id=? AND category=?').run(uid,type);
      return getEquipped(db,uid);
    }
    const item = ITEMS.get(id);
    if (!item || item.category !== type) throw new Error('That item cannot be equipped here.');
    if (!owns(db,uid,id)) throw new Error('You must own an item before equipping it.');
    db.prepare(`
      INSERT INTO pb_cosmetics_equipped(user_id,category,item_id)
      VALUES (?,?,?)
      ON CONFLICT(user_id,category) DO UPDATE SET item_id=excluded.item_id, equipped_ts=unixepoch()
    `).run(uid,type,id);
    return getEquipped(db,uid);
  })();
}

function sameOrigin(req) {
  for (const h of ['origin','referer']) {
    const raw = req.get(h);
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.host !== req.get('host') || !['http:','https:'].includes(url.protocol)) return false;
    } catch { return false; }
  }
  return true;
}
function csrfToken(req) {
  if (!req.session.cosmeticsCsrf) req.session.cosmeticsCsrf = crypto.randomBytes(32).toString('hex');
  return req.session.cosmeticsCsrf;
}
function validateWrite(req,res,next) {
  if (!req.session?.uid) return res.redirect('/login?next=%2Fstore');
  if (!sameOrigin(req)) return res.status(403).send('Invalid request origin.');
  const expected = String(req.session.cosmeticsCsrf || '');
  const provided = String(req.body.csrf || '');
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(provided) ||
      !crypto.timingSafeEqual(Buffer.from(expected, 'hex'),Buffer.from(provided, 'hex'))) {
    return res.status(403).send('Invalid form token. Refresh the store and try again.');
  }
  next();
}

function mount(app, getConn) {
  function page(req,res,view) {
    const db=getConn();
    try {
      initialize(db);
      const uid=Number(req.session?.uid || 0);
      const owned=uid?inventory(db,uid):[];
      const equipped=uid?getEquipped(db,uid):getEquipped(db,0);
      const balance=uid?gems.balance(db,uid):null;
      res.set('Cache-Control','private, no-store');
      return res.render(view,{
        me:res.locals.me || null,
        catalog:CATALOG,
        owned_ids:new Set(owned.map(x=>x.item_id)),
        owned,
        equipped,
        balance,
        csrf:uid?csrfToken(req):'',
        notice:String(req.query.ok||'').slice(0,100),
        error:String(req.query.error||'').slice(0,150)
      });
    } finally { db.close(); }
  }
  app.get('/store',(req,res)=>page(req,res,'cosmetics_store'));
  app.get('/me/cosmetics',(req,res)=>{
    if(!req.session?.uid) return res.redirect('/login?next=%2Fme%2Fcosmetics');
    return page(req,res,'cosmetics_inventory');
  });
  app.post('/store/buy',validateWrite,(req,res,next)=>{
    const db=getConn();
    try {
      const result=buy(db,req.session.uid,req.body.item_id);
      res.redirect('/store?ok='+encodeURIComponent(result.item.name+' purchased!'));
    } catch(err) {
      if (err.message?.includes('SQLITE')) return next(err);
      res.redirect('/store?error='+encodeURIComponent(err.message || 'Purchase failed.'));
    } finally { db.close(); }
  });
  app.post('/store/equip',validateWrite,(req,res,next)=>{
    const db=getConn();
    try {
      equip(db,req.session.uid,req.body.category,req.body.item_id);
      res.redirect('/me/cosmetics?ok='+encodeURIComponent('Cosmetic updated!'));
    } catch(err) {
      if (err.message?.includes('SQLITE')) return next(err);
      res.redirect('/me/cosmetics?error='+encodeURIComponent(err.message || 'Could not equip item.'));
    } finally { db.close(); }
  });
}

module.exports={CATALOG,ITEMS,CATEGORIES,initialize,owns,inventory,getEquipped,buy,equip,mount};
