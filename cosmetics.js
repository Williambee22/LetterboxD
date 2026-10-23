'use strict';

// Profile cosmetics: permanent ownership, one equipped item per category,
// and atomic virtual-Gems purchases. Never use this module for real money.
const crypto = require('crypto');
const gems = require('./gems');

const CATALOG = Object.freeze([
  { id:'frame_sapphire', category:'frame', name:'Sapphire', price:1000, rarity:'Common', description:'A blue avatar border.' },
  { id:'frame_rose', category:'frame', name:'Rose', price:1000, rarity:'Common', description:'A pink avatar border.' },
  { id:'frame_inferno', category:'frame', name:'Ember', price:2000, rarity:'Rare', description:'An orange and red border.' },
  { id:'frame_gold', category:'frame', name:'Gilded', price:2000, rarity:'Epic', description:'A gold frame.' },
  { id:'frame_aurora', category:'frame', name:'Aurora', price:5000, rarity:'Epic', description:'A shifting northern lights ring.' },
  { id:'frame_prism', category:'frame', name:'Prism', price:10000, rarity:'Legendary', description:'A spinning rainbow border.' },
  { id:'motion_float', category:'motion', name:'Float', price:2500, rarity:'Rare', description:'Your avatar gently floats up and down.' },
  { id:'motion_pulse', category:'motion', name:'Pulse', price:5000, rarity:'Rare', description:'Your avatar pulses in size.' },
  { id:'motion_wobble', category:'motion', name:'Wobble', price:8000, rarity:'Epic', description:'Your avatar tilts side to side.' },
  { id:'name_electric', category:'nameplate', name:'Electric', price:5000, rarity:'Rare', description:'Blue glowing text.' },
  { id:'name_gold', category:'nameplate', name:'Gold Gradient', price:7500, rarity:'Legendary', description:'Gold gradient text.' },
  { id:'name_rainbow', category:'nameplate', name:'Spectrum', price:10000, rarity:'Legendary', description:'Animated rainbow text.' },
  { id:'avatar_gif', category:'unlock', name:'Animated Avatar', price:20000, rarity:'Epic', description:'Allows GIF profile pictures. Permanent.' },
  { id:'frame_obsidian', category:'frame', name:'Obsidian', price:3000, rarity:'Rare', description:'Dark grey with a silver edge.' },
  { id:'frame_crimson', category:'frame', name:'Crimson', price:3500, rarity:'Rare', description:'Dark red border.' },
  { id:'frame_emerald', category:'frame', name:'Emerald', price:3750, rarity:'Rare', description:'Green crystal border.' },
  { id:'frame_amethyst', category:'frame', name:'Amethyst', price:4200, rarity:'Epic', description:'Light purple crystal border.' },
  { id:'frame_frost', category:'frame', name:'Frost', price:4500, rarity:'Epic', description:'Light blue and white border.' },
  { id:'frame_copper', category:'frame', name:'Copper', price:5000, rarity:'Epic', description:'Metallic copper border.' },
  { id:'frame_moonstone', category:'frame', name:'Moonstone', price:6000, rarity:'Epic', description:'White and silver-blue border.' },
  { id:'frame_nebula', category:'frame', name:'Nebula', price:7500, rarity:'Epic', description:'Blue, purple, and pink space theme.' },
  { id:'frame_solar', category:'frame', name:'Solar', price:8000, rarity:'Epic', description:'Bright yellow energy border.' },
  { id:'frame_phantom', category:'frame', name:'Phantom', price:9000, rarity:'Legendary', description:'Light silver with a blue tint.' },
  { id:'frame_toxic', category:'frame', name:'Biohazard', price:10000, rarity:'Legendary', description:'Bright green and dark green border.' },
  { id:'frame_plasma', category:'frame', name:'Plasma', price:12000, rarity:'Legendary', description:'Pink, blue, and purple border.' },
  { id:'frame_eclipse', category:'frame', name:'Eclipse', price:14000, rarity:'Legendary', description:'Dark center with an orange rim.' },
  { id:'frame_celestial', category:'frame', name:'Starlight', price:17000, rarity:'Legendary', description:'White and gold border.' },
  { id:'frame_stardust', category:'frame', name:'Stardust', price:18500, rarity:'Legendary', description:'Light blue and pink sparkle border.' },
  { id:'frame_hologram', category:'frame', name:'Hologram', price:20000, rarity:'Legendary', description:'Shiny shifting chrome border.' },
  { id:'frame_chromatic', category:'frame', name:'Chromatic', price:24000, rarity:'Legendary', description:'Moving color bands.' },
  { id:'frame_lightning', category:'frame', name:'Lightning', price:28000, rarity:'Mythic', description:'White lightning with a blue edge.' },
  { id:'frame_nova', category:'frame', name:'Nova', price:32000, rarity:'Mythic', description:'Red, pink, and gold ring.' },
  { id:'frame_abyss', category:'frame', name:'Abyss', price:38000, rarity:'Mythic', description:'Teal and dark purple border.' },
  { id:'frame_supernova', category:'frame', name:'Supernova', price:45000, rarity:'Mythic', description:'Animated fire border.' },
  { id:'frame_quantum', category:'frame', name:'Quantum', price:55000, rarity:'Mythic', description:'Cyan and violet energy border.' },
  { id:'frame_singularity', category:'frame', name:'Black Hole', price:70000, rarity:'Celestial', description:'Dark center with a bright ring.' },
  { id:'frame_divine', category:'frame', name:'Radiant', price:100000, rarity:'Celestial', description:'Platinum and diamond-white border.' },
  { id:'motion_drift', category:'motion', name:'Drift', price:6000, rarity:'Epic', description:'Slow side-to-side movement.' },
  { id:'motion_bounce', category:'motion', name:'Bounce', price:9500, rarity:'Epic', description:'Smooth bouncing motion.' },
  { id:'motion_spin', category:'motion', name:'Spin', price:11500, rarity:'Legendary', description:'Slow full rotation.' },
  { id:'motion_orbit', category:'motion', name:'Orbit', price:14500, rarity:'Legendary', description:'Circular movement around the avatar.' },
  { id:'motion_shiver', category:'motion', name:'Jitter', price:18000, rarity:'Legendary', description:'Small twitching movements.' },
  { id:'motion_tilt', category:'motion', name:'Tilt', price:22000, rarity:'Legendary', description:'Tilting back and forth.' },
  { id:'motion_glitch', category:'motion', name:'Glitch', price:28000, rarity:'Mythic', description:'Brief digital glitch effect.' },
  { id:'motion_vortex', category:'motion', name:'Vortex', price:36000, rarity:'Mythic', description:'Slow twisting motion.' },
  { id:'motion_astral', category:'motion', name:'Levitate', price:50000, rarity:'Celestial', description:'Floating and breathing motion.' },
  { id:'name_ember', category:'nameplate', name:'Ember Glow', price:6000, rarity:'Epic', description:'Copper colored text.' },
  { id:'name_glacier', category:'nameplate', name:'Glacier', price:7000, rarity:'Epic', description:'Frozen blue text with white highlights.' },
  { id:'name_jade', category:'nameplate', name:'Jade', price:8500, rarity:'Epic', description:'Green and mint colored text.' },
  { id:'name_lavender', category:'nameplate', name:'Lilac', price:9500, rarity:'Epic', description:'Light purple text.' },
  { id:'name_rosefire', category:'nameplate', name:'Magenta Glow', price:12000, rarity:'Legendary', description:'Bright pink text.' },
  { id:'name_chrome', category:'nameplate', name:'Chrome', price:14000, rarity:'Legendary', description:'Reflective silver text.' },
  { id:'name_ghost', category:'nameplate', name:'Mist', price:16000, rarity:'Legendary', description:'White text with a light purple mist.' },
  { id:'name_neon', category:'nameplate', name:'Neon', price:18000, rarity:'Legendary', description:'Hot pink text with a blue glow.' },
  { id:'name_copper', category:'nameplate', name:'Antique Copper', price:20000, rarity:'Legendary', description:'Copper text with gold highlights.' },
  { id:'name_sunset', category:'nameplate', name:'Sunset', price:22000, rarity:'Legendary', description:'Coral, amber, and purple text.' },
  { id:'name_ocean', category:'nameplate', name:'Deep Blue', price:24000, rarity:'Legendary', description:'Blue and aqua text.' },
  { id:'name_celestial', category:'nameplate', name:'White Gold', price:28000, rarity:'Mythic', description:'White gold colored text.' },
  { id:'name_static', category:'nameplate', name:'Voltage', price:32000, rarity:'Mythic', description:'Color-shifting electric blue text.' },
  { id:'name_fire', category:'nameplate', name:'Flame', price:40000, rarity:'Mythic', description:'Animated fire text gradient.' },
  { id:'name_void', category:'nameplate', name:'Twilight', price:50000, rarity:'Mythic', description:'Purple and white text.' },
  { id:'name_holographic', category:'nameplate', name:'Hologram', price:60000, rarity:'Mythic', description:'Cyan, purple, and pink holographic text.' },
  { id:'name_royalty', category:'nameplate', name:'Champagne', price:75000, rarity:'Celestial', description:'Champagne-gold and platinum text.' },
  { id:'name_omnichrome', category:'nameplate', name:'Prism Flow', price:100000, rarity:'Celestial', description:'Full-spectrum moving rainbow text.' }
]);
const ITEMS = new Map(CATALOG.map(item => [item.id, item]));
const CATEGORIES = Object.freeze(['frame','motion','nameplate']);
const MAX_PRICE = 1_000_000_000; // Maximum allowed price in virtual Gems.

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
    CREATE TABLE IF NOT EXISTS pb_cosmetics_price_overrides (
      item_id TEXT PRIMARY KEY,
      price INTEGER NOT NULL CHECK(price >= 0 AND price <= 1000000000),
      updated_by INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS pb_cosmetics_price_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      old_price INTEGER NOT NULL,
      new_price INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('set', 'reset')),
      admin_user_id INTEGER NOT NULL,
      changed_ts INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_pb_cosmetics_price_audit_recent
      ON pb_cosmetics_price_audit(changed_ts DESC, id DESC);
  `);
}

// The code catalog is the default; optional per-item overrides live in SQLite.
// These functions always read the current connection, so changes work across
// processes/redeploys and never depend on an in-memory cache.
function effectivePrice(db, item) {
  const row = db.prepare('SELECT price FROM pb_cosmetics_price_overrides WHERE item_id=?').get(item.id);
  return row ? Number(row.price) : item.price;
}

function getCatalog(db) {
  initialize(db);
  const overrides = new Map(
    db.prepare('SELECT item_id,price FROM pb_cosmetics_price_overrides').all()
      .map(row => [row.item_id, Number(row.price)])
  );
  return CATALOG.map(item => ({
    ...item,
    price: overrides.has(item.id) ? overrides.get(item.id) : item.price,
    defaultPrice: item.price,
    isOverridden: overrides.has(item.id)
  }));
}

function priceHistory(db, limit=25) {
  initialize(db);
  const safeLimit=Math.max(1,Math.min(100,Number(limit)||25));
  return db.prepare(`
    SELECT h.item_id,h.old_price,h.new_price,h.operation,h.changed_ts,
           h.admin_user_id,COALESCE(u.username,'Admin #' || h.admin_user_id) AS admin_name
    FROM pb_cosmetics_price_audit h
    LEFT JOIN users u ON u.id=h.admin_user_id
    ORDER BY h.id DESC LIMIT ?
  `).all(safeLimit);
}

// Admin permissions are verified against the current database row, not a
// browser-supplied value or stale session.is_admin flag.
function isStoreAdmin(db, userId) {
  const uid=Number(userId);
  if (!Number.isSafeInteger(uid) || uid<=0) return false;
  const row=db.prepare('SELECT is_admin FROM users WHERE id=?').get(uid);
  return Number(row?.is_admin) === 1;
}

function changePrice(db, adminId, itemId, rawPrice, reset=false) {
  const uid=Number(adminId);
  const id=String(itemId || '').trim();
  const item=ITEMS.get(id);
  if (!item) throw new Error('Unknown cosmetic item.');
  initialize(db);
  if (!isStoreAdmin(db,uid)) throw new Error('Administrator access required.');
  let price;
  if (!reset) {
    const input=String(rawPrice ?? '').trim();
    if (!/^\d{1,12}$/.test(input)) throw new Error('Enter a whole-number Gem price.');
    price=Number(input);
    if (!Number.isSafeInteger(price) || price < 0 || price > MAX_PRICE) {
      throw new Error('Price must be between 0 and 1,000,000,000 Gems.');
    }
  }
  const tx=db.transaction(() => {
    const oldPrice=effectivePrice(db,item);
    const newPrice=reset ? item.price : price;
    const previousOverride=db.prepare('SELECT price FROM pb_cosmetics_price_overrides WHERE item_id=?').get(id);
    if (reset) {
      if (!previousOverride) return {item,oldPrice,newPrice,changed:false};
      db.prepare('DELETE FROM pb_cosmetics_price_overrides WHERE item_id=?').run(id);
    } else {
      if (previousOverride && Number(previousOverride.price) === newPrice) {
        return {item,oldPrice,newPrice,changed:false};
      }
      db.prepare(`
        INSERT INTO pb_cosmetics_price_overrides(item_id,price,updated_by,updated_ts)
        VALUES (?,?,?,unixepoch())
        ON CONFLICT(item_id) DO UPDATE SET
          price=excluded.price, updated_by=excluded.updated_by, updated_ts=unixepoch()
      `).run(id,newPrice,uid);
    }
    db.prepare(`
      INSERT INTO pb_cosmetics_price_audit(item_id,old_price,new_price,operation,admin_user_id)
      VALUES (?,?,?,?,?)
    `).run(id,oldPrice,newPrice,reset?'reset':'set',uid);
    return {item,oldPrice,newPrice,changed:true};
  });
  return typeof tx.immediate === 'function' ? tx.immediate() : tx();
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
  const out = { frame: null, motion: null, nameplate: null };
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
  const tx=db.transaction(() => {
    if (owns(db, uid, item.id)) throw new Error('You already own this item.');
    // Read the price INSIDE the same write transaction used for the debit.
    // Admin edits and purchases cannot charge a stale price.
    const currentPrice=effectivePrice(db,item);
    gems.balance(db, uid); // Creates a wallet only if one does not already exist.
    const debit = db.prepare('UPDATE pb_betting_wallets SET balance=balance-? WHERE user_id=? AND balance>=?').run(currentPrice, uid, currentPrice);
    if (debit.changes !== 1) throw new Error('Not enough Gems for this item.');
    db.prepare('INSERT INTO pb_cosmetics_inventory(user_id,item_id,price_paid) VALUES (?,?,?)').run(uid,item.id,currentPrice);
    db.prepare('INSERT INTO pb_betting_ledger(user_id,delta,reason) VALUES(?,?,?)').run(uid,-currentPrice,`cosmetic:${item.id}`);
    // The first item in a category is automatically equipped.
    if (CATEGORIES.includes(item.category)) {
      db.prepare('INSERT OR IGNORE INTO pb_cosmetics_equipped(user_id,category,item_id) VALUES (?,?,?)').run(uid,item.category,item.id);
    }
    return { item: {...item,price:currentPrice}, balance: gems.balance(db, uid) };
  });
  return typeof tx.immediate === 'function' ? tx.immediate() : tx();
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
        catalog:getCatalog(db),
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
  // Verify admin rights directly in the database on every admin request.
  function requireStoreAdmin(req,res,next) {
    if (!req.session?.uid) return res.redirect('/login?next=%2Fstore%2Fadmin');
    let db;
    try {
      db=getConn();
      if (!isStoreAdmin(db,req.session.uid)) return res.status(403).send('Store admin access required.');
      return next();
    } catch(err) { return next(err); }
    finally { if (db) db.close(); }
  }

  app.get('/store/admin',requireStoreAdmin,(req,res,next)=>{
    let db;
    try {
      db=getConn();
      res.set('Cache-Control','private, no-store');
      return res.render('cosmetics_admin',{
        me:res.locals.me || null,
        catalog:getCatalog(db),
        history:priceHistory(db,25),
        csrf:csrfToken(req),
        maxPrice:MAX_PRICE,
        notice:String(req.query.ok||'').slice(0,180),
        error:String(req.query.error||'').slice(0,180)
      });
    } catch(err) { return next(err); }
    finally { if(db) db.close(); }
  });

  app.post('/store/admin/price',requireStoreAdmin,validateWrite,(req,res,next)=>{
    let db;
    try {
      db=getConn();
      const reset=String(req.body.reset||'')==='1';
      const result=changePrice(db,req.session.uid,req.body.item_id,req.body.price,reset);
      const message=result.changed
        ? result.item.name+' updated to '+result.newPrice.toLocaleString()+' Gems.'
        : 'No price change needed for '+result.item.name+'.';
      return res.redirect('/store/admin?ok='+encodeURIComponent(message)+'#item-'+encodeURIComponent(result.item.id));
    } catch(err) {
      if (err.code && String(err.code).startsWith('SQLITE_')) return next(err);
      return res.redirect('/store/admin?error='+encodeURIComponent(err.message||'Unable to change price.'));
    } finally { if (db) db.close(); }
  });

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

module.exports={CATALOG,ITEMS,CATEGORIES,MAX_PRICE,initialize,owns,inventory,getEquipped,getCatalog,priceHistory,isStoreAdmin,changePrice,buy,equip,mount};
