
'use strict';

const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');

const MAX_ROWS = 1500;
const MAX_COLS = 160;
const MAX_CELLS = 120000;

const UPLOAD = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024,
    files: 1
  }
});

const categories = ['DCI', 'BOA', 'Other'];

const color = v =>
  /^#[0-9a-fA-F]{6}$/.test(String(v || ''))
    ? String(v).toUpperCase()
    : null;

const text = v => String(v ?? '').slice(0, 1200);

function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pb_sheldon_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT NOT NULL
        CHECK(category IN ('DCI','BOA','Other')),
      description TEXT NOT NULL DEFAULT '',
      sheets_json TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_ts INTEGER NOT NULL DEFAULT(unixepoch()),
      updated_ts INTEGER NOT NULL DEFAULT(unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_pb_sheldon_results_category
    ON pb_sheldon_results(category, created_ts DESC);
  `);
}

function requireAdmin(getConn) {
  return (req, res, next) => {
    if (!req.session?.uid) {
      return res.redirect(
        '/login?next=' + encodeURIComponent(req.originalUrl)
      );
    }

    let db;

    try {
      db = getConn();

      const row = db.prepare(
        'SELECT is_admin FROM users WHERE id=?'
      ).get(req.session.uid);

      if (Number(row?.is_admin) !== 1) {
        return res.status(403).send('Admin access required.');
      }

      next();
    } catch (e) {
      next(e);
    } finally {
      db?.close();
    }
  };
}

function token(req) {
  if (!req.session.sheldonCsrf) {
    req.session.sheldonCsrf =
      crypto.randomBytes(24).toString('hex');
  }

  return req.session.sheldonCsrf;
}

function csrf(req, res, next) {
  const a = String(req.session?.sheldonCsrf || '');
  const b = String(req.body?.csrf || '');

  if (
    a.length !== 48 ||
    b.length !== 48 ||
    !crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))
  ) {
    return res.status(403).send(
      'Invalid form token. Refresh and retry.'
    );
  }

  const origin = req.get('origin');

  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).send('Invalid origin.');
      }
    } catch {
      return res.status(403).send('Invalid origin.');
    }
  }

  next();
}

const rgb = c => `#${c.argb?.slice(-6) || 'FFFFFF'}`;

function getCellValue(cell) {
  const val = cell.value;

  if (val == null) return '';

  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }

  if (typeof val === 'object') {
    if (Array.isArray(val.richText)) {
      return val.richText.map(v => v.text || '').join('');
    }

    if (val.result !== undefined && val.result !== null) {
      return text(val.result);
    }

    if (val.formula) return '=' + val.formula;
    if (val.text !== undefined) return text(val.text);

    return text(JSON.stringify(val));
  }

  return text(val);
}

function styleFromExcel(c) {
  const s = {};

  if (c.font?.bold) s.bold = true;
  if (c.font?.italic) s.italic = true;

  if (c.font?.color?.type === 'rgb') {
    s.color = rgb(c.font.color);
  }

  if (
    c.fill?.type === 'pattern' &&
    c.fill?.fgColor?.type === 'rgb'
  ) {
    s.bg = rgb(c.fill.fgColor);
  }

  if (
    c.alignment?.horizontal &&
    ['left', 'center', 'right'].includes(c.alignment.horizontal)
  ) {
    s.align = c.alignment.horizontal;
  }

  return s;
}

async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const tabs = [];
  let total = 0;

  for (const ws of wb.worksheets) {
    if (ws.state === 'veryHidden' || ws.state === 'hidden') {
      continue;
    }

    const rows = ws.rowCount;
    const cols = ws.columnCount;

    if (rows > MAX_ROWS || cols > MAX_COLS) {
      throw Error(
        `Sheet ${ws.name} exceeds the limit of ` +
        `${MAX_ROWS} rows or ${MAX_COLS} columns.`
      );
    }

    if (total + rows * cols > MAX_CELLS) {
      throw Error('Workbook contains too many cells.');
    }

    total += rows * cols;

    const grid = Array.from(
      { length: rows },
      () => Array(cols).fill('')
    );

    const styles = {};

    ws.eachRow({ includeEmpty: true }, (row, r) => {
      if (r > rows) return;

      row.eachCell({ includeEmpty: false }, (cell, c) => {
        if (c > cols) return;

        grid[r - 1][c - 1] = getCellValue(cell);

        const st = styleFromExcel(cell);

        if (Object.keys(st).length) {
          styles[`${r - 1}:${c - 1}`] = st;
        }
      });
    });

    const merges = [];

    for (const range of Object.values(ws._merges || {})) {
      const m = range.model;

      if (m) {
        merges.push({
          r: m.top - 1,
          c: m.left - 1,
          rs: m.bottom - m.top + 1,
          cs: m.right - m.left + 1
        });
      }
    }

    tabs.push({
      name: text(ws.name).slice(0, 80),
      rows,
      cols,
      grid,
      styles,
      merges
    });
  }

  if (!tabs.length) {
    throw Error('Workbook contains no visible worksheets.');
  }

  return tabs;
}

function safeSheet(tab) {
  return {
    name: tab.name,
    rows: tab.rows,
    cols: tab.cols,
    grid: tab.grid,
    styles: tab.styles || {},
    merges: tab.merges || []
  };
}

function save(db, id, tabs) {
  db.prepare(`
    UPDATE pb_sheldon_results
    SET sheets_json=?, updated_ts=unixepoch()
    WHERE id=?
  `).run(JSON.stringify(tabs), id);
}

function mount(app, getConn) {
  const admin = requireAdmin(getConn);

  const common = req => ({
    me: req.res.locals.me || null,
    csrf: token(req)
  });

  // ==========================================================
  // SHELDON RESULTS SECRET EASTER EGG
  //
  // 1. Enter "3or4" in the Shows year filter.
  // 2. Click Top Shows.
  // 3. Click Lowest Critic Shows.
  // 4. Click ranking #3 or #4.
  // 5. Unlock Sheldon Results.
  //
  // Session progress expires after 15 minutes.
  // ==========================================================

  const SECRET_TTL_MS = 15 * 60 * 1000;

  function newSecret() {
    return {
      stage: 0,
      started: 0,
      unlocked: false
    };
  }

  function secretState(req) {
    if (!req.session) return null;

    if (!req.session.sheldonSecret) {
      req.session.sheldonSecret = newSecret();
    }

    const state = req.session.sheldonSecret;

    if (
      state.started &&
      Date.now() - state.started > SECRET_TTL_MS
    ) {
      req.session.sheldonSecret = newSecret();
    }

    return req.session.sheldonSecret;
  }

  function saveProgress(req, res, next) {
    req.session.save(err => {
      if (err) return next(err);
      res.json({ ok: true });
    });
  }

  function resetProgress(req) {
    if (req.session) {
      req.session.sheldonSecret = newSecret();
    }
  }

  function sameOrigin(req) {
    const origin = req.get('origin');

    if (origin) {
      try {
        return new URL(origin).host === req.get('host');
      } catch {
        return false;
      }
    }

    const referer = req.get('referer');

    if (!referer) return false;

    try {
      return new URL(referer).host === req.get('host');
    } catch {
      return false;
    }
  }

  // STEP 1
  // User enters 3or4 and clicks Top Shows.
  app.post(
    '/__sheldon/step1',
    express.json(),
    (req, res, next) => {
      if (!sameOrigin(req)) {
        return res.sendStatus(403);
      }

      const state = secretState(req);

      if (!state) {
        return res.sendStatus(500);
      }

      const year = String(req.body?.year || '')
        .trim()
        .toLowerCase();

      if (year !== '3or4') {
        resetProgress(req);
        return res.sendStatus(403);
      }

      state.stage = 1;
      state.started = Date.now();
      state.unlocked = false;

      saveProgress(req, res, next);
    }
  );

  // STEP 2
  // User clicks Lowest Critic Shows.
  app.post('/__sheldon/step2', (req, res, next) => {
    if (!sameOrigin(req)) {
      return res.sendStatus(403);
    }

    const state = secretState(req);

    if (
      !state ||
      state.stage !== 1 ||
      state.unlocked
    ) {
      return res.sendStatus(403);
    }

    state.stage = 2;

    saveProgress(req, res, next);
  });

  // STEP 3
  // User clicks the displayed #3 or #4 ranking.
  app.post(
    '/__sheldon/finish',
    express.json(),
    (req, res, next) => {
      if (!sameOrigin(req)) {
        return res.sendStatus(403);
      }

      const state = secretState(req);
      const rank = Number(req.body?.rank);

      if (
        !state ||
        state.stage !== 2 ||
        ![3, 4].includes(rank)
      ) {
        return res.sendStatus(403);
      }

      state.stage = 3;
      state.unlocked = true;
      state.started = Date.now();

      saveProgress(req, res, next);
    }
  );

  // RESET SECRET ACCESS
  app.post('/__sheldon/reset', (req, res, next) => {
    if (!sameOrigin(req)) {
      return res.sendStatus(403);
    }

    if (!req.session) {
      return res.sendStatus(204);
    }

    resetProgress(req);

    req.session.save(err => {
      if (err) return next(err);
      res.sendStatus(204);
    });
  });

  // PROTECT PUBLIC RESULTS
  // Admin actions retain their normal admin checks.
  app.use('/sheldon-results', (req, res, next) => {
    const adminPath =
      /^\/admin(?:\/|$)/.test(req.path);

    const editPath =
      /^\/\d+\/edit(?:\/|$)/.test(req.path);

    const otherAdminAction =
      /^\/\d+\/(?:info|delete)(?:\/|$)/.test(req.path);

    if (
      adminPath ||
      editPath ||
      otherAdminAction
    ) {
      return next();
    }

    const state = secretState(req);

    if (
      !state ||
      !state.unlocked ||
      state.stage !== 3
    ) {
      return res.redirect('/shows');
    }

    res.set('Cache-Control', 'no-store, private');

    next();
  });

  // ==========================================================
  // PUBLIC SHELDON RESULTS INDEX
  // ==========================================================

  app.get('/sheldon-results', (req, res, next) => {
    let db;

    try {
      db = getConn();
      init(db);

      const items = db.prepare(`
        SELECT id, title, category, description, created_ts
        FROM pb_sheldon_results
        ORDER BY created_ts DESC, id DESC
      `).all();

      res.set('Cache-Control', 'no-store');

      res.render('sheldon_index', {
        ...common(req),
        items,
        admin: false,
        isAdmin: false
      });
    } catch (e) {
      next(e);
    } finally {
      db?.close();
    }
  });

  // ==========================================================
  // ADMIN DASHBOARD
  // ==========================================================

  app.get(
    '/sheldon-results/admin',
    admin,
    (req, res, next) => {
      let db;

      try {
        db = getConn();
        init(db);

        const items = db.prepare(`
          SELECT id, title, category, created_ts
          FROM pb_sheldon_results
          ORDER BY id DESC
        `).all();

        res.render('sheldon_admin', {
          ...common(req),
          items
        });
      } catch (e) {
        next(e);
      } finally {
        db?.close();
      }
    }
  );

  // ==========================================================
  // UPLOAD RESULTS
  // ==========================================================

  app.post(
    '/sheldon-results/admin/upload',
    admin,
    UPLOAD.single('file'),
    csrf,
    async (req, res, next) => {
      let db;

      try {
        if (
          !req.file ||
          !/\.xlsx$/i.test(req.file.originalname)
        ) {
          throw Error('Upload an .xlsx file.');
        }

        const cat = String(req.body.category || '');

        if (!categories.includes(cat)) {
          throw Error('Choose DCI, BOA, or Other.');
        }

        const title = text(req.body.title)
          .trim()
          .slice(0, 160);

        if (!title) {
          throw Error('Enter a title.');
        }

        const tabs = await parseWorkbook(req.file.buffer);

        db = getConn();
        init(db);

        const info = db.prepare(`
          INSERT INTO pb_sheldon_results
          (title, category, description, sheets_json, created_by)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          title,
          cat,
          text(req.body.description).slice(0, 600),
          JSON.stringify(tabs),
          req.session.uid
        );

        res.redirect(
          `/sheldon-results/${info.lastInsertRowid}/edit`
        );
      } catch (e) {
        next(e);
      } finally {
        db?.close();
      }
    }
  );

  // ==========================================================
  // PUBLIC / ADMIN SHEET VIEW
  // ==========================================================

  function getPage(req, res, next, editing) {
    let db;

    try {
      db = getConn();
      init(db);

      const item = db.prepare(`
        SELECT *
        FROM pb_sheldon_results
        WHERE id=?
      `).get(Number(req.params.id));

      if (!item) {
        return res.status(404).send('Results not found.');
      }

      const tabs = JSON.parse(item.sheets_json)
        .map(safeSheet);

      let chosen = Number(req.query.sheet || 0);

      if (
        !Number.isInteger(chosen) ||
        chosen < 0 ||
        chosen >= tabs.length
      ) {
        chosen = 0;
      }

      res.set('Cache-Control', 'no-store');

      res.render('sheldon_sheet', {
        ...common(req),
        item,
        tabs,
        chosen,
        editing
      });
    } catch (e) {
      next(e);
    } finally {
      db?.close();
    }
  }

  app.get(
    '/sheldon-results/:id(\\d+)/edit',
    admin,
    (req, res, next) => getPage(req, res, next, true)
  );

  app.get(
    '/sheldon-results/:id(\\d+)',
    (req, res, next) => getPage(req, res, next, false)
  );

  // ==========================================================
  // EDIT CELLS, MERGE, UNMERGE, FORMATTING
  // ==========================================================

  app.post(
    '/sheldon-results/:id(\\d+)/edit',
    admin,
    csrf,
    (req, res, next) => {
      let db;

      try {
        db = getConn();
        init(db);

        const id = Number(req.params.id);

        const row = db.prepare(`
          SELECT *
          FROM pb_sheldon_results
          WHERE id=?
        `).get(id);

        if (!row) {
          return res.status(404).send('Missing results.');
        }

        const tabs = JSON.parse(row.sheets_json);

        const i = Number(req.body.sheet);
        const r0 = Number(req.body.r1);
        const r1 = Number(req.body.r2);
        const c0 = Number(req.body.c1);
        const c1 = Number(req.body.c2);

        const t = tabs[i];

        if (
          !t ||
          ![i, r0, r1, c0, c1].every(Number.isSafeInteger) ||
          r0 < 0 ||
          c0 < 0 ||
          r1 < r0 ||
          c1 < c0 ||
          r1 >= t.rows ||
          c1 >= t.cols ||
          (r1 - r0 + 1) * (c1 - c0 + 1) > 10000
        ) {
          throw Error('Invalid cell selection.');
        }

        const mode = String(req.body.action || 'style');

        if (mode === 'text') {
          const exactMerge =
            Array.isArray(t.merges) &&
            t.merges.some(m =>
              m.r === r0 &&
              m.c === c0 &&
              m.rs === r1 - r0 + 1 &&
              m.cs === c1 - c0 + 1
            );

          if (
            (r0 !== r1 || c0 !== c1) &&
            !exactMerge
          ) {
            throw Error(
              'Text editing requires one cell or one complete merged cell.'
            );
          }

          t.grid[r0][c0] = text(req.body.value);

        } else if (mode === 'merge') {
          if (r0 === r1 && c0 === c1) {
            throw Error('Select at least two cells to merge.');
          }

          t.merges = Array.isArray(t.merges)
            ? t.merges
            : [];

          const intersects = m =>
            r0 < m.r + m.rs &&
            r1 >= m.r &&
            c0 < m.c + m.cs &&
            c1 >= m.c;

          if (t.merges.some(intersects)) {
            throw Error(
              'Selection overlaps an existing merge. ' +
              'Unmerge it before creating a new merge.'
            );
          }

          t.merges.push({
            r: r0,
            c: c0,
            rs: r1 - r0 + 1,
            cs: c1 - c0 + 1
          });

        } else if (mode === 'unmerge') {
          t.merges = Array.isArray(t.merges)
            ? t.merges
            : [];

          const before = t.merges.length;

          t.merges = t.merges.filter(m =>
            !(
              r0 < m.r + m.rs &&
              r1 >= m.r &&
              c0 < m.c + m.cs &&
              c1 >= m.c
            )
          );

          if (before === t.merges.length) {
            throw Error(
              'Selection does not contain merged cells.'
            );
          }

        } else if (mode === 'style') {
          const font = color(req.body.color);
          const bg = color(req.body.bg);
          const grad = color(req.body.gradientEnd);

          const bold = req.body.bold === 'yes';
          const italic = req.body.italic === 'yes';

          const align =
            ['left', 'center', 'right'].includes(req.body.align)
              ? req.body.align
              : 'left';

          for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
              const key = `${r}:${c}`;
              const s = t.styles[key] || {};

              if (font) s.color = font;
              if (bg) s.bg = bg;

              s.bold = bold;
              s.italic = italic;
              s.align = align;

              if (grad && bg) {
                s.gradientEnd = grad;
                s.gradientAngle =
                  Number(req.body.gradientAngle) === 90
                    ? 90
                    : 0;
              } else {
                delete s.gradientEnd;
                delete s.gradientAngle;
              }

              t.styles[key] = s;
            }
          }

        } else {
          throw Error('Unknown action.');
        }

        save(db, id, tabs);

        return res.redirect(
          `/sheldon-results/${id}/edit?sheet=${i}&saved=1`
        );

      } catch (e) {
        next(e);
      } finally {
        db?.close();
      }
    }
  );

  // ==========================================================
  // EDIT RESULT INFORMATION
  // ==========================================================

  app.post(
    '/sheldon-results/:id(\\d+)/info',
    admin,
    csrf,
    (req, res, next) => {
      let db;

      try {
        db = getConn();
        init(db);

        const title = text(req.body.title)
          .trim()
          .slice(0, 160);

        const cat = String(req.body.category || '');

        if (!title || !categories.includes(cat)) {
          throw Error('Invalid title or category.');
        }

        const result = db.prepare(`
          UPDATE pb_sheldon_results
          SET
            title=?,
            category=?,
            description=?,
            updated_ts=unixepoch()
          WHERE id=?
        `).run(
          title,
          cat,
          text(req.body.description).slice(0, 600),
          Number(req.params.id)
        );

        if (!result.changes) {
          return res.status(404).send('Not found.');
        }

        res.redirect(
          `/sheldon-results/${req.params.id}/edit`
        );
      } catch (e) {
        next(e);
      } finally {
        db?.close();
      }
    }
  );

  // ==========================================================
  // DELETE RESULT
  // ==========================================================

  app.post(
    '/sheldon-results/:id(\\d+)/delete',
    admin,
    csrf,
    (req, res, next) => {
      let db;

      try {
        db = getConn();
        init(db);

        db.prepare(`
          DELETE FROM pb_sheldon_results
          WHERE id=?
        `).run(Number(req.params.id));

        res.redirect('/sheldon-results/admin');
      } catch (e) {
        next(e);
      } finally {
        db?.close();
      }
    }
  );

  // ==========================================================
  // ERROR HANDLING
  // ==========================================================

  app.use('/sheldon-results', (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      return res.status(400).send(
        'Upload error: ' + err.message
      );
    }

    if (
      err &&
      /Workbook|sheet|cell|title|category|Upload|Invalid|Unknown|exceeds|too many/i
        .test(err.message)
    ) {
      return res.status(400).send(
        'Sheldon Results: ' + err.message
      );
    }

    next(err);
  });
}

module.exports = {
  mount,
  parseWorkbook,
  init
};
