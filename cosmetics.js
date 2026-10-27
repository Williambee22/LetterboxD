
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
  { id:'name_electric', category:'nameplate', name:'Electric Name', price:5000, rarity:'Rare', description:'Blue glowing username treatment.' },
  { id:'name_gold', category:'nameplate', name:'Royal Name', price:7500, rarity:'Epic', description:'Gold gradient username treatment.' },
  { id:'name_rainbow', category:'nameplate', name:'Spectrum Name', price:10000, rarity:'Legendary', description:'Animated gradient username treatment.' },
  { id:'avatar_gif', category:'unlock', name:'Animated Avatar Upload', price:20000, rarity:'Epic', description:'Unlock GIF uploads for your profile picture. Permanent.' },
  {"id":"frame_obsidian","category":"frame","name":"Obsidian Edge","price":3000,"rarity":"Rare","description":"Polished onyx edged with icy silver."},
  {"id":"frame_crimson","category":"frame","name":"Crimson Crown","price":3500,"rarity":"Rare","description":"Deep ruby enamel with luminous crimson trim."},
  {"id":"frame_emerald","category":"frame","name":"Emerald Halo","price":3750,"rarity":"Rare","description":"Vivid green crystal with a jade outer light."},
  {"id":"frame_amethyst","category":"frame","name":"Amethyst Arc","price":4200,"rarity":"Epic","description":"Faceted violet light with a royal-purple gleam."},
  {"id":"frame_frost","category":"frame","name":"Frostbite","price":4500,"rarity":"Epic","description":"Subzero cyan and snow-white frost."},
  {"id":"frame_copper","category":"frame","name":"Molten Copper","price":5000,"rarity":"Epic","description":"Rose-copper shine with forged-metal depth."},
  {"id":"frame_moonstone","category":"frame","name":"Moonstone","price":6000,"rarity":"Epic","description":"Iridescent white and silver-blue moonlight."},
  {"id":"frame_nebula","category":"frame","name":"Nebula Veil","price":7500,"rarity":"Epic","description":"Clouds of indigo, fuchsia and blue."},
  {"id":"frame_solar","category":"frame","name":"Solar Flare","price":8000,"rarity":"Epic","description":"Bright molten-yellow solar energy."},
  {"id":"frame_phantom","category":"frame","name":"Phantom Silver","price":9000,"rarity":"Legendary","description":"Spectral white-silver with a faint blue shadow."},
  {"id":"frame_toxic","category":"frame","name":"Toxic Reactor","price":10000,"rarity":"Legendary","description":"Radioactive chartreuse outlined in deep green."},
  {"id":"frame_plasma","category":"frame","name":"Plasma Coil","price":12000,"rarity":"Legendary","description":"Hot pink, charged blue and electric purple."},
  {"id":"frame_eclipse","category":"frame","name":"Total Eclipse","price":14000,"rarity":"Legendary","description":"A darkened sun rimmed by molten amber."},
  {"id":"frame_celestial","category":"frame","name":"Celestial Crown","price":17000,"rarity":"Legendary","description":"Pearlescent starlight and heavenly gold."},
  {"id":"frame_stardust","category":"frame","name":"Stardust Trail","price":18500,"rarity":"Legendary","description":"Glittering pale blue and pink cosmic dust."},
  {"id":"frame_hologram","category":"frame","name":"Hologram","price":20000,"rarity":"Legendary","description":"Liquid chrome shifting through holographic hues."},
  {"id":"frame_chromatic","category":"frame","name":"Chromatic Flux","price":24000,"rarity":"Legendary","description":"Saturated spectral bands in constant motion."},
  {"id":"frame_lightning","category":"frame","name":"Thunderstrike","price":28000,"rarity":"Mythic","description":"White-hot lightning edged with electric cobalt."},
  {"id":"frame_nova","category":"frame","name":"Nova Burst","price":32000,"rarity":"Mythic","description":"A radiant corona of red, pink and gold."},
  {"id":"frame_abyss","category":"frame","name":"Abyssal Gate","price":38000,"rarity":"Mythic","description":"Deep-sea teal with a black-violet interior."},
  {"id":"frame_supernova","category":"frame","name":"Supernova","price":45000,"rarity":"Mythic","description":"A blazing supernova with rolling spectral fire."},
  {"id":"frame_quantum","category":"frame","name":"Quantum Shift","price":55000,"rarity":"Mythic","description":"Unstable electric cyan and violet energy."},
  {"id":"frame_singularity","category":"frame","name":"Singularity","price":70000,"rarity":"Celestial","description":"A dark gravitational ring surrounded by intense light."},
  {"id":"frame_divine","category":"frame","name":"Divine Ascension","price":100000,"rarity":"Celestial","description":"Radiant platinum, sunlight and diamond-white brilliance."},
  {"id":"motion_drift","category":"motion","name":"Zero Gravity","price":6000,"rarity":"Epic","description":"An unhurried weightless side-to-side drift."},
  {"id":"motion_bounce","category":"motion","name":"Spring Loaded","price":9500,"rarity":"Epic","description":"Smooth, elastic bounces without leaving the avatar spot."},
  {"id":"motion_spin","category":"motion","name":"Orbiting","price":11500,"rarity":"Legendary","description":"A continuous, gentle full revolution."},
  {"id":"motion_orbit","category":"motion","name":"Satellite","price":14500,"rarity":"Legendary","description":"Slow circular movement around the avatar position."},
  {"id":"motion_shiver","category":"motion","name":"Static Charge","price":18000,"rarity":"Legendary","description":"Small intermittent charged micro-movements."},
  {"id":"motion_tilt","category":"motion","name":"Pendulum","price":22000,"rarity":"Legendary","description":"Controlled alternating tilt with a subtle rise."},
  {"id":"motion_glitch","category":"motion","name":"Digital Distortion","price":28000,"rarity":"Mythic","description":"Brief, purposeful glitch jolts and recovery."},
  {"id":"motion_vortex","category":"motion","name":"Vortex","price":36000,"rarity":"Mythic","description":"A slow twisting magnetic pull."},
  {"id":"motion_astral","category":"motion","name":"Astral Projection","price":50000,"rarity":"Celestial","description":"Dreamlike floating, tilting and breathing motion."},
  {"id":"name_ember","category":"nameplate","name":"Ember Script","price":6000,"rarity":"Epic","description":"Burnished copper lettering with a warm ember glow."},
  {"id":"name_glacier","category":"nameplate","name":"Glacial","price":7000,"rarity":"Epic","description":"Frozen-blue lettering with frosty white highlights."},
  {"id":"name_jade","category":"nameplate","name":"Jade Monarch","price":8500,"rarity":"Epic","description":"Luxurious emerald and mint gemstone type."},
  {"id":"name_lavender","category":"nameplate","name":"Lilac Dream","price":9500,"rarity":"Epic","description":"Soft lilac-to-violet lettering with delicate light."},
  {"id":"name_rosefire","category":"nameplate","name":"Rosefire","price":12000,"rarity":"Legendary","description":"Hot magenta lettering with a rose-pink flare."},
  {"id":"name_chrome","category":"nameplate","name":"Liquid Chrome","price":14000,"rarity":"Legendary","description":"Reflective silver metallic typography."},
  {"id":"name_ghost","category":"nameplate","name":"Ghostwriter","price":16000,"rarity":"Legendary","description":"Spectral white lettering with a pale violet mist."},
  {"id":"name_neon","category":"nameplate","name":"Neon Overdrive","price":18000,"rarity":"Legendary","description":"Hot fuchsia with an electric blue afterglow."},
  {"id":"name_copper","category":"nameplate","name":"Copperplate","price":20000,"rarity":"Legendary","description":"Shimmering antiqued copper and golden highlights."},
  {"id":"name_sunset","category":"nameplate","name":"Sunset Drive","price":22000,"rarity":"Legendary","description":"Moving coral, amber and purple-gold bands."},
  {"id":"name_ocean","category":"nameplate","name":"Deep Current","price":24000,"rarity":"Legendary","description":"Rippling aqua, azure and deep-sea blue."},
  {"id":"name_celestial","category":"nameplate","name":"Starborn","price":28000,"rarity":"Mythic","description":"White gold and distant starlight captured in letters."},
  {"id":"name_static","category":"nameplate","name":"Voltage","price":32000,"rarity":"Mythic","description":"Iridescent electric blue with lively color shifts."},
  {"id":"name_fire","category":"nameplate","name":"Phoenix Flame","price":40000,"rarity":"Mythic","description":"Rolling fire gradients without fast flashing."},
  {"id":"name_void","category":"nameplate","name":"Voidwalker","price":50000,"rarity":"Mythic","description":"Violet twilight against cold cosmic white."},
  {"id":"name_holographic","category":"nameplate","name":"Holographic Elite","price":60000,"rarity":"Mythic","description":"An animated cyan, purple and rose holographic finish."},
  {"id":"name_royalty","category":"nameplate","name":"Imperial","price":75000,"rarity":"Celestial","description":"Animated champagne-gold and platinum prestige."},
  {"id":"name_omnichrome","category":"nameplate","name":"Omnichrome","price":100000,"rarity":"Celestial","description":"A constantly flowing full-spectrum name treatment."},
  {
    id: 'frame_oatmeal',
    category: 'frame',
    name: 'Oatmeal',
    price: 0,
    rarity: 'Secret',
    description: 'Unlocked after finding a secret.'
  }
]);

const ITEMS = new Map(CATALOG.map(item => [item.id, item]));
const CATEGORIES = Object.freeze(['frame','motion','nameplate']);
const MAX_PRICE = 1_000_000_000;
const RARITIES = Object.freeze([...new Set(CATALOG.map(item => item.rarity))]);

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
    CREATE TABLE IF NOT EXISTS pb_cosmetics_metadata_overrides (
      item_id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
      rarity TEXT NOT NULL,
      updated_by INTEGER NOT NULL,
      updated_ts INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS pb_cosmetics_metadata_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      old_name TEXT NOT NULL,
      new_name TEXT NOT NULL,
      old_rarity TEXT NOT NULL,
      new_rarity TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('set', 'reset')),
      admin_user_id INTEGER NOT NULL,
      changed_ts INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_pb_cosmetics_metadata_audit_recent
      ON pb_cosmetics_metadata_audit(id DESC);
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
  const prices = new Map(
    db.prepare('SELECT item_id,price FROM pb_cosmetics_price_overrides').all()
      .map(row => [row.item_id, Number(row.price)])
  );
  const metadata = new Map(
    db.prepare('SELECT item_id,name,rarity FROM pb_cosmetics_metadata_overrides').all()
      .map(row => [row.item_id, row])
  );
  return CATALOG.map(item => {
    const changed=metadata.get(item.id);
    return {
      ...item,
      name: changed ? changed.name : item.name,
      rarity: changed ? changed.rarity : item.rarity,
      price: prices.has(item.id) ? prices.get(item.id) : item.price,
      defaultPrice: item.price,
      defaultName: item.name,
      defaultRarity: item.rarity,
      isOverridden: prices.has(item.id),
      nameOverridden: !!changed && changed.name !== item.name,
      rarityOverridden: !!changed && changed.rarity !== item.rarity,
      metadataOverridden: !!changed
    };
  });
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

// Separate audit log of all catalog name / rarity edits.
function metadataHistory(db, limit=25) {
  initialize(db);
  const safeLimit=Math.max(1,Math.min(100,Number(limit)||25));
  return db.prepare(`
    SELECT h.item_id,h.old_name,h.new_name,h.old_rarity,h.new_rarity,
           h.operation,h.changed_ts,h.admin_user_id,
           COALESCE(u.username,'Admin #' || h.admin_user_id) AS admin_name
    FROM pb_cosmetics_metadata_audit h
    LEFT JOIN users u ON u.id=h.admin_user_id
    ORDER BY h.id DESC LIMIT ?
  `).all(safeLimit);
}

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

function changeMetadata(db, adminId, itemId, rawName, rawRarity, reset=false) {
  const uid=Number(adminId);
  const id=String(itemId || '').trim();
  const item=ITEMS.get(id);
  if (!item) throw new Error('Unknown cosmetic item.');
  initialize(db);
  if (!isStoreAdmin(db,uid)) throw new Error('Administrator access required.');

  let name=item.name;
  let rarity=item.rarity;
  if (!reset) {
    if (typeof rawName !== 'string') throw new Error('Enter a cosmetic name.');
    name=rawName.trim();
    if (!name || Array.from(name).length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error('Cosmetic name must contain 1–80 printable characters.');
    }
    rarity=String(rawRarity || '');
    if (!RARITIES.includes(rarity)) throw new Error('Choose a valid cosmetic rarity.');
  }
  const tx=db.transaction(() => {
    const prev=db.prepare('SELECT name,rarity FROM pb_cosmetics_metadata_overrides WHERE item_id=?').get(id);
    const oldName=prev ? prev.name : item.name;
    const oldRarity=prev ? prev.rarity : item.rarity;
    const changed=(oldName !== name || oldRarity !== rarity);
    if (reset) {
      if (!prev) return {item,changed:false,oldName,oldRarity,newName:name,newRarity:rarity};
      db.prepare('DELETE FROM pb_cosmetics_metadata_overrides WHERE item_id=?').run(id);
    } else if (name===item.name && rarity===item.rarity) {
      if (!prev) return {item,changed:false,oldName,oldRarity,newName:name,newRarity:rarity};
      db.prepare('DELETE FROM pb_cosmetics_metadata_overrides WHERE item_id=?').run(id);
    } else {
      if (!changed) return {item,changed:false,oldName,oldRarity,newName:name,newRarity:rarity};
      db.prepare(`
        INSERT INTO pb_cosmetics_metadata_overrides(item_id,name,rarity,updated_by,updated_ts)
        VALUES (?,?,?,?,unixepoch())
        ON CONFLICT(item_id) DO UPDATE SET
          name=excluded.name,rarity=excluded.rarity,
          updated_by=excluded.updated_by,updated_ts=unixepoch()
      `).run(id,name,rarity,uid);
    }
    if (changed) {
      db.prepare(`
        INSERT INTO pb_cosmetics_metadata_audit
          (item_id,old_name,new_name,old_rarity,new_rarity,operation,admin_user_id)
        VALUES (?,?,?,?,?,?,?)
      `).run(id,oldName,name,oldRarity,rarity,reset?'reset':'set',uid);
    }
    return {item,changed,oldName,oldRarity,newName:name,newRarity:rarity};
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
  const rows=db.prepare(`
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

  if (item?.id === 'frame_oatmeal') {
    throw new Error('This frame can only be unlocked by finding a secret.');
  }

  const uid=Number(userId);
  if (!item) throw new Error('Unknown store item.');
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Sign in to purchase cosmetics.');
  initialize(db);
  const tx=db.transaction(() => {
    if (owns(db,uid,item.id)) throw new Error('You already own this item.');
    const currentPrice=effectivePrice(db,item);
    gems.balance(db,uid);
    const debit=db.prepare(
      'UPDATE pb_betting_wallets SET balance=balance-? WHERE user_id=? AND balance>=?'
    ).run(currentPrice,uid,currentPrice);
    if (debit.changes !== 1) throw new Error('Not enough Gems for this item.');
    db.prepare('INSERT INTO pb_cosmetics_inventory(user_id,item_id,price_paid) VALUES (?,?,?)')
      .run(uid,item.id,currentPrice);
    db.prepare('INSERT INTO pb_betting_ledger(user_id,delta,reason) VALUES(?,?,?)')
      .run(uid,-currentPrice,`cosmetic:${item.id}`);
    if (CATEGORIES.includes(item.category)) {
      db.prepare(
        'INSERT OR IGNORE INTO pb_cosmetics_equipped(user_id,category,item_id) VALUES (?,?,?)'
      ).run(uid,item.category,item.id);
    }
    const metadata=db.prepare(
      'SELECT name,rarity FROM pb_cosmetics_metadata_overrides WHERE item_id=?'
    ).get(item.id);
    return {
      item:{...item,...(metadata || {}),price:currentPrice},
      balance:gems.balance(db,uid)
    };
  });
  return typeof tx.immediate === 'function' ? tx.immediate() : tx();
}

function equip(db, userId, category, itemId) {
  const uid=Number(userId);
  const type=String(category || '');
  const id=String(itemId || '');
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Sign in first.');
  if (!CATEGORIES.includes(type)) throw new Error('Unknown cosmetic category.');
  initialize(db);
  return db.transaction(() => {
    if (!id || id === 'none') {
      db.prepare('DELETE FROM pb_cosmetics_equipped WHERE user_id=? AND category=?').run(uid,type);
      return getEquipped(db,uid);
    }
    const item=ITEMS.get(id);
    if (!item || item.category !== type) throw new Error('That item cannot be equipped here.');
    if (!owns(db,uid,id)) throw new Error('You must own an item before equipping it.');
    db.prepare(`
      INSERT INTO pb_cosmetics_equipped(user_id,category,item_id)
      VALUES (?,?,?)
      ON CONFLICT(user_id,category)
      DO UPDATE SET item_id=excluded.item_id, equipped_ts=unixepoch()
    `).run(uid,type,id);
    return getEquipped(db,uid);
  })();
}

function sameOrigin(req) {
  for (const h of ['origin','referer']) {
    const raw=req.get(h);
    if (!raw) continue;
    try {
      const url=new URL(raw);
      if (url.host !== req.get('host') || !['http:','https:'].includes(url.protocol)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function csrfToken(req) {
  if (!req.session.cosmeticsCsrf) {
    req.session.cosmeticsCsrf=crypto.randomBytes(32).toString('hex');
  }
  return req.session.cosmeticsCsrf;
}

function validateWrite(req,res,next) {
  if (!req.session?.uid) return res.redirect('/login?next=%2Fstore');
  if (!sameOrigin(req)) return res.status(403).send('Invalid request origin.');
  const expected=String(req.session.cosmeticsCsrf || '');
  const provided=String(req.body.csrf || '');
  if (
    !/^[a-f0-9]{64}$/.test(expected) ||
    !/^[a-f0-9]{64}$/.test(provided) ||
    !crypto.timingSafeEqual(Buffer.from(expected,'hex'),Buffer.from(provided,'hex'))
  ) {
    return res.status(403).send('Invalid form token. Refresh the store and try again.');
  }
  next();
}

function mount(app,getConn) {
  // ========== OATMEAL SECRET UNLOCK ==========
  const OATMEAL_TTL=10*60*1000;

  function oatmealState(req) {
    if (!req.session) return null;
    let state=req.session.oatmealSecret;
    if (!state || Date.now()-state.started > OATMEAL_TTL) {
      state={stage:0,clicks:0,started:Date.now()};
      req.session.oatmealSecret=state;
    }
    return state;
  }

  function oatmealOrigin(req,pathname) {
    const origin=req.get('origin');
    const referer=req.get('referer');
    if (!origin || !referer) return false;

    try {
      const source=new URL(referer);
      const from=new URL(origin);
      return (
        source.host === req.get('host') &&
        from.host === req.get('host') &&
        source.pathname === pathname &&
        ['http:','https:'].includes(source.protocol)
      );
    } catch {
      return false;
    }
  }

  function oatmealSave(req,res,next,payload) {
    req.session.save(err => {
      if (err) return next(err);
      res.json(payload);
    });
  }

  app.post('/__oatmeal/crown',(req,res,next) => {
    if (!req.session?.uid) return res.sendStatus(401);
    if (!oatmealOrigin(req,'/shows')) return res.sendStatus(403);

    req.session.oatmealSecret={
      stage:1,
      clicks:0,
      started:Date.now()
    };
    oatmealSave(req,res,next,{ok:true});
  });

  app.post('/__oatmeal/critics',(req,res,next) => {
    if (!req.session?.uid) return res.sendStatus(401);
    if (!oatmealOrigin(req,'/show/1112')) return res.sendStatus(403);

    const state=oatmealState(req);
    if (state.stage !== 1) return res.sendStatus(403);

    state.stage=2;
    oatmealSave(req,res,next,{ok:true});
  });

  app.post('/__oatmeal/profile',(req,res,next) => {
    if (!req.session?.uid) return res.sendStatus(401);
    if (!oatmealOrigin(req,'/show/1112/critics')) return res.sendStatus(403);

    const state=oatmealState(req);
    if (state.stage !== 2) return res.sendStatus(403);

    state.stage=3;
    state.clicks=0;
    oatmealSave(req,res,next,{ok:true});
  });

  app.post('/__oatmeal/footer',(req,res,next) => {
    if (!req.session?.uid) return res.sendStatus(401);
    if (!oatmealOrigin(req,'/me')) return res.sendStatus(403);

    const state=oatmealState(req);
    if (state.stage !== 3) return res.sendStatus(403);

    state.clicks+=1;

    if (state.clicks < 4) {
      return oatmealSave(req,res,next,{
        ok:true,
        unlocked:false
      });
    }

    let db;
    try {
      db=getConn();
      initialize(db);

      db.prepare(`
        INSERT OR IGNORE INTO pb_cosmetics_inventory
          (user_id,item_id,price_paid)
        VALUES (?,'frame_oatmeal',0)
      `).run(Number(req.session.uid));

      req.session.oatmealSecret={
        stage:0,
        clicks:0,
        started:Date.now()
      };

      oatmealSave(req,res,next,{
        ok:true,
        unlocked:true
      });
    } catch (err) {
      next(err);
    } finally {
      if (db) db.close();
    }
  });

  // ========== END OATMEAL SECRET ==========

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
        notice:String(req.query.ok || '').slice(0,100),
        error:String(req.query.error || '').slice(0,150)
      });
    } finally {
      db.close();
    }
  }

  function requireStoreAdmin(req,res,next) {
    if (!req.session?.uid) {
      return res.redirect('/login?next=%2Fstore%2Fadmin');
    }
    let db;
    try {
      db=getConn();
      if (!isStoreAdmin(db,req.session.uid)) {
        return res.status(403).send('Store admin access required.');
      }
      return next();
    } catch (err) {
      return next(err);
    } finally {
      if (db) db.close();
    }
  }

  app.get('/store/admin',requireStoreAdmin,(req,res,next) => {
    let db;
    try {
      db=getConn();
      res.set('Cache-Control','private, no-store');
      return res.render('cosmetics_admin',{
        me:res.locals.me || null,
        catalog:getCatalog(db),
        history:priceHistory(db,25),
        metadataHistory:metadataHistory(db,25),
        rarities:RARITIES,
        csrf:csrfToken(req),
        maxPrice:MAX_PRICE,
        notice:String(req.query.ok || '').slice(0,180),
        error:String(req.query.error || '').slice(0,180)
      });
    } catch (err) {
      return next(err);
    } finally {
      if (db) db.close();
    }
  });

  app.post('/store/admin/price',requireStoreAdmin,validateWrite,(req,res,next) => {
    let db;
    try {
      db=getConn();
      const reset=String(req.body.reset || '') === '1';
      const result=changePrice(
        db,req.session.uid,req.body.item_id,req.body.price,reset
      );

      const message=result.changed
        ? result.item.name+' updated to '+result.newPrice.toLocaleString()+' Gems.'
        : 'No price change needed for '+result.item.name+'.';

      return res.redirect(
        '/store/admin?ok='+encodeURIComponent(message)+
        '#item-'+encodeURIComponent(result.item.id)
      );
    } catch (err) {
      if (err.code && String(err.code).startsWith('SQLITE_')) return next(err);
      return res.redirect(
        '/store/admin?error='+encodeURIComponent(err.message || 'Unable to change price.')
      );
    } finally {
      if (db) db.close();
    }
  });

  app.post('/store/admin/metadata',requireStoreAdmin,validateWrite,(req,res,next) => {
    let db;
    try {
      db=getConn();
      const reset=String(req.body.reset || '') === '1';
      const result=changeMetadata(
        db,req.session.uid,req.body.item_id,req.body.name,req.body.rarity,reset
      );

      const message=result.changed
        ? 'Updated '+result.newName+' ('+result.newRarity+').'
        : 'No name or rarity change needed.';

      return res.redirect(
        '/store/admin?ok='+encodeURIComponent(message)+
        '#item-'+encodeURIComponent(result.item.id)
      );
    } catch (err) {
      if (err.code && String(err.code).startsWith('SQLITE_')) return next(err);
      return res.redirect(
        '/store/admin?error='+encodeURIComponent(err.message || 'Unable to change item details.')
      );
    } finally {
      if (db) db.close();
    }
  });

  app.get('/store',(req,res) => page(req,res,'cosmetics_store'));

  app.get('/me/cosmetics',(req,res) => {
    if (!req.session?.uid) {
      return res.redirect('/login?next=%2Fme%2Fcosmetics');
    }
    return page(req,res,'cosmetics_inventory');
  });

  app.post('/store/buy',validateWrite,(req,res,next) => {
    const db=getConn();
    try {
      const result=buy(db,req.session.uid,req.body.item_id);
      res.redirect(
        '/store?ok='+encodeURIComponent(result.item.name+' purchased!')
      );
    } catch (err) {
      if (err.message?.includes('SQLITE')) return next(err);
      res.redirect(
        '/store?error='+encodeURIComponent(err.message || 'Purchase failed.')
      );
    } finally {
      db.close();
    }
  });

  app.post('/store/equip',validateWrite,(req,res,next) => {
    const db=getConn();
    try {
      equip(db,req.session.uid,req.body.category,req.body.item_id);
      res.redirect(
        '/me/cosmetics?ok='+encodeURIComponent('Cosmetic updated!')
      );
    } catch (err) {
      if (err.message?.includes('SQLITE')) return next(err);
      res.redirect(
        '/me/cosmetics?error='+encodeURIComponent(err.message || 'Could not equip item.')
      );
    } finally {
      db.close();
    }
  });
}

module.exports={
  CATALOG,
  ITEMS,
  CATEGORIES,
  MAX_PRICE,
  RARITIES,
  initialize,
  owns,
  inventory,
  getEquipped,
  getCatalog,
  priceHistory,
  metadataHistory,
  isStoreAdmin,
  changePrice,
  changeMetadata,
  buy,
  equip,
  mount
};
