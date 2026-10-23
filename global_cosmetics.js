'use strict';

// Read-only avatar decorations across Pressboxd. No wallet or inventory writes.
const cosmetics = require('./cosmetics');
const FRAMES = new Set(['frame_sapphire','frame_rose','frame_inferno','frame_gold','frame_aurora','frame_prism']);
const MOTIONS = new Set(['motion_float','motion_pulse','motion_wobble']);
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;

function cleanStrings(raw, maxLen, maxCount = 100) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.slice(0, maxCount).filter(x => typeof x === 'string')
    .map(x => x.trim()).filter(x => x && x.length <= maxLen))];
}

function lookupAvatarEffects(db, usernames, avatars) {
  cosmetics.initialize(db);
  const normalized = cleanStrings(usernames, 20).filter(x => USER_RE.test(x)).map(x => x.toLowerCase());
  const urls = cleanStrings(avatars, 1024).filter(x => /^(?:https?:\/\/|\/)/i.test(x));
  if (!normalized.length && !urls.length) return [];
  const where = [];
  const params = [];
  if (normalized.length) {
    where.push(`LOWER(u.username) IN (${normalized.map(() => '?').join(',')})`);
    params.push(...normalized);
  }
  if (urls.length) {
    where.push(`u.avatar_url IN (${urls.map(() => '?').join(',')})`);
    params.push(...urls);
  }
  // Only publicly equipped items are returned, never inventory/wallet information.
  const rows = db.prepare(`
    SELECT u.username, u.avatar_url, e.category, e.item_id
    FROM users u
    JOIN pb_cosmetics_equipped e ON e.user_id = u.id
    JOIN pb_cosmetics_inventory i ON i.user_id = e.user_id AND i.item_id = e.item_id
    WHERE e.category IN ('frame','motion') AND (${where.join(' OR ')})
  `).all(...params);
  const out = new Map();
  for (const r of rows) {
    const key = r.username.toLowerCase();
    if (!out.has(key)) out.set(key, {username:r.username, avatar_url:r.avatar_url || '', frame:null, motion:null});
    const item = String(r.item_id || '');
    if (r.category === 'frame' && FRAMES.has(item)) out.get(key).frame=item;
    if (r.category === 'motion' && MOTIONS.has(item)) out.get(key).motion=item;
  }
  return [...out.values()];
}

function mount(app, getConn) {
  app.post('/api/cosmetics/avatar-effects', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.is('application/json')) return res.status(415).json({error:'json_required'});
    if (!Array.isArray(req.body?.usernames) || !Array.isArray(req.body?.avatar_urls) ||
        req.body.usernames.length > 100 || req.body.avatar_urls.length > 100) {
      return res.status(400).json({error:'invalid_request'});
    }
    let db;
    try {
      db = getConn();
      return res.json({users:lookupAvatarEffects(db, req.body.usernames, req.body.avatar_urls)});
    } catch (err) {
      console.error('Cosmetic avatar lookup:', err);
      return res.status(500).json({error:'lookup_failed'});
    } finally {
      if (db) db.close();
    }
  });

  // Only full rendered HTML is affected. No changes to JSON, images, or downloads.
  app.use((req,res,next) => {
    const oldSend = res.send.bind(res);
    res.send = function sendWithGlobalCosmetics(body) {
      if (typeof body === 'string' && /<\/head\s*>/i.test(body) && /<\/body\s*>/i.test(body) &&
          /<html[\s>]/i.test(body)) {
        const self = String(res.locals.me?.username || '');
        const meta = self && USER_RE.test(self)
          ? `<meta name="pb-cosmetics-self" content="${encodeURIComponent(self)}">\n`
          : '';
        // Append a versioned stylesheet AFTER the existing profile CSS, if present.
        body = body.replace(/<\/head\s*>/i,
          `${meta}<link rel="stylesheet" href="/static/cosmetics.css?v=4">\n</head>`);
        body = body.replace(/<\/body\s*>/i,
          `<script defer src="/static/cosmetics-global.js?v=4"></script>\n</body>`);
      }
      return oldSend(body);
    };
    next();
  });
}

module.exports = {mount, lookupAvatarEffects};
