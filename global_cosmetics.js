'use strict';

// Public, read-only equipped frame/motion lookup for site-wide avatars.
// Wallets, purchases, and equipped cosmetics are never modified by this module.
const cosmetics = require('./cosmetics');
const FRAME_IDS = new Set(['frame_sapphire','frame_rose','frame_inferno','frame_gold','frame_aurora','frame_prism']);
const MOTION_IDS = new Set(['motion_float','motion_pulse','motion_wobble']);
const USER_RE = /^[A-Za-z0-9_]{3,20}$/;

function distinct(raw, maxLength) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.slice(0, 100).filter(x => typeof x === 'string')
    .map(x => x.trim()).filter(x => x && x.length <= maxLength))];
}

function lookupAvatarEffects(db, usernames = [], avatarUrls = [], userIds = []) {
  cosmetics.initialize(db);
  const names = distinct(usernames, 20).filter(n => USER_RE.test(n)).map(n => n.toLowerCase());
  const urls = distinct(avatarUrls, 1024).filter(url => /^(?:https?:\/\/|\/)/i.test(url));
  const ids = [...new Set((Array.isArray(userIds) ? userIds : []).slice(0,100)
    .map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!names.length && !urls.length && !ids.length) return [];

  const filters = [], values = [];
  if (names.length) { filters.push(`LOWER(u.username) IN (${names.map(() => '?').join(',')})`); values.push(...names); }
  if (urls.length) { filters.push(`u.avatar_url IN (${urls.map(() => '?').join(',')})`); values.push(...urls); }
  if (ids.length) { filters.push(`u.id IN (${ids.map(() => '?').join(',')})`); values.push(...ids); }

  const rows = db.prepare(`
    SELECT u.id, u.username, u.avatar_url, e.category, e.item_id
    FROM users u
    JOIN pb_cosmetics_equipped e ON e.user_id=u.id
    JOIN pb_cosmetics_inventory i ON i.user_id=e.user_id AND i.item_id=e.item_id
    WHERE e.category IN ('frame','motion') AND (${filters.join(' OR ')})
  `).all(...values);

  // Two users can have the same generic/default picture. Never use a shared
  // avatar URL as a global identity: prefer username or user ID instead.
  const foundUrls = [...new Set(rows.map(row => row.avatar_url).filter(Boolean))];
  const uniqueUrls = new Set();
  if (foundUrls.length) {
    const counts = db.prepare(`
      SELECT avatar_url, COUNT(*) AS count FROM users
      WHERE avatar_url IN (${foundUrls.map(() => '?').join(',')})
      GROUP BY avatar_url
    `).all(...foundUrls);
    for (const row of counts) if (row.count === 1) uniqueUrls.add(row.avatar_url);
  }

  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, {
        user_id: row.id,
        username: row.username,
        avatar_url: uniqueUrls.has(row.avatar_url) ? row.avatar_url : '',
        frame: null,
        motion: null
      });
    }
    const item = String(row.item_id || '');
    const obj = byId.get(row.id);
    if (row.category === 'frame' && FRAME_IDS.has(item)) obj.frame = item;
    if (row.category === 'motion' && MOTION_IDS.has(item)) obj.motion = item;
  }
  return [...byId.values()];
}

function mount(app, getConn) {
  app.post('/api/cosmetics/avatar-effects', (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' });
    const body = req.body || {};
    if (!Array.isArray(body.usernames) || !Array.isArray(body.avatar_urls) ||
        body.usernames.length > 100 || body.avatar_urls.length > 100 ||
        (body.user_ids != null && (!Array.isArray(body.user_ids) || body.user_ids.length > 100))) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    let db;
    try {
      db = getConn();
      return res.json({ users: lookupAvatarEffects(db, body.usernames, body.avatar_urls, body.user_ids || []) });
    } catch (err) {
      console.error('Cosmetic avatar lookup failed:', err);
      return res.status(500).json({ error: 'lookup_failed' });
    } finally {
      if (db) db.close();
    }
  });

  // Installed before regular page routes, but after Express body parsing.
  // Only inject into complete HTML pages, never API JSON/downloads.
  app.use((req, res, next) => {
    const originalSend = res.send.bind(res);
    res.send = function sendWithGlobalAvatars(body) {
      if (typeof body === 'string' && /<html[\s>]/i.test(body) &&
          /<\/head\s*>/i.test(body) && /<\/body\s*>/i.test(body)) {
        const self = String(res.locals.me?.username || '');
        const myId = Number(res.locals.me?.id || 0);
        const nameMeta = USER_RE.test(self)
          ? `<meta name="pb-cosmetics-self" content="${encodeURIComponent(self)}">\n` : '';
        const idMeta = Number.isSafeInteger(myId) && myId > 0
          ? `<meta name="pb-cosmetics-self-id" content="${myId}">\n` : '';
        if (!body.includes('name="pb-cosmetics-self"')) {
          body = body.replace(/<\/head\s*>/i, nameMeta + idMeta + '</head>');
        }
        if (!body.includes('href="/static/cosmetics.css?v=14"')) {
          body = body.replace(/<\/head\s*>/i,
            '<link rel="stylesheet" href="/static/cosmetics.css?v=14">\n</head>');
        }
        if (!body.includes('src="/static/cosmetics-global.js?v=14"')) {
          body = body.replace(/<\/body\s*>/i,
            '<script defer src="/static/cosmetics-global.js?v=14"></script>\n</body>');
        }
      }
      return originalSend(body);
    };
    next();
  });
}

module.exports = { mount, lookupAvatarEffects };
