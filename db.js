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
      AND ro.name = 'Verified Critic'
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
  const makeAdmin = !!(opts.makeAdmin || opts.make);
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

function getHotShows(conn, limit = 3) {
  return conn.prepare(`
    WITH recent_ratings AS (
      SELECT
        r.show_id,
        COUNT(*) AS ratings_2d
      FROM ratings r
      WHERE CAST(COALESCE(r.ts, 0) AS INTEGER) >= strftime('%s','now','-2 days')
      GROUP BY r.show_id
    ),
    recent_reviews AS (
      SELECT
        rv.show_id,
        COUNT(*) AS reviews_2d
      FROM reviews rv
      WHERE CAST(COALESCE(rv.ts, 0) AS INTEGER) >= strftime('%s','now','-2 days')
      GROUP BY rv.show_id
    )
    SELECT
      s.id,
      s.title,
      s.corps,
      s.year,
      s.poster_url,
      COALESCE(rrt.ratings_2d, 0) AS ratings_2d,
      COALESCE(rrv.reviews_2d, 0) AS reviews_2d,
      COALESCE(rrt.ratings_2d, 0) + COALESCE(rrv.reviews_2d, 0) AS activity_count,
      COALESCE((
        SELECT ROUND(AVG(r2.rating_half / 2.0), 2)
        FROM ratings r2
        WHERE r2.show_id = s.id
      ), 0) AS avg_rating
    FROM shows s
    LEFT JOIN recent_ratings rrt ON rrt.show_id = s.id
    LEFT JOIN recent_reviews rrv ON rrv.show_id = s.id
    WHERE COALESCE(rrt.ratings_2d, 0) + COALESCE(rrv.reviews_2d, 0) > 0
    ORDER BY
      activity_count DESC,
      COALESCE(rrv.reviews_2d, 0) DESC,
      COALESCE(rrt.ratings_2d, 0) DESC,
      avg_rating DESC,
      s.year DESC,
      s.id DESC
    LIMIT ?
  `).all(Number(limit || 3));
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

function ensureFavoriteShowsTable(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS user_favorite_shows (
      user_id    INTEGER NOT NULL,
      show_id    INTEGER NOT NULL,
      created_ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (user_id, show_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_favorite_shows_user_created
    ON user_favorite_shows(user_id, created_ts DESC);
  `);
}

function getUserFavoriteShowIds(conn, userId) {
  ensureFavoriteShowsTable(conn);
  return conn.prepare(`
    SELECT show_id
    FROM user_favorite_shows
    WHERE user_id = ?
    ORDER BY created_ts ASC
  `).all(userId);
}

function getUserFavoriteShows(conn, userId, limit = 5) {
  ensureFavoriteShowsTable(conn);
  return conn.prepare(`
    SELECT
      s.id AS show_id,
      s.title,
      s.year,
      s.corps,
      s.poster_url,
      ufs.created_ts
    FROM user_favorite_shows ufs
    JOIN shows s ON s.id = ufs.show_id
    WHERE ufs.user_id = ?
    ORDER BY ufs.created_ts ASC
    LIMIT ?
  `).all(userId, limit);
}

function isShowFavoritedByUser(conn, userId, showId) {
  ensureFavoriteShowsTable(conn);
  const row = conn.prepare(`
    SELECT 1
    FROM user_favorite_shows
    WHERE user_id = ? AND show_id = ?
    LIMIT 1
  `).get(userId, showId);
  return !!row;
}

function countUserFavoriteShows(conn, userId) {
  ensureFavoriteShowsTable(conn);
  const row = conn.prepare(`
    SELECT COUNT(*) AS cnt
    FROM user_favorite_shows
    WHERE user_id = ?
  `).get(userId);
  return Number(row?.cnt || 0);
}

function addUserFavoriteShow(conn, userId, showId) {
  ensureFavoriteShowsTable(conn);

  const existing = conn.prepare(`
    SELECT 1
    FROM user_favorite_shows
    WHERE user_id = ? AND show_id = ?
    LIMIT 1
  `).get(userId, showId);

  if (existing) {
    return { ok: true, already_exists: true, count: countUserFavoriteShows(conn, userId) };
  }

  const count = countUserFavoriteShows(conn, userId);
  if (count >= 5) {
    return { ok: false, error: 'limit_reached', count };
  }

  conn.prepare(`
    INSERT INTO user_favorite_shows (user_id, show_id, created_ts)
    VALUES (?, ?, strftime('%s','now'))
  `).run(userId, showId);

  return { ok: true, already_exists: false, count: countUserFavoriteShows(conn, userId) };
}

function removeUserFavoriteShow(conn, userId, showId) {
  ensureFavoriteShowsTable(conn);
  conn.prepare(`
    DELETE FROM user_favorite_shows
    WHERE user_id = ? AND show_id = ?
  `).run(userId, showId);

  return { ok: true, count: countUserFavoriteShows(conn, userId) };
}



function upsertRating(conn, showId, userId, ratingHalf) {
  return conn.prepare(`
    INSERT INTO ratings (show_id, user_id, rating_half, ts)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(show_id, user_id)
    DO UPDATE SET
      rating_half = excluded.rating_half,
      ts = strftime('%s','now')
  `).run(showId, userId, ratingHalf);
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

function ensurePredictionTables(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS prediction_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      season_label TEXT NOT NULL DEFAULT 'Next Season',
      is_open INTEGER NOT NULL DEFAULT 1,
      results_awarded INTEGER NOT NULL DEFAULT 0,
      updated_ts INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    INSERT OR IGNORE INTO prediction_settings(id, season_label, is_open, results_awarded, updated_ts)
    VALUES (1, 'Next Season', 1, 0, strftime('%s','now'));

    CREATE TABLE IF NOT EXISTS prediction_active_corps (
      season_label TEXT NOT NULL,
      corps TEXT NOT NULL,
      created_ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (season_label, corps)
    );

    CREATE TABLE IF NOT EXISTS season_predictions (
      season_label TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      slot INTEGER NOT NULL,
      corps TEXT NOT NULL,
      submitted_ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (season_label, user_id, slot),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_season_predictions_season_user
    ON season_predictions(season_label, user_id);

    CREATE TABLE IF NOT EXISTS season_prediction_results (
      season_label TEXT NOT NULL,
      slot INTEGER NOT NULL,
      corps TEXT NOT NULL,
      created_ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (season_label, slot)
    );

    CREATE TABLE IF NOT EXISTS season_prediction_scores (
      season_label TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      total_points INTEGER NOT NULL DEFAULT 0,
      awarded_ts INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (season_label, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_season_prediction_scores_points
    ON season_prediction_scores(season_label, total_points DESC);
  `);
}

function getPredictionSettings(conn) {
  ensurePredictionTables(conn);

  return conn.prepare(`
    SELECT *
    FROM prediction_settings
    WHERE id = 1
  `).get() || {
    id: 1,
    season_label: 'Next Season',
    is_open: 1,
    results_awarded: 0,
  };
}

function listAllPredictionSubmissions(conn, seasonLabel = null) {
  ensurePredictionTables(conn);

  const season = String(seasonLabel || getPredictionSettings(conn).season_label || 'Next Season').trim();

  const rows = conn.prepare(`
    SELECT
      u.id AS user_id,
      u.username,
      u.avatar_url,
      p.slot,
      p.corps,
      p.submitted_ts,
      COALESCE(sc.total_points, NULL) AS total_points
    FROM season_predictions p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN season_prediction_scores sc
      ON sc.season_label = p.season_label
     AND sc.user_id = p.user_id
    WHERE p.season_label = ?
    ORDER BY
      sc.total_points DESC,
      LOWER(u.username) ASC,
      p.slot ASC
  `).all(season);

  const users = new Map();

  for (const row of rows) {
    const userId = Number(row.user_id);

    if (!users.has(userId)) {
      users.set(userId, {
        user_id: userId,
        username: row.username,
        avatar_url: row.avatar_url,
        submitted_ts: row.submitted_ts,
        total_points: row.total_points == null ? null : Number(row.total_points),
        picks: [],
      });
    }

    users.get(userId).picks.push({
      slot: Number(row.slot),
      corps: row.corps,
    });
  }

  return [...users.values()];
}

function listPredictionAllTimeLeaderboard(conn) {
  ensurePredictionTables(conn);

  return conn.prepare(`
    SELECT
      u.id AS user_id,
      u.username,
      u.avatar_url,
      SUM(s.total_points) AS total_points,
      COUNT(*) AS seasons_count,
      RANK() OVER (
        ORDER BY SUM(s.total_points) DESC, LOWER(u.username) ASC
      ) AS rank
    FROM season_prediction_scores s
    JOIN users u ON u.id = s.user_id
    GROUP BY u.id, u.username, u.avatar_url
    ORDER BY total_points DESC, LOWER(u.username) ASC
  `).all();
}

function deletePredictionSeasonResults(conn, seasonLabel = null) {
  ensurePredictionTables(conn);

  const settings = getPredictionSettings(conn);
  const season = String(seasonLabel || settings.season_label || 'Next Season').trim();

  const tx = conn.transaction(() => {
    conn.prepare(`
      DELETE FROM season_prediction_results
      WHERE season_label = ?
    `).run(season);

    conn.prepare(`
      DELETE FROM season_prediction_scores
      WHERE season_label = ?
    `).run(season);

    if (String(settings.season_label || '') === season) {
      conn.prepare(`
        UPDATE prediction_settings
        SET results_awarded = 0,
            updated_ts = strftime('%s','now')
        WHERE id = 1
      `).run();
    }
  });

  tx();

  return true;
}

function listPredictionSeasons(conn) {
  ensurePredictionTables(conn);

  return conn.prepare(`
    SELECT season_label
    FROM (
      SELECT season_label FROM season_predictions
      UNION
      SELECT season_label FROM season_prediction_results
      UNION
      SELECT season_label FROM season_prediction_scores
      UNION
      SELECT season_label FROM prediction_active_corps
    )
    WHERE TRIM(COALESCE(season_label, '')) <> ''
    ORDER BY season_label DESC
  `).all().map(r => r.season_label);
}

function updatePredictionSettings(conn, args = {}) {
  ensurePredictionTables(conn);

  const current = getPredictionSettings(conn);

  const oldSeasonLabel = String(current.season_label || 'Next Season').trim() || 'Next Season';
  const newSeasonLabel = String(args.seasonLabel ?? oldSeasonLabel).trim() || oldSeasonLabel;

  const isOpen = args.isOpen == null
    ? Number(current.is_open || 0)
    : (args.isOpen ? 1 : 0);

  const resultsAwarded = args.resultsAwarded == null
    ? Number(current.results_awarded || 0)
    : (args.resultsAwarded ? 1 : 0);

  const tx = conn.transaction(() => {
    if (newSeasonLabel !== oldSeasonLabel) {
      conn.prepare(`
        UPDATE prediction_active_corps
        SET season_label = ?
        WHERE season_label = ?
      `).run(newSeasonLabel, oldSeasonLabel);

      conn.prepare(`
        UPDATE season_predictions
        SET season_label = ?
        WHERE season_label = ?
      `).run(newSeasonLabel, oldSeasonLabel);

      conn.prepare(`
        UPDATE season_prediction_results
        SET season_label = ?
        WHERE season_label = ?
      `).run(newSeasonLabel, oldSeasonLabel);

      conn.prepare(`
        UPDATE season_prediction_scores
        SET season_label = ?
        WHERE season_label = ?
      `).run(newSeasonLabel, oldSeasonLabel);
    }

    conn.prepare(`
      UPDATE prediction_settings
      SET season_label = ?,
          is_open = ?,
          results_awarded = ?,
          updated_ts = strftime('%s','now')
      WHERE id = 1
    `).run(newSeasonLabel, isOpen, resultsAwarded);
  });

  tx();

  return getPredictionSettings(conn);
}

function listAllCorps(conn) {
  return conn.prepare(`
    SELECT DISTINCT TRIM(corps) AS corps
    FROM shows
    WHERE TRIM(COALESCE(corps, '')) <> ''
    ORDER BY corps COLLATE NOCASE ASC
  `).all().map(r => r.corps);
}

function listPredictionActiveCorps(conn, seasonLabel = null) {
  ensurePredictionTables(conn);

  const settings = getPredictionSettings(conn);
  const season = String(seasonLabel || settings.season_label || 'Next Season').trim();

  return conn.prepare(`
    SELECT corps
    FROM prediction_active_corps
    WHERE season_label = ?
    ORDER BY corps COLLATE NOCASE ASC
  `).all(season).map(r => r.corps);
}

function setPredictionActiveCorps(conn, seasonLabel, corpsList = []) {
  ensurePredictionTables(conn);

  const season = String(seasonLabel || getPredictionSettings(conn).season_label || 'Next Season').trim();
  const clean = [...new Set(
    (Array.isArray(corpsList) ? corpsList : [])
      .map(c => String(c || '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  const tx = conn.transaction(() => {
    conn.prepare(`
      DELETE FROM prediction_active_corps
      WHERE season_label = ?
    `).run(season);

    const ins = conn.prepare(`
      INSERT OR IGNORE INTO prediction_active_corps(season_label, corps)
      VALUES (?, ?)
    `);

    for (const corps of clean) {
      ins.run(season, corps);
    }
  });

  tx();

  return clean;
}

function getUserPredictionRows(conn, seasonLabel, userId) {
  ensurePredictionTables(conn);

  const season = String(seasonLabel || getPredictionSettings(conn).season_label || 'Next Season').trim();

  const rows = conn.prepare(`
    SELECT slot, corps, submitted_ts
    FROM season_predictions
    WHERE season_label = ?
      AND user_id = ?
    ORDER BY slot ASC
  `).all(season, Number(userId));

  const bySlot = new Map(rows.map(r => [Number(r.slot), r]));

  const out = [];
  for (let i = 1; i <= 12; i += 1) {
    out.push({
      slot: i,
      corps: bySlot.get(i)?.corps || '',
      submitted_ts: bySlot.get(i)?.submitted_ts || null,
    });
  }

  return out;
}

function saveUserPrediction(conn, seasonLabel, userId, picks = []) {
  ensurePredictionTables(conn);

  const settings = getPredictionSettings(conn);
  const season = String(seasonLabel || settings.season_label || 'Next Season').trim();

  if (Number(settings.is_open || 0) !== 1) {
    throw new Error('Predictions are closed.');
  }

  const activeCorps = new Set(listPredictionActiveCorps(conn, season));

  if (activeCorps.size < 12) {
    throw new Error('Admin must choose at least 12 active corps first.');
  }

  const clean = [];

  for (let slot = 1; slot <= 12; slot += 1) {
    const corps = String(picks[slot - 1] || '').trim();

    if (!corps) {
      throw new Error(`Missing pick for placement #${slot}.`);
    }

    if (!activeCorps.has(corps)) {
      throw new Error(`${corps} is not an active corps for this season.`);
    }

    clean.push({ slot, corps });
  }

  const unique = new Set(clean.map(x => x.corps));
  if (unique.size !== 12) {
    throw new Error('You cannot use the same corps more than once.');
  }

  const tx = conn.transaction(() => {
    conn.prepare(`
      DELETE FROM season_predictions
      WHERE season_label = ?
        AND user_id = ?
    `).run(season, Number(userId));

    const ins = conn.prepare(`
      INSERT INTO season_predictions(season_label, user_id, slot, corps, submitted_ts)
      VALUES (?, ?, ?, ?, strftime('%s','now'))
    `);

    for (const p of clean) {
      ins.run(season, Number(userId), Number(p.slot), p.corps);
    }
  });

  tx();

  return true;
}

function getPredictionResultsRows(conn, seasonLabel = null) {
  ensurePredictionTables(conn);

  const season = String(seasonLabel || getPredictionSettings(conn).season_label || 'Next Season').trim();

  const rows = conn.prepare(`
    SELECT slot, corps
    FROM season_prediction_results
    WHERE season_label = ?
    ORDER BY slot ASC
  `).all(season);

  const bySlot = new Map(rows.map(r => [Number(r.slot), r.corps]));

  const out = [];
  for (let i = 1; i <= 12; i += 1) {
    out.push({
      slot: i,
      corps: bySlot.get(i) || '',
    });
  }

  return out;
}

function savePredictionResults(conn, seasonLabel, results = []) {
  ensurePredictionTables(conn);

  const season = String(seasonLabel || getPredictionSettings(conn).season_label || 'Next Season').trim();
  const activeCorps = new Set(listPredictionActiveCorps(conn, season));

  const clean = [];

  for (let slot = 1; slot <= 12; slot += 1) {
    const corps = String(results[slot - 1] || '').trim();

    if (!corps) {
      throw new Error(`Missing result for placement #${slot}.`);
    }

    if (!activeCorps.has(corps)) {
      throw new Error(`${corps} is not an active corps for this season.`);
    }

    clean.push({ slot, corps });
  }

  const unique = new Set(clean.map(x => x.corps));
  if (unique.size !== 12) {
    throw new Error('Results cannot use the same corps more than once.');
  }

  const tx = conn.transaction(() => {
    conn.prepare(`
      DELETE FROM season_prediction_results
      WHERE season_label = ?
    `).run(season);

    const ins = conn.prepare(`
      INSERT INTO season_prediction_results(season_label, slot, corps, created_ts)
      VALUES (?, ?, ?, strftime('%s','now'))
    `);

    for (const r of clean) {
      ins.run(season, Number(r.slot), r.corps);
    }

    conn.prepare(`
      UPDATE prediction_settings
      SET results_awarded = 0,
          updated_ts = strftime('%s','now')
      WHERE id = 1
    `).run();
  });

  tx();

  return true;
}

function awardPredictionScores(conn, seasonLabel = null) {
  ensurePredictionTables(conn);

  const season = String(seasonLabel || getPredictionSettings(conn).season_label || 'Next Season').trim();

  const resultRows = conn.prepare(`
    SELECT slot, corps
    FROM season_prediction_results
    WHERE season_label = ?
    ORDER BY slot ASC
  `).all(season);

  if (resultRows.length !== 12) {
    throw new Error('You must enter all 12 final results before awarding points.');
  }

  const resultBySlot = new Map(resultRows.map(r => [Number(r.slot), String(r.corps)]));

  const users = conn.prepare(`
    SELECT DISTINCT user_id
    FROM season_predictions
    WHERE season_label = ?
  `).all(season);

  const tx = conn.transaction(() => {
    conn.prepare(`
      DELETE FROM season_prediction_scores
      WHERE season_label = ?
    `).run(season);

    const pickStmt = conn.prepare(`
      SELECT slot, corps
      FROM season_predictions
      WHERE season_label = ?
        AND user_id = ?
      ORDER BY slot ASC
    `);

    const scoreStmt = conn.prepare(`
      INSERT INTO season_prediction_scores(season_label, user_id, total_points, awarded_ts)
      VALUES (?, ?, ?, strftime('%s','now'))
    `);

    for (const u of users) {
      const picks = pickStmt.all(season, Number(u.user_id));

      let points = 0;

      for (const p of picks) {
        const predictedSlot = Number(p.slot);
        const predictedCorps = String(p.corps);
      
        for (const [actualSlot, actualCorps] of resultBySlot.entries()) {
          if (actualCorps !== predictedCorps) continue;
      
          const distance = Math.abs(actualSlot - predictedSlot);
      
          if (distance === 0) {
            points += 20;
          } else if (distance === 1) {
            points += 10;
          }
      
          break;
        }
      }

      scoreStmt.run(season, Number(u.user_id), points);
    }

    conn.prepare(`
      UPDATE prediction_settings
      SET results_awarded = 1,
          is_open = 0,
          updated_ts = strftime('%s','now')
      WHERE id = 1
    `).run();
  });

  tx();

  return {
    users_scored: users.length,
  };
}

function listPredictionLeaderboard(conn, seasonLabel = null) {
  ensurePredictionTables(conn);

  const season = String(seasonLabel || getPredictionSettings(conn).season_label || 'Next Season').trim();

  return conn.prepare(`
    SELECT
      s.user_id,
      u.username,
      u.avatar_url,
      s.total_points,
      s.awarded_ts,
      RANK() OVER (
        ORDER BY s.total_points DESC, LOWER(u.username) ASC
      ) AS rank
    FROM season_prediction_scores s
    JOIN users u ON u.id = s.user_id
    WHERE s.season_label = ?
    ORDER BY s.total_points DESC, LOWER(u.username) ASC
  `).all(season);
}

function countPredictionSubmissions(conn, seasonLabel = null) {
  ensurePredictionTables(conn);

  const season = String(seasonLabel || getPredictionSettings(conn).season_label || 'Next Season').trim();

  const row = conn.prepare(`
    SELECT COUNT(DISTINCT user_id) AS cnt
    FROM season_predictions
    WHERE season_label = ?
  `).get(season);

  return Number(row?.cnt || 0);
}

function resetPredictionSeason(conn, newSeasonLabel) {
  ensurePredictionTables(conn);

  const season = String(newSeasonLabel || '').trim();
  if (!season) throw new Error('Season label is required.');

  conn.prepare(`
    UPDATE prediction_settings
    SET season_label = ?,
        is_open = 1,
        results_awarded = 0,
        updated_ts = strftime('%s','now')
    WHERE id = 1
  `).run(season);

  conn.prepare(`
    DELETE FROM prediction_active_corps
    WHERE season_label = ?
  `).run(season);

  conn.prepare(`
    DELETE FROM season_predictions
    WHERE season_label = ?
  `).run(season);

  conn.prepare(`
    DELETE FROM season_prediction_results
    WHERE season_label = ?
  `).run(season);

  conn.prepare(`
    DELETE FROM season_prediction_scores
    WHERE season_label = ?
  `).run(season);

  return getPredictionSettings(conn);
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

function listTopUsersByReviewUpvotes(conn, limit = 25) {
  // Defensive query: Pre-aggregates counts to prevent row-multiplication crashes
  const sql = `
    WITH user_vote_totals AS (
      SELECT 
        review_user_id,
        SUM(CASE WHEN vote > 0 THEN 1 ELSE 0 END) as upvotes,
        SUM(CASE WHEN vote < 0 THEN 1 ELSE 0 END) as downvotes,
        SUM(vote) as net_score
      FROM review_votes
      GROUP BY review_user_id
    ),
    user_review_counts AS (
      SELECT user_id, COUNT(*) as r_cnt FROM reviews GROUP BY user_id
    ),
    best_review AS (
      SELECT 
        rv.user_id,
        rv.show_id,
        rv.review_text,
        s.corps,
        s.year,
        ROW_NUMBER() OVER (
          PARTITION BY rv.user_id 
          ORDER BY (SELECT SUM(vote) FROM review_votes v2 WHERE v2.show_id = rv.show_id AND v2.review_user_id = rv.user_id) DESC
        ) as rn
      FROM reviews rv
      JOIN shows s ON s.id = rv.show_id
    )
    SELECT 
      u.id, 
      u.username, 
      u.avatar_url,
      COALESCE(vt.upvotes, 0) as upvotes,
      COALESCE(vt.downvotes, 0) as downvotes,
      COALESCE(vt.net_score, 0) as net_score,
      COALESCE(rc.r_cnt, 0) as reviews_count,
      br.show_id as top_show_id,
      br.review_text as top_review_text,
      br.corps as top_corps,
      br.year as top_year
    FROM users u
    LEFT JOIN user_vote_totals vt ON vt.review_user_id = u.id
    LEFT JOIN user_review_counts rc ON rc.user_id = u.id
    LEFT JOIN best_review br ON br.user_id = u.id AND br.rn = 1
    ORDER BY net_score DESC, upvotes DESC, reviews_count DESC
    LIMIT ?
  `;

  try {
    return conn.prepare(sql).all(limit);
  } catch (err) {
    console.error("CRITICAL SQL ERROR in Top Users:", err.message);
    return []; // Return empty array to prevent 502 Bad Gateway
  }
}

function listShows(conn, args = {}) {
  const sort = String(args.sort || 'year_desc').trim().toLowerCase();
  const year = String(args.year || '').trim();
  const corps = String(args.corps || '').trim();

  const params = [];
  const where = [];
  if (year) { where.push('s.year = ?'); params.push(Number(year)); }
  if (corps) { where.push('s.corps LIKE ? COLLATE NOCASE'); params.push(`%${corps}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Logic: (cnt == 0) returns 1 (True) for unrated shows, 0 (False) for rated.
  // Sorting by this first ensures 0s (rated) are always above 1s (unrated).
  let orderSql = 's.year DESC, s.corps ASC'; // Default
  
  if (sort === 'top') {
    orderSql = '(COUNT(r.rating_half) = 0) ASC, avg_rating DESC, cnt DESC';
  } else if (sort === 'bottom') {
    orderSql = '(COUNT(r.rating_half) = 0) ASC, avg_rating ASC, cnt DESC';
  } else if (sort === 'year_asc') {
    orderSql = 's.year ASC, s.corps ASC';
  } else if (sort === 'corps') {
    orderSql = 's.corps ASC, s.year DESC';
  }

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
  if (text.length > 6000) throw new Error('Review is too long (max 6000 chars).');

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

function getSiteStats(conn) {
  const totals = conn.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS total_users,
      (SELECT COUNT(*) FROM shows) AS total_shows,
      (SELECT COUNT(*) FROM ratings) AS total_ratings,
      (SELECT COUNT(*) FROM reviews) AS total_reviews,
      (SELECT COUNT(*) FROM review_comments) AS total_comments,
      (SELECT COUNT(*) FROM review_comment_replies) AS total_replies
  `).get() || {};

  const ratingRows = conn.prepare(`
    SELECT
      rating_half,
      COUNT(*) AS cnt
    FROM ratings
    WHERE rating_half IS NOT NULL
    GROUP BY rating_half
    ORDER BY rating_half DESC
  `).all();

  const rating_breakdown = {
    "5.0": 0,
    "4.5": 0,
    "4.0": 0,
    "3.5": 0,
    "3.0": 0,
    "2.5": 0,
    "2.0": 0,
    "1.5": 0,
    "1.0": 0,
    "0.5": 0,
    "0.0": 0
  };

  for (const row of ratingRows || []) {
    const label = (Number(row.rating_half) / 2).toFixed(1);
    if (Object.prototype.hasOwnProperty.call(rating_breakdown, label)) {
      rating_breakdown[label] = Number(row.cnt || 0);
    }
  }

  const weekly = conn.prepare(`
    SELECT
      (SELECT COUNT(*) FROM ratings
        WHERE CAST(COALESCE(ts, 0) AS INTEGER) >= strftime('%s','now','-7 days')
      ) AS ratings_this_week,

      (SELECT COUNT(*) FROM ratings
        WHERE CAST(COALESCE(ts, 0) AS INTEGER) >= strftime('%s','now','-14 days')
          AND CAST(COALESCE(ts, 0) AS INTEGER) < strftime('%s','now','-7 days')
      ) AS ratings_prev_week,

      (SELECT COUNT(*) FROM reviews
        WHERE CAST(COALESCE(ts, 0) AS INTEGER) >= strftime('%s','now','-7 days')
      ) AS reviews_this_week,

      (SELECT COUNT(*) FROM reviews
        WHERE CAST(COALESCE(ts, 0) AS INTEGER) >= strftime('%s','now','-14 days')
          AND CAST(COALESCE(ts, 0) AS INTEGER) < strftime('%s','now','-7 days')
      ) AS reviews_prev_week,

      (SELECT COUNT(*) FROM review_comments
        WHERE strftime('%s', created_at) >= strftime('%s','now','-7 days')
      ) AS comments_this_week,

      (SELECT COUNT(*) FROM review_comments
        WHERE strftime('%s', created_at) >= strftime('%s','now','-14 days')
          AND strftime('%s', created_at) < strftime('%s','now','-7 days')
      ) AS comments_prev_week,

      (SELECT COUNT(*) FROM review_comment_replies
        WHERE strftime('%s', created_at) >= strftime('%s','now','-7 days')
      ) AS replies_this_week,

      (SELECT COUNT(*) FROM review_comment_replies
        WHERE strftime('%s', created_at) >= strftime('%s','now','-14 days')
          AND strftime('%s', created_at) < strftime('%s','now','-7 days')
      ) AS replies_prev_week
  `).get() || {};

  function pctChange(current, previous) {
    const cur = Number(current || 0);
    const prev = Number(previous || 0);

    if (prev === 0) {
      if (cur === 0) return 0;
      return 100;
    }

    return ((cur - prev) / prev) * 100;
  }

  return {
    total_users: Number(totals.total_users || 0),
    total_shows: Number(totals.total_shows || 0),
    total_ratings: Number(totals.total_ratings || 0),
    total_reviews: Number(totals.total_reviews || 0),
    total_comments: Number(totals.total_comments || 0),
    total_replies: Number(totals.total_replies || 0),
    total_discussion_posts:
      Number(totals.total_comments || 0) + Number(totals.total_replies || 0),

    rating_breakdown,

    weekly: {
      ratings: {
        current: Number(weekly.ratings_this_week || 0),
        previous: Number(weekly.ratings_prev_week || 0),
        pct_change: pctChange(weekly.ratings_this_week, weekly.ratings_prev_week),
      },
      reviews: {
        current: Number(weekly.reviews_this_week || 0),
        previous: Number(weekly.reviews_prev_week || 0),
        pct_change: pctChange(weekly.reviews_this_week, weekly.reviews_prev_week),
      },
      comments: {
        current: Number(weekly.comments_this_week || 0),
        previous: Number(weekly.comments_prev_week || 0),
        pct_change: pctChange(weekly.comments_this_week, weekly.comments_prev_week),
      },
      replies: {
        current: Number(weekly.replies_this_week || 0),
        previous: Number(weekly.replies_prev_week || 0),
        pct_change: pctChange(weekly.replies_this_week, weekly.replies_prev_week),
      }
    }
  };
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
  const textCol = reviewsTextCol(conn);

  const isCriticMode = mode === 'critic_top' || mode === 'critic_bottom';
  const isBottomMode = mode === 'bottom' || mode === 'critic_bottom';

  const showStatsSql = isCriticMode
    ? `
      SELECT
        s.id,
        s.title,
        s.corps,
        s.year,
        s.poster_url,
        COUNT(r.rating_half) AS cnt,
        COALESCE(ROUND(AVG(r.rating_half) / 2.0, 2), 0) AS avg_rating
      FROM shows s
      LEFT JOIN ratings r
        ON r.show_id = s.id
       AND EXISTS (
         SELECT 1
         FROM user_roles ur
         JOIN roles ro ON ro.id = ur.role_id
         WHERE ur.user_id = r.user_id
           AND ro.name = 'Verified Critic'
       )
      GROUP BY s.id, s.title, s.corps, s.year, s.poster_url
    `
    : `
      SELECT
        s.id,
        s.title,
        s.corps,
        s.year,
        s.poster_url,
        COUNT(r.rating_half) AS cnt,
        COALESCE(ROUND(AVG(r.rating_half) / 2.0, 2), 0) AS avg_rating
      FROM shows s
      LEFT JOIN ratings r ON r.show_id = s.id
      GROUP BY s.id, s.title, s.corps, s.year, s.poster_url
    `;

  const reviewScoresSql = isCriticMode
    ? `
      SELECT
        rv.show_id,
        rv.user_id,
        rv.${textCol} AS review_text,
        u.username,
        u.avatar_url,
        COALESCE(SUM(v.vote), 0) AS vote_score
      FROM reviews rv
      JOIN users u ON u.id = rv.user_id
      JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles ro ON ro.id = ur.role_id
      LEFT JOIN review_votes v
        ON v.show_id = rv.show_id
       AND v.review_user_id = rv.user_id
      WHERE ro.name = 'Verified Critic'
      GROUP BY rv.show_id, rv.user_id, rv.${textCol}, u.username, u.avatar_url
    `
    : `
      SELECT
        rv.show_id,
        rv.user_id,
        rv.${textCol} AS review_text,
        u.username,
        u.avatar_url,
        COALESCE(SUM(v.vote), 0) AS vote_score
      FROM reviews rv
      JOIN users u ON u.id = rv.user_id
      LEFT JOIN review_votes v
        ON v.show_id = rv.show_id
       AND v.review_user_id = rv.user_id
      GROUP BY rv.show_id, rv.user_id, rv.${textCol}, u.username, u.avatar_url
    `;

  const orderSql = isBottomMode
    ? '(ss.cnt = 0) ASC, ss.avg_rating ASC, ss.cnt DESC, ss.year DESC'
    : '(ss.cnt = 0) ASC, ss.avg_rating DESC, ss.cnt DESC, ss.year DESC';

  const sql = `
    WITH show_stats AS (
      ${showStatsSql}
    ),
    review_scores AS (
      ${reviewScoresSql}
    ),
    top_review_per_show AS (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY show_id
          ORDER BY vote_score DESC, user_id ASC
        ) AS rn
      FROM review_scores
    )
    SELECT
      ss.id,
      ss.title,
      ss.corps,
      ss.year,
      ss.poster_url,
      ss.cnt,
      ss.avg_rating,
      tr.username AS top_review_username,
      tr.avatar_url AS top_review_avatar_url,
      tr.review_text AS top_review_text,
      tr.vote_score AS top_review_score
    FROM show_stats ss
    LEFT JOIN top_review_per_show tr
      ON tr.show_id = ss.id
     AND tr.rn = 1
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
  const textCol = tableColumns(conn, 'reviews').has('review_text') ? 'review_text' : reviewsTextCol(conn);

  let reviewWhere = '';
  if (sort === 'high_reviews' || sort === 'low_reviews') {
    reviewWhere = `AND rv.${textCol} IS NOT NULL AND TRIM(rv.${textCol}) <> ''`;
  }

  let orderSql = 'r.rating_half DESC, r.ts DESC, s.year DESC, s.id ASC';

  if (sort === 'low') {
    orderSql = 'r.rating_half ASC, r.ts DESC, s.year DESC, s.id ASC';
  } else if (sort === 'high_reviews') {
    orderSql = 'r.rating_half DESC, rv.ts DESC, s.year DESC, s.id ASC';
  } else if (sort === 'low_reviews') {
    orderSql = 'r.rating_half ASC, rv.ts DESC, s.year DESC, s.id ASC';
  }

  const sql = `
    SELECT
      r.show_id,
      r.rating_half,
      r.ts AS rating_ts,
      s.title,
      s.corps,
      s.year,
      COALESCE(s.poster_url, '') AS poster_url,
      rv.${textCol} AS review_text,
      rv.ts AS review_ts
    FROM ratings r
    JOIN shows s ON s.id = r.show_id
    LEFT JOIN reviews rv
      ON rv.show_id = r.show_id
     AND rv.user_id = r.user_id
    WHERE r.user_id = ?
      AND (? = '' OR LOWER(s.corps) LIKE '%' || LOWER(?) || '%')
      ${reviewWhere}
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

function listFriendActivity(conn, userId, { limit = 8 } = {}) {
  const uid = Number(userId);
  const lim = Math.max(1, Math.min(50, Number(limit || 8)));

  return conn.prepare(`
    WITH visible_users AS (
      SELECT followed_id AS user_id
      FROM follows
      WHERE follower_id = @uid
    ),

    activity AS (
      SELECT
        'rating' AS kind,
        r.user_id AS actor_user_id,
        u.username AS actor_username,
        s.id AS show_id,
        s.corps,
        s.year,
        s.title,
        s.poster_url,
        r.rating_half,
        NULL AS body,
        r.ts AS ts
      FROM ratings r
      JOIN visible_users vu ON vu.user_id = r.user_id
      JOIN users u ON u.id = r.user_id
      JOIN shows s ON s.id = r.show_id
      WHERE r.user_id != @uid

      UNION ALL

      SELECT
        'review' AS kind,
        rv.user_id AS actor_user_id,
        u.username AS actor_username,
        s.id AS show_id,
        s.corps,
        s.year,
        s.title,
        s.poster_url,
        rv.rating_half,
        rv.body AS body,
        rv.ts AS ts
      FROM reviews rv
      JOIN visible_users vu ON vu.user_id = rv.user_id
      JOIN users u ON u.id = rv.user_id
      JOIN shows s ON s.id = rv.show_id
      WHERE rv.user_id != @uid
    )

    SELECT *
    FROM activity
    ORDER BY ts DESC
    LIMIT @lim
  `).all({ uid, lim });
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

    CREATE TABLE IF NOT EXISTS review_comment_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comment_id INTEGER NOT NULL,
      show_id INTEGER NOT NULL,
      review_user_id INTEGER NOT NULL,
      replier_user_id INTEGER NOT NULL,
      reply_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (comment_id) REFERENCES review_comments(id) ON DELETE CASCADE,
      FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE,
      FOREIGN KEY (review_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (replier_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_review_comment_replies_comment
      ON review_comment_replies(comment_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_review_comment_replies_replier
      ON review_comment_replies(replier_user_id, created_at);
  `);

  const replyCols = tableColumns(conn, 'review_comment_replies');

  if (!replyCols.has('parent_reply_id')) {
    try {
      conn.prepare(`
        ALTER TABLE review_comment_replies
        ADD COLUMN parent_reply_id INTEGER
      `).run();
      console.log('Added parent_reply_id to review_comment_replies');
    } catch (err) {
      console.error('Failed adding parent_reply_id:', err.message);
    }
  }
}

function addReviewComment(conn, showId, reviewUserId, commenterUserId, commentText) {
  const text = String(commentText || '').trim();
  if (!text) throw new Error('Comment cannot be empty.');
  if (text.length > 1000) throw new Error('Comment too long (max 1000 chars).');

  conn.prepare(`
    INSERT INTO review_comments(show_id, review_user_id, commenter_user_id, comment_text)
    VALUES (?, ?, ?, ?)
  `).run(
    Number(showId),
    Number(reviewUserId),
    Number(commenterUserId),
    text
  );
}

function addReviewReply(conn, commentId, showId, reviewUserId, replierUserId, replyText, parentReplyId = null) {
  const text = String(replyText || '').trim();
  if (!text) throw new Error('Reply cannot be empty.');
  if (text.length > 1000) throw new Error('Reply too long (max 1000 chars).');

  conn.prepare(`
    INSERT INTO review_comment_replies (
      comment_id,
      show_id,
      review_user_id,
      replier_user_id,
      parent_reply_id,
      reply_text
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    Number(commentId),
    Number(showId),
    Number(reviewUserId),
    Number(replierUserId),
    parentReplyId == null ? null : Number(parentReplyId),
    text
  );
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
    ORDER BY datetime(rc.created_at) ASC, rc.id ASC
    LIMIT ?
  `).all(Number(showId), limitTotal);
}

function listReviewRepliesForShow(conn, showId, opts = {}) {
  const limitTotal = Number(opts.limitTotal || 500);

  return conn.prepare(`
    SELECT
      r.id AS reply_id,
      r.comment_id,
      r.show_id,
      r.review_user_id,
      r.replier_user_id,
      r.parent_reply_id,
      u.username AS replier_username,
      u.avatar_url AS replier_avatar_url,
      pr.replier_user_id AS parent_replier_user_id,
      pu.username AS parent_replier_username,
      r.reply_text,
      r.created_at
    FROM review_comment_replies r
    JOIN users u ON u.id = r.replier_user_id
    LEFT JOIN review_comment_replies pr ON pr.id = r.parent_reply_id
    LEFT JOIN users pu ON pu.id = pr.replier_user_id
    WHERE r.show_id = ?
    ORDER BY datetime(r.created_at) ASC, r.id ASC
    LIMIT ?
  `).all(Number(showId), limitTotal);
}

function deleteReviewComment(conn, commentId, opts = {}) {
  const requesterUserId = Number(opts.requesterUserId);
  const isAdmin = !!opts.isAdmin;
  const row = conn.prepare(`
    SELECT commenter_user_id
    FROM review_comments
    WHERE id = ?
  `).get(Number(commentId));

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

  const row = conn.prepare(`
    SELECT id, commenter_user_id, comment_text
    FROM review_comments
    WHERE id = ?
  `).get(cid);

  if (!row) throw new Error('Comment not found.');
  if (Number(row.commenter_user_id) !== uid) {
    throw new Error('You can only delete your own comments.');
  }

  const info = conn.prepare(`
    UPDATE review_comments
    SET comment_text = '[comment deleted]'
    WHERE id = ?
  `).run(cid);

  if (info.changes < 1) {
    throw new Error('Comment was not deleted.');
  }

  return true;
}

function deleteReviewReply(conn, replyId, opts = {}) {
  const requesterUserId = Number(opts.requesterUserId);
  const isAdmin = !!opts.isAdmin;

  const row = conn.prepare(`
    SELECT replier_user_id
    FROM review_comment_replies
    WHERE id = ?
  `).get(Number(replyId));

  if (!row) return false;

  if (Number(row.replier_user_id) !== requesterUserId && !isAdmin) {
    throw new Error('Not allowed.');
  }

  conn.prepare(`
    DELETE FROM review_comment_replies
    WHERE id = ?
  `).run(Number(replyId));

  return true;
}


function softDeleteReviewReply(conn, replyId, opts = {}) {
  const rid = Number(replyId);
  const uid = Number(opts.requesterUserId);

  const row = conn.prepare(`
    SELECT id, replier_user_id
    FROM review_comment_replies
    WHERE id = ?
  `).get(rid);

  if (!row) throw new Error('Reply not found.');
  if (Number(row.replier_user_id) !== uid) {
    throw new Error('You can only delete your own replies.');
  }

  const info = conn.prepare(`
    UPDATE review_comment_replies
    SET reply_text = '[reply deleted]'
    WHERE id = ?
  `).run(rid);

  if (info.changes < 1) {
    throw new Error('Reply was not deleted.');
  }

  return true;
}



function adminHardDeleteReviewComment(conn, commentId) {
  const cid = Number(commentId);

  try {
    conn.prepare(`
      DELETE FROM review_comment_replies
      WHERE comment_id = ?
    `).run(cid);
  } catch (_) {}

  conn.prepare(`
    DELETE FROM review_comments
    WHERE id = ?
  `).run(cid);
}

function adminDeleteShow(conn, showId) {
  const sid = Number(showId);

  try { conn.prepare('DELETE FROM notifications WHERE show_id = ?').run(sid); } catch (_) {}
  try { conn.prepare('DELETE FROM review_comment_replies WHERE show_id = ?').run(sid); } catch (_) {}
  try { conn.prepare('DELETE FROM review_comments WHERE show_id = ?').run(sid); } catch (_) {}
  try { conn.prepare('DELETE FROM review_votes WHERE show_id = ?').run(sid); } catch (_) {}
  try { conn.prepare('DELETE FROM reviews WHERE show_id = ?').run(sid); } catch (_) {}
  try { conn.prepare('DELETE FROM ratings WHERE show_id = ?').run(sid); } catch (_) {}

  conn.prepare('DELETE FROM shows WHERE id = ?').run(sid);
}

function adminDeleteReview(conn, showId, reviewUserId) {
  const sid = Number(showId);
  const ruid = Number(reviewUserId);

  try { conn.prepare('DELETE FROM review_votes WHERE show_id = ? AND review_user_id = ?').run(sid, ruid); } catch (_) {}

  try {
    conn.prepare(`
      DELETE FROM review_comment_replies
      WHERE show_id = ? AND review_user_id = ?
    `).run(sid, ruid);
  } catch (_) {}

  try {
    conn.prepare(`
      DELETE FROM review_comments
      WHERE show_id = ? AND review_user_id = ?
    `).run(sid, ruid);
  } catch (_) {}

  conn.prepare(`
    DELETE FROM reviews
    WHERE show_id = ? AND user_id = ?
  `).run(sid, ruid);
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
  getHotShows,
  getRatingHistogram,
  getVerifiedRatingHistogram,
  ensureFavoriteShowsTable,
  getUserFavoriteShowIds,
  getUserFavoriteShows,
  isShowFavoritedByUser,
  countUserFavoriteShows,
  addUserFavoriteShow,
  removeUserFavoriteShow,
  updateUserBio,
  addReviewReply,
  listReviewRepliesForShow,
  deleteReviewReply,
  softDeleteReviewReply,
  getSiteStats,
  ensurePredictionTables,
  getPredictionSettings,
  updatePredictionSettings,
  listAllCorps,
  listPredictionActiveCorps,
  setPredictionActiveCorps,
  getUserPredictionRows,
  saveUserPrediction,
  getPredictionResultsRows,
  savePredictionResults,
  awardPredictionScores,
  listPredictionLeaderboard,
  countPredictionSubmissions,
  resetPredictionSeason,
  listAllPredictionSubmissions,
  listPredictionAllTimeLeaderboard,
  deletePredictionSeasonResults,
  listPredictionSeasons,
};










































