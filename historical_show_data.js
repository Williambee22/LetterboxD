'use strict';

const DCI_BASE = 'https://www.dci.org/scores/final-scores';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'Pressboxd/1.0 (+https://www.pressboxd.com)';
const ERROR_RETRY_SECONDS = 24 * 60 * 60;

let cheerioModule = null;

function cheerio() {
  if (cheerioModule) return cheerioModule;

  try {
    cheerioModule = require('cheerio');
    return cheerioModule;
  } catch (err) {
    const e = new Error(
      'Historical show lookup requires the cheerio package. Run: npm install cheerio@1.0.0'
    );

    e.cause = err;
    throw e;
  }
}

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/^the\s+/, '')
    .replace(/drum\s*(and|&)\s*bugle\s*corps/g, '')
    .replace(/drum\s*corps/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CORPS_ALIASES = new Map([
  ['the cadets', 'cadets'],
  ['cadets', 'cadets'],
  ['holy name cadets', 'cadets'],
  ['cadets of bergen county', 'cadets'],

  ['the cavaliers', 'cavaliers'],
  ['cavaliers', 'cavaliers'],

  ['santa clara vanguard', 'santa clara vanguard'],
  ['scv', 'santa clara vanguard'],

  ['vanguard cadets', 'vanguard cadets'],
  ['santa clara vanguard cadets', 'vanguard cadets'],

  ['blue devils b', 'blue devils b'],
  ['blue devils c', 'blue devils c'],

  ['spirit', 'spirit of atlanta'],
  ['spirit of atlanta', 'spirit of atlanta'],

  ['seattle cascades', 'seattle cascades'],
  ['cascades', 'seattle cascades'],
]);

function canonicalCorps(value) {
  const raw = normalizeName(value);
  return CORPS_ALIASES.get(raw) || raw;
}

function sameCorps(a, b) {
  return canonicalCorps(a) === canonicalCorps(b);
}

function cleanText(value) {
  return String(value || '')
    .replace(/\[[0-9]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function ordinal(n) {
  const v = Number(n);

  if (!Number.isInteger(v) || v <= 0) {
    return '';
  }

  const mod100 = v % 100;
  const mod10 = v % 10;

  if (mod100 >= 11 && mod100 <= 13) {
    return `${v}th`;
  }

  if (mod10 === 1) return `${v}st`;
  if (mod10 === 2) return `${v}nd`;
  if (mod10 === 3) return `${v}rd`;

  return `${v}th`;
}

async function fetchText(
  url,
  { timeoutMs = 6500 } = {}
) {
  if (typeof fetch !== 'function') {
    throw new Error(
      'This feature requires Node.js 18+ because it uses the built-in fetch API.'
    );
  }

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    const response = await fetch(url, {
      redirect: 'follow',

      signal: controller.signal,

      headers: {
        'User-Agent': USER_AGENT,

        Accept:
          'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      const error = new Error(
        `HTTP ${response.status} for ${url}`
      );

      error.status = response.status;

      throw error;
    }

    return await response.text();

  } finally {
    clearTimeout(timer);
  }
}

function dciSlugCandidates(year, round) {
  const y = Number(year);

  if (round === 'Finals') {
    return [
      `${y}-dci-world-championship-finals`,
      `${y}-dci-world-championships-world-class-finals`,
      `${y}-dci-world-championships-finals`,
      `${y}-dci-championships-finals`,
      `${y}-dci-open-class-world-championship-finals`,
      `${y}-dci-world-championships-open-class-championship-finals`,
    ];
  }

  if (round === 'Semifinals') {
    return [
      `${y}-dci-world-championship-semifinals`,
      `${y}-dci-world-championships-world-class-semifinals`,
      `${y}-dci-world-championships-semifinals`,
      `${y}-dci-championships-semifinals`,
    ];
  }

  return [
    `${y}-dci-world-championship-prelims`,
    `${y}-dci-championships-prelims`,
    `${y}-dci-world-championships-world-class-prelims`,
    `${y}-dci-world-championships-prelims`,
    `${y}-dci-open-class-world-championship-prelims`,
    `${y}-dci-world-championships-open-class-championship-prelims`,
  ];
}

function parseDciPage(
  html,
  corps,
  round,
  url
) {
  const $ = cheerio().load(html);

  const matches = [];

  $('tr').each((_i, tr) => {
    const cells = $(tr)
      .find('th, td')
      .map((_j, cell) =>
        cleanText($(cell).text())
      )
      .get()
      .filter(Boolean);

    if (cells.length < 3) return;

    const placeMatch =
      String(cells[0]).match(
        /^([0-9]{1,3})$/
      );

    if (!placeMatch) return;

    let corpsIndex = -1;

    for (
      let i = 1;
      i < cells.length;
      i += 1
    ) {
      if (sameCorps(cells[i], corps)) {
        corpsIndex = i;
        break;
      }
    }

    if (corpsIndex < 0) return;

    let score = null;

    for (
      let i = corpsIndex + 1;
      i < cells.length;
      i += 1
    ) {
      const scoreMatch =
        String(cells[i]).match(
          /\b([0-9]{1,3}\.[0-9]{2,3})\b/
        );

      if (scoreMatch) {
        score = Number(scoreMatch[1]);
        break;
      }
    }

    matches.push({
      placement:
        Number(placeMatch[1]),

      final_score:
        Number.isFinite(score)
          ? score
          : null,

      championship_round:
        round,

      placement_source_url:
        url,

      placement_source_label:
        'Drum Corps International',
    });
  });

  return matches.length
    ? matches[matches.length - 1]
    : null;
}

async function fetchDciRound(
  corps,
  year,
  round
) {
  const candidates =
    dciSlugCandidates(
      year,
      round
    ).map((slug) => ({
      url: `${DCI_BASE}/${slug}/`,
    }));

  const responses =
    await Promise.allSettled(
      candidates.map(
        async ({ url }) => ({
          url,

          html:
            await fetchText(
              url,
              {
                timeoutMs: 4500,
              }
            ),
        })
      )
    );

  for (const response of responses) {
    if (
      response.status !==
      'fulfilled'
    ) {
      continue;
    }

    const {
      url,
      html,
    } = response.value;

    const parsed =
      parseDciPage(
        html,
        corps,
        round,
        url
      );

    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function roundOrderFromPlacement(
  placement
) {
  const p = Number(
    placement || 0
  );

  if (
    p > 0 &&
    p <= 12
  ) {
    return [
      'Finals',
      'Semifinals',
      'Prelims',
    ];
  }

  if (
    p > 12 &&
    p <= 25
  ) {
    return [
      'Semifinals',
      'Prelims',
      'Finals',
    ];
  }

  if (p > 25) {
    return [
      'Prelims',
      'Semifinals',
      'Finals',
    ];
  }

  return [
    'Finals',
    'Semifinals',
    'Prelims',
  ];
}

async function fetchDciPlacement(
  corps,
  year,
  hintedPlacement = null
) {
  for (
    const round
    of roundOrderFromPlacement(
      hintedPlacement
    )
  ) {
    const result =
      await fetchDciRound(
        corps,
        year,
        round
      );

    if (result) {
      return result;
    }
  }

  return null;
}

function wikiPageUrl(title) {
  return (
    'https://en.wikipedia.org/wiki/' +
    encodeURIComponent(
      String(title || '')
        .replace(/ /g, '_')
    )
  );
}

async function wikiSearch(corps) {
  const searchTerms = [
    `${corps} drum and bugle corps`,
    `${corps} drum corps`,
    corps,
  ];

  const seen = new Set();
  const results = [];

  for (
    const term
    of searchTerms
  ) {
    const url =
      `${WIKI_API}` +
      `?action=query` +
      `&list=search` +
      `&srsearch=${encodeURIComponent(term)}` +
      `&srlimit=8` +
      `&format=json` +
      `&origin=*`;

    try {
      const raw =
        await fetchText(url);

      const data =
        JSON.parse(raw);

      const rows =
        data &&
        data.query &&
        Array.isArray(
          data.query.search
        )
          ? data.query.search
          : [];

      for (const row of rows) {
        const title =
          String(
            row.title || ''
          ).trim();

        if (
          !title ||
          seen.has(title)
        ) {
          continue;
        }

        seen.add(title);

        results.push(title);
      }

    } catch (_err) {
      // Try next search phrase.
    }

    if (results.length >= 8) {
      break;
    }
  }

  const target =
    canonicalCorps(corps);

  results.sort((a, b) => {
    const aNorm =
      canonicalCorps(a);

    const bNorm =
      canonicalCorps(b);

    const aScore =
      aNorm === target
        ? 0
        : (
            aNorm.includes(target)
              ? 1
              : 2
          );

    const bScore =
      bNorm === target
        ? 0
        : (
            bNorm.includes(target)
              ? 1
              : 2
          );

    return aScore - bScore;
  });

  return results.slice(0, 8);
}

function cellTextWithBreaks(
  $,
  cell
) {
  const clone =
    $(cell).clone();

  clone
    .find('sup.reference')
    .remove();

  clone
    .find('br')
    .replaceWith('\n');

  clone
    .find('li')
    .each((_i, li) => {
      $(li)
        .prepend('\n')
        .append('\n');
    });

  return String(
    clone.text() || ''
  )
    .replace(
      /\u00a0/g,
      ' '
    )
    .replace(
      /[ \t]+/g,
      ' '
    )
    .replace(
      / *\n */g,
      '\n'
    )
    .replace(
      /\n{2,}/g,
      '\n'
    )
    .trim();
}

function splitRepertoire(raw) {
  const text =
    String(raw || '')
      .replace(
        /\[[0-9]+\]/g,
        ''
      )
      .replace(
        /\r/g,
        '\n'
      )
      .trim();

  if (!text) {
    return [];
  }

  const pieces = [];

  for (
    const line
    of text.split(/\n+/)
  ) {
    const cleanLine =
      line
        .replace(
          /^[-•–—]\s*/,
          ''
        )
        .trim();

    if (!cleanLine) {
      continue;
    }

    const slashParts =
      cleanLine.split(
        /\s+\/\s+/
      );

    for (
      const part
      of slashParts
    ) {
      const value =
        part
          .replace(
            /\s+/g,
            ' '
          )
          .trim();

      if (!value) {
        continue;
      }

      if (
        !pieces.includes(value)
      ) {
        pieces.push(value);
      }
    }
  }

  return pieces.slice(0, 40);
}

function headerIndex(
  headers,
  tests
) {
  return headers.findIndex(
    (header) =>
      tests.some(
        (test) =>
          header.includes(test)
      )
  );
}

function parseWikipediaYearRow(
  html,
  year
) {
  const $ =
    cheerio().load(html);

  const targetYear =
    String(year);

  let found = null;

  $('table').each(
    (_tableIndex, table) => {
      if (found) {
        return false;
      }

      let headers = [];
      let indexes = null;

      $(table)
        .find('tr')
        .each(
          (_rowIndex, tr) => {
            if (found) {
              return false;
            }

            const ths =
              $(tr).find('th');

            if (
              ths.length >= 3
            ) {
              const candidateHeaders =
                ths
                  .map(
                    (_i, th) =>
                      cleanText(
                        $(th).text()
                      ).toLowerCase()
                  )
                  .get();

              if (
                candidateHeaders.some(
                  (h) =>
                    h === 'year' ||
                    h.includes(
                      'year'
                    )
                )
              ) {
                headers =
                  candidateHeaders;

                indexes = {
                  year:
                    headerIndex(
                      headers,
                      ['year']
                    ),

                  title:
                    headerIndex(
                      headers,
                      [
                        'show title',
                        'show theme',
                        'theme',
                        'program',
                      ]
                    ),

                  repertoire:
                    headerIndex(
                      headers,
                      [
                        'repertoire',
                        'music',
                      ]
                    ),

                  score:
                    headerIndex(
                      headers,
                      ['score']
                    ),

                  placement:
                    headerIndex(
                      headers,
                      [
                        'placement',
                        'place',
                      ]
                    ),
                };

                return;
              }
            }

            const cells =
              $(tr)
                .find('td, th')
                .toArray();

            if (
              cells.length < 4
            ) {
              return;
            }

            const texts =
              cells.map(
                (cell) =>
                  cleanText(
                    $(cell).text()
                  )
              );

            let yearIndex =
              indexes &&
              indexes.year >= 0
                ? indexes.year
                : 0;

            if (
              !texts[yearIndex] ||
              !new RegExp(
                `\\b${targetYear}\\b`
              ).test(
                texts[yearIndex]
              )
            ) {
              yearIndex =
                texts.findIndex(
                  (t) =>
                    new RegExp(
                      `^${targetYear}(?:\\D|$)`
                    ).test(t)
                );
            }

            if (
              yearIndex < 0
            ) {
              return;
            }

            const repIndex =
              indexes &&
              indexes.repertoire >= 0
                ? indexes.repertoire
                : Math.min(
                    yearIndex + 2,
                    cells.length - 3
                  );

            const titleIndex =
              indexes &&
              indexes.title >= 0
                ? indexes.title
                : Math.min(
                    yearIndex + 1,
                    cells.length - 1
                  );

            const scoreIndex =
              indexes &&
              indexes.score >= 0
                ? indexes.score
                : Math.max(
                    cells.length - 2,
                    0
                  );

            const placementIndex =
              indexes &&
              indexes.placement >= 0
                ? indexes.placement
                : Math.max(
                    cells.length - 1,
                    0
                  );

            const repertoireRaw =
              repIndex >= 0 &&
              cells[repIndex]
                ? cellTextWithBreaks(
                    $,
                    cells[repIndex]
                  )
                : '';

            const scoreText =
              scoreIndex >= 0
                ? texts[scoreIndex]
                : '';

            const placementText =
              placementIndex >= 0
                ? texts[
                    placementIndex
                  ]
                : '';

            const scoreMatch =
              String(
                scoreText
              ).match(
                /\b([0-9]{1,3}\.[0-9]{2,3})\b/
              );

            const placementMatch =
              String(
                placementText
              ).match(
                /\b([0-9]{1,3})(?:st|nd|rd|th)?\b/i
              );

            found = {
              show_title:
                titleIndex >= 0
                  ? cleanText(
                      texts[
                        titleIndex
                      ]
                    )
                  : null,

              repertoire:
                splitRepertoire(
                  repertoireRaw
                ),

              final_score:
                scoreMatch
                  ? Number(
                      scoreMatch[1]
                    )
                  : null,

              placement:
                placementMatch
                  ? Number(
                      placementMatch[1]
                    )
                  : null,
            };

            return false;
          }
        );

      return undefined;
    }
  );

  return found;
}

async function fetchWikipediaHistory(
  corps,
  year
) {
  const titles =
    await wikiSearch(corps);

  for (
    const title
    of titles
  ) {
    const url =
      `${WIKI_API}` +
      `?action=parse` +
      `&page=${encodeURIComponent(title)}` +
      `&prop=text` +
      `&format=json` +
      `&origin=*`;

    try {
      const raw =
        await fetchText(url);

      const data =
        JSON.parse(raw);

      const html =
        data &&
        data.parse &&
        data.parse.text
          ? data.parse.text['*']
          : null;

      if (!html) {
        continue;
      }

      const parsed =
        parseWikipediaYearRow(
          html,
          year
        );

      if (!parsed) {
        continue;
      }

      return {
        ...parsed,

        repertoire_source_url:
          wikiPageUrl(title),

        repertoire_source_label:
          'Wikipedia corps history',

        fallback_placement_source_url:
          wikiPageUrl(title),

        fallback_placement_source_label:
          'Wikipedia corps history',
      };

    } catch (_err) {
      // Try next candidate article.
    }
  }

  return null;
}

async function fetchHistoricalShowData(
  show
) {
  const corps =
    String(
      show &&
      show.corps ||
      ''
    ).trim();

  const year =
    Number(
      show &&
      show.year ||
      0
    );

  if (
    !corps ||
    !Number.isInteger(year) ||
    year < 1900
  ) {
    throw new Error(
      'The show needs a valid corps and year before historical data can be looked up.'
    );
  }

  const wiki =
    await fetchWikipediaHistory(
      corps,
      year
    );

  const dci =
    await fetchDciPlacement(
      corps,
      year,
      wiki && wiki.placement
    );

  const placement =
    dci &&
    dci.placement != null
      ? dci.placement
      : (
          wiki &&
          wiki.placement != null
            ? wiki.placement
            : null
        );

  const finalScore =
    dci &&
    dci.final_score != null
      ? dci.final_score
      : (
          wiki &&
          wiki.final_score != null
            ? wiki.final_score
            : null
        );

  const repertoire =
    wiki &&
    Array.isArray(
      wiki.repertoire
    )
      ? wiki.repertoire
      : [];

  const hasPlacement =
    placement != null ||
    finalScore != null;

  const hasRepertoire =
    repertoire.length > 0;

  let status =
    'not_found';

  if (
    hasPlacement &&
    hasRepertoire
  ) {
    status = 'ok';

  } else if (
    hasPlacement ||
    hasRepertoire
  ) {
    status = 'partial';
  }

  return {
    show_id:
      Number(show.id),

    show_title:
      wiki &&
      wiki.show_title
        ? wiki.show_title
        : null,

    placement,

    placement_display:
      placement
        ? ordinal(placement)
        : null,

    final_score:
      finalScore,

    championship_round:
      dci &&
      dci.championship_round
        ? dci.championship_round
        : null,

    repertoire,

    placement_source_url:
      dci &&
      dci.placement_source_url
        ? dci.placement_source_url
        : (
            wiki &&
            wiki.fallback_placement_source_url
              ? wiki.fallback_placement_source_url
              : null
          ),

    placement_source_label:
      dci &&
      dci.placement_source_label
        ? dci.placement_source_label
        : (
            wiki &&
            wiki.fallback_placement_source_label
              ? wiki.fallback_placement_source_label
              : null
          ),

    repertoire_source_url:
      wiki &&
      wiki.repertoire_source_url
        ? wiki.repertoire_source_url
        : null,

    repertoire_source_label:
      wiki &&
      wiki.repertoire_source_label
        ? wiki.repertoire_source_label
        : null,

    fetch_status:
      status,

    fetched_ts:
      nowTs(),

    fetch_error:
      null,
  };
}

function ensureHistoricalShowDataTable(
  conn
) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS show_external_history (
      show_id INTEGER PRIMARY KEY,

      show_title TEXT,

      placement INTEGER,

      final_score REAL,

      championship_round TEXT,

      repertoire_json TEXT
        NOT NULL
        DEFAULT '[]',

      placement_source_url TEXT,

      placement_source_label TEXT,

      repertoire_source_url TEXT,

      repertoire_source_label TEXT,

      fetch_status TEXT
        NOT NULL
        DEFAULT 'not_found',

      fetched_ts INTEGER
        NOT NULL
        DEFAULT 0,

      fetch_error TEXT,

      FOREIGN KEY(show_id)
        REFERENCES shows(id)
        ON DELETE CASCADE
    );
  `);
}

function hydrateRow(row) {
  if (!row) {
    return null;
  }

  let repertoire = [];

  try {
    const parsed =
      JSON.parse(
        row.repertoire_json ||
        '[]'
      );

    repertoire =
      Array.isArray(parsed)
        ? parsed
        : [];

  } catch (_err) {
    repertoire = [];
  }

  return {
    show_id:
      Number(row.show_id),

    show_title:
      row.show_title ||
      null,

    placement:
      row.placement == null
        ? null
        : Number(
            row.placement
          ),

    placement_display:
      row.placement == null
        ? null
        : ordinal(
            Number(
              row.placement
            )
          ),

    final_score:
      row.final_score == null
        ? null
        : Number(
            row.final_score
          ),

    championship_round:
      row.championship_round ||
      null,

    repertoire,

    placement_source_url:
      row.placement_source_url ||
      null,

    placement_source_label:
      row.placement_source_label ||
      null,

    repertoire_source_url:
      row.repertoire_source_url ||
      null,

    repertoire_source_label:
      row.repertoire_source_label ||
      null,

    fetch_status:
      row.fetch_status ||
      'not_found',

    fetched_ts:
      Number(
        row.fetched_ts ||
        0
      ),

    fetch_error:
      row.fetch_error ||
      null,
  };
}

function getCachedHistoricalShowData(
  conn,
  showId
) {
  ensureHistoricalShowDataTable(
    conn
  );

  const row =
    conn.prepare(`
      SELECT *
      FROM show_external_history
      WHERE show_id = ?
    `).get(
      Number(showId)
    );

  return hydrateRow(row);
}

function saveHistoricalShowData(
  conn,
  data
) {
  ensureHistoricalShowDataTable(
    conn
  );

  conn.prepare(`
    INSERT INTO show_external_history (
      show_id,
      show_title,
      placement,
      final_score,
      championship_round,
      repertoire_json,
      placement_source_url,
      placement_source_label,
      repertoire_source_url,
      repertoire_source_label,
      fetch_status,
      fetched_ts,
      fetch_error
    )
    VALUES (
      @show_id,
      @show_title,
      @placement,
      @final_score,
      @championship_round,
      @repertoire_json,
      @placement_source_url,
      @placement_source_label,
      @repertoire_source_url,
      @repertoire_source_label,
      @fetch_status,
      @fetched_ts,
      @fetch_error
    )

    ON CONFLICT(show_id)
    DO UPDATE SET
      show_title =
        excluded.show_title,

      placement =
        excluded.placement,

      final_score =
        excluded.final_score,

      championship_round =
        excluded.championship_round,

      repertoire_json =
        excluded.repertoire_json,

      placement_source_url =
        excluded.placement_source_url,

      placement_source_label =
        excluded.placement_source_label,

      repertoire_source_url =
        excluded.repertoire_source_url,

      repertoire_source_label =
        excluded.repertoire_source_label,

      fetch_status =
        excluded.fetch_status,

      fetched_ts =
        excluded.fetched_ts,

      fetch_error =
        excluded.fetch_error
  `).run({
    show_id:
      Number(
        data.show_id
      ),

    show_title:
      data.show_title ||
      null,

    placement:
      data.placement == null
        ? null
        : Number(
            data.placement
          ),

    final_score:
      data.final_score == null
        ? null
        : Number(
            data.final_score
          ),

    championship_round:
      data.championship_round ||
      null,

    repertoire_json:
      JSON.stringify(
        Array.isArray(
          data.repertoire
        )
          ? data.repertoire
          : []
      ),

    placement_source_url:
      data.placement_source_url ||
      null,

    placement_source_label:
      data.placement_source_label ||
      null,

    repertoire_source_url:
      data.repertoire_source_url ||
      null,

    repertoire_source_label:
      data.repertoire_source_label ||
      null,

    fetch_status:
      data.fetch_status ||
      'not_found',

    fetched_ts:
      Number(
        data.fetched_ts ||
        nowTs()
      ),

    fetch_error:
      data.fetch_error ||
      null,
  });
}

async function getOrFetchHistoricalShowData(
  conn,
  show,
  { force = false } = {}
) {
  ensureHistoricalShowDataTable(
    conn
  );

  const cached =
    getCachedHistoricalShowData(
      conn,
      show.id
    );

  const ageSeconds =
    cached
      ? Math.max(
          0,
          nowTs() -
          Number(
            cached.fetched_ts ||
            0
          )
        )
      : Infinity;

  if (
    !force &&
    cached
  ) {
    if (
      cached.fetch_status ===
        'ok' ||
      cached.fetch_status ===
        'partial'
    ) {
      return cached;
    }

    if (
      ageSeconds <
      ERROR_RETRY_SECONDS
    ) {
      return cached;
    }
  }

  try {
    const fresh =
      await fetchHistoricalShowData(
        show
      );

    saveHistoricalShowData(
      conn,
      fresh
    );

    return (
      getCachedHistoricalShowData(
        conn,
        show.id
      )
    );

  } catch (err) {
    const failed = {
      show_id:
        Number(show.id),

      show_title:
        cached &&
        cached.show_title,

      placement:
        cached &&
        cached.placement,

      final_score:
        cached &&
        cached.final_score,

      championship_round:
        cached &&
        cached.championship_round,

      repertoire:
        cached &&
        cached.repertoire ||
        [],

      placement_source_url:
        cached &&
        cached.placement_source_url,

      placement_source_label:
        cached &&
        cached.placement_source_label,

      repertoire_source_url:
        cached &&
        cached.repertoire_source_url,

      repertoire_source_label:
        cached &&
        cached.repertoire_source_label,

      fetch_status:
        cached &&
        (
          cached.placement != null ||
          (
            cached.repertoire ||
            []
          ).length
        )
          ? 'partial'
          : 'error',

      fetched_ts:
        nowTs(),

      fetch_error:
        String(
          err &&
          err.message ||
          err ||
          'Historical lookup failed'
        ),
    };

    saveHistoricalShowData(
      conn,
      failed
    );

    return (
      getCachedHistoricalShowData(
        conn,
        show.id
      )
    );
  }
}

module.exports = {
  ensureHistoricalShowDataTable,
  getCachedHistoricalShowData,
  getOrFetchHistoricalShowData,
  fetchHistoricalShowData,
  saveHistoricalShowData,
  ordinal,
};
