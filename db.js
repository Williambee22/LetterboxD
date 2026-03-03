const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function connect(dbPath) {
  const resolved = dbPath || '/data/site.db';
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  console.log('Opening SQLite DB at:', resolved);

  const db = new Database(resolved);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = DELETE');
  db.pragma('busy_timeout = 5000');
  return db;
}

function close(conn) {
  if (conn) conn.close();
}

async function commit(_conn) {
  return true;
}

function initDb(dbPath, opts = {}) {
  const resolved = dbPath || '/data/site.db';
  const schemaPath = opts.schemaPath || path.join(process.cwd(), 'schema.sql');

  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const schema = fs.readFileSync(schemaPath, 'utf8');
  const conn = connect(resolved);
  try {
    conn.exec(schema);
  } finally {
    conn.close();
  }
}

function normKey(year, corps, title) {
  const norm = (s) => String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 \-]/g, '')
    .trim();
  return `${parseInt(year, 10)}|${norm(corps)}|${norm(title)}`;
}

function tableColumns(conn, table) {
  const rows = conn.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((r) => String(r.name)));
}

function usersColumns(conn) {
  return tableColumns(conn, 'users');
}

function getRatingHistogram(conn, showId) {
  const rows = conn.prepare(`
    SELECT
      rating_half,
      COUNT(*) AS cnt
    FROM ratings
    WHERE show_id = ?
      AND rating_half IS NOT NULL
    GROUP BY rating_half
    ORDER BY rating_half ASC
  `).all(Number(showId));

  const out = {
    "0.0": 0,
    "0.5": 0,
    "1.0": 0,
    "1.5": 0,
    "2.0": 0,
    "2.5": 0,
    "3.0": 0,
    "3.5": 0,
    "4.0": 0,
    "4.5": 0,
    "5.0": 0
  };

  for (const r of rows || []) {
    const label = (Number(r.rating_half) / 2).toFixed(1);
    if (label in out) out[label] = Number(r.cnt || 0);
  }

  return out;
}

function getVerifiedRatingHistogram(conn, showId) {
  const rows = conn.prepare(`
    SELECT
      r.rating_half,
      COUNT(*) AS cnt
    FROM ratings r
    JOIN users u ON u.id = r.user_id
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN roles ro ON ro.id = ur.role_id
    WHERE r.show_id = ?
      AND r.rating_half IS NOT NULL
      AND ro.name = 'Verified Reviewer'
    GROUP BY r.rating_half
    ORDER BY r.rating_half ASC
  `).all(Number(showId));

  const out = {
    "0.0": 0,
    "0.5": 0,
    "1.0": 0,
    "1.5": 0,
    "2.0": 0,
    "2.5": 0,
    "3.0": 0,
    "3.5": 0,
    "4.0": 0,
    "4.5": 0,
    "5.0": 0
  };

  for (const r of rows || []) {
    const label = (Number(r.rating_half) / 2).toFixed(1);
    if (label in out) out[label] = Number(r.cnt || 0);
  }

  return out;
}



function pfpUrlForUsername(username) {
  const key = slugify(username);
  const base = `pfp_${key}`;

  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const abs = path.join(PFP_DIR, `${base}${ext}`);
    if (fs.existsSync(abs)) return `/uploads/pfps/${base}${ext}`;
  }

  return null;
}

function usersPasswordCol(conn) {
  const cols = usersColumns(conn);
  if (cols.has('pass_hash')) return 'pass_hash';
  if (cols.has('password_hash')) return 'password_hash';
  throw new Error(`users table missing password hash column. Found: ${JSON.stringify([...cols].sort())}`);
}

function reviewsTextCol(conn) {
  const cols = tableColumns(conn, 'reviews');
  for (const c of ['text', 'review_text', 'body', 'content']) {
    if (cols.has(c)) return c;
  }
  throw new Error(`reviews table has no recognized text column. Found: ${JSON.stringify([...cols].sort())}`);
}

function ensureAuthColumns(conn) {
  const cols = tableColumns(conn, 'users');

  if (!cols.has('email')) {
    conn.prepare('ALTER TABLE users ADD COLUMN email TEXT').run();
  }
  if (!cols.has('must_change_password')) {
    conn.prepare('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!cols.has('reset_token')) {
    conn.prepare('ALTER TABLE users ADD COLUMN reset_token TEXT').run();
  }
  if (!cols.has('reset_token_expires_ts')) {
    conn.prepare('ALTER TABLE users ADD COLUMN reset_token_expires_ts INTEGER').run();
  }

  try {
    conn.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email)').run();
  } catch (_) {}
}

function userByEmail(conn, email) {
  return conn.prepare(
    'SELECT * FROM users WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))'
  ).get(String(email || '').trim()) || null;
}

function bestTsExpr(cols, prefix) {
  for (const c of ['updated_at', 'created_at', 'ts', 'timestamp']) {
    if (cols.has(c)) return `${prefix}.${c}`;
  }
  return "datetime('now')";
}

function pickFirstExisting(cols, candidates) {
  for (const c of candidates) {
    if (cols.has(c)) return c;
  }
  return null;
}

function isFirstUser(conn) {
  const row = conn.prepare('SELECT COUNT(*) AS n FROM users').get();
  return Number(row.n) === 0;
}

function userByUsername(conn, username) {
  return conn.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim()) || null;
}

function userById(conn, userId) {
  return conn.prepare('SELECT * FROM users WHERE id = ?').get(Number(userId)) || null;
}

function createUser(conn, username, passHash, opts = {}) {
  const makeAdmin = !!opts.makeAdmin;
  const email = String(opts.email || '').trim() || null;

  const cols = usersColumns(conn);

  if (cols.has('email')) {
    const stmt = conn.prepare(
      'INSERT INTO users(username, email, pass_hash, is_admin, created_ts) VALUES (?,?,?,?,?)'
    );
    const info = stmt.run(String(username || '').trim(), email, passHash, makeAdmin ? 1 : 0, nowTs());
    return Number(info.lastInsertRowid);
  }

  const stmt = conn.prepare(
    'INSERT INTO users(username, pass_hash, is_admin, created_ts) VALUES (?,?,?,?)'
  );
  const info = stmt.run(String(username || '').trim(), passHash, makeAdmin ? 1 : 0, nowTs());
  return Number(info.lastInsertRowid);
}

function setPasswordResetToken(conn, userId, token, expiresTs) {
  conn.prepare(`
    UPDATE users
    SET reset_token = ?, reset_token_expires_ts = ?
    WHERE id = ?
  `).run(String(token || ''), Number(expiresTs), Number(userId));
}

function updateUserBio(conn, userId, bio) {
  return conn.prepare(`
    UPDATE users
    SET bio = ?
    WHERE id = ?
  `).run(String(bio || '').trim(), Number(userId));
}


function userByResetToken(conn, token) {
  return conn.prepare(`
    SELECT *
    FROM users
    WHERE reset_token = ?
      AND reset_token_expires_ts IS NOT NULL
      AND reset_token_expires_ts >= ?
    LIMIT 1
  `).get(String(token || ''), nowTs()) || null;
}

function clearPasswordResetToken(conn, userId) {
  conn.prepare(`
    UPDATE users
    SET reset_token = NULL,
        reset_token_expires_ts = NULL
    WHERE id = ?
  `).run(Number(userId));
}

function setUserMustChangePassword(conn, userId, flag = 1) {
  conn.prepare(`
    UPDATE users
    SET must_change_password = ?
    WHERE id = ?
  `).run(flag ? 1 : 0, Number(userId));
}

function updateUserEmail(conn, userId, email) {
  conn.prepare(`
    UPDATE users
    SET email = ?
    WHERE id = ?
  `).run(String(email || '').trim() || null, Number(userId));
}


function addShow(conn, year, corps, title, opts = {}) {
  const yearI = Number(year);
  const corpsS = String(corps || '').trim();
  const titleS = String(title || '').trim();
  const posterS = String(opts.posterUrl || '').trim() || null;

  if (!corpsS || !titleS) return [false, null, 'Missing corps or title.'];

  const key = normKey(yearI, corpsS, titleS);

  try {
    const info = conn.prepare(
      'INSERT INTO shows(title, corps, year, poster_url, norm_key, created_ts) VALUES (?,?,?,?,?,?)'
    ).run(titleS, corpsS, yearI, posterS, key, nowTs());
    return [true, Number(info.lastInsertRowid), 'Inserted'];
  } catch (err) {
    if (!String(err.message || '').includes('UNIQUE')) throw err;

    const row = conn.prepare('SELECT id, poster_url FROM shows WHERE norm_key = ?').get(key);
    if (row && posterS && (!row.poster_url || !String(row.poster_url).trim())) {
      conn.prepare('UPDATE shows SET poster_url = ? WHERE id = ?').run(posterS, Number(row.id));
      return [false, Number(row.id), 'Duplicate (poster updated)'];
    }
    return [false, row ? Number(row.id) : null, 'Duplicate'];
  }
}

function upsertRating(conn, showId, userId, ratingHalf) {
  const rh = Math.max(0, Math.min(10, Number(ratingHalf)));
  conn.prepare(`
    INSERT INTO ratings(show_id, user_id, rating_half, ts)
    VALUES (?,?,?,?)
    ON CONFLICT(show_id, user_id) DO UPDATE SET
      rating_half=excluded.rating_half,
      ts=excluded.ts
  `).run(Number(showId), Number(userId), rh, nowTs());
}

function deleteRating(conn, showId, userId) {
  conn.prepare('DELETE FROM ratings WHERE show_id=? AND user_id=?').run(Number(showId), Number(userId));
}

function ensureHalfStarMigration(conn) {
  const cols = tableColumns(conn, 'ratings');
  if (!cols.has('rating_half')) {
    conn.prepare('ALTER TABLE ratings ADD COLUMN rating_half INTEGER NOT NULL DEFAULT 0').run();
    if (cols.has('rating_int')) {
      conn.prepare('UPDATE ratings SET rating_half = COALESCE(rating_int, 0) * 2').run();
    }
  }
}

function ensureNotificationsTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS notifications(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      actor_user_id INTEGER,
      kind TEXT NOT NULL,
      show_id INTEGER,
      review_user_id INTEGER,
      vote INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_read INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read);
  `);
}

function addNotification(conn, args = {}) {
  conn.prepare(`
    INSERT INTO notifications(user_id, actor_user_id, kind, show_id, review_user_id, vote)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    Number(args.userId),
    args.actorUserId == null ? null : Number(args.actorUserId),
    String(args.kind),
    args.showId == null ? null : Number(args.showId),
    args.reviewUserId == null ? null : Number(args.reviewUserId),
    args.vote == null ? null : Number(args.vote),
  );
}

function unreadNotificationsCount(conn, userId) {
  const row = conn.prepare(`
    SELECT COUNT(*) AS c
    FROM notifications
    WHERE user_id=? AND COALESCE(is_read, 0)=0
  `).get(Number(userId));
  return Number(row ? row.c : 0);
}

function listUnreadNotifications(conn, userId, opts = {}) {
  const limit = Number(opts.limit || 30);
  const cols = tableColumns(conn, 'notifications');

  const hasActorUsername = cols.has('actor_username');
  const hasActorUserId = cols.has('actor_user_id');

  const showExpr = cols.has('show_id') ? 'n.show_id AS show_id' : 'NULL AS show_id';
  const createdExpr = cols.has('created_at') ? 'n.created_at AS created_at' : 'NULL AS created_at';
  const isReadExpr = cols.has('is_read') ? 'n.is_read AS is_read' : '0 AS is_read';
  const kindExpr = cols.has('kind') ? 'n.kind AS kind' : `'' AS kind`;

  let actorExpr;
  let joinSql = '';
  if (hasActorUsername) {
    actorExpr = 'n.actor_username AS actor_username';
  } else if (hasActorUserId) {
    actorExpr = `COALESCE(u.username, 'Someone') AS actor_username`;
    joinSql = 'LEFT JOIN users u ON u.id = n.actor_user_id';
  } else {
    actorExpr = `'Someone' AS actor_username`;
  }

  const sql = `
    SELECT
      n.id AS id,
      ${kindExpr},
      ${actorExpr},
      ${showExpr},
      ${createdExpr},
      ${isReadExpr}
    FROM notifications n
    ${joinSql}
    WHERE n.user_id = ?
      AND COALESCE(n.is_read, 0) = 0
    ORDER BY n.id DESC
    LIMIT ?
  `;

  return conn.prepare(sql).all(Number(userId), limit);
}

function markAllNotificationsRead(conn, userId) {
  conn.prepare(`
    UPDATE notifications
    SET is_read = 1
    WHERE user_id = ?
      AND COALESCE(is_read, 0) = 0
  `).run(Number(userId));
}

function markNotificationsRead(conn, userId) {
  return markAllNotificationsRead(conn, userId);
}

function listTopUsersByReviewUpvotes(conn, opts = {}) {
  const limit = Number(opts.limit || 25);
  const textCol = reviewsTextCol(conn);

  const sql = `
    WITH review_vote_totals AS (
      SELECT
        r.user_id AS review_user_id,
        r.show_id AS show_id,
        r.${textCol} AS review_text,
        SUM(CASE WHEN rv.vote = 1 THEN 1 ELSE 0 END) AS upvotes,
        SUM(CASE WHEN rv.vote = -1 THEN 1 ELSE 0 END) AS downvotes,
        SUM(CASE WHEN rv.vote = 1 THEN 1 WHEN rv.vote = -1 THEN -1 ELSE 0 END) AS net_score
      FROM reviews r
      LEFT JOIN review_votes rv
        ON rv.show_id = r.show_id
       AND rv.review_user_id = r.user_id
      WHERE TRIM(COALESCE(r.${textCol}, '')) <> ''
      GROUP BY r.user_id, r.show_id, r.${textCol}
    ),
    user_totals AS (
      SELECT
        review_user_id,
        SUM(upvotes) AS total_upvotes,
        SUM(downvotes) AS total_downvotes,
        SUM(net_score) AS total_net
      FROM review_vote_totals
      GROUP BY review_user_id
    ),
    best_review AS (
      SELECT
        rvt.*,
        ROW_NUMBER() OVER (
          PARTITION BY rvt.review_user_id
          ORDER BY rvt.net_score DESC, rvt.upvotes DESC, LENGTH(rvt.review_text) DESC
        ) AS rn
      FROM review_vote_totals rvt
    )
    SELECT
      u.id AS user_id,
      u.username AS username,
      u.avatar_url AS avatar_url,
      ut.total_upvotes AS upvotes,
      ut.total_downvotes AS downvotes,
      ut.total_net AS net_score,
      br.show_id AS top_show_id,
      br.review_text AS top_review_text,
      br.net_score AS top_review_score,
      s.year AS top_year,
      s.corps AS top_corps,
      s.title AS top_title,
      s.poster_url AS top_poster_url
    FROM user_totals ut
    JOIN users u ON u.id = ut.review_user_id
    LEFT JOIN best_review br
      ON br.review_user_id = ut.review_user_id
     AND br.rn = 1
    LEFT JOIN shows s
      ON s.id = br.show_id
    ORDER BY ut.total_upvotes DESC, ut.total_net DESC, ut.total_downvotes ASC
    LIMIT ?
  `;

  return conn.prepare(sql).all(limit);
}

function listShows(conn, args = {}) {
  const sort = String(args.sort || 'year_desc').trim().toLowerCase();
  const year = String(args.year || '').trim();
  const corps = String(args.corps || '').trim();

  const where = [];
  const params = [];

  if (year) {
    where.push('s.year = ?');
    params.push(Number(year));
  }
  if (corps) {
    where.push('s.corps LIKE ? COLLATE NOCASE');
    params.push(`%${corps}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let orderSql = 's.year DESC, s.corps ASC, s.title ASC';
  if (sort === 'year_asc') orderSql = 's.year ASC, s.corps ASC, s.title ASC';
  else if (sort === 'year_desc') orderSql = 's.year DESC, s.corps ASC, s.title ASC';
  else if (sort === 'corps') orderSql = 's.corps ASC, s.year DESC, s.title ASC';
  else if (sort === 'top') orderSql = 'avg_rating DESC, cnt DESC, s.year DESC, s.title ASC';
  else if (sort === 'bottom') orderSql = 'avg_rating ASC, cnt DESC, s.year DESC, s.title ASC';

  return conn.prepare(`
    SELECT
      s.*,
      COUNT(r.rating_half) AS cnt,
      COALESCE(ROUND(AVG(r.rating_half) / 2.0, 2), 0) AS avg_rating
    FROM shows s
    LEFT JOIN ratings r ON r.show_id = s.id
    ${whereSql}
    GROUP BY s.id
    ORDER BY ${orderSql}
  `).all(...params);
}

function showDetail(conn, showId) {
  return conn.prepare(`
    SELECT
      s.*,
      (COALESCE(AVG(r.rating_half), 0.0) / 2.0) AS avg_rating,
      COUNT(r.rating_half) AS cnt
    FROM shows s
    LEFT JOIN ratings r ON r.show_id = s.id
    WHERE s.id = ?
    GROUP BY s.id
  `).get(Number(showId)) || null;
}

function getShowById(conn, showId) {
  return conn.prepare(`
    SELECT
      s.*,
      COUNT(r.rating_half) AS cnt,
      COALESCE(ROUND(AVG(r.rating_half) / 2.0, 2), 0) AS avg_rating
    FROM shows s
    LEFT JOIN ratings r ON r.show_id = s.id
    WHERE s.id = ?
    GROUP BY s.id
  `).get(Number(showId)) || null;
}

function userRatingForShow(conn, showId, userId) {
  const row = conn.prepare(
    'SELECT rating_half FROM ratings WHERE show_id=? AND user_id=?'
  ).get(Number(showId), Number(userId));
  return row ? Number(row.rating_half) : null;
}

function ensurePosterUrlColumn(conn) {
  const cols = tableColumns(conn, 'shows');
  if (!cols.has('poster_url')) {
    conn.prepare('ALTER TABLE shows ADD COLUMN poster_url TEXT').run();
  }
}

function updateShow(conn, showId, year, corps, title, opts = {}) {
  const yearI = Number(year);
  const corpsS = String(corps || '').trim();
  const titleS = String(title || '').trim();
  const posterS = String(opts.posterUrl || '').trim() || null;

  if (!corpsS || !titleS) throw new Error('Missing corps or title.');

  const newKey = normKey(yearI, corpsS, titleS);
  const row = conn.prepare('SELECT id FROM shows WHERE norm_key = ? AND id <> ?').get(newKey, Number(showId));
  if (row) throw new Error('Another show already exists with the same year/corps/title (duplicate).');

  conn.prepare(`
    UPDATE shows
    SET title = ?, corps = ?, year = ?, poster_url = ?, norm_key = ?
    WHERE id = ?
  `).run(titleS, corpsS, yearI, posterS, newKey, Number(showId));
}

function updateShowPosterUrl(conn, showId, posterUrl) {
  conn.prepare('UPDATE shows SET poster_url = ? WHERE id = ?').run(posterUrl || null, Number(showId));
}

function upsertReview(conn, showId, userId, reviewText) {
  const text = String(reviewText || '').trim();
  if (!text) throw new Error('Review cannot be empty.');
  if (text.length > 5000) throw new Error('Review is too long (max 5000 chars).');

  const textCol = tableColumns(conn, 'reviews').has('review_text') ? 'review_text' : reviewsTextCol(conn);
  conn.prepare(`
    INSERT INTO reviews(show_id, user_id, ${textCol}, ts)
    VALUES (?,?,?,?)
    ON CONFLICT(show_id, user_id) DO UPDATE SET
      ${textCol}=excluded.${textCol},
      ts=excluded.ts
  `).run(Number(showId), Number(userId), text, nowTs());
}

function deleteReview(conn, showId, userId) {
  conn.prepare('DELETE FROM reviews WHERE show_id=? AND user_id=?').run(Number(showId), Number(userId));
}

function myReviewForShow(conn, showId, userId) {
  const textCol = reviewsTextCol(conn);
  const row = conn.prepare(`SELECT ${textCol} AS review_text FROM reviews WHERE show_id=? AND user_id=?`).get(Number(showId), Number(userId));
  return row ? String(row.review_text) : null;
}

function listReviewsForShow(conn, showId, opts = {}) {
  const viewerUserId = opts.viewerUserId == null ? null : Number(opts.viewerUserId);
  const limit = Number(opts.limit || 30);
  const textCol = tableColumns(conn, 'reviews').has('review_text') ? 'review_text' : reviewsTextCol(conn);

  return conn.prepare(`
    SELECT
      rv.${textCol} AS review_text, rv.ts,
      u.id AS user_id, u.username, u.avatar_url,
      r.rating_half,
      (
        SELECT rl.name
        FROM user_roles ur
        JOIN roles rl ON rl.id = ur.role_id
        WHERE ur.user_id = u.id
        ORDER BY ur.assigned_ts ASC
        LIMIT 1
      ) AS role_name,
      (
        SELECT rl.color
        FROM user_roles ur
        JOIN roles rl ON rl.id = ur.role_id
        WHERE ur.user_id = u.id
        ORDER BY ur.assigned_ts ASC
        LIMIT 1
      ) AS role_color,
      COALESCE((
        SELECT SUM(v.vote)
        FROM review_votes v
        WHERE v.show_id = rv.show_id AND v.review_user_id = rv.user_id
      ), 0) AS vote_score,
      (
        SELECT v.vote
        FROM review_votes v
        WHERE v.show_id = rv.show_id
          AND v.review_user_id = rv.user_id
          AND v.voter_user_id = ?
      ) AS my_vote
    FROM reviews rv
    JOIN users u ON u.id = rv.user_id
    LEFT JOIN ratings r ON r.show_id = rv.show_id AND r.user_id = rv.user_id
    WHERE rv.show_id = ?
    ORDER BY rv.ts DESC
    LIMIT ?
  `).all(viewerUserId, Number(showId), limit);
}

function recentRatingsForUser(conn, userId, limit = 24) {
  return conn.prepare(`
    SELECT
      s.id AS show_id, s.title, s.corps, s.year, s.poster_url,
      r.rating_half, r.ts
    FROM ratings r
    JOIN shows s ON s.id = r.show_id
    WHERE r.user_id = ?
    ORDER BY r.ts DESC
    LIMIT ?
  `).all(Number(userId), Number(limit));
}

function recentReviewsForUser(conn, userId, limit = 12) {
  const textCol = tableColumns(conn, 'reviews').has('review_text') ? 'review_text' : reviewsTextCol(conn);
  return conn.prepare(`
    SELECT
      s.id AS show_id, s.title, s.corps, s.year, s.poster_url,
      rv.${textCol} AS review_text, rv.ts,
      r.rating_half
    FROM reviews rv
    JOIN shows s ON s.id = rv.show_id
    LEFT JOIN ratings r ON r.show_id = rv.show_id AND r.user_id = rv.user_id
    WHERE rv.user_id = ?
    ORDER BY rv.ts DESC
    LIMIT ?
  `).all(Number(userId), Number(limit));
}

function ensureReviewsTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      show_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      review_text TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY(show_id, user_id),
      FOREIGN KEY(show_id) REFERENCES shows(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_show_id ON reviews(show_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON reviews(user_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_ts ON reviews(ts);
  `);
}

function ensureProfileColumns(conn) {
  const cols = tableColumns(conn, 'users');
  if (!cols.has('avatar_url')) conn.prepare('ALTER TABLE users ADD COLUMN avatar_url TEXT').run();
  if (!cols.has('banner_url')) conn.prepare('ALTER TABLE users ADD COLUMN banner_url TEXT').run();
  if (!cols.has('theme_color')) conn.prepare('ALTER TABLE users ADD COLUMN theme_color TEXT').run();
  try { conn.prepare(`ALTER TABLE users ADD COLUMN bio TEXT`).run(); } catch (_) {}
}

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{6})$/;

function cleanColor(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  return HEX_COLOR_RE.test(v) ? v : '';
}

function updateUserProfileStyle(conn, userId, avatarUrl, bannerUrl, themeColor) {
  const a = String(avatarUrl || '').trim() || null;
  const b = String(bannerUrl || '').trim() || null;
  const c = cleanColor(themeColor) || null;

  conn.prepare(`
    UPDATE users
    SET avatar_url = ?, banner_url = ?, theme_color = ?
    WHERE id = ?
  `).run(a, b, c, Number(userId));
}

function slugifyRole(name) {
  const s = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'role';
}

function cleanHexColor(s) {
  const v = String(s || '').trim();
  return HEX_COLOR_RE.test(v) ? v : '';
}

function updateUserAvatarUrl(conn, userId, avatarUrl) {
  conn.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl || null, Number(userId));
}

function listRecentRatingsForUser(conn, userId, opts = {}) {
  const limit = Number(opts.limit || 20);
  return conn.prepare(`
    SELECT
      r.show_id,
      r.rating_half,
      r.ts,
      s.title,
      s.corps,
      s.year,
      COALESCE(s.poster_url, '') AS poster_url
    FROM ratings r
    JOIN shows s ON s.id = r.show_id
    WHERE r.user_id = ?
    ORDER BY r.ts DESC
    LIMIT ?
  `).all(Number(userId), limit);
}

function listRecentReviewsForUser(conn, userId, opts = {}) {
  const limit = Number(opts.limit || 20);
  const textCol = tableColumns(conn, 'reviews').has('review_text') ? 'review_text' : reviewsTextCol(conn);
  return conn.prepare(`
    SELECT
      rv.show_id,
      rv.${textCol} AS review_text,
      rv.ts,
      s.title,
      s.corps,
      s.year,
      COALESCE(s.poster_url, '') AS poster_url,
      COALESCE((
        SELECT SUM(v.vote)
        FROM review_votes v
        WHERE v.show_id = rv.show_id AND v.review_user_id = rv.user_id
      ), 0) AS vote_score,
      r.rating_half AS rating_half
    FROM reviews rv
    JOIN shows s ON s.id = rv.show_id
    LEFT JOIN ratings r ON r.show_id = rv.show_id AND r.user_id = rv.user_id
    WHERE rv.user_id = ?
    ORDER BY rv.ts DESC
    LIMIT ?
  `).all(Number(userId), limit);
}

function userStats(conn, userId) {
  const row = conn.prepare(`
    SELECT
      (SELECT COUNT(*) FROM ratings WHERE user_id = ?) AS ratings_count,
      (SELECT COUNT(*) FROM reviews WHERE user_id = ?) AS reviews_count,
      (SELECT COALESCE(ROUND(AVG(rating_half)/2.0, 2), 0) FROM ratings WHERE user_id = ?) AS avg_rating_given
  `).get(Number(userId), Number(userId), Number(userId));

  return row || { ratings_count: 0, reviews_count: 0, avg_rating_given: 0 };
}

function ensureRolesTables(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      color TEXT,
      created_ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      assigned_ts INTEGER NOT NULL,
      assigned_by_user_id INTEGER,
      PRIMARY KEY(user_id, role_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles(role_id);
  `);
}

function listRoles(conn) {
  return conn.prepare('SELECT * FROM roles ORDER BY name ASC').all();
}

function createRole(conn, name, color = '') {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('Role name is required.');

  let slug = slugifyRole(nm);
  const col = cleanHexColor(color) || null;

  const exists = conn.prepare('SELECT 1 FROM roles WHERE slug = ?');
  const base = slug;
  let n = 2;
  while (exists.get(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }

  conn.prepare('INSERT INTO roles(name, slug, color, created_ts) VALUES (?,?,?,?)')
    .run(nm, slug, col, nowTs());
}

function deleteRole(conn, roleId) {
  conn.prepare('DELETE FROM roles WHERE id = ?').run(Number(roleId));
}

function assignRoleToUser(conn, userId, roleId, opts = {}) {
  const assignedByUserId = opts.assignedByUserId == null ? null : Number(opts.assignedByUserId);
  conn.prepare(`
    INSERT OR IGNORE INTO user_roles(user_id, role_id, assigned_ts, assigned_by_user_id)
    VALUES (?,?,?,?)
  `).run(Number(userId), Number(roleId), nowTs(), assignedByUserId);
}

function removeRoleFromUser(conn, userId, roleId) {
  conn.prepare('DELETE FROM user_roles WHERE user_id = ? AND role_id = ?').run(Number(userId), Number(roleId));
}

function rolesForUser(conn, userId) {
  return conn.prepare(`
    SELECT r.*
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ?
    ORDER BY ur.assigned_ts ASC
  `).all(Number(userId));
}

function primaryRoleForUser(conn, userId) {
  return conn.prepare(`
    SELECT r.*
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ?
    ORDER BY ur.assigned_ts ASC
    LIMIT 1
  `).get(Number(userId)) || null;
}

function roleById(conn, roleId) {
  return conn.prepare('SELECT * FROM roles WHERE id = ?').get(Number(roleId)) || null;
}

function updateRole(conn, roleId, name, color = '') {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('Role name is required.');
  const col = cleanHexColor(color) || null;
  conn.prepare('UPDATE roles SET name = ?, color = ? WHERE id = ?').run(nm, col, Number(roleId));
}

function ensureReviewVotesTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS review_votes (
      show_id INTEGER NOT NULL,
      review_user_id INTEGER NOT NULL,
      voter_user_id INTEGER NOT NULL,
      vote INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (show_id, review_user_id, voter_user_id),
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE,
      FOREIGN KEY (review_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (voter_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_review_votes_show ON review_votes(show_id);
    CREATE INDEX IF NOT EXISTS idx_review_votes_review_user ON review_votes(review_user_id);
    CREATE INDEX IF NOT EXISTS idx_review_votes_voter_user ON review_votes(voter_user_id);
  `);
}

function setReviewVote(conn, showId, reviewUserId, voterUserId, vote) {
  const sid = Number(showId);
  const ruid = Number(reviewUserId);
  const vuid = Number(voterUserId);
  const v = Number(vote) > 0 ? 1 : -1;

  const cur = conn.prepare(`
    SELECT vote
    FROM review_votes
    WHERE show_id = ? AND review_user_id = ? AND voter_user_id = ?
  `).get(sid, ruid, vuid);

  if (!cur) {
    conn.prepare(`
      INSERT INTO review_votes(show_id, review_user_id, voter_user_id, vote, ts)
      VALUES (?,?,?,?,?)
    `).run(sid, ruid, vuid, v, nowTs());
    return;
  }

  const existing = Number(cur.vote);
  if (existing === v) {
    conn.prepare(`
      DELETE FROM review_votes
      WHERE show_id = ? AND review_user_id = ? AND voter_user_id = ?
    `).run(sid, ruid, vuid);
  } else {
    conn.prepare(`
      UPDATE review_votes
      SET vote = ?, ts = ?
      WHERE show_id = ? AND review_user_id = ? AND voter_user_id = ?
    `).run(v, nowTs(), sid, ruid, vuid);
  }
}

function listUsers(conn) {
  return conn.prepare(
    'SELECT id, username, is_admin, created_ts FROM users ORDER BY username COLLATE NOCASE'
  ).all();
}

function listTopShowsWithTopReview(conn, opts = {}) {
  const limit = Number(opts.limit || 25);
  const mode = String(opts.mode || 'top').trim().toLowerCase();
  const orderSql = mode === 'bottom'
    ? 'ss.avg_rating ASC, ss.cnt DESC, ss.year DESC, ss.id ASC'
    : 'ss.avg_rating DESC, ss.cnt DESC, ss.year DESC, ss.id ASC';

  const sql = `
    WITH show_stats AS (
      SELECT
        s.id,
        s.title,
        s.corps,
        s.year,
        COALESCE(s.poster_url, '') AS poster_url,
        COUNT(r.rating_half) AS cnt,
        COALESCE(ROUND(AVG(r.rating_half) / 2.0, 2), 0) AS avg_rating
      FROM shows s
      LEFT JOIN ratings r ON r.show_id = s.id
      GROUP BY s.id
    ),
    review_scores AS (
      SELECT
        rv.show_id,
        rv.user_id,
        rv.review_text,
        rv.ts,
        u.username,
        COALESCE(u.avatar_url, '') AS avatar_url,
        r.rating_half AS review_rating_half,
        COALESCE((
          SELECT SUM(v.vote)
          FROM review_votes v
          WHERE v.show_id = rv.show_id AND v.review_user_id = rv.user_id
        ), 0) AS vote_score
      FROM reviews rv
      JOIN users u ON u.id = rv.user_id
      LEFT JOIN ratings r ON r.show_id = rv.show_id AND r.user_id = rv.user_id
    ),
    top_review_per_show AS (
      SELECT
        rs.*,
        ROW_NUMBER() OVER (
          PARTITION BY rs.show_id
          ORDER BY rs.vote_score DESC, rs.ts DESC
        ) AS rn
      FROM review_scores rs
    )
    SELECT
      ss.*,
      tr.username AS top_review_username,
      tr.avatar_url AS top_review_avatar_url,
      tr.review_text AS top_review_text,
      tr.vote_score AS top_review_score,
      tr.ts AS top_review_ts,
      tr.review_rating_half AS top_review_rating_half
    FROM show_stats ss
    LEFT JOIN top_review_per_show tr
      ON tr.show_id = ss.id AND tr.rn = 1
    WHERE ss.cnt >= 5
    ORDER BY ${orderSql}
    LIMIT ?
  `;

  return conn.prepare(sql).all(limit);
}

function ensureSocialTables(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL,
      followed_id INTEGER NOT NULL,
      created_ts INTEGER NOT NULL,
      PRIMARY KEY (follower_id, followed_id),
      FOREIGN KEY (follower_id) REFERENCES users(id),
      FOREIGN KEY (followed_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);

    CREATE TABLE IF NOT EXISTS friend_requests (
      requester_id INTEGER NOT NULL,
      addressee_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_ts INTEGER NOT NULL,
      responded_ts INTEGER,
      PRIMARY KEY (requester_id, addressee_id),
      FOREIGN KEY (requester_id) REFERENCES users(id),
      FOREIGN KEY (addressee_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_friendreq_addressee ON friend_requests(addressee_id);
    CREATE INDEX IF NOT EXISTS idx_friendreq_requester ON friend_requests(requester_id);
  `);
}

function listAllRatingsForUser(conn, userId, opts = {}) {
  const sort = String(opts.sort || 'high').trim().toLowerCase();
  const corpsQ = String(opts.corpsQ || '').trim();
  const orderSql = sort === 'low'
    ? 'r.rating_half ASC, r.ts DESC, s.year DESC, s.id ASC'
    : 'r.rating_half DESC, r.ts DESC, s.year DESC, s.id ASC';

  const sql = `
    SELECT
      r.show_id,
      r.rating_half,
      r.ts,
      s.title,
      s.corps,
      s.year,
      COALESCE(s.poster_url, '') AS poster_url
    FROM ratings r
    JOIN shows s ON s.id = r.show_id
    WHERE r.user_id = ?
      AND (? = '' OR LOWER(s.corps) LIKE '%' || LOWER(?) || '%')
    ORDER BY ${orderSql}
  `;

  return conn.prepare(sql).all(Number(userId), corpsQ, corpsQ);
}

function follow(conn, followerId, followedId) {
  const fid = Number(followerId);
  const tid = Number(followedId);
  if (fid === tid) throw new Error("You can't follow yourself.");
  conn.prepare(
    'INSERT OR IGNORE INTO follows(follower_id, followed_id, created_ts) VALUES(?,?,?)'
  ).run(fid, tid, nowTs());
}

function unfollow(conn, followerId, followedId) {
  conn.prepare('DELETE FROM follows WHERE follower_id=? AND followed_id=?').run(Number(followerId), Number(followedId));
}

function isFollowing(conn, followerId, followedId) {
  const row = conn.prepare('SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?').get(Number(followerId), Number(followedId));
  return !!row;
}

function followerCount(conn, userId) {
  const row = conn.prepare('SELECT COUNT(*) AS c FROM follows WHERE followed_id=?').get(Number(userId));
  return Number(row ? row.c : 0);
}

function followingCount(conn, userId) {
  const row = conn.prepare('SELECT COUNT(*) AS c FROM follows WHERE follower_id=?').get(Number(userId));
  return Number(row ? row.c : 0);
}

function listFollowers(conn, userId, opts = {}) {
  const limit = Number(opts.limit || 200);
  return conn.prepare(`
    SELECT u.id, u.username, u.avatar_url
    FROM follows f
    JOIN users u ON u.id = f.follower_id
    WHERE f.followed_id = ?
    ORDER BY f.created_ts DESC
    LIMIT ?
  `).all(Number(userId), limit);
}

function listFollowing(conn, userId, opts = {}) {
  const limit = Number(opts.limit || 200);
  return conn.prepare(`
    SELECT u.id, u.username, u.avatar_url
    FROM follows f
    JOIN users u ON u.id = f.followed_id
    WHERE f.follower_id = ?
    ORDER BY f.created_ts DESC
    LIMIT ?
  `).all(Number(userId), limit);
}

function sendFriendRequest(conn, requesterId, addresseeId) {
  const rid = Number(requesterId);
  const aid = Number(addresseeId);
  if (rid === aid) throw new Error("You can't friend yourself.");

  const existing = conn.prepare(
    'SELECT status FROM friend_requests WHERE requester_id=? AND addressee_id=?'
  ).get(aid, rid);

  if (existing && existing.status === 'pending') {
    acceptFriendRequest(conn, aid, rid);
    return;
  }

  conn.prepare(`
    INSERT OR IGNORE INTO friend_requests(requester_id, addressee_id, status, requested_ts)
    VALUES(?, ?, 'pending', ?)
  `).run(rid, aid, nowTs());
}

function acceptFriendRequest(conn, requesterId, addresseeId) {
  conn.prepare(`
    UPDATE friend_requests
    SET status='accepted', responded_ts=?
    WHERE requester_id=? AND addressee_id=? AND status='pending'
  `).run(nowTs(), Number(requesterId), Number(addresseeId));
}

function declineFriendRequest(conn, requesterId, addresseeId) {
  conn.prepare(`
    DELETE FROM friend_requests
    WHERE requester_id=? AND addressee_id=? AND status='pending'
  `).run(Number(requesterId), Number(addresseeId));
}

function removeFriend(conn, userId, otherId) {
  conn.prepare(`
    DELETE FROM friend_requests
    WHERE status='accepted'
      AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))
  `).run(Number(userId), Number(otherId), Number(otherId), Number(userId));
}

function friendsStatus(conn, aId, bId) {
  const a = Number(aId);
  const b = Number(bId);
  if (a === b) return 'none';

  const row = conn.prepare(`
    SELECT requester_id, addressee_id, status
    FROM friend_requests
    WHERE (requester_id=? AND addressee_id=?)
       OR (requester_id=? AND addressee_id=?)
  `).get(a, b, b, a);

  if (!row) return 'none';
  if (row.status === 'accepted') return 'friends';
  return Number(row.requester_id) === a ? 'pending_out' : 'pending_in';
}

function listFriends(conn, userId, opts = {}) {
  const limit = Number(opts.limit || 500);
  return conn.prepare(`
    SELECT u.id, u.username, u.avatar_url
    FROM friend_requests fr
    JOIN users u
      ON u.id = CASE
                  WHEN fr.requester_id = ? THEN fr.addressee_id
                  ELSE fr.requester_id
                END
    WHERE fr.status='accepted'
      AND (fr.requester_id=? OR fr.addressee_id=?)
    ORDER BY COALESCE(fr.responded_ts, fr.requested_ts) DESC
    LIMIT ?
  `).all(Number(userId), Number(userId), Number(userId), limit);
}

function listIncomingFriendRequests(conn, userId, opts = {}) {
  const limit = Number(opts.limit || 200);
  return conn.prepare(`
    SELECT u.id, u.username, u.avatar_url, fr.requested_ts
    FROM friend_requests fr
    JOIN users u ON u.id = fr.requester_id
    WHERE fr.addressee_id=? AND fr.status='pending'
    ORDER BY fr.requested_ts DESC
    LIMIT ?
  `).all(Number(userId), limit);
}

function listFriendActivity(conn, viewerId, opts = {}) {
  const limit = Number(opts.limit || 10);
  const friends = listFriends(conn, viewerId, { limit: 2000 });
  const friendIds = [];

  for (const f of friends || []) {
    const d = { ...f };
    for (const k of ['id', 'user_id', 'friend_id', 'other_user_id']) {
      if (Object.prototype.hasOwnProperty.call(d, k) && d[k] != null) {
        if (Number(d[k]) !== Number(viewerId)) friendIds.push(Number(d[k]));
        break;
      }
    }
  }

  const uniqueIds = [...new Set(friendIds)].sort((a, b) => a - b);
  if (!uniqueIds.length) return [];

  const qmarks = uniqueIds.map(() => '?').join(',');
  const reviewCols = tableColumns(conn, 'reviews');
  const ratingCols = tableColumns(conn, 'ratings');
  const reviewTs = bestTsExpr(reviewCols, 'r');
  const ratingTs = bestTsExpr(ratingCols, 'rt');
  const reviewBodyCol = pickFirstExisting(reviewCols, ['text', 'review_text', 'body', 'content', 'comment', 'message']);
  const reviewNonemptyWhere = reviewBodyCol ? `AND TRIM(COALESCE(r.${reviewBodyCol}, '')) <> ''` : '';

  const reviews = conn.prepare(`
    SELECT
      'review' AS kind,
      u.username AS actor_username,
      s.id AS show_id,
      s.corps AS corps,
      s.year AS year,
      NULL AS rating_half,
      ${reviewTs} AS ts
    FROM reviews r
    JOIN users u ON u.id = r.user_id
    JOIN shows s ON s.id = r.show_id
    WHERE r.user_id IN (${qmarks})
    ${reviewNonemptyWhere}
  `).all(...uniqueIds);

  const ratings = conn.prepare(`
    SELECT
      'rating' AS kind,
      u.username AS actor_username,
      s.id AS show_id,
      s.corps AS corps,
      s.year AS year,
      rt.rating_half AS rating_half,
      ${ratingTs} AS ts
    FROM ratings rt
    JOIN users u ON u.id = rt.user_id
    JOIN shows s ON s.id = rt.show_id
    WHERE rt.user_id IN (${qmarks})
  `).all(...uniqueIds);

  const combined = [...reviews, ...ratings].map((x) => ({ ...x }));
  combined.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return combined.slice(0, limit);
}

function ensureReviewCommentsTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS review_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      show_id INTEGER NOT NULL,
      review_user_id INTEGER NOT NULL,
      commenter_user_id INTEGER NOT NULL,
      comment_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE,
      FOREIGN KEY (review_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (commenter_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_review_comments_target
      ON review_comments(show_id, review_user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_review_comments_commenter
      ON review_comments(commenter_user_id, created_at);
  `);
}

function addReviewComment(conn, showId, reviewUserId, commenterUserId, commentText) {
  const text = String(commentText || '').trim();
  if (!text) throw new Error('Comment cannot be empty.');
  if (text.length > 1000) throw new Error('Comment too long (max 1000 chars).');

  conn.prepare(`
    INSERT INTO review_comments(show_id, review_user_id, commenter_user_id, comment_text)
    VALUES(?,?,?,?)
  `).run(Number(showId), Number(reviewUserId), Number(commenterUserId), text);
}

function listReviewCommentsForShow(conn, showId, opts = {}) {
  const limitTotal = Number(opts.limitTotal || 500);
  return conn.prepare(`
    SELECT
      rc.id AS comment_id,
      rc.show_id,
      rc.review_user_id,
      rc.commenter_user_id,
      u.username AS commenter_username,
      u.avatar_url AS commenter_avatar_url,
      rc.comment_text,
      rc.created_at
    FROM review_comments rc
    JOIN users u ON u.id = rc.commenter_user_id
    WHERE rc.show_id = ?
    ORDER BY rc.created_at DESC
    LIMIT ?
  `).all(Number(showId), limitTotal);
}

function deleteReviewComment(conn, commentId, opts = {}) {
  const requesterUserId = Number(opts.requesterUserId);
  const isAdmin = !!opts.isAdmin;
  const row = conn.prepare('SELECT commenter_user_id FROM review_comments WHERE id = ?').get(Number(commentId));
  if (!row) return false;
  const ownerId = Number(row.commenter_user_id);
  if (ownerId !== requesterUserId && !isAdmin) {
    throw new Error('Not allowed.');
  }
  conn.prepare('DELETE FROM review_comments WHERE id = ?').run(Number(commentId));
  return true;
}

function softDeleteReviewComment(conn, commentId, opts = {}) {
  const cid = Number(commentId);
  const uid = Number(opts.requesterUserId);
  const row = conn.prepare('SELECT id, commenter_user_id FROM review_comments WHERE id=?').get(cid);

  if (!row) throw new Error('Comment not found.');
  if (Number(row.commenter_user_id) !== uid) throw new Error('You can only delete your own comments.');

  conn.prepare("UPDATE review_comments SET comment_text='[comment deleted]' WHERE id=?").run(cid);
}

function adminHardDeleteReviewComment(conn, commentId) {
  conn.prepare('DELETE FROM review_comments WHERE id=?').run(Number(commentId));
}

function adminDeleteShow(conn, showId) {
  const sid = Number(showId);
  try { conn.prepare('DELETE FROM notifications WHERE show_id = ?').run(sid); } catch (_) {}
  try { conn.prepare('DELETE FROM review_comments WHERE show_id = ?').run(sid); } catch (_) {}
  try { conn.prepare('DELETE FROM review_votes WHERE show_id = ?').run(sid); } catch (_) {}
  try { conn.prepare('DELETE FROM reviews WHERE show_id = ?').run(sid); } catch (_) {}
  try { conn.prepare('DELETE FROM ratings WHERE show_id = ?').run(sid); } catch (_) {}
  conn.prepare('DELETE FROM shows WHERE id = ?').run(sid);
}

function adminDeleteReview(conn, showId, reviewUserId) {
  const sid = Number(showId);
  const ruid = Number(reviewUserId);
  try { conn.prepare('DELETE FROM review_votes WHERE show_id=? AND review_user_id=?').run(sid, ruid); } catch (_) {}
  try { conn.prepare('DELETE FROM review_comments WHERE show_id=? AND review_user_id=?').run(sid, ruid); } catch (_) {}
  conn.prepare('DELETE FROM reviews WHERE show_id=? AND user_id=?').run(sid, ruid);
}

function userAvgRating(conn, userId) {
  const row = conn.prepare(`
    SELECT
      COUNT(*) AS cnt,
      AVG(rating_half) / 2.0 AS avg_rating
    FROM ratings
    WHERE user_id = ?
  `).get(Number(userId));

  return [Number(row?.avg_rating || 0.0), Number(row?.cnt || 0)];
}

function updateUserUsername(conn, userId, newUsername) {
  conn.prepare('UPDATE users SET username=? WHERE id=?').run(String(newUsername), Number(userId));
}

function updateUserPasswordHash(conn, userId, newHash) {
  const col = usersPasswordCol(conn);
  conn.prepare(`UPDATE users SET ${col}=? WHERE id=?`).run(newHash, Number(userId));
}

function searchUsers(conn, q, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit || 8), 20));
  const term = String(q || '').trim();

  if (!term) return [];

  const starts = `${term}%`;
  const contains = `%${term}%`;

  return conn.prepare(`
    SELECT
      id,
      username,
      avatar_url
    FROM users
    WHERE username LIKE ? COLLATE NOCASE
    ORDER BY
      CASE
        WHEN username LIKE ? COLLATE NOCASE THEN 0
        ELSE 1
      END,
      LENGTH(username) ASC,
      username COLLATE NOCASE ASC
    LIMIT ?
  `).all(contains, starts, limit);
}

module.exports = {
  nowTs,
  connect,
  close,
  commit,
  initDb,
  normKey,
  isFirstUser,
  userByUsername,
  userById,
  createUser,
  addShow,
  upsertRating,
  deleteRating,
  ensureHalfStarMigration,
  ensureNotificationsTable,
  addNotification,
  unreadNotificationsCount,
  listUnreadNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  listTopUsersByReviewUpvotes,
  usersPasswordCol,
  listShows,
  showDetail,
  getShowById,
  userRatingForShow,
  ensurePosterUrlColumn,
  updateShow,
  updateShowPosterUrl,
  upsertReview,
  deleteReview,
  myReviewForShow,
  listReviewsForShow,
  recentRatingsForUser,
  recentReviewsForUser,
  ensureReviewsTable,
  ensureProfileColumns,
  updateUserProfileStyle,
  updateUserAvatarUrl,
  listRecentRatingsForUser,
  listRecentReviewsForUser,
  userStats,
  ensureRolesTables,
  listRoles,
  createRole,
  deleteRole,
  assignRoleToUser,
  removeRoleFromUser,
  rolesForUser,
  primaryRoleForUser,
  roleById,
  updateRole,
  ensureReviewVotesTable,
  setReviewVote,
  listUsers,
  listTopShowsWithTopReview,
  ensureSocialTables,
  listAllRatingsForUser,
  follow,
  unfollow,
  isFollowing,
  followerCount,
  followingCount,
  listFollowers,
  listFollowing,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
  friendsStatus,
  listFriends,
  listIncomingFriendRequests,
  listFriendActivity,
  ensureReviewCommentsTable,
  addReviewComment,
  listReviewCommentsForShow,
  deleteReviewComment,
  softDeleteReviewComment,
  adminHardDeleteReviewComment,
  adminDeleteShow,
  adminDeleteReview,
  userAvgRating,
  updateUserUsername,
  updateUserPasswordHash,
  searchUsers,
  ensureAuthColumns,
  userByEmail,
  setPasswordResetToken,
  userByResetToken,
  clearPasswordResetToken,
  setUserMustChangePassword,
  updateUserEmail,
  getRatingHistogram,
  getVerifiedRatingHistogram,
  updateUserBio 
};
















