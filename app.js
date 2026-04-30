const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { Resend } = require('resend');
const { uploadBufferToR2, deleteFromR2 } = require('./r2');

const dbx = require('./db');

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BASE_DIR = __dirname;
const STATIC_DIR = path.join(BASE_DIR, 'static');

const DATA_DIR = process.env.DATA_DIR || '/data';
const PFP_DIR = path.join(DATA_DIR, 'pfps');

fs.mkdirSync(PFP_DIR, { recursive: true });

const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_UPLOAD_MB = 5;

const APP_SECRET = process.env.APP_SECRET || 'dev-secret-change-me';
const PORT = parseInt(process.env.PORT || '8080', 10);

const SOURCE_DB_PATH = path.join(BASE_DIR, 'site.db');
const DB_PATH = process.env.DB_PATH || '/data/site.db';

console.log('APP DB_PATH =', DB_PATH);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

if (!fs.existsSync(DB_PATH)) {
  if (fs.existsSync(SOURCE_DB_PATH)) {
    fs.copyFileSync(SOURCE_DB_PATH, DB_PATH);
    console.log(`Copied seeded DB from ${SOURCE_DB_PATH} -> ${DB_PATH}`);
  } else {
    dbx.initDb(DB_PATH, { schemaPath: path.join(BASE_DIR, 'schema.sql') });
    console.log(`Initialized new DB at ${DB_PATH}`);
  }
}

const BAD_WORDS = new Set([
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy',
  'faggot', 'nigger', 'slut', 'whore', 'douchebag', 'motherfucker', 'twat',
  'cock', 'piss', 'fucker', 'shitter', 'bitchass', 'asshat', 'bullshit',
  'chink', 'cocks', 'niggers', 'faggots', 'sluts', 'douchebags',
  'motherfuckers', 'pussylicker', 'pussylicking', 'pussylicked', 'nigglet', 'nigglets',
  'nigga', 'niggas', 'faggotry', 'fag', 'fags', 'jiggaboo', 'jiggaboos',
  'spic', 'spics', 'gook', 'gooks', 'beaner', 'beaners', 'horseshit',
  'asswipe', 'asswipes', 'shithead', 'shitheads', 'dickhead', 'dickheads',
  'dogshit', 'cuntface', 'cuntfaces', 'pisshead', 'pissheads', 'twatface', 'twatfaces', 'twink', 'twinks'
]);

function adminRequired(handler) {
  return async (req, res, next) => {
    try {
      const user = req.session?.user;

      if (user && Number(user.is_admin) === 1) {
        return await handler(req, res, next);
      }

      console.log('Access Denied for user:', user?.username || '(no session user)');
      if (req.flash) req.flash('error', 'Admin access required.');
      return res.redirect('/shows');
    } catch (err) {
      return next(err);
    }
  };
}

function compileBadRegex(words) {
  const parts = [...words]
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);

  if (!parts.length) return /^\b$/i;
  return new RegExp(`\\b(${parts.join('|')})\\b`, 'i');
}

const BAD_RE = compileBadRegex(BAD_WORDS);

function containsProfanity(text) {
  if (!text || typeof text !== 'string') return false;
  return BAD_RE.test(text);
}

function findProfanityInJson(obj, currentPath = '$') {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const found = findProfanityInJson(v, `${currentPath}.${k}`);
      if (found.path) return found;
    }
    return { path: null, bad: null };
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i += 1) {
      const found = findProfanityInJson(obj[i], `${currentPath}[${i}]`);
      if (found.path) return found;
    }
    return { path: null, bad: null };
  }

  if (typeof obj === 'string') {
    const match = obj.match(BAD_RE);
    if (match) return { path: currentPath, bad: match[0] };
  }

  return { path: null, bad: null };
}

function slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function staticFileExists(relPath) {
  return fs.existsSync(path.join(STATIC_DIR, relPath));
}

function r2KeyFromPublicUrl(url) {
  const base = String(process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const full = String(url || '').trim();

  if (!base || !full) return null;
  if (!full.startsWith(base + '/')) return null;

  return full.slice(base.length + 1);
}

function deleteLocalFileIfExists(absPath) {
  try {
    if (absPath && fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
    }
  } catch (err) {
    console.error('Failed to delete local file:', absPath, err);
  }
}

async function deleteStoredImageByUrl(url, kind) {
  const full = String(url || '').trim();
  if (!full) return;

  const r2Key = r2KeyFromPublicUrl(full);
  if (r2Key) {
    await deleteFromR2(r2Key);
    return;
  }

  if (kind === 'poster') {
    if (full.includes('/static/')) {
      const rel = full.split('/static/')[1];
      if (rel) deleteLocalFileIfExists(path.join(STATIC_DIR, rel));
    }
    return;
  }

  if (kind === 'pfp') {
    if (full.includes('/uploads/pfps/')) {
      const rel = full.split('/uploads/pfps/')[1];
      if (rel) deleteLocalFileIfExists(path.join(PFP_DIR, rel));
      return;
    }

    if (full.includes('/static/pfps/')) {
      const rel = full.split('/static/')[1];
      if (rel) deleteLocalFileIfExists(path.join(STATIC_DIR, rel));
    }
    return;
  }

  if (kind === 'banner') {
    if (full.includes('/static/')) {
      const rel = full.split('/static/')[1];
      if (rel) deleteLocalFileIfExists(path.join(STATIC_DIR, rel));
    }
  }
}

function pfpUrlForUsername(username) {
  const key = slugify(username);
  const base = `pfp_${key}`;

  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const file = `${base}${ext}`;
    const abs = path.join(PFP_DIR, file);
    if (fs.existsSync(abs)) return `/uploads/pfps/${file}`;
  }

  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const rel = `pfps/${base}${ext}`;
    if (staticFileExists(rel)) return `/static/${rel}`;
  }

  return null;
}

function posterUrlForShow(corps, year) {
  const key = String(corps || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const y = parseInt(year || 0, 10);
  const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'];

  if (!key || !y) return '/static/posters/placeholder.png';

  for (const ext of exts) {
    const rel = `posters/${key}${y}${ext}`;
    const abs = path.join(__dirname, 'static', rel);
    if (fs.existsSync(abs)) return `/static/${rel}`;
  }

  for (const ext of exts) {
    const rel = `posters/${key}default${ext}`;
    const abs = path.join(__dirname, 'static', rel);
    if (fs.existsSync(abs)) return `/static/${rel}`;
  }

  for (const ext of exts) {
    const rel = `posters/default${ext}`;
    const abs = path.join(__dirname, 'static', rel);
    if (fs.existsSync(abs)) return `/static/${rel}`;
  }

  return '/static/posters/placeholder.png';
}

function normalizeRow(row) {
  if (!row) return row;
  if (typeof row.toJSON === 'function') return row.toJSON();
  return { ...row };
}

function parseLines(text) {
  const items = [];
  const errors = [];

  for (const [idx, raw] of String(text || '').split(/\r?\n/).entries()) {
    const i = idx + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.includes('|')
      ? line.split('|').map((p) => p.trim())
      : line.split(',').map((p) => p.trim());

    if (![3, 4].includes(parts.length)) {
      errors.push(`Line ${i}: expected 3 or 4 fields (year, corps, title, [poster_url]). Got: ${raw}`);
      continue;
    }

    const [y, c, t, poster] = parts;
    if (!/^\d+$/.test(y)) {
      errors.push(`Line ${i}: year must be a number. Got: ${y}`);
      continue;
    }

    items.push([parseInt(y, 10), c, t, poster || null]);
  }

  return { items, errors };
}

function wantsJson(req) {
  return req.path.startsWith('/api/')
    || req.get('X-Requested-With') === 'XMLHttpRequest'
    || req.accepts(['html', 'json']) === 'json';
}

function safeEqualHex(a, b) {
  try {
    const aBuf = Buffer.from(String(a || ''), 'hex');
    const bBuf = Buffer.from(String(b || ''), 'hex');
    if (aBuf.length !== bBuf.length) return false;
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

function verifyWerkzeugHash(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;

  const parts = storedHash.split('$');
  if (parts.length !== 3) return false;

  const [methodSpec, salt, expectedHex] = parts;

  if (methodSpec.startsWith('pbkdf2:')) {
    const m = methodSpec.match(/^pbkdf2:([^:]+):(\d+)$/);
    if (!m) return false;

    const hashMethod = m[1];
    const iterations = parseInt(m[2], 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;

    const keylen = expectedHex.length / 2;
    if (!Number.isFinite(keylen) || keylen <= 0) return false;

    const derived = crypto.pbkdf2Sync(
      String(password),
      salt,
      iterations,
      keylen,
      hashMethod
    ).toString('hex');

    return safeEqualHex(derived, expectedHex);
  }

  if (methodSpec.startsWith('scrypt:')) {
    const m = methodSpec.match(/^scrypt:(\d+):(\d+):(\d+)$/);
    if (!m) return false;

    const N = parseInt(m[1], 10);
    const r = parseInt(m[2], 10);
    const p = parseInt(m[3], 10);
    const keylen = expectedHex.length / 2;

    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !Number.isFinite(keylen) || keylen <= 0) {
      return false;
    }

    const estimatedMaxmem = Math.max(128 * N * r * p, 64 * 1024 * 1024);

    const derived = crypto.scryptSync(
      String(password),
      salt,
      keylen,
      { N, r, p, maxmem: estimatedMaxmem }
    ).toString('hex');

    return safeEqualHex(derived, expectedHex);
  }

  return false;
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;

  if (
    storedHash.startsWith('$2a$') ||
    storedHash.startsWith('$2b$') ||
    storedHash.startsWith('$2y$')
  ) {
    return bcrypt.compare(password, storedHash);
  }

  if (
    storedHash.startsWith('pbkdf2:') ||
    storedHash.startsWith('scrypt:')
  ) {
    return verifyWerkzeugHash(password, storedHash);
  }

  return false;
}

function needsRehashToBcrypt(storedHash) {
  return !!storedHash && !storedHash.startsWith('$2');
}

async function hashPassword(password) {
  return bcrypt.hash(String(password || ''), 12);
}

const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_dNcSQUTw_4vJre8Avs4k2b6CUHrsdzj47';
const MAIL_FROM = process.env.MAIL_FROM || 'Pressboxd pressboxdcontact@gmail.com';
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://www.pressboxd.com';

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makeTempPassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function sendTempPasswordEmail(toEmail, username, tempPassword) {
  if (!resend) {
    throw new Error('Email is not configured. Missing RESEND_API_KEY.');
  }

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111;">
      <h2 style="margin-bottom:8px;">Pressboxd temporary password</h2>
      <p>Hello <b>${escapeHtml(username)}</b>,</p>
      <p>You requested a temporary password for your Pressboxd account.</p>

      <div style="margin:16px 0;padding:14px 16px;border:1px solid #ddd;border-radius:10px;background:#f7f7f7;">
        <div style="font-size:12px;color:#666;margin-bottom:4px;">Temporary password</div>
        <div style="font-size:20px;font-weight:700;letter-spacing:.4px;">${escapeHtml(tempPassword)}</div>
      </div>

      <p>After logging in, you will be required to change your password.</p>
      <p>
        Login here:
        <a href="${APP_BASE_URL}">${APP_BASE_URL}</a>
      </p>

      <p style="color:#666;font-size:12px;margin-top:20px;">
        If you did not request this, you can ignore this email.
      </p>
    </div>
  `;

  const result = await resend.emails.send({
    from: MAIL_FROM,
    to: [toEmail],
    subject: 'Your Pressboxd temporary password',
    html,
  });

  if (result?.error) {
    throw new Error(result.error.message || 'Failed to send email.');
  }

  return result;
}

function resolveAccentColor(value) {
  const v = String(value || '').trim();
  return /^#([0-9a-fA-F]{6})$/.test(v) ? v : '#3252b3';
}


function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(BASE_DIR, 'templates'));

  app.use('/static', express.static(path.join(__dirname, 'static'), {
    maxAge: '30d',
    immutable: true,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
    }
  }));

  app.use('/uploads/pfps', express.static(PFP_DIR, {
    maxAge: '7d',
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }));

  app.use((req, res, next) => {
    const uncachedPrefixes = [
      '',
      '/register',
      '/logout',
      '/me',
      '/settings',
      '/notifications',
      '/admin',
      '/api'
    ];

    if (uncachedPrefixes.some(prefix => req.path === prefix || req.path.startsWith(prefix + '/'))) {
      res.setHeader('Cache-Control', 'private, no-store');
    }

    next();
  });

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: `${MAX_UPLOAD_MB}mb` }));

  app.use(session({
    secret: APP_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,
    name: 'pressboxd.sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  }));

  app.use((req, res, next) => {
    if (!Array.isArray(req.session.flash)) req.session.flash = [];

    req.flash = (category, message) => {
      req.session.flash.push({ category, message });
    };

    res.locals.flashes = req.session.flash || [];
    req.session.flash = [];

    next();
  });

  function getConn() {
    const conn = dbx.connect(DB_PATH);
    dbx.ensureReviewsTable(conn);
    dbx.ensureProfileColumns(conn);
    dbx.ensureRolesTables(conn);
    dbx.ensureReviewVotesTable(conn);
    dbx.ensureReviewCommentsTable(conn);
    dbx.ensureSocialTables(conn);
    dbx.ensureNotificationsTable(conn);
    dbx.ensureAuthColumns(conn);
    dbx.ensureFavoriteShowsTable(conn);
    dbx.ensurePredictionTables(conn);
    return conn;
  }

  const uploadPfp = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
  });

  const uploadPoster = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }
  });

  async function currentUser(req) {
    const uid = req.session.uid;
    if (!uid) return null;
    const conn = getConn();
    try {
      return normalizeRow(await dbx.userById(conn, Number(uid)));
    } finally {
      dbx.close(conn);
    }
  }

  function loginRequired(handler) {
    return async (req, res, next) => {
      if (!req.session.uid) {
        req.flash('warn', 'Please log in to do that.');
        return res.redirect(`?next=${encodeURIComponent(req.path)}`);
      }
      try {
        return await handler(req, res, next);
      } catch (err) {
        return next(err);
      }
    };
  }

  app.get('/posters/:name', async (req, res) => {
    const name = String(req.params.name || '').trim();
    const base = String(process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');

    if (!base || !name) {
      return res.redirect('/static/posters/placeholder.png');
    }

    const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

    try {
      for (const ext of exts) {
        const url = `${base}/posters/${name}${ext}`;
        const r = await fetch(url, { method: 'HEAD' });
        if (r.ok) return res.redirect(url);
      }

      for (const ext of exts) {
        const url = `${base}/posters/default${ext}`;
        const r = await fetch(url, { method: 'HEAD' });
        if (r.ok) return res.redirect(url);
      }
    } catch (err) {
      console.error('poster lookup failed:', err);
    }

    return res.redirect('/static/posters/placeholder.png');
  });

  app.get('/forgot-password', (req, res) => {
    res.render('forgot_password');
  });

  app.post('/forgot-password', async (req, res, next) => {
    const email = String(req.body.email || '').trim().toLowerCase();

    if (!email) {
      req.flash('error', 'Enter your email address.');
      return res.redirect('/forgot-password');
    }

    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userByEmail(conn, email));

      if (!u) {
        req.flash('ok', 'If that email exists, a temporary password has been sent.');
        return res.redirect('');
      }

      const tempPassword = makeTempPassword(12);
      const newHash = await hashPassword(tempPassword);

      await dbx.updateUserPasswordHash(conn, Number(u.id), newHash);
      await dbx.setUserMustChangePassword(conn, Number(u.id), 1);
      await dbx.commit(conn);

      await sendTempPasswordEmail(email, u.username, tempPassword);

      req.flash('ok', 'If that email exists, a temporary password has been sent.');
      return res.redirect('');
    } catch (err) {
      return next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/force-change-password', loginRequired(async (req, res) => {
    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userById(conn, Number(req.session.uid)));
      if (!u) return res.redirect('');

      if (Number(u.must_change_password || 0) !== 1) {
        return res.redirect('/shows');
      }

      return res.render('force_change_password');
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/force-change-password', async (req, res, next) => {
    const { new_password, confirm_password } = req.body;
    const userId = req.session.uid;

    if (new_password !== confirm_password) {
      req.flash('error', 'Passwords do not match.');
      return res.redirect('/force-change-password');
    }

    let conn;
    try {
      conn = getConn();
      const hashed = await hashPassword(new_password);
      await dbx.updateUserPasswordHash(conn, userId, hashed);
      await dbx.setUserMustChangePassword(conn, userId, 0);
      await dbx.commit(conn);

      req.flash('ok', 'Password updated! Please log in again.');
      req.session.destroy(() => {
        res.redirect('');
      });
    } catch (err) {
      next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.use(async (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();

    for (const [k, v] of Object.entries(req.query || {})) {
      if (typeof v === 'string' && containsProfanity(v)) {
        if (wantsJson(req)) return res.status(400).json({ error: `Profanity not allowed in query param '${k}'.` });
        req.flash('error', 'Profanity is not allowed. Please remove it and try again.');
        return res.redirect(req.get('referer') || '/shows');
      }
    }

    for (const [k, v] of Object.entries(req.body || {})) {
      if (typeof v === 'string' && containsProfanity(v)) {
        if (wantsJson(req)) return res.status(400).json({ error: `Profanity not allowed in form field '${k}'.` });
        req.flash('error', 'Profanity is not allowed. Please remove it and try again.');
        return res.redirect(req.get('referer') || '/shows');
      }
    }

    if (req.is('application/json')) {
      const found = findProfanityInJson(req.body);
      if (found.path) {
        if (wantsJson(req)) return res.status(400).json({ error: `Profanity not allowed in json field ${found.path}.` });
        req.flash('error', 'Profanity is not allowed. Please remove it and try again.');
        return res.redirect(req.get('referer') || '/shows');
      }
    }

    return next();
  });

  app.use(async (req, res, next) => {
    try {
      const me = await currentUser(req);
      let notifCount = 0;
      let notifItems = [];

      if (me) {
        const safeThemeColor = resolveAccentColor(me.theme_color);

        req.session.user = {
          id: Number(me.id),
          username: me.username,
          email: me.email || null,
          is_admin: Number(me.is_admin || 0),
          avatar_url: me.avatar_url || null,
          theme_color: safeThemeColor,
        };

        me.theme_color = safeThemeColor;

        const conn = getConn();
        try {
          notifCount = await dbx.unreadNotificationsCount(conn, Number(me.id));
          notifItems = (await dbx.listUnreadNotifications(conn, Number(me.id), { limit: 20 }) || []).map(normalizeRow);
        } finally {
          dbx.close(conn);
        }
      } else {
        delete req.session.user;
      }

      res.locals.me = me;
      res.locals.accent_color = resolveAccentColor(me?.theme_color);
      res.locals.notif_count = notifCount;
      res.locals.notif_items = notifItems;
      next();
    } catch (err) {
      next(err);
    }
  });
  
  app.get('/', (_req, res) => res.redirect('/shows'));
  app.get('/register', (_req, res) => res.render('auth_register'));

  app.post('/register', async (req, res, next) => {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '').trim();

    if (username.length < 3) {
      req.flash('error', 'Username must be at least 3 characters.');
      return res.redirect('/register');
    }

    if (!EMAIL_RE.test(email)) {
      req.flash('error', 'Enter a valid email address.');
      return res.redirect('/register');
    }

    if (password.length < 6) {
      req.flash('error', 'Password must be at least 6 characters.');
      return res.redirect('/register');
    }

    let conn;
    try {
      conn = getConn();

      if (await dbx.userByUsername(conn, username)) {
        req.flash('error', 'That username is taken.');
        return res.redirect('/register');
      }

      if (await dbx.userByEmail(conn, email)) {
        req.flash('error', 'That email is already in use.');
        return res.redirect('/register');
      }

      const make = await dbx.isFirstUser(conn);
      const uid = await dbx.createUser(
        conn,
        username,
        await hashPassword(password),
        { makeAdmin: make, email }
      );

      req.session.uid = Number(uid);
      req.session.user = {
        id: Number(uid),
        username,
        email,
        is_admin: make ? 1 : 0,
        avatar_url: null,
        theme_color: null,
      };

      req.flash('ok', "Account created. You're logged in.");

      return req.session.save((err) => {
        if (err) return next(err);
        return res.redirect('/shows');
      });
    } catch (err) {
      return next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/login', (req, res) => {
    res.render('auth_login', { next: req.query.next || '' });
  });

  app.post('/login', async (req, res, next) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    const nxt = String(req.body.next || '').trim();

    let conn;
    try {
      conn = getConn();

      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) {
        req.flash('error', 'Invalid username/password.');
        return res.redirect('/login');
      }

      const passCol = dbx.usersPasswordCol(conn);
      const storedHash = u[passCol];

      const ok = storedHash ? await verifyPassword(password, storedHash) : false;
      if (!ok) {
        req.flash('error', 'Invalid username/password.');
        return res.redirect('/login');
      }

      if (needsRehashToBcrypt(storedHash)) {
        const newHash = await hashPassword(password);
        await dbx.updateUserPasswordHash(conn, Number(u.id), newHash);
        await dbx.commit(conn);
      }

      req.session.uid = Number(u.id);
      req.session.user = {
        id: Number(u.id),
        username: u.username,
        email: u.email || null,
        is_admin: Number(u.is_admin || 0),
        avatar_url: u.avatar_url || null,
        theme_color: u.theme_color || null,
      };

      req.flash('ok', 'Logged in.');

      return req.session.save((err) => {
        if (err) return next(err);
        return res.redirect(nxt || '/shows');
      });
    } catch (err) {
      return next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('pressboxd.sid');
      res.redirect('/shows');
    });
  });

  app.post('/me/update_bio', loginRequired(async (req, res) => {
    const bio = String(req.body.bio || '').trim();

    let conn;
    try {
      conn = getConn();
      await dbx.updateUserBio(conn, Number(req.session.uid), bio);
      await dbx.commit(conn);

      req.flash('ok', 'Bio updated.');
      return res.redirect('/me');
    } catch (err) {
      req.flash('error', String(err.message || err));
      return res.redirect('/me');
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.get('/shows', async (req, res, next) => {
    const sort = String(req.query.sort || 'year_desc').trim();
    const year = String(req.query.year || '').trim();
    const corps = String(req.query.corps || '').trim();

    let conn;
    try {
      conn = getConn();

      const rows = await dbx.listShows(conn, { sort, year, corps });
      const rows2 = (rows || []).map((r) => {
        const d = normalizeRow(r);
        if (!d.poster_url) d.poster_url = posterUrlForShow(d.corps || '', d.year || 0);
        return d;
      });

      let friendActivity = [];
      if (req.session.uid) {
        friendActivity = (await dbx.listFriendActivity(conn, Number(req.session.uid), { limit: 5 }) || []).map((x) => {
          const d = normalizeRow(x);
          if (!d.poster_url) d.poster_url = posterUrlForShow(d.corps || '', d.year || 0);
          return d;
        });
      }

      let hotShows = [];
      if (typeof dbx.getHotShows === 'function') {
        hotShows = (await dbx.getHotShows(conn, 3) || []).map((x) => {
          const d = normalizeRow(x);
          if (!d.poster_url) d.poster_url = posterUrlForShow(d.corps || '', d.year || 0);
          return d;
        });
      }

      res.render('shows', {
        rows: rows2,
        sort,
        year,
        corps,
        friend_activity: friendActivity,
        hot_shows: hotShows,
      });
    } catch (err) {
      next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/show/:show_id', async (req, res, next) => {
    const showId = Number(req.params.show_id);
    const viewerUid = req.session.uid ? Number(req.session.uid) : null;
  
    const sort = String(req.query.sort || 'popular').trim().toLowerCase();
    const allowedSorts = new Set(['popular', 'newest', 'oldest', 'highest', 'lowest']);
    const activeSort = allowedSorts.has(sort) ? sort : 'popular';
  
    let conn;
    try {
      conn = getConn();
  
      let row = normalizeRow(await dbx.getShowById(conn, showId));
      if (!row) return res.sendStatus(404);
      if (!row.poster_url) row.poster_url = posterUrlForShow(row.corps || '', row.year || 0);
  
      let me = viewerUid ? normalizeRow(await dbx.userById(conn, viewerUid)) : null;
      const myRating = viewerUid ? await dbx.userRatingForShow(conn, showId, viewerUid) : null;
      const myReview = viewerUid ? await dbx.myReviewForShow(conn, showId, viewerUid) : null;
  
      const isFavorite = viewerUid
        ? !!dbx.isShowFavoritedByUser(conn, viewerUid, showId)
        : false;
  
      const favoriteCount = viewerUid
        ? Number(dbx.countUserFavoriteShows(conn, viewerUid) || 0)
        : 0;
  
      const showFavoriteCountRow = conn.prepare(`
        SELECT COUNT(*) AS cnt
        FROM user_favorite_shows
        WHERE show_id = ?
      `).get(showId);
  
      const show_favorite_count = showFavoriteCountRow
        ? Number(showFavoriteCountRow.cnt || 0)
        : 0;
  
      if (me && !me.avatar_url) me.avatar_url = pfpUrlForUsername(me.username || '');
  
      const reviews = (await dbx.listReviewsForShow(conn, showId, { viewerUserId: viewerUid, limit: 300 }) || []).map((rv) => {
        const d = normalizeRow(rv);
        if (!d.avatar_url) d.avatar_url = pfpUrlForUsername(d.username || '');
        return d;
      });
  
      const comments = (await dbx.listReviewCommentsForShow(conn, showId, { limitTotal: 500 }) || []).map((c) => {
        const d = normalizeRow(c);
        if (!d.commenter_avatar_url) d.commenter_avatar_url = pfpUrlForUsername(d.commenter_username || '');
        d.replies = [];
        return d;
      });
  
      const replies = (typeof dbx.listReviewRepliesForShow === 'function'
        ? await dbx.listReviewRepliesForShow(conn, showId, { limitTotal: 500 })
        : []
      ) || [];
  
      const replyRows = replies.map((r) => {
        const d = normalizeRow(r);
        if (!d.replier_avatar_url) d.replier_avatar_url = pfpUrlForUsername(d.replier_username || '');
        return d;
      });
  
      const commentsByReviewUser = new Map();
      const commentsById = new Map();
  
      for (const c of comments) {
        const reviewKey = Number(c.review_user_id);
  
        if (!commentsByReviewUser.has(reviewKey)) {
          commentsByReviewUser.set(reviewKey, []);
        }
  
        commentsByReviewUser.get(reviewKey).push(c);
        commentsById.set(Number(c.comment_id), c);
      }
  
      for (const r of replyRows) {
        const parentComment = commentsById.get(Number(r.comment_id));
        if (parentComment) {
          parentComment.replies.push(r);
        }
      }
  
      for (const c of comments) {
        c.replies.sort((a, b) => {
          const at = String(a.created_at || '');
          const bt = String(b.created_at || '');
          return at.localeCompare(bt);
        });
      }
  
      let reviewsWithComments = reviews.map((rv) => {
        const reviewComments = commentsByReviewUser.get(Number(rv.user_id)) || [];
  
        reviewComments.sort((a, b) => {
          const at = String(a.created_at || '');
          const bt = String(b.created_at || '');
          return at.localeCompare(bt);
        });
  
        return {
          ...rv,
          comments: reviewComments,
          comment_count: reviewComments.length + reviewComments.reduce((sum, c) => {
            return sum + (Array.isArray(c.replies) ? c.replies.length : 0);
          }, 0),
        };
      });
  
      reviewsWithComments.sort((a, b) => {
        if (activeSort === 'newest') {
          return Number(b.ts || 0) - Number(a.ts || 0);
        }
        if (activeSort === 'oldest') {
          return Number(a.ts || 0) - Number(b.ts || 0);
        }
        if (activeSort === 'highest') {
          return Number(b.rating_half || 0) - Number(a.rating_half || 0)
            || Number(b.vote_score || 0) - Number(a.vote_score || 0)
            || Number(b.ts || 0) - Number(a.ts || 0);
        }
        if (activeSort === 'lowest') {
          return Number(a.rating_half || 0) - Number(b.rating_half || 0)
            || Number(b.vote_score || 0) - Number(a.vote_score || 0)
            || Number(b.ts || 0) - Number(a.ts || 0);
        }
  
        return Number(b.vote_score || 0) - Number(a.vote_score || 0)
          || Number(b.ts || 0) - Number(a.ts || 0);
      });
  
      const rating_histogram = dbx.getRatingHistogram(conn, showId);
      const verified_rating_histogram = dbx.getVerifiedRatingHistogram(conn, showId);
  
      const overallRankRow = conn.prepare(`
        WITH scored AS (
          SELECT
            s.id,
            ROUND(AVG(r.rating_half) / 2.0, 2) AS avg_rating,
            COUNT(*) AS rating_count,
            s.year
          FROM shows s
          JOIN ratings r ON r.show_id = s.id
          GROUP BY s.id
          HAVING COUNT(*) >= 5
        ),
        ordered AS (
          SELECT
            id,
            avg_rating,
            rating_count,
            year,
            ROW_NUMBER() OVER (
              ORDER BY avg_rating DESC, rating_count DESC, year DESC, id ASC
            ) AS overall_rank
          FROM scored
        ),
        ranked AS (
          SELECT
            id,
            overall_rank,
            MIN(overall_rank) OVER (
              PARTITION BY avg_rating
            ) AS overall_tie_rank
          FROM ordered
        )
        SELECT overall_rank, overall_tie_rank
        FROM ranked
        WHERE id = ?
      `).get(showId);
  
      const criticRankRow = conn.prepare(`
        WITH scored AS (
          SELECT
            s.id,
            ROUND(AVG(r.rating_half) / 2.0, 2) AS avg_rating,
            COUNT(*) AS rating_count,
            s.year
          FROM shows s
          JOIN ratings r ON r.show_id = s.id
          JOIN user_roles ur ON ur.user_id = r.user_id
          JOIN roles ro ON ro.id = ur.role_id
          WHERE ro.name = 'Verified Critic'
          GROUP BY s.id
          HAVING COUNT(*) >= 5
        ),
        ordered AS (
          SELECT
            id,
            avg_rating,
            rating_count,
            year,
            ROW_NUMBER() OVER (
              ORDER BY avg_rating DESC, rating_count DESC, year DESC, id ASC
            ) AS critic_rank
          FROM scored
        ),
        ranked AS (
          SELECT
            id,
            critic_rank,
            MIN(critic_rank) OVER (
              PARTITION BY avg_rating
            ) AS critic_tie_rank
          FROM ordered
        )
        SELECT critic_rank, critic_tie_rank
        FROM ranked
        WHERE id = ?
      `).get(showId);
  
      const corpsRankRow = conn.prepare(`
        WITH ranked AS (
          SELECT
            s.id,
            s.corps,
            RANK() OVER (
              PARTITION BY s.corps
              ORDER BY AVG(r.rating_half) DESC, COUNT(*) DESC, s.year DESC, s.id ASC
            ) AS corps_rank
          FROM shows s
          JOIN ratings r ON r.show_id = s.id
          GROUP BY s.id, s.corps
          HAVING COUNT(*) >= 5
        )
        SELECT corps_rank
        FROM ranked
        WHERE id = ?
      `).get(showId);
  
      const yearRankRow = conn.prepare(`
        WITH ranked AS (
          SELECT
            s.id,
            s.year,
            RANK() OVER (
              PARTITION BY s.year
              ORDER BY AVG(r.rating_half) DESC, COUNT(*) DESC, s.id ASC
            ) AS year_rank
          FROM shows s
          JOIN ratings r ON r.show_id = s.id
          GROUP BY s.id, s.year
          HAVING COUNT(*) >= 5
        )
        SELECT year_rank
        FROM ranked
        WHERE id = ?
      `).get(showId);
  
      const overall_rank = overallRankRow ? Number(overallRankRow.overall_rank || 0) : 0;
      const overall_tie_rank = overallRankRow ? Number(overallRankRow.overall_tie_rank || 0) : 0;
      
      const critic_rank = criticRankRow ? Number(criticRankRow.critic_rank || 0) : 0;
      const critic_tie_rank = criticRankRow ? Number(criticRankRow.critic_tie_rank || 0) : 0;
      
      const corps_rank = corpsRankRow ? Number(corpsRankRow.corps_rank || 0) : 0;
      const year_rank = yearRankRow ? Number(yearRankRow.year_rank || 0) : 0;
  
      res.render('show_detail', {
        row,
        me,
        my_rating: myRating,
        my_review: myReview,
        rating_histogram,
        verified_rating_histogram,
        reviews: reviewsWithComments,
        sort: activeSort,
        is_favorite: isFavorite,
        favorite_count: favoriteCount,
        show_favorite_count,
        overall_rank,
        overall_tie_rank,
        critic_rank,
        critic_tie_rank,
        corps_rank,
        year_rank,
      });
    } catch (err) {
      next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });


  app.post('/admin/show/:show_id/reply/:reply_id/delete', adminRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const replyId = Number(req.params.reply_id);
    let conn;
    try {
      conn = getConn();
      if (typeof dbx.deleteReviewReply === 'function') {
        await dbx.deleteReviewReply(conn, replyId, {
          requesterUserId: Number(req.session.uid),
          isAdmin: true
        });
      }
      await dbx.commit(conn);
      req.flash('ok', 'Reply deleted.');
    } catch (err) {
      req.flash('error', String(err.message || err));
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/show/${showId}`);
  }));


  app.post('/show/:show_id/comment/:comment_id/delete', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const commentId = Number(req.params.comment_id);
  
    let conn;
    try {
      conn = getConn();
  
      const show = await dbx.getShowById(conn, showId);
      if (!show) return res.sendStatus(404);
  
      await dbx.deleteReviewComment(conn, commentId, {
        requesterUserId: Number(req.session.uid),
        isAdmin: false
      });
  
      await dbx.commit(conn);
      req.flash('ok', 'Comment deleted.');
    } catch (err) {
      req.flash('error', String(err.message || err));
    } finally {
      if (conn) dbx.close(conn);
    }
  
    return res.redirect(`/show/${showId}`);
  }));
  
  app.post('/show/:show_id/reply/:reply_id/delete', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const replyId = Number(req.params.reply_id);
  
    let conn;
    try {
      conn = getConn();
  
      const show = await dbx.getShowById(conn, showId);
      if (!show) return res.sendStatus(404);
  
      await dbx.deleteReviewReply(conn, replyId, {
        requesterUserId: Number(req.session.uid),
        isAdmin: false
      });
  
      await dbx.commit(conn);
      req.flash('ok', 'Reply deleted.');
    } catch (err) {
      req.flash('error', String(err.message || err));
    } finally {
      if (conn) dbx.close(conn);
    }
  
    return res.redirect(`/show/${showId}`);
  }));
  
  
  

  app.post('/admin/show/:show_id/review/:review_user_id/delete', adminRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const reviewUserId = Number(req.params.review_user_id);
    let conn;
    try {
      conn = getConn();
      const show = await dbx.getShowById(conn, showId);
      if (!show) return res.sendStatus(404);
      await dbx.adminDeleteReview(conn, showId, reviewUserId);
      await dbx.commit(conn);
      req.flash('ok', 'Review deleted.');
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/show/${showId}`);
  }));

  app.post('/admin/show/:show_id/comment/:comment_id/delete', adminRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const commentId = Number(req.params.comment_id);
    let conn;
    try {
      conn = getConn();
      await dbx.deleteReviewComment(conn, commentId, { requesterUserId: Number(req.session.uid), isAdmin: true });
      await dbx.commit(conn);
      req.flash('ok', 'Comment deleted.');
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/show/${showId}`);
  }));

    app.get('/predictions', loginRequired(async (req, res, next) => {
      let conn;
  
      try {
        conn = getConn();
  
        const me = normalizeRow(await dbx.userById(conn, Number(req.session.uid)));
        if (!me) return res.sendStatus(404);
  
        if (!me.avatar_url) me.avatar_url = pfpUrlForUsername(me.username || '');
  
        const settings = normalizeRow(dbx.getPredictionSettings(conn));
        const seasonLabel = settings.season_label;
  
        const activeCorps = dbx.listPredictionActiveCorps(conn, seasonLabel);
        const activeSet = activeCorps;
        const myPrediction = dbx.getUserPredictionRows(conn, seasonLabel, Number(req.session.uid));
        const results = dbx.getPredictionResultsRows(conn, seasonLabel);
        const leaderboard = dbx.listPredictionLeaderboard(conn, seasonLabel).map((r) => {
          const d = normalizeRow(r);
          if (!d.avatar_url) d.avatar_url = pfpUrlForUsername(d.username || '');
          return d;
        });
  
        const submissionCount = dbx.countPredictionSubmissions(conn, seasonLabel);
  
        return res.render('predictions', {
          me,
          settings,
          active_corps: activeCorps,
          my_prediction: myPrediction,
          results,
          leaderboard,
          submission_count: submissionCount,
        });
      } catch (err) {
        return next(err);
      } finally {
        if (conn) dbx.close(conn);
      }
    }));
  
    app.post('/predictions', loginRequired(async (req, res) => {
      let conn;
  
      try {
        conn = getConn();
  
        const settings = dbx.getPredictionSettings(conn);
        const picks = [];
  
        for (let i = 1; i <= 12; i += 1) {
          picks.push(String(req.body[`slot_${i}`] || '').trim());
        }
  
        dbx.saveUserPrediction(conn, settings.season_label, Number(req.session.uid), picks);
        await dbx.commit(conn);
  
        req.flash('ok', 'Prediction submitted.');
      } catch (err) {
        req.flash('error', String(err.message || err));
      } finally {
        if (conn) dbx.close(conn);
      }
  
      return res.redirect('/predictions');
    }));

    app.get('/predictions/all', loginRequired(async (req, res, next) => {
      let conn;
    
      try {
        conn = getConn();
    
        const me = normalizeRow(await dbx.userById(conn, Number(req.session.uid)));
        if (!me) return res.sendStatus(404);
    
        if (!me.avatar_url) me.avatar_url = pfpUrlForUsername(me.username || '');
    
        const settings = normalizeRow(dbx.getPredictionSettings(conn));
        const seasonLabel = settings.season_label;
    
        const submissions = dbx.listAllPredictionSubmissions(conn, seasonLabel).map((u) => {
          const d = normalizeRow(u);
          if (!d.avatar_url) d.avatar_url = pfpUrlForUsername(d.username || '');
          return d;
        });
    
        return res.render('prediction_submissions', {
          me,
          settings,
          submissions,
        });
      } catch (err) {
        return next(err);
      } finally {
        if (conn) dbx.close(conn);
      }
    }));


  
    app.get('/admin/predictions', adminRequired(async (req, res, next) => {
      let conn;
  
      try {
        conn = getConn();
  
        const settings = normalizeRow(dbx.getPredictionSettings(conn));
        const seasonLabel = settings.season_label;
  
        const allCorps = dbx.listAllCorps(conn);
        const activeCorps = dbx.listPredictionActiveCorps(conn, seasonLabel);
        const activeSet = activeCorps;
  
        const results = dbx.getPredictionResultsRows(conn, seasonLabel);
        const leaderboard = dbx.listPredictionLeaderboard(conn, seasonLabel).map((r) => {
          const d = normalizeRow(r);
          if (!d.avatar_url) d.avatar_url = pfpUrlForUsername(d.username || '');
          return d;
        });
  
        const submissionCount = dbx.countPredictionSubmissions(conn, seasonLabel);
  
        return res.render('admin_predictions', {
          me: res.locals.me,
          settings,
          all_corps: allCorps,
          active_corps: activeCorps,
          active_set: activeSet,
          results,
          leaderboard,
          submission_count: submissionCount,
        });
      } catch (err) {
        return next(err);
      } finally {
        if (conn) dbx.close(conn);
      }
    }));
  
    app.post('/admin/predictions/settings', adminRequired(async (req, res) => {
      let conn;
  
      try {
        conn = getConn();
  
        const seasonLabel = String(req.body.season_label || '').trim() || 'Next Season';
        const isOpen = req.body.is_open === '1';
  
        dbx.updatePredictionSettings(conn, {
          seasonLabel,
          isOpen,
        });
  
        await dbx.commit(conn);
        req.flash('ok', 'Prediction settings updated.');
      } catch (err) {
        req.flash('error', String(err.message || err));
      } finally {
        if (conn) dbx.close(conn);
      }
  
      return res.redirect('/admin/predictions');
    }));
  
    app.post('/admin/predictions/active-corps', adminRequired(async (req, res) => {
      let conn;
  
      try {
        conn = getConn();
  
        const settings = dbx.getPredictionSettings(conn);
  
        let selected = req.body.active_corps || [];
        if (!Array.isArray(selected)) selected = selected ? [selected] : [];
  
        const customCorpsRaw = String(req.body.custom_corps || '').trim();
        const customCorps = customCorpsRaw
          ? customCorpsRaw
              .split(/\r?\n|,/)
              .map(x => x.trim())
              .filter(Boolean)
          : [];
  
        const finalList = [...selected, ...customCorps];
  
        dbx.setPredictionActiveCorps(conn, settings.season_label, finalList);
        await dbx.commit(conn);
  
        req.flash('ok', 'Active corps updated.');
      } catch (err) {
        req.flash('error', String(err.message || err));
      } finally {
        if (conn) dbx.close(conn);
      }
  
      return res.redirect('/admin/predictions');
    }));
  
    app.post('/admin/predictions/results', adminRequired(async (req, res) => {
      let conn;
  
      try {
        conn = getConn();
  
        const settings = dbx.getPredictionSettings(conn);
        const results = [];
  
        for (let i = 1; i <= 12; i += 1) {
          results.push(String(req.body[`result_${i}`] || '').trim());
        }
  
        dbx.savePredictionResults(conn, settings.season_label, results);
        await dbx.commit(conn);
  
        req.flash('ok', 'Final results saved.');
      } catch (err) {
        req.flash('error', String(err.message || err));
      } finally {
        if (conn) dbx.close(conn);
      }
  
      return res.redirect('/admin/predictions');
    }));
  
    app.post('/admin/predictions/award', adminRequired(async (req, res) => {
      let conn;
  
      try {
        conn = getConn();
  
        const settings = dbx.getPredictionSettings(conn);
        const result = dbx.awardPredictionScores(conn, settings.season_label);
  
        await dbx.commit(conn);
  
        req.flash('ok', `Points awarded. Users scored: ${result.users_scored}.`);
      } catch (err) {
        req.flash('error', String(err.message || err));
      } finally {
        if (conn) dbx.close(conn);
      }
  
      return res.redirect('/admin/predictions');
    }));
  
    app.post('/admin/predictions/reset-season', adminRequired(async (req, res) => {
      let conn;
  
      try {
        conn = getConn();
  
        const newSeasonLabel = String(req.body.new_season_label || '').trim();
  
        if (!newSeasonLabel) {
          req.flash('error', 'Enter a season label.');
          return res.redirect('/admin/predictions');
        }
  
        dbx.resetPredictionSeason(conn, newSeasonLabel);
        await dbx.commit(conn);
  
        req.flash('ok', `Prediction window reset for ${newSeasonLabel}.`);
      } catch (err) {
        req.flash('error', String(err.message || err));
      } finally {
        if (conn) dbx.close(conn);
      }
  
      return res.redirect('/admin/predictions');
    }));



  
  app.post('/show/:show_id/review/:review_user_id/comment', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const reviewUserId = Number(req.params.review_user_id);
    const commenterId = Number(req.session.uid);
    const text = String(req.body.comment_text || '').trim();
  
    let conn;
    try {
      conn = getConn();
  
      if (!text) {
        req.flash('error', 'Comment cannot be empty.');
        return res.redirect(`/show/${showId}`);
      }
  
      await dbx.addReviewComment(conn, showId, reviewUserId, commenterId, text);
  
      if (commenterId !== reviewUserId) {
        try {
          await dbx.addNotification(conn, {
            userId: reviewUserId,
            kind: 'review_comment',
            actorUserId: commenterId,
            showId,
            reviewUserId,
          });
        } catch (_) {}
      }
  
      await dbx.commit(conn);
      req.flash('ok', 'Comment posted.');
    } catch (err) {
      req.flash('error', String(err.message || err));
    } finally {
      if (conn) dbx.close(conn);
    }
  
    res.redirect(`/show/${showId}`);
  }));

  app.post('/show/:show_id/review/:review_user_id/comment/:comment_id/reply', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const reviewUserId = Number(req.params.review_user_id);
    const commentId = Number(req.params.comment_id);
    const replierId = Number(req.session.uid);
    const text = String(req.body.reply_text || '').trim();
    const parentReplyId = req.body.parent_reply_id ? Number(req.body.parent_reply_id) : null;
  
    let conn;
    try {
      conn = getConn();
      const show = await dbx.getShowById(conn, showId);
      if (!show) return res.sendStatus(404);
  
      await dbx.addReviewReply(
        conn,
        commentId,
        showId,
        reviewUserId,
        replierId,
        text,
        parentReplyId
      );
  
      let notifyUserId = reviewUserId;
  
      if (parentReplyId) {
        const parentReply = conn.prepare(`
          SELECT replier_user_id
          FROM review_comment_replies
          WHERE id = ?
        `).get(parentReplyId);
  
        if (parentReply && Number(parentReply.replier_user_id) !== replierId) {
          notifyUserId = Number(parentReply.replier_user_id);
        }
      } else {
        const parentComment = conn.prepare(`
          SELECT commenter_user_id
          FROM review_comments
          WHERE id = ?
        `).get(commentId);
  
        if (parentComment && Number(parentComment.commenter_user_id) !== replierId) {
          notifyUserId = Number(parentComment.commenter_user_id);
        }
      }
  
      if (notifyUserId !== replierId) {
        try {
          await dbx.addNotification(conn, {
            userId: notifyUserId,
            kind: 'comment_reply',
            actorUserId: replierId,
            showId,
            reviewUserId,
          });
        } catch (_) {}
      }
  
      await dbx.commit(conn);
    } catch (err) {
      req.flash('error', String(err.message || err));
    } finally {
      if (conn) dbx.close(conn);
    }
  
    res.redirect(`/show/${showId}`);
  }));

  app.post('/me/upload_banner', loginRequired((req, res, next) => {
    uploadPfp.single('banner_file')(req, res, async (err) => {
      if (err) {
        req.flash('error', `Upload failed: ${err.message}`);
        return res.redirect('/me/customize');
      }

      if (!req.file) {
        req.flash('error', 'No file selected.');
        return res.redirect('/me/customize');
      }

      let conn;
      try {
        conn = getConn();
        const me = normalizeRow(await dbx.userById(conn, Number(req.session.uid)));
        if (!me) return res.sendStatus(404);

        let ext = path.extname(req.file.originalname || '').toLowerCase();
        if (!ALLOWED_IMAGE_EXTS.has(ext)) {
          req.flash('error', 'Invalid file type.');
          return res.redirect('/me/customize');
        }
        if (ext === '.jpeg') ext = '.jpg';

        const oldBannerUrl = String(me.banner_url || '').trim();
        const fileName = `banner_${slugify(me.username)}_${crypto.randomUUID()}${ext}`;
        const key = `banners/${fileName}`;

        const bannerUrl = await uploadBufferToR2({
          key,
          buffer: req.file.buffer,
          contentType: req.file.mimetype || 'application/octet-stream',
          cacheControl: 'public, max-age=604800',
        });

        await dbx.updateUserProfileStyle(
          conn,
          Number(req.session.uid),
          me.avatar_url || null,
          bannerUrl,
          me.theme_color || null
        );
        await dbx.commit(conn);

        try {
          if (oldBannerUrl && oldBannerUrl !== bannerUrl) {
            await deleteStoredImageByUrl(oldBannerUrl, 'banner');
          }
        } catch (cleanupErr) {
          console.error('Failed to delete old banner asset:', cleanupErr);
        }

        req.flash('ok', 'Banner updated.');
        return res.redirect('/me/customize');
      } catch (e) {
        return next(e);
      } finally {
        if (conn) dbx.close(conn);
      }
    });
  }));

  app.post('/me/upload_pfp', loginRequired((req, res, next) => {
    uploadPfp.single('pfp_file')(req, res, async (err) => {
      if (err) {
        req.flash('error', `Upload failed: ${err.message}`);
        return res.redirect('/me/customize');
      }

      if (!req.file) {
        req.flash('error', 'No file selected.');
        return res.redirect('/me/customize');
      }

      let conn;
      try {
        conn = getConn();
        const me = normalizeRow(await dbx.userById(conn, Number(req.session.uid)));
        if (!me) return res.sendStatus(404);

        let ext = path.extname(req.file.originalname || '').toLowerCase();
        if (!ALLOWED_IMAGE_EXTS.has(ext)) {
          req.flash('error', 'Invalid file type.');
          return res.redirect('/me/customize');
        }
        if (ext === '.jpeg') ext = '.jpg';

        const oldAvatarUrl = String(me.avatar_url || '').trim();
        const fileName = `pfp_${slugify(me.username)}_${crypto.randomUUID()}${ext}`;
        const key = `pfps/${fileName}`;

        const avatarUrl = await uploadBufferToR2({
          key,
          buffer: req.file.buffer,
          contentType: req.file.mimetype || 'application/octet-stream',
          cacheControl: 'public, max-age=604800',
        });

        await dbx.updateUserAvatarUrl(conn, Number(req.session.uid), avatarUrl);
        await dbx.commit(conn);

        req.session.user = {
          id: Number(me.id),
          username: me.username,
          email: me.email || null,
          is_admin: Number(me.is_admin || 0),
          avatar_url: avatarUrl,
          theme_color: me.theme_color || null,
        };

        try {
          if (oldAvatarUrl && oldAvatarUrl !== avatarUrl) {
            await deleteStoredImageByUrl(oldAvatarUrl, 'pfp');
          }
        } catch (cleanupErr) {
          console.error('Failed to delete old avatar asset:', cleanupErr);
        }

        req.flash('ok', 'Profile picture updated.');
        return res.redirect('/me/customize');
      } catch (e) {
        return next(e);
      } finally {
        if (conn) dbx.close(conn);
      }
    });
  }));

  app.post('/show/:show_id/rate', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const ratingHalf = String(req.body.rating_half || '').trim();
    if (!/^\d+$/.test(ratingHalf)) {
      req.flash('error', 'Rating must be in half-star steps.');
      return res.redirect(`/show/${showId}`);
    }

    const rh = Number(ratingHalf);
    if (rh < 0 || rh > 10) {
      req.flash('error', 'Rating must be between 0 and 5 stars (half steps).');
      return res.redirect(`/show/${showId}`);
    }

    let conn;
    try {
      conn = getConn();
      const show = await dbx.getShowById(conn, showId);
      if (!show) return res.sendStatus(404);
      await dbx.upsertRating(conn, showId, Number(req.session.uid), rh);
      await dbx.commit(conn);
      req.flash('ok', 'Saved your rating.');
    } finally {
      if (conn) dbx.close(conn);
    }

    return res.redirect(`/show/${showId}`);
  }));

  app.post('/show/:show_id/unrate', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    let conn;
    try {
      conn = getConn();
      await dbx.deleteRating(conn, showId, Number(req.session.uid));
      await dbx.commit(conn);
      req.flash('ok', 'Removed your rating.');
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/show/${showId}`);
  }));

  app.get('/admin/bulk_add', adminRequired(async (req, res) => {
    return res.render('bulk_add', { me: res.locals.me });
  }));

  app.post('/show/:show_id/favorite', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const userId = Number(req.session.uid);

    let conn;
    try {
      conn = getConn();

      const show = await dbx.getShowById(conn, showId);
      if (!show) return res.sendStatus(404);

      const result = await dbx.addUserFavoriteShow(conn, userId, showId);

      if (result && result.ok === false && result.error === 'limit_reached') {
        req.flash('error', 'You can only have up to 5 favorite shows.');
        return res.redirect(`/show/${showId}`);
      }

      await dbx.commit(conn);
      req.flash('ok', 'Added to favorites.');
    } catch (err) {
      req.flash('error', String(err.message || err));
    } finally {
      if (conn) dbx.close(conn);
    }

    return res.redirect(`/show/${showId}`);
  }));

  
  app.post('/show/:show_id/unfavorite', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const userId = Number(req.session.uid);

    let conn;
    try {
      conn = getConn();

      const show = await dbx.getShowById(conn, showId);
      if (!show) return res.sendStatus(404);

      await dbx.removeUserFavoriteShow(conn, userId, showId);
      await dbx.commit(conn);
      req.flash('ok', 'Removed from favorites.');
    } catch (err) {
      req.flash('error', String(err.message || err));
    } finally {
      if (conn) dbx.close(conn);
    }

    return res.redirect(`/show/${showId}`);
  }));

  app.post('/admin/bulk_add', adminRequired(async (req, res) => {
    const { items, errors } = parseLines(req.body.bulk_text || '');

    if (errors.length) {
      for (const e of errors.slice(0, 10)) req.flash('error', e);
      if (errors.length > 10) req.flash('error', `...and ${errors.length - 10} more errors.`);
      return res.redirect('/admin/bulk_add');
    }

    let inserted = 0;
    let dupes = 0;
    let otherBad = 0;
    let conn;

    try {
      conn = getConn();
      for (const [y, c, t, poster] of items) {
        const [ok, _sid, msg] = await dbx.addShow(conn, y, c, t, { posterUrl: poster });
        if (ok) inserted += 1;
        else if (msg === 'Duplicate') dupes += 1;
        else otherBad += 1;
      }
      await dbx.commit(conn);
    } finally {
      if (conn) dbx.close(conn);
    }

    req.flash('ok', `Bulk add done. Inserted: ${inserted}. Duplicates skipped: ${dupes}. Other issues: ${otherBad}.`);
    return res.redirect('/shows');
  }));

  app.post('/admin/user/:user_id/delete-pfp', adminRequired(async (req, res) => {
    const userId = Number(req.params.user_id);
    let conn;
    let redirectTo = `/u/${userId}`;

    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userById(conn, userId));
      if (!u) return res.status(404).send('User not found');

      redirectTo = `/u/${encodeURIComponent(u.username)}`;

      const avatarUrl = String(u.avatar_url || '').trim();

      try {
        await deleteStoredImageByUrl(avatarUrl, 'pfp');
      } catch (err) {
        console.error('Failed to delete profile picture asset:', err);
      }

      await dbx.updateUserAvatarUrl(conn, userId, null);
      await dbx.commit(conn);

      req.flash('ok', `Profile picture for ${u.username} has been removed.`);
    } catch (err) {
      req.flash('error', `Failed to delete PFP: ${err.message}`);
    } finally {
      if (conn) dbx.close(conn);
    }

    res.redirect(redirectTo);
  }));

  app.get('/admin/show/:show_id/edit', adminRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    let conn;
    try {
      conn = getConn();
      const s = normalizeRow(await dbx.getShowById(conn, showId));
      if (!s) return res.sendStatus(404);
      return res.render('admin_edit_show', { s, me: res.locals.me });
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/admin/show/:show_id/edit', adminRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const title = String(req.body.title || '').trim();
    const corps = String(req.body.corps || '').trim();
    const year = String(req.body.year || '').trim();
    const posterUrl = String(req.body.poster_url || '').trim();

    if (!/^\d+$/.test(year)) {
      req.flash('error', 'Year must be a number.');
      return res.redirect(`/admin/show/${showId}/edit`);
    }

    let conn;
    try {
      conn = getConn();
      const s = await dbx.getShowById(conn, showId);
      if (!s) return res.sendStatus(404);
      await dbx.updateShow(conn, showId, Number(year), corps, title, { posterUrl });
      await dbx.commit(conn);
      req.flash('ok', 'Show updated.');
      return res.redirect(`/show/${showId}`);
    } catch (err) {
      req.flash('error', String(err.message || err));
      return res.redirect(`/admin/show/${showId}/edit`);
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/admin/show/:show_id/upload_poster', adminRequired((req, res, next) => {
    uploadPoster.single('poster_file')(req, res, async (err) => {
      const showId = Number(req.params.show_id);

      if (err) {
        req.flash('error', `Upload failed: ${err.message}`);
        return res.redirect(`/admin/show/${showId}/edit`);
      }

      if (!req.file) {
        req.flash('error', 'No file selected.');
        return res.redirect(`/admin/show/${showId}/edit`);
      }

      let conn;
      try {
        conn = getConn();
        const row = normalizeRow(await dbx.getShowById(conn, showId));
        if (!row) return res.sendStatus(404);

        let ext = path.extname(req.file.originalname || '').toLowerCase();
        if (!ALLOWED_IMAGE_EXTS.has(ext)) {
          req.flash('error', 'Invalid file type.');
          return res.redirect(`/admin/show/${showId}/edit`);
        }
        if (ext === '.jpeg') ext = '.jpg';

        const oldPosterUrl = String(row.poster_url || '').trim();

        const fileName = `${slugify(row.corps)}${parseInt(row.year, 10)}_${crypto.randomUUID()}${ext}`;
        const key = `posters/${fileName}`;

        const posterUrl = await uploadBufferToR2({
          key,
          buffer: req.file.buffer,
          contentType: req.file.mimetype || 'application/octet-stream',
          cacheControl: 'public, max-age=31536000, immutable',
        });

        await dbx.updateShowPosterUrl(conn, showId, posterUrl);
        await dbx.commit(conn);

        try {
          if (oldPosterUrl && oldPosterUrl !== posterUrl) {
            await deleteStoredImageByUrl(oldPosterUrl, 'poster');
          }
        } catch (cleanupErr) {
          console.error('Failed to delete old poster asset:', cleanupErr);
        }

        req.flash('ok', 'Poster uploaded.');
        return res.redirect(`/admin/show/${showId}/edit`);
      } catch (e) {
        return next(e);
      } finally {
        if (conn) dbx.close(conn);
      }
    });
  }));

  app.get('/u/:username/ratings', async (req, res, next) => {
    const username = req.params.username;
    const sort = String(req.query.sort || 'high').trim().toLowerCase();
    const q = String(req.query.q || '').trim();

    let conn;
    try {
      conn = getConn();
      const me = await currentUser(req);
      const profileUser = normalizeRow(await dbx.userByUsername(conn, username));
      if (!profileUser) return res.sendStatus(404);
      const rows = (await dbx.listAllRatingsForUser(conn, profileUser.id, { sort, corpsQ: q }) || []).map(normalizeRow);
      const userRoles = (await dbx.rolesForUser(conn, Number(profileUser.id)) || []).map(normalizeRow);

      return res.render('user_all_ratings', {
        me,
        profile_user: profileUser,
        user_roles: userRoles,
        sort,
        q,
        rows,
      });
    } catch (err) {
      return next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.post('/show/:show_id/review', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const text = String(req.body.review_text || '').trim();
    let conn;
    try {
      conn = getConn();
      const show = await dbx.showDetail(conn, showId);
      if (!show) return res.sendStatus(404);
      await dbx.upsertReview(conn, showId, Number(req.session.uid), text);
      await dbx.commit(conn);
      req.flash('ok', 'Saved your review.');
    } catch (err) {
      req.flash('error', String(err.message || err));
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/show/${showId}`);
  }));

  app.post('/show/:show_id/review/delete', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    let conn;
    try {
      conn = getConn();
      await dbx.deleteReview(conn, showId, Number(req.session.uid));
      await dbx.commit(conn);
      req.flash('ok', 'Deleted your review.');
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/show/${showId}`);
  }));

  app.get('/admin/roles', adminRequired(async (req, res) => {
    let conn;
    try {
      conn = getConn();
      const roles = (await dbx.listRoles(conn) || []).map(normalizeRow);
      return res.render('admin_roles', {
        roles,
        me: res.locals.me,
      });
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/admin/roles', adminRequired(async (req, res) => {
    const name = String(req.body.name || '').trim();
    const color = String(req.body.color || '').trim();
    let conn;
    try {
      conn = getConn();
      await dbx.createRole(conn, name, color);
      await dbx.commit(conn);
      req.flash('ok', 'Role created.');
    } catch (err) {
      req.flash('error', String(err.message || 'Role name already exists.'));
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect('/admin/roles');
  }));

  app.post('/admin/roles/:role_id/delete', adminRequired(async (req, res) => {
    let conn;
    try {
      conn = getConn();
      await dbx.deleteRole(conn, Number(req.params.role_id));
      await dbx.commit(conn);
      req.flash('ok', 'Role deleted.');
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect('/admin/roles');
  }));

  app.get('/admin/user/:username/roles', adminRequired(async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      const roles = (await dbx.listRoles(conn) || []).map(normalizeRow);
      const userRoles = (await dbx.rolesForUser(conn, Number(u.id)) || []).map(normalizeRow);
      const userRoleIds = new Set(userRoles.map((r) => Number(r.id)));
      return res.render('admin_user_roles', {
        u,
        roles,
        user_roles: userRoles,
        user_role_ids: userRoleIds,
        me: res.locals.me,
      });
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/admin/user/:username/roles/assign', adminRequired(async (req, res) => {
    const username = req.params.username;
    const roleId = Number(req.body.role_id || 0);
    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      await dbx.assignRoleToUser(conn, Number(u.id), roleId, { assignedByUserId: Number(req.session.uid) });
      await dbx.commit(conn);
      req.flash('ok', 'Role assigned.');
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/admin/user/${encodeURIComponent(username)}/roles`);
  }));

  app.post('/admin/user/:username/roles/remove', adminRequired(async (req, res) => {
    const username = req.params.username;
    const roleId = Number(req.body.role_id || 0);
    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      await dbx.removeRoleFromUser(conn, Number(u.id), roleId);
      await dbx.commit(conn);
      req.flash('ok', 'Role removed.');
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/admin/user/${encodeURIComponent(username)}/roles`);
  }));

  app.get('/admin/user/:username/force-reset', adminRequired(async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      res.render('admin_force_reset', { u, me: res.locals.me });
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.get('/admin/user/:username/set-temp-password', adminRequired(async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      res.render('admin_set_temp_password', { u, me: res.locals.me });
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/admin/user/:username/set-temp-password', adminRequired(async (req, res) => {
    const username = req.params.username;
    const tempPassword = String(req.body.temp_password || '').trim();
    const tempPassword2 = String(req.body.temp_password2 || '').trim();

    if (tempPassword.length < 6) {
      req.flash('error', 'Temporary password must be at least 6 characters.');
      return res.redirect(`/admin/user/${encodeURIComponent(username)}/set-temp-password`);
    }

    if (tempPassword !== tempPassword2) {
      req.flash('error', 'Temporary passwords do not match.');
      return res.redirect(`/admin/user/${encodeURIComponent(username)}/set-temp-password`);
    }

    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);

      const newHash = await hashPassword(tempPassword);
      await dbx.updateUserPasswordHash(conn, Number(u.id), newHash);
      await dbx.setUserMustChangePassword(conn, Number(u.id), 1);
      await dbx.commit(conn);

      req.flash('ok', `Temporary password set for ${u.username}.`);
      res.redirect('/admin/users');
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/admin/user/:username/force-reset', adminRequired(async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);

      await dbx.setUserMustChangePassword(conn, Number(u.id), 1);
      await dbx.commit(conn);

      req.flash('ok', `Forced password reset for ${u.username}.`);
      res.redirect('/admin/users');
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/admin/user/:username/temp-password', adminRequired(async (req, res, next) => {
    const username = String(req.params.username || '').trim();

    let conn;
    try {
      conn = getConn();

      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);

      if (!u.email) {
        req.flash('error', 'That user does not have an email address on file.');
        return res.redirect('/admin/users');
      }

      const tempPassword = makeTempPassword(12);
      const newHash = await hashPassword(tempPassword);

      await dbx.updateUserPasswordHash(conn, Number(u.id), newHash);
      await dbx.setUserMustChangePassword(conn, Number(u.id), 1);
      await dbx.commit(conn);

      await sendTempPasswordEmail(u.email, u.username, tempPassword);

      req.flash('ok', `Temporary password sent to ${u.email}.`);
      return res.redirect('/admin/users');
    } catch (err) {
      return next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.get('/api/users/search', (req, res) => {
    try {
      const q = String(req.query.q || '').trim();

      if (!q) {
        return res.json({ ok: true, users: [] });
      }

      const conn = dbx.connect(process.env.DB_PATH || '/data/site.db');
      try {
        const users = dbx.searchUsers(conn, q, { limit: 8 }) || [];
        return res.json({
          ok: true,
          users: users.map(u => ({
            id: Number(u.id),
            username: u.username || '',
            avatar_url: u.avatar_url || ''
          }))
        });
      } finally {
        dbx.close(conn);
      }
    } catch (err) {
      console.error('user search error:', err);
      return res.status(500).json({ ok: false, users: [], error: 'search_failed' });
    }
  });

  app.get('/me', loginRequired(async (req, res) => {
    let conn;
    try {
      conn = getConn();
      const uid = Number(req.session.uid);
      const u = normalizeRow(await dbx.userById(conn, uid));
      if (!u) return res.sendStatus(404);

      const [avg, cnt] = await dbx.userAvgRating(conn, uid);
      u.avg_rating = avg;
      u.avg_rating_cnt = cnt;
      u.followers_count = await dbx.followerCount(conn, uid);
      u.following_count = await dbx.followingCount(conn, uid);
      u.viewer_is_following = await dbx.isFollowing(conn, uid, uid);
      u.viewer_friend_status = await dbx.friendsStatus(conn, uid, uid);

      const rolesForMe = (await dbx.rolesForUser(conn, uid) || []).map(normalizeRow);
      const recentRatings = (await dbx.listRecentRatingsForUser(conn, uid, { limit: 8 }) || []).map((x) => {
        const d = normalizeRow(x);
        if (!d.poster_url) d.poster_url = posterUrlForShow(d.corps || '', d.year || 0);
        return d;
      });
      const recentReviews = (await dbx.listRecentReviewsForUser(conn, uid, { limit: 8 }) || []).map((x) => {
        const d = normalizeRow(x);
        if (!d.poster_url) d.poster_url = posterUrlForShow(d.corps || '', d.year || 0);
        return d;
      });

      const favoriteShows = (await dbx.getUserFavoriteShows(conn, uid, 5) || []).map((x) => {
        const d = normalizeRow(x);
        if (!d.poster_url) d.poster_url = posterUrlForShow(d.corps || '', d.year || 0);
        return d;
      });

      if (!u.avatar_url) u.avatar_url = pfpUrlForUsername(u.username || '');

      return res.render('profile', {
        profile_user: u,
        user_roles: rolesForMe,
        recent_ratings: recentRatings,
        recent_reviews: recentReviews,
        favorite_shows: favoriteShows,
        me: u,
        is_me: true,
      });
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.get('/u/:username', async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const profile = normalizeRow(await dbx.userByUsername(conn, username));
      if (!profile) return res.sendStatus(404);

      const [avg, cnt] = await dbx.userAvgRating(conn, Number(profile.id));
      profile.avg_rating = avg;
      profile.avg_rating_cnt = cnt;

      const viewerId = req.session.uid ? Number(req.session.uid) : null;
      profile.followers_count = await dbx.followerCount(conn, Number(profile.id));
      profile.following_count = await dbx.followingCount(conn, Number(profile.id));
      profile.viewer_is_following = viewerId ? await dbx.isFollowing(conn, viewerId, Number(profile.id)) : false;
      profile.viewer_friend_status = viewerId ? await dbx.friendsStatus(conn, viewerId, Number(profile.id)) : 'none';

      const rolesForUser = (await dbx.rolesForUser(conn, Number(profile.id)) || []).map(normalizeRow);
      const recentRatings = (await dbx.listRecentRatingsForUser(conn, Number(profile.id), { limit: 7 }) || []).map((x) => {
        const d = normalizeRow(x);
        if (!d.poster_url) d.poster_url = posterUrlForShow(d.corps || '', d.year || 0);
        return d;
      });
      const recentReviews = (await dbx.listRecentReviewsForUser(conn, Number(profile.id), { limit: 8 }) || []).map((x) => {
        const d = normalizeRow(x);
        if (!d.poster_url) d.poster_url = posterUrlForShow(d.corps || '', d.year || 0);
        return d;
      });

      const favoriteShows = (await dbx.getUserFavoriteShows(conn, Number(profile.id), 5) || []).map((x) => {
        const d = normalizeRow(x);
        if (!d.poster_url) d.poster_url = posterUrlForShow(d.corps || '', d.year || 0);
        return d;
      });

      if (!profile.avatar_url) profile.avatar_url = pfpUrlForUsername(profile.username || '');

      let me = null;
      if (req.session.uid) {
        const meRow = await dbx.userById(conn, Number(req.session.uid));
        me = meRow ? normalizeRow(meRow) : null;
      }

      const isMe = !!(me && me.username === profile.username);
      return res.render('profile', {
        profile_user: profile,
        user_roles: rolesForUser,
        recent_ratings: recentRatings,
        recent_reviews: recentReviews,
        favorite_shows: favoriteShows,
        me,
        is_me: isMe,
      });
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/me/customize', loginRequired(async (req, res) => {
    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userById(conn, Number(req.session.uid)));
      if (!u) return res.sendStatus(404);
      res.render('profile_customize', { u, me: res.locals.me });
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/me/customize', loginRequired(async (req, res) => {
    const themeColorRaw = String(req.body.theme_color || '').trim();
    const themeColor = themeColorRaw ? resolveAccentColor(themeColorRaw) : null;

    if (themeColorRaw && !/^#([0-9a-fA-F]{6})$/.test(themeColorRaw)) {
      req.flash('error', 'Theme color must be in #RRGGBB format.');
      return res.redirect('/me/customize');
    }

    let conn;
    try {
      conn = getConn();

      const current = normalizeRow(await dbx.userById(conn, Number(req.session.uid)));
      if (!current) return res.sendStatus(404);

      await dbx.updateUserProfileStyle(
        conn,
        Number(req.session.uid),
        current.avatar_url || null,
        current.banner_url || null,
        themeColor
      );

      await dbx.commit(conn);

      const fresh = normalizeRow(await dbx.userById(conn, Number(req.session.uid)));
      const safeThemeColor = resolveAccentColor(fresh.theme_color);

      req.session.user = {
        ...(req.session.user || {}),
        id: Number(fresh.id),
        username: fresh.username,
        email: fresh.email || null,
        is_admin: Number(fresh.is_admin || 0),
        avatar_url: fresh.avatar_url || null,
        theme_color: safeThemeColor,
      };

      req.flash('ok', 'Theme color updated.');
    } finally {
      if (conn) dbx.close(conn);
    }

    res.redirect('/me/customize');
  }));

  app.get('/admin/stats', adminRequired(async (req, res, next) => {
    let conn;
    try {
      conn = getConn();
  
      const stats = normalizeRow(await dbx.getSiteStats(conn));
  
      return res.render('admin_stats', {
        me: res.locals.me,
        stats,
      });
    } catch (err) {
      return next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.get('/admin/users', adminRequired(async (req, res, next) => {
    let conn;
    try {
      conn = getConn();

      const sort = req.query.sort === 'newest' ? 'newest' : 'default';

      const users = conn.prepare(`
        SELECT
          id,
          username,
          email,
          is_admin,
          avatar_url,
          created_ts,
          must_change_password
        FROM users
        ORDER BY ${
          sort === 'newest'
            ? 'created_ts DESC, id DESC'
            : 'LOWER(username) ASC'
        }
      `).all().map(normalizeRow);

      for (const u of users) {
        if (!u.avatar_url) u.avatar_url = pfpUrlForUsername(u.username || '');
        try {
          u.roles = (await dbx.rolesForUser(conn, Number(u.id)) || []).map(normalizeRow);
        } catch {
          u.roles = [];
        }
      }

      return res.render('admin_users', {
        me: res.locals.me,
        users,
        sort,
      });
    } catch (err) {
      return next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.get('/admin/roles/:role_id/edit', adminRequired(async (req, res) => {
    let conn;
    try {
      conn = getConn();
      const r = await dbx.roleById(conn, Number(req.params.role_id));
      if (!r) return res.sendStatus(404);
      res.render('admin_role_edit', { r: normalizeRow(r), me: res.locals.me });
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/admin/roles/:role_id/edit', adminRequired(async (req, res) => {
    const roleId = Number(req.params.role_id);
    const name = String(req.body.name || '').trim();
    const color = String(req.body.color || '').trim();
    let conn;
    try {
      conn = getConn();
      await dbx.updateRole(conn, roleId, name, color);
      await dbx.commit(conn);
      req.flash('ok', 'Role updated.');
      res.redirect('/admin/roles');
    } catch (err) {
      req.flash('error', String(err.message || err));
      res.redirect(`/admin/roles/${roleId}/edit`);
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.get('/show/:show_id/critics', async (req, res, next) => {
    const showId = Number(req.params.show_id);
    const viewerUid = req.session.uid ? Number(req.session.uid) : null;

    let conn;
    try {
      conn = getConn();

      let row = normalizeRow(await dbx.getShowById(conn, showId));
      if (!row) return res.sendStatus(404);
      if (!row.poster_url) row.poster_url = posterUrlForShow(row.corps || '', row.year || 0);

      let me = viewerUid ? normalizeRow(await dbx.userById(conn, viewerUid)) : null;
      if (me && !me.avatar_url) me.avatar_url = pfpUrlForUsername(me.username || '');

      const criticRatings = conn.prepare(`
        SELECT
          u.id AS user_id,
          u.username,
          u.avatar_url,
          r.rating_half,
          rv.review_text,
          rv.ts,
          ro.name AS role_name,
          ro.color AS role_color
        FROM ratings r
        JOIN users u ON u.id = r.user_id
        JOIN user_roles ur ON ur.user_id = u.id
        JOIN roles ro ON ro.id = ur.role_id
        LEFT JOIN reviews rv ON rv.show_id = r.show_id AND rv.user_id = r.user_id
        WHERE r.show_id = ?
          AND ro.name = 'Verified Critic'
        ORDER BY r.rating_half DESC, LOWER(u.username) ASC
      `).all(showId).map(normalizeRow).map((c) => {
        if (!c.avatar_url) c.avatar_url = pfpUrlForUsername(c.username || '');
        return c;
      });

      res.render('show_critics', {
        row,
        me,
        critic_ratings: criticRatings,
      });
    } catch (err) {
      next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.post('/show/:show_id/review/:review_user_id/vote', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const reviewUserId = Number(req.params.review_user_id);
    const vote = Number(req.body.vote || 0);
    const voterUserId = Number(req.session.uid);

    if (![1, -1].includes(vote)) return res.sendStatus(400);
    if (voterUserId === reviewUserId) {
      req.flash('error', "You can't vote on your own review.");
      return res.redirect(`/show/${showId}`);
    }

    let conn;
    try {
      conn = getConn();
      await dbx.setReviewVote(conn, showId, reviewUserId, voterUserId, vote);
      if (vote === 1) {
        await dbx.addNotification(conn, {
          userId: reviewUserId,
          kind: 'review_upvote',
          actorUserId: voterUserId,
          showId,
          reviewUserId,
          vote: 1,
        });
      }
      await dbx.commit(conn);
    } finally {
      if (conn) dbx.close(conn);
    }

    res.redirect(`/show/${showId}`);
  }));

  app.get('/top', (req, res, next) => {
    const mode = String(req.query.mode || 'top').trim().toLowerCase();

    const allowedModes = new Set(['top', 'bottom', 'critic_top', 'critic_bottom']);
    const safeMode = allowedModes.has(mode) ? mode : 'top';

    let conn;
    try {
      conn = getConn();

      let rawRows = dbx.listTopShowsWithTopReview(conn, {
        mode: safeMode,
        limit: 100
      }) || [];

      const rows = rawRows.map((r) => {
        const d = normalizeRow(r);
        if (!d.poster_url || !String(d.poster_url).trim()) {
          d.poster_url = posterUrlForShow(d.corps || '', d.year || 0);
        }
        if (d.top_review_username && !d.top_review_avatar_url) {
          d.top_review_avatar_url = pfpUrlForUsername(d.top_review_username);
        }
        return d;
      });

      return res.render('top_shows', {
        me: res.locals.me || null,
        rows,
        mode: safeMode
      });
    } catch (err) {
      return next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/top_users', async (req, res, next) => {
    let conn;
    try {
      conn = getConn();
      const rawRows = dbx.listTopUsersByReviewUpvotes(conn, 25) || [];

      const rows = rawRows.map((r) => {
        const d = normalizeRow(r);
        if (!d.avatar_url) d.avatar_url = pfpUrlForUsername(d.username || '');
        if (d.top_show_id && !d.top_poster_url) {
          d.top_poster_url = posterUrlForShow(d.top_corps || '', d.top_year || 0);
        }
        return d;
      });

      res.render('top_users', { rows });
    } catch (err) {
      console.error("Top Users Route Error:", err);
      next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.post('/u/:username/follow', loginRequired(async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const meId = Number(req.session.uid);
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      await dbx.follow(conn, meId, Number(u.id));
      await dbx.addNotification(conn, { userId: Number(u.id), kind: 'follow', actorUserId: meId });
      await dbx.commit(conn);
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/u/${encodeURIComponent(username)}`);
  }));

  app.post('/u/:username/unfollow', loginRequired(async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const meId = Number(req.session.uid);
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      await dbx.unfollow(conn, meId, Number(u.id));
      await dbx.commit(conn);
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/u/${encodeURIComponent(username)}`);
  }));

  app.get('/u/:username/followers', async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      const rows = (await dbx.listFollowers(conn, Number(u.id), { limit: 500 }) || []).map(normalizeRow);
      res.render('followers', { profile_user: u, rows });
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/u/:username/following', async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      const rows = (await dbx.listFollowing(conn, Number(u.id), { limit: 500 }) || []).map(normalizeRow);
      res.render('following', { profile_user: u, rows });
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/me/friends', loginRequired(async (req, res) => {
    let conn;
    try {
      conn = getConn();
      const meId = Number(req.session.uid);
      const me = normalizeRow(await dbx.userById(conn, meId));
      const friends = (await dbx.listFriends(conn, meId, { limit: 500 }) || []).map(normalizeRow);
      const incoming = (await dbx.listIncomingFriendRequests(conn, meId, { limit: 200 }) || []).map(normalizeRow);
      res.render('friends', { me, friends, incoming });
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/u/:username/friend/request', loginRequired(async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const meId = Number(req.session.uid);
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      await dbx.sendFriendRequest(conn, meId, Number(u.id));
      await dbx.addNotification(conn, { userId: Number(u.id), kind: 'friend_request', actorUserId: meId });
      await dbx.commit(conn);
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/u/${encodeURIComponent(username)}`);
  }));

  app.post('/u/:username/friend/accept', loginRequired(async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const meId = Number(req.session.uid);
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      await dbx.acceptFriendRequest(conn, Number(u.id), meId);
      await dbx.commit(conn);
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect('/me/friends');
  }));

  app.post('/u/:username/friend/decline', loginRequired(async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const meId = Number(req.session.uid);
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      await dbx.declineFriendRequest(conn, Number(u.id), meId);
      await dbx.commit(conn);
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect('/me/friends');
  }));

  app.post('/u/:username/friend/remove', loginRequired(async (req, res) => {
    const username = req.params.username;
    let conn;
    try {
      conn = getConn();
      const meId = Number(req.session.uid);
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u) return res.sendStatus(404);
      await dbx.removeFriend(conn, meId, Number(u.id));
      await dbx.commit(conn);
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/u/${encodeURIComponent(username)}`);
  }));

  app.post('/me/notifications/read', loginRequired(async (req, res) => {
    let conn;
    try {
      conn = getConn();
      await dbx.markAllNotificationsRead(conn, Number(req.session.uid));
      await dbx.commit(conn);
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(req.get('referer') || '/shows');
  }));

  app.post('/admin/show/:show_id/delete', adminRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    let conn;

    try {
      conn = getConn();
      const s = normalizeRow(await dbx.getShowById(conn, showId));
      if (!s) return res.sendStatus(404);

      const posterUrl = String(s.poster_url || '').trim();

      try {
        await deleteStoredImageByUrl(posterUrl, 'poster');
      } catch (err) {
        console.error('Failed to delete poster asset:', err);
      }

      await dbx.adminDeleteShow(conn, showId);
      await dbx.commit(conn);
      req.flash('ok', 'Show deleted permanently.');
    } finally {
      if (conn) dbx.close(conn);
    }

    res.redirect('/shows');
  }));

  app.post('/me/change_username', loginRequired(async (req, res) => {
    const uid = Number(req.session.uid);
    const newUsername = String(req.body.new_username || '').trim();
    const currentPassword = String(req.body.current_password || '').trim();

    if (!USERNAME_RE.test(newUsername)) {
      req.flash('error', 'Username must be 3–20 chars and only letters, numbers, underscore.');
      return res.redirect('/me');
    }
    if (!currentPassword) {
      req.flash('error', 'Enter your current password to change your username.');
      return res.redirect('/me');
    }

    let conn;
    try {
      conn = getConn();
      const me = normalizeRow(await dbx.userById(conn, uid));
      if (!me) return res.sendStatus(404);

      const passCol = dbx.usersPasswordCol(conn);
      const storedHash = me[passCol];
      const ok = await verifyPassword(currentPassword, storedHash);
      if (!ok) {
        req.flash('error', 'Current password is incorrect.');
        return res.redirect('/me');
      }

      if (String(me.username || '').toLowerCase() === newUsername.toLowerCase()) {
        req.flash('warn', 'That is already your username.');
        return res.redirect('/me');
      }

      if (await dbx.userByUsername(conn, newUsername)) {
        req.flash('error', 'That username is already taken.');
        return res.redirect('/me');
      }

      await dbx.updateUserUsername(conn, uid, newUsername);

      if (needsRehashToBcrypt(storedHash)) {
        const newHash = await hashPassword(currentPassword);
        await dbx.updateUserPasswordHash(conn, uid, newHash);
      }

      await dbx.commit(conn);

      const fresh = normalizeRow(await dbx.userById(conn, uid));
      req.session.user = {
        ...(req.session.user || {}),
        id: Number(fresh.id),
        username: fresh.username,
        email: fresh.email || null,
        is_admin: Number(fresh.is_admin || 0),
        avatar_url: fresh.avatar_url || null,
        theme_color: fresh.theme_color || null,
      };

      req.flash('ok', 'Username updated.');
      return res.redirect('/me');
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/me/change_password', loginRequired(async (req, res) => {
    const uid = Number(req.session.uid);
    const currentPassword = String(req.body.current_password || '').trim();
    const newPassword = String(req.body.new_password || '').trim();
    const newPassword2 = String(req.body.new_password2 || '').trim();

    if (!currentPassword) {
      req.flash('error', 'Enter your current password.');
      return res.redirect('/me');
    }
    if (newPassword.length < 6) {
      req.flash('error', 'New password must be at least 6 characters.');
      return res.redirect('/me');
    }
    if (newPassword !== newPassword2) {
      req.flash('error', 'New passwords do not match.');
      return res.redirect('/me');
    }

    let conn;
    try {
      conn = getConn();
      const me = normalizeRow(await dbx.userById(conn, uid));
      if (!me) return res.sendStatus(404);

      const passCol = dbx.usersPasswordCol(conn);
      const storedHash = me[passCol];
      const ok = await verifyPassword(currentPassword, storedHash);
      if (!ok) {
        req.flash('error', 'Current password is incorrect.');
        return res.redirect('/me');
      }

      await dbx.updateUserPasswordHash(conn, uid, await hashPassword(newPassword));
      await dbx.setUserMustChangePassword(conn, uid, 0);
      await dbx.commit(conn);
      req.flash('ok', 'Password updated.');
      return res.redirect('/me');
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.get('/debug-session', (req, res) => {
    res.json({
      sessionID: req.sessionID,
      uid: req.session?.uid || null,
      sessionUser: req.session?.user || null,
      session: req.session || null,
    });
  });

  app.get('/debug-users', (_req, res, next) => {
    let conn;
    try {
      conn = getConn();
      const users = conn.prepare('SELECT id, username, email, is_admin, created_ts FROM users ORDER BY id ASC').all();
      res.json(users);
    } catch (err) {
      next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(err.status || 500).send(err.message || 'Internal Server Error');
  });

  app.use((_req, res) => res.status(404).send('Not Found'));

  return app;
}

const app = createApp();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`DB_PATH=${DB_PATH}`);
});
