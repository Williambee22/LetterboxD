const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const SQLiteStoreFactory = require('connect-sqlite3');

const dbx = require('./db');

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

const BASE_DIR = __dirname;
const STATIC_DIR = path.join(BASE_DIR, 'static');
const POSTER_DIR = path.join(STATIC_DIR, 'posters');
const PFP_DIR = path.join(STATIC_DIR, 'pfps');

fs.mkdirSync(POSTER_DIR, { recursive: true });
fs.mkdirSync(PFP_DIR, { recursive: true });

const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_UPLOAD_MB = 5;

const APP_SECRET = process.env.APP_SECRET || 'dev-secret-change-me';
const DB_PATH = process.env.DB_PATH || "/data/site.db";
const PORT = parseInt(process.env.PORT || '8080', 10);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });


const SQLiteStore = require("connect-sqlite3")(session);

app.use(session({
  secret: process.env.APP_SECRET || "dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    sameSite: "lax"
  }
}));


const BAD_WORDS = new Set([
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'pussy',
  'faggot', 'nigger', 'slut', 'whore', 'douchebag', 'motherfucker', 'twat',
  'cock', 'piss', 'fucker', 'shitter', 'bitchass', 'asshat', 'bullshit',
  'chink', 'cocks', 'niggers', 'faggots', 'sluts', 'whores', 'douchebags',
  'motherfuckers', 'pussylicker', 'pussylicking', 'pussylicked', 'nigglet', 'nigglets',
  'nigga', 'niggas', 'faggotry', 'fag', 'fags', 'jiggaboo', 'jiggaboos',
  'spic', 'spics', 'gook', 'gooks', 'beaner', 'beaners', 'horseshit',
  'asswipe', 'asswipes', 'shithead', 'shitheads', 'dickhead', 'dickheads',
  'dogshit', 'cuntface', 'cuntfaces', 'pisshead', 'pissheads', 'twatface', 'twatfaces', 'twink', 'twinks'
]);

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

function pfpFilenameForUsername(username, ext) {
  let safeExt = String(ext || '').toLowerCase();
  if (safeExt === '.jpeg') safeExt = '.jpg';
  return `pfp_${slugify(username)}${safeExt}`;
}

function posterFilenameForShow(corps, year, ext) {
  let safeExt = String(ext || '').toLowerCase();
  if (safeExt === '.jpeg') safeExt = '.jpg';
  return `${slugify(corps)}${parseInt(year, 10)}${safeExt}`;
}

function pfpUrlForUsername(username) {
  const key = slugify(username);
  const base = `pfps/pfp_${key}`;
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const rel = `${base}${ext}`;
    if (staticFileExists(rel)) return `/static/${rel}`;
  }
  return null;
}

function posterUrlForShow(corps, year) {
  const key = slugify(corps);

  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const rel = `posters/${key}${parseInt(year || 0, 10)}${ext}`;
    if (staticFileExists(rel)) return `/static/${rel}`;
  }

  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const rel = `posters/${key}default${ext}`;
    if (staticFileExists(rel)) return `/static/${rel}`;
  }

  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const rel = `posters/default${ext}`;
    if (staticFileExists(rel)) return `/static/${rel}`;
  }

  return null;
}

function normalizeRow(row) {
  if (!row) return row;
  if (typeof row.toJSON === 'function') return row.toJSON();
  return { ...row };
}

function parseBulkLines(text) {
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

function createApp() {
  const app = express();
  const SQLiteStore = SQLiteStoreFactory(session);

  if (!fs.existsSync(DB_PATH)) {
    dbx.initDb(DB_PATH, { schemaPath: path.join(BASE_DIR, 'schema.sql') });
  }

  app.set('view engine', 'ejs');
  app.set('views', path.join(BASE_DIR, 'templates'));

  app.use('/static', express.static(STATIC_DIR));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: `${MAX_UPLOAD_MB}mb` }));

  app.use(session({
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: BASE_DIR }),
    secret: APP_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  }));

  app.use((req, res, next) => {
    if (!Array.isArray(req.session.flash)) req.session.flash = [];

    req.flash = (category, message) => {
      req.session.flash.push({ category, message });
    };

    res.locals.getFlashes = () => {
      const items = req.session.flash || [];
      req.session.flash = [];
      return items;
    };

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
    return conn;
  }

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
        return res.redirect(`/login?next=${encodeURIComponent(req.path)}`);
      }
      try {
        return await handler(req, res, next);
      } catch (err) {
        return next(err);
      }
    };
  }

  function adminRequired(handler) {
    return async (req, res, next) => {
      try {
        const u = await currentUser(req);
        if (!u || Number(u.is_admin) !== 1) {
          return res.status(403).render('base', { body: 'Forbidden' });
        }
        return await handler(req, res, next);
      } catch (err) {
        return next(err);
      }
    };
  }

  const uploadPfp = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, PFP_DIR),
      filename: async (req, file, cb) => {
        try {
          const conn = getConn();
          const me = normalizeRow(await dbx.userById(conn, Number(req.session.uid)));
          dbx.close(conn);
          cb(null, pfpFilenameForUsername(me.username, path.extname(file.originalname).toLowerCase()));
        } catch (e) {
          cb(e);
        }
      },
    }),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_IMAGE_EXTS.has(ext)) return cb(new Error('Invalid file type'));
      return cb(null, true);
    },
  });

  const uploadPoster = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, POSTER_DIR),
      filename: async (req, file, cb) => {
        try {
          const conn = getConn();
          const row = normalizeRow(await dbx.getShowById(conn, Number(req.params.show_id)));
          dbx.close(conn);
          cb(null, posterFilenameForShow(row.corps, row.year, path.extname(file.originalname).toLowerCase()));
        } catch (e) {
          cb(e);
        }
      },
    }),
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_IMAGE_EXTS.has(ext)) return cb(new Error('Invalid file type'));
      return cb(null, true);
    },
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
        const conn = getConn();
        try {
          notifCount = await dbx.unreadNotificationsCount(conn, Number(me.id));
          notifItems = (await dbx.listUnreadNotifications(conn, Number(me.id), { limit: 20 }) || []).map(normalizeRow);
        } finally {
          dbx.close(conn);
        }
      }

      res.locals.me = me;
      res.locals.notif_count = notifCount;
      res.locals.notif_items = notifItems;
      next();
    } catch (err) {
      next(err);
    }
  });

  app.get('/', (_req, res) => res.redirect('/shows'));

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

      res.render('shows', { rows: rows2, sort, year, corps, friend_activity: friendActivity });
    } catch (err) {
      next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/show/:show_id', async (req, res, next) => {
    const showId = Number(req.params.show_id);
    const viewerUid = req.session.uid ? Number(req.session.uid) : null;

    let conn;
    try {
      conn = getConn();
      let row = normalizeRow(await dbx.getShowById(conn, showId));
      if (!row) return res.sendStatus(404);
      if (!row.poster_url) row.poster_url = posterUrlForShow(row.corps || '', row.year || 0);

      let me = viewerUid ? normalizeRow(await dbx.userById(conn, viewerUid)) : null;
      const myRating = viewerUid ? await dbx.userRatingForShow(conn, showId, viewerUid) : null;

      if (me && !me.avatar_url) me.avatar_url = pfpUrlForUsername(me.username || '');

      const reviews = (await dbx.listReviewsForShow(conn, showId, { viewerUserId: viewerUid, limit: 30 }) || []).map((rv) => {
        const d = normalizeRow(rv);
        if (!d.avatar_url) d.avatar_url = pfpUrlForUsername(d.username || '');
        return d;
      });

      const comments = (await dbx.listReviewCommentsForShow(conn, showId, { limitTotal: 500 }) || []).map((c) => {
        const d = normalizeRow(c);
        if (!d.commenter_avatar_url) d.commenter_avatar_url = pfpUrlForUsername(d.commenter_username || '');
        return d;
      });

      const commentsMap = new Map();
      for (const c of comments) {
        const key = Number(c.review_user_id);
        if (!commentsMap.has(key)) commentsMap.set(key, []);
        commentsMap.get(key).push(c);
      }

      const reviewsWithComments = reviews.map((rv) => {
        const items = commentsMap.get(Number(rv.user_id)) || [];
        return {
          ...rv,
          comments: items,
          comment_count: items.length,
        };
      });

      res.render('show_detail', { row, me, my_rating: myRating, reviews: reviewsWithComments });
    } catch (err) {
      next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.post('/show/:show_id/comment/:comment_id/delete', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const commentId = Number(req.params.comment_id);
    let conn;
    try {
      conn = getConn();
      const show = await dbx.getShowById(conn, showId);
      if (!show) return res.sendStatus(404);
      await dbx.softDeleteReviewComment(conn, commentId, { requesterUserId: Number(req.session.uid) });
      await dbx.commit(conn);
      req.flash('ok', 'Comment deleted.');
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
      if (typeof dbx.deleteReviewComment === 'function') {
        await dbx.deleteReviewComment(conn, commentId, { requesterUserId: Number(req.session.uid), isAdmin: true });
      } else {
        await dbx.run(conn, 'DELETE FROM review_comments WHERE id = ?', [commentId]);
      }
      await dbx.commit(conn);
      req.flash('ok', 'Comment deleted.');
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/show/${showId}`);
  }));

  app.post('/show/:show_id/review/:review_user_id/comment', loginRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    const reviewUserId = Number(req.params.review_user_id);
    const commenterId = Number(req.session.uid);
    const text = String(req.body.comment_text || '').trim();

    let conn;
    try {
      conn = getConn();
      const show = await dbx.getShowById(conn, showId);
      if (!show) return res.sendStatus(404);

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
    } catch (err) {
      req.flash('error', String(err.message || err));
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/show/${showId}`);
  }));

  app.post('/me/upload_pfp', loginRequired((req, res, next) => {
    uploadPfp.single('pfp_file')(req, res, async (err) => {
      if (err) {
        req.flash('error', `Upload failed: ${err.message}`);
        return res.redirect('/me');
      }

      if (!req.file) {
        req.flash('error', 'No file selected.');
        return res.redirect('/me');
      }

      let conn;
      try {
        conn = getConn();
        const me = normalizeRow(await dbx.userById(conn, Number(req.session.uid)));
        if (!me) return res.sendStatus(404);

        const avatarUrl = `/static/pfps/${req.file.filename}`;
        await dbx.updateUserAvatarUrl(conn, Number(req.session.uid), avatarUrl);
        await dbx.commit(conn);
        req.flash('ok', 'Profile picture updated.');
        return res.redirect('/me');
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
      req.flash('ok', 'Removed your rating.');
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/show/${showId}`);
  }));

  app.get('/register', (_req, res) => res.render('auth_register'));

  app.post('/register', async (req, res, next) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();

    if (username.length < 3) {
      req.flash('error', 'Username must be at least 3 characters.');
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

      const makeAdmin = await dbx.isFirstUser(conn);
      const uid = await dbx.createUser(conn, username, await bcrypt.hash(password, 12), { makeAdmin });
      req.session.uid = uid;
      req.flash('ok', "Account created. You're logged in.");
      if (makeAdmin) req.flash('ok', 'First user created: you are admin (can mass add shows).');
      return res.redirect('/shows');
    } catch (err) {
      return next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/login', (req, res) => res.render('auth_login', { next: req.query.next || '' }));

  app.post('/login', async (req, res, next) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    const nxt = String(req.body.next || '').trim();

    let conn;
    try {
      conn = getConn();
      const u = normalizeRow(await dbx.userByUsername(conn, username));
      if (!u || !(await bcrypt.compare(password, u.pass_hash))) {
        req.flash('error', 'Invalid username/password.');
        return res.redirect('/login');
      }

      req.session.uid = Number(u.id);
      req.flash('ok', 'Logged in.');
      return res.redirect(nxt || '/shows');
    } catch (err) {
      return next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/shows'));
  });

  app.get('/admin/bulk_add', adminRequired(async (_req, res) => res.render('bulk_add')));

  app.post('/admin/bulk_add', adminRequired(async (req, res) => {
    const { items, errors } = parseBulkLines(req.body.bulk_text || '');
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
    } finally {
      if (conn) dbx.close(conn);
    }

    req.flash('ok', `Bulk add done. Inserted: ${inserted}. Duplicates skipped: ${dupes}. Other issues: ${otherBad}.`);
    return res.redirect('/shows');
  }));

  app.get('/admin/show/:show_id/edit', adminRequired(async (req, res) => {
    const showId = Number(req.params.show_id);
    let conn;
    try {
      conn = getConn();
      const s = normalizeRow(await dbx.getShowById(conn, showId));
      if (!s) return res.sendStatus(404);
      return res.render('admin_edit_show', { s });
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
        const posterUrl = `/static/posters/${req.file.filename}`;
        await dbx.updateShowPosterUrl(conn, showId, posterUrl);
        await dbx.commit(conn);
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
      let me = await currentUser(req);
      let profileUser = normalizeRow(await dbx.userByUsername(conn, username));
      if (!profileUser) return res.sendStatus(404);
      const rows = (await dbx.listAllRatingsForUser(conn, profileUser.id, { sort, corpsQ: q }) || []).map(normalizeRow);
      return res.render('user_all_ratings', { me, profile_user: profileUser, sort, q, rows });
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
      req.flash('ok', 'Deleted your review.');
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/show/${showId}`);
  }));

  app.get('/admin/roles', adminRequired(async (_req, res) => {
    let conn;
    try {
      conn = getConn();
      const roles = await dbx.listRoles(conn);
      return res.render('admin_roles', { roles });
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
      const roles = await dbx.listRoles(conn);
      const userRoles = (await dbx.rolesForUser(conn, Number(u.id)) || []).map(normalizeRow);
      const userRoleIds = new Set(userRoles.map((r) => Number(r.id)));
      return res.render('admin_user_roles', { u, roles, user_roles: userRoles, user_role_ids: userRoleIds });
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
      req.flash('ok', 'Role removed.');
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect(`/admin/user/${encodeURIComponent(username)}/roles`);
  }));

  app.get('/api/users/search', async (req, res, next) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });

    let conn;
    try {
      conn = getConn();
      const rows = await dbx.searchUsers(conn, q.slice(0, 50), { limit: 8 });
      const results = (rows || []).map((r) => {
        const d = normalizeRow(r);
        if (!d.avatar_url) d.avatar_url = pfpUrlForUsername(d.username || '');
        return {
          username: d.username,
          avatar_url: d.avatar_url,
          profile_url: `/u/${encodeURIComponent(d.username)}`,
        };
      });
      return res.json({ results });
    } catch (err) {
      return next(err);
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/me', loginRequired(async (req, res) => {
    let conn;
    try {
      conn = getConn();
      const uid = Number(req.session.uid);
      let u = normalizeRow(await dbx.userById(conn, uid));
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

      if (!u.avatar_url) u.avatar_url = pfpUrlForUsername(u.username || '');

      return res.render('profile', {
        profile_user: u,
        user_roles: rolesForMe,
        recent_ratings: recentRatings,
        recent_reviews: recentReviews,
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
      let profile = normalizeRow(await dbx.userByUsername(conn, username));
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
      const u = await dbx.userById(conn, Number(req.session.uid));
      if (!u) return res.sendStatus(404);
      res.render('profile_customize', { u: normalizeRow(u) });
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.post('/me/customize', loginRequired(async (req, res) => {
    const avatarUrl = String(req.body.avatar_url || '').trim();
    const bannerUrl = String(req.body.banner_url || '').trim();
    const themeColor = String(req.body.theme_color || '').trim();
    let conn;
    try {
      conn = getConn();
      await dbx.updateUserProfileStyle(conn, Number(req.session.uid), avatarUrl, bannerUrl, themeColor);
      req.flash('ok', 'Profile updated.');
    } finally {
      if (conn) dbx.close(conn);
    }
    res.redirect('/me');
  }));

  app.get('/admin/users', adminRequired(async (_req, res) => {
    let conn;
    try {
      conn = getConn();
      const users = (await dbx.listUsers(conn) || []).map(normalizeRow);
      res.render('admin_users', { users });
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
      res.render('admin_role_edit', { r: normalizeRow(r) });
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
      req.flash('ok', 'Role updated.');
      res.redirect('/admin/roles');
    } catch (err) {
      req.flash('error', String(err.message || err));
      res.redirect(`/admin/roles/${roleId}/edit`);
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

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

  app.get('/top', async (req, res) => {
    let mode = String(req.query.mode || 'top').trim().toLowerCase();
    if (!['top', 'bottom'].includes(mode)) mode = 'top';

    let conn;
    try {
      conn = getConn();
      const rows = (await dbx.listTopShowsWithTopReview(conn, { limit: 50, mode }) || []).map((r) => {
        const d = normalizeRow(r);
        if (!d.poster_url) d.poster_url = posterUrlForShow(d.corps || '', d.year || 0);
        if (d.top_review_username && !d.top_review_avatar_url) d.top_review_avatar_url = pfpUrlForUsername(d.top_review_username || '');
        return d;
      });
      res.render('top_shows', { rows, mode });
    } finally {
      if (conn) dbx.close(conn);
    }
  });

  app.get('/top_users', async (_req, res) => {
    let conn;
    try {
      conn = getConn();
      const rows = (await dbx.listTopUsersByReviewUpvotes(conn, { limit: 25 }) || []).map((r) => {
        const d = normalizeRow(r);
        if (!d.avatar_url) d.avatar_url = pfpUrlForUsername(d.username || '');
        if (d.top_show_id && !d.top_poster_url) d.top_poster_url = posterUrlForShow(d.top_corps || '', d.top_year || 0);
        return d;
      });
      res.render('top_users', { rows });
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
      if (posterUrl.includes('/static/')) {
        try {
          const rel = posterUrl.split('/static/')[1];
          const absPath = path.join(STATIC_DIR, rel);
          if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
        } catch (_) {}
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

      const passCol = await dbx.usersPasswordCol(conn);
      const storedHash = me[passCol];
      const ok = storedHash ? await bcrypt.compare(currentPassword, storedHash) : false;
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
      await dbx.commit(conn);
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

      const passCol = await dbx.usersPasswordCol(conn);
      const storedHash = me[passCol];
      const ok = storedHash ? await bcrypt.compare(currentPassword, storedHash) : false;
      if (!ok) {
        req.flash('error', 'Current password is incorrect.');
        return res.redirect('/me');
      }

      await dbx.updateUserPasswordHash(conn, uid, await bcrypt.hash(newPassword, 12));
      await dbx.commit(conn);
      req.flash('ok', 'Password updated.');
      return res.redirect('/me');
    } finally {
      if (conn) dbx.close(conn);
    }
  }));

  app.use((_req, res) => res.status(404).send('Not Found'));

  app.use((err, _req, res, _next) => {
    console.error(err);
    if (res.headersSent) return;
    res.status(err.status || 500).send(err.message || 'Internal Server Error');
  });

  return app;
}

const app = createApp();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});




