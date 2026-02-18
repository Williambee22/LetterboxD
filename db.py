import sqlite3
import time
import re
from typing import Any, Dict, List, Optional, Tuple




def now_ts() -> int:
    return int(time.time())

def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn

def init_db(db_path: str, schema_path: str = "schema.sql") -> None:
    with open(schema_path, "r", encoding="utf-8") as f:
        schema = f.read()
    conn = connect(db_path)
    try:
        conn.executescript(schema)
        conn.commit()
    finally:
        conn.close()

def norm_key(year: int, corps: str, title: str) -> str:
    # Stable uniqueness key: "2017|blue devils|metamorph"
    def norm(s: str) -> str:
        s = s.strip().lower()
        s = re.sub(r"\s+", " ", s)
        s = re.sub(r"[^a-z0-9 \-]", "", s)
        return s.strip()
    return f"{int(year)}|{norm(corps)}|{norm(title)}"

def is_first_user(conn: sqlite3.Connection) -> bool:
    row = conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()
    return int(row["n"]) == 0

def user_by_username(conn: sqlite3.Connection, username: str):
    return conn.execute("SELECT * FROM users WHERE username = ?", (username.strip(),)).fetchone()

def user_by_id(conn: sqlite3.Connection, user_id: int):
    return conn.execute("SELECT * FROM users WHERE id = ?", (int(user_id),)).fetchone()

def create_user(conn: sqlite3.Connection, username: str, pass_hash: str, make_admin: bool = False) -> int:
    conn.execute(
        "INSERT INTO users(username, pass_hash, is_admin, created_ts) VALUES (?,?,?,?)",
        (username.strip(), pass_hash, 1 if make_admin else 0, now_ts()),
    )
    conn.commit()
    return int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])

def add_show(conn: sqlite3.Connection, year: int, corps: str, title: str, poster_url: Optional[str] = None) -> Tuple[bool, Optional[int], str]:
    year_i = int(year)
    corps_s = corps.strip()
    title_s = title.strip()
    poster_s = (poster_url or "").strip() or None

    if not corps_s or not title_s:
        return (False, None, "Missing corps or title.")

    key = norm_key(year_i, corps_s, title_s)

    try:
        conn.execute(
            "INSERT INTO shows(title, corps, year, poster_url, norm_key, created_ts) VALUES (?,?,?,?,?,?)",
            (title_s, corps_s, year_i, poster_s, key, now_ts()),
        )
        conn.commit()
        show_id = int(conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"])
        return (True, show_id, "Inserted")

    except sqlite3.IntegrityError:
        # Duplicate show — optionally update poster_url if you provided one and DB is empty
        row = conn.execute("SELECT id, poster_url FROM shows WHERE norm_key = ?", (key,)).fetchone()
        if row and poster_s and (row["poster_url"] is None or str(row["poster_url"]).strip() == ""):
            conn.execute("UPDATE shows SET poster_url = ? WHERE id = ?", (poster_s, int(row["id"])))
            conn.commit()
            return (False, int(row["id"]), "Duplicate (poster updated)")
        return (False, int(row["id"]) if row else None, "Duplicate")

def upsert_rating(conn: sqlite3.Connection, show_id: int, user_id: int, rating_half: int) -> None:
    rh = max(0, min(10, int(rating_half)))  # 0..10
    conn.execute(
        """
        INSERT INTO ratings(show_id, user_id, rating_half, ts)
        VALUES (?,?,?,?)
        ON CONFLICT(show_id, user_id) DO UPDATE SET
          rating_half=excluded.rating_half,
          ts=excluded.ts
        """,
        (int(show_id), int(user_id), rh, now_ts()),
    )
    conn.commit()

def list_friend_activity(conn: sqlite3.Connection, viewer_id: int, limit: int = 10):
    """
    Unified feed of friends' recent ratings + reviews.
    Uses list_friends() that you already have in your project.

    Expected tables:
      - ratings(show_id, user_id, rating_half, created_at, updated_at)
      - reviews(show_id, user_id, text, created_at, updated_at)
      - shows(id, year, corps, title)
      - users(id, username)

    Returns rows with:
      kind, actor_username, show_id, corps, year, rating_half, ts
    """

    # 1) Get friends via your existing helper.
    friends = list_friends(conn, viewer_id, limit=2000)  # you already have this
    friend_ids = []
    for f in friends or []:
        d = dict(f)
        # list_friends usually returns the OTHER user info; common key names:
        # id, user_id, friend_id, other_user_id. We'll check a few.
        for k in ("id", "user_id", "friend_id", "other_user_id"):
            if k in d and d[k] is not None:
                # avoid accidentally including yourself if the row includes you
                if int(d[k]) != int(viewer_id):
                    friend_ids.append(int(d[k]))
                break

    friend_ids = sorted(set(friend_ids))
    if not friend_ids:
        return []

    # 2) Build a parameter list for "IN (...)"
    qmarks = ",".join(["?"] * len(friend_ids))

    # 3) Pull recent reviews
    reviews = conn.execute(f"""
      SELECT
        'review' AS kind,
        u.username AS actor_username,
        s.id AS show_id,
        s.corps AS corps,
        s.year AS year,
        NULL AS rating_half,
        COALESCE(r.updated_at, r.created_at) AS ts
      FROM reviews r
      JOIN users u ON u.id = r.user_id
      JOIN shows s ON s.id = r.show_id
      WHERE r.user_id IN ({qmarks})
        AND TRIM(COALESCE(r.text,'')) <> ''
    """, friend_ids).fetchall()

    # 4) Pull recent ratings
    ratings = conn.execute(f"""
      SELECT
        'rating' AS kind,
        u.username AS actor_username,
        s.id AS show_id,
        s.corps AS corps,
        s.year AS year,
        rt.rating_half AS rating_half,
        COALESCE(rt.updated_at, rt.created_at) AS ts
      FROM ratings rt
      JOIN users u ON u.id = rt.user_id
      JOIN shows s ON s.id = rt.show_id
      WHERE rt.user_id IN ({qmarks})
    """, friend_ids).fetchall()

    # 5) Merge + sort in Python (simple + reliable)
    combined = [dict(x) for x in (reviews or [])] + [dict(x) for x in (ratings or [])]
    combined.sort(key=lambda d: (d.get("ts") or ""), reverse=True)
    return combined[:int(limit)]


def ensure_half_star_migration(conn: sqlite3.Connection) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(ratings)").fetchall()]
    if "rating_half" not in cols:
        conn.execute("ALTER TABLE ratings ADD COLUMN rating_half INTEGER NOT NULL DEFAULT 0;")
        # If old column exists, migrate values
        if "rating_int" in cols:
            conn.execute("UPDATE ratings SET rating_half = COALESCE(rating_int, 0) * 2;")
        conn.commit()



def list_unread_notifications(conn: sqlite3.Connection, user_id: int, limit: int = 30):
    return conn.execute("""
        SELECT id, kind, actor_user_id, actor_username, show_id, created_at, is_read
        FROM notifications
        WHERE user_id = ?
          AND COALESCE(is_read, 0) = 0
        ORDER BY id DESC
        LIMIT ?
    """, (int(user_id), int(limit))).fetchall()

def unread_notifications_count(conn: sqlite3.Connection, user_id: int) -> int:
    row = conn.execute("""
        SELECT COUNT(*) AS c
        FROM notifications
        WHERE user_id = ?
          AND COALESCE(is_read, 0) = 0
    """, (int(user_id),)).fetchone()
    return int(row["c"] if isinstance(row, sqlite3.Row) else row[0])

def mark_all_notifications_read(conn: sqlite3.Connection, user_id: int):
    conn.execute("""
        UPDATE notifications
        SET is_read = 1
        WHERE user_id = ?
          AND COALESCE(is_read, 0) = 0
    """, (int(user_id),))

def list_top_users_by_review_upvotes(conn, limit: int = 25):
    text_col = _reviews_text_col(conn)

    sql = f"""
    WITH review_vote_totals AS (
      SELECT
        r.user_id AS review_user_id,
        r.show_id AS show_id,
        r.{text_col} AS review_text,
        SUM(CASE WHEN rv.vote = 1 THEN 1 ELSE 0 END)  AS upvotes,
        SUM(CASE WHEN rv.vote = -1 THEN 1 ELSE 0 END) AS downvotes,
        SUM(CASE WHEN rv.vote = 1 THEN 1
                 WHEN rv.vote = -1 THEN -1
                 ELSE 0 END) AS net_score
      FROM reviews r
      LEFT JOIN review_votes rv
        ON rv.show_id = r.show_id
       AND rv.review_user_id = r.user_id
      WHERE TRIM(COALESCE(r.{text_col}, '')) <> ''
      GROUP BY r.user_id, r.show_id, r.{text_col}
    ),
    user_totals AS (
      SELECT
        review_user_id,
        SUM(upvotes)    AS total_upvotes,
        SUM(downvotes)  AS total_downvotes,
        SUM(net_score)  AS total_net
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
    LIMIT ?;
    """
    return conn.execute(sql, (int(limit),)).fetchall()


def ensure_notifications_table(conn: sqlite3.Connection):
    conn.execute("""
    CREATE TABLE IF NOT EXISTS notifications(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,              -- recipient
      actor_user_id INTEGER,                 -- who did it (nullable)
      kind TEXT NOT NULL,                    -- 'friend_request' | 'follow' | 'review_upvote'
      show_id INTEGER,                       -- optional
      review_user_id INTEGER,                -- optional (author of review)
      vote INTEGER,                          -- optional (+1 / -1)
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_read INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    """)

    conn.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, is_read);")


def add_notification(conn: sqlite3.Connection,
                     user_id: int,
                     kind: str,
                     actor_user_id: int | None = None,
                     show_id: int | None = None,
                     review_user_id: int | None = None,
                     vote: int | None = None):
    conn.execute("""
      INSERT INTO notifications(user_id, actor_user_id, kind, show_id, review_user_id, vote)
      VALUES(?, ?, ?, ?, ?, ?)
    """, (user_id, actor_user_id, kind, show_id, review_user_id, vote))


def unread_notifications_count(conn: sqlite3.Connection, user_id: int) -> int:
    row = conn.execute("""
      SELECT COUNT(*) AS c
      FROM notifications
      WHERE user_id=? AND is_read=0
    """, (user_id,)).fetchone()
    return int(row["c"] if isinstance(row, sqlite3.Row) else row[0])


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    cols = set()
    for r in rows or []:
        name = r["name"] if isinstance(r, sqlite3.Row) else r[1]
        cols.add(str(name))
    return cols

def _users_columns(conn: sqlite3.Connection) -> set[str]:
    return {r[1] for r in conn.execute("PRAGMA table_info(users);").fetchall()}

def users_password_col(conn: sqlite3.Connection) -> str:
    cols = _users_columns(conn)
    if "pass_hash" in cols:
        return "pass_hash"
    if "password_hash" in cols:
        return "password_hash"
    raise RuntimeError(f"users table missing password hash column. Found: {sorted(cols)}")

def update_user_username(conn: sqlite3.Connection, user_id: int, new_username: str) -> None:
    conn.execute("UPDATE users SET username=? WHERE id=?", (new_username, int(user_id)))

def update_user_password_hash(conn: sqlite3.Connection, user_id: int, new_hash: str) -> None:
    col = users_password_col(conn)
    conn.execute(f"UPDATE users SET {col}=? WHERE id=?", (new_hash, int(user_id)))



def list_unread_notifications(conn: sqlite3.Connection, user_id: int, limit: int = 30):
    cols = _table_columns(conn, "notifications")

    has_actor_username = "actor_username" in cols
    has_actor_user_id  = "actor_user_id" in cols

    # always present (in your implementation assumptions)
    # but keep safe fallbacks anyway:
    show_expr     = "n.show_id"     if "show_id" in cols else "NULL AS show_id"
    created_expr  = "n.created_at"  if "created_at" in cols else "NULL AS created_at"
    is_read_expr  = "n.is_read"     if "is_read" in cols else "0 AS is_read"
    kind_expr     = "n.kind"        if "kind" in cols else "'' AS kind"

    if has_actor_username:
        actor_expr = "n.actor_username AS actor_username"
        join_sql = ""
    elif has_actor_user_id:
        actor_expr = "COALESCE(u.username, 'Someone') AS actor_username"
        join_sql = "LEFT JOIN users u ON u.id = n.actor_user_id"
    else:
        actor_expr = "'Someone' AS actor_username"
        join_sql = ""

    sql = f"""
        SELECT
            n.id AS id,
            {kind_expr},
            {actor_expr},
            {show_expr},
            {created_expr},
            {is_read_expr}
        FROM notifications n
        {join_sql}
        WHERE n.user_id = ?
          AND COALESCE(n.is_read, 0) = 0
        ORDER BY n.id DESC
        LIMIT ?
    """

    return conn.execute(sql, (int(user_id), int(limit))).fetchall()

def mark_notifications_read(conn: sqlite3.Connection, user_id: int):
    conn.execute("""
      UPDATE notifications
      SET is_read=1
      WHERE user_id=? AND is_read=0
    """, (user_id,))


import sqlite3
from typing import List, Optional


def _best_ts_expr(cols: set[str], prefix: str) -> str:
    for c in ("updated_at", "created_at", "ts", "timestamp"):
        if c in cols:
            return f"{prefix}.{c}"
    return "datetime('now')"

def _pick_first_existing(cols: set[str], candidates: list[str]) -> Optional[str]:
    for c in candidates:
        if c in cols:
            return c
    return None

def list_friend_activity(conn: sqlite3.Connection, viewer_id: int, limit: int = 10):
    """
    Unified feed of friends' recent ratings + reviews.
    Detects your schema for:
      - reviews body column (text/review_text/body/content/...)
      - timestamps (updated_at/created_at/...)
    """

    # 1) Get friend IDs via your existing helper
    friends = list_friends(conn, viewer_id, limit=2000)
    friend_ids: List[int] = []

    for f in friends or []:
        d = dict(f)
        for k in ("id", "user_id", "friend_id", "other_user_id"):
            if k in d and d[k] is not None:
                if int(d[k]) != int(viewer_id):
                    friend_ids.append(int(d[k]))
                break

    friend_ids = sorted(set(friend_ids))
    if not friend_ids:
        return []

    qmarks = ",".join(["?"] * len(friend_ids))

    # 2) Detect columns
    review_cols = _table_columns(conn, "reviews")
    rating_cols = _table_columns(conn, "ratings")

    review_ts = _best_ts_expr(review_cols, "r")
    rating_ts = _best_ts_expr(rating_cols, "rt")

    # Detect the review body column name
    review_body_col = _pick_first_existing(
        review_cols,
        ["text", "review_text", "body", "content", "comment", "message"]
    )

    # If there's no recognizable review text column, we can still show "reviewed" events,
    # but we can't filter out empty reviews. We'll just skip the TRIM filter.
    if review_body_col:
        review_body_expr = f"COALESCE(r.{review_body_col}, '')"
        review_nonempty_where = f"AND TRIM({review_body_expr}) <> ''"
    else:
        review_body_expr = "''"
        review_nonempty_where = ""

    # 3) Fetch reviews
    reviews = conn.execute(f"""
      SELECT
        'review' AS kind,
        u.username AS actor_username,
        s.id AS show_id,
        s.corps AS corps,
        s.year AS year,
        NULL AS rating_half,
        {review_ts} AS ts
      FROM reviews r
      JOIN users u ON u.id = r.user_id
      JOIN shows s ON s.id = r.show_id
      WHERE r.user_id IN ({qmarks})
      {review_nonempty_where}
    """, friend_ids).fetchall()

    # 4) Fetch ratings (rating_half column must exist for your app; if not, tell me)
    ratings = conn.execute(f"""
      SELECT
        'rating' AS kind,
        u.username AS actor_username,
        s.id AS show_id,
        s.corps AS corps,
        s.year AS year,
        rt.rating_half AS rating_half,
        {rating_ts} AS ts
      FROM ratings rt
      JOIN users u ON u.id = rt.user_id
      JOIN shows s ON s.id = rt.show_id
      WHERE rt.user_id IN ({qmarks})
    """, friend_ids).fetchall()

    combined = [dict(x) for x in (reviews or [])] + [dict(x) for x in (ratings or [])]
    combined.sort(key=lambda d: (d.get("ts") or ""), reverse=True)
    return combined[:int(limit)]

def delete_rating(conn: sqlite3.Connection, show_id: int, user_id: int) -> None:
    conn.execute("DELETE FROM ratings WHERE show_id=? AND user_id=?", (int(show_id), int(user_id)))
    conn.commit()

def list_shows(conn, sort: str = "year_desc", year: str | None = None, corps: str | None = None):
    year = (year or "").strip()
    corps = (corps or "").strip()

    where = []
    params = []

    if year:
        where.append("s.year = ?")
        params.append(int(year))

    if corps:
        where.append("s.corps = ?")
        params.append(corps)

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    # sort options
    sort = (sort or "year_desc").strip().lower()
    if sort == "year_asc":
        order_sql = "s.year ASC, s.corps ASC, s.title ASC"
    elif sort == "year_desc":
        order_sql = "s.year DESC, s.corps ASC, s.title ASC"
    elif sort == "corps":
        order_sql = "s.corps ASC, s.year DESC, s.title ASC"
    elif sort == "top":
        order_sql = "avg_rating DESC, cnt DESC, s.year DESC, s.title ASC"
    elif sort == "bottom":
        order_sql = "avg_rating ASC, cnt DESC, s.year DESC, s.title ASC"
    else:
        order_sql = "s.year DESC, s.corps ASC, s.title ASC"

    return conn.execute(
        f"""
        SELECT
          s.*,
          COUNT(r.rating_half) AS cnt,
          COALESCE(ROUND(AVG(r.rating_half) / 2.0, 2), 0) AS avg_rating
        FROM shows s
        LEFT JOIN ratings r ON r.show_id = s.id
        {where_sql}
        GROUP BY s.id
        ORDER BY {order_sql}
        """,
        params,
    ).fetchall()

def show_detail(conn: sqlite3.Connection, show_id: int) -> Optional[sqlite3.Row]:
    return conn.execute(
        """
        SELECT
          s.*,
          (COALESCE(AVG(r.rating_half), 0.0) / 2.0) AS avg_rating,
          COUNT(r.rating_half) AS cnt
        FROM shows s
        LEFT JOIN ratings r ON r.show_id = s.id
        WHERE s.id = ?
        GROUP BY s.id
        """,
        (int(show_id),),
    ).fetchone()

def user_rating_for_show(conn: sqlite3.Connection, show_id: int, user_id: int) -> Optional[int]:
    row = conn.execute(
        "SELECT rating_half FROM ratings WHERE show_id=? AND user_id=?",
        (int(show_id), int(user_id)),
    ).fetchone()
    return int(row["rating_half"]) if row else None


def _reviews_text_col(conn) -> str:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(reviews);").fetchall()}
    for c in ("text", "review_text", "body", "content"):
        if c in cols:
            return c
    raise RuntimeError(f"reviews table has no recognized text column. Found: {sorted(cols)}")


def get_show_by_id(conn, show_id: int):
    return conn.execute(
        """
        SELECT
          s.*,
          COUNT(r.rating_half) AS cnt,
          COALESCE(ROUND(AVG(r.rating_half) / 2.0, 2), 0) AS avg_rating
        FROM shows s
        LEFT JOIN ratings r ON r.show_id = s.id
        WHERE s.id = ?
        GROUP BY s.id
        """,
        (int(show_id),),
    ).fetchone()

def ensure_poster_url_column(conn: sqlite3.Connection) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(shows)").fetchall()]
    if "poster_url" not in cols:
        conn.execute("ALTER TABLE shows ADD COLUMN poster_url TEXT;")
        conn.commit()

def update_show(
    conn: sqlite3.Connection,
    show_id: int,
    year: int,
    corps: str,
    title: str,
    poster_url: Optional[str] = None,
) -> None:
    year_i = int(year)
    corps_s = corps.strip()
    title_s = title.strip()
    poster_s = (poster_url or "").strip() or None

    if not corps_s or not title_s:
        raise ValueError("Missing corps or title.")

    new_key = norm_key(year_i, corps_s, title_s)

    # Prevent collision with an existing show's norm_key (other than this show)
    row = conn.execute(
        "SELECT id FROM shows WHERE norm_key = ? AND id <> ?",
        (new_key, int(show_id)),
    ).fetchone()
    if row:
        raise ValueError("Another show already exists with the same year/corps/title (duplicate).")

    conn.execute(
        """
        UPDATE shows
        SET title = ?, corps = ?, year = ?, poster_url = ?, norm_key = ?
        WHERE id = ?
        """,
        (title_s, corps_s, year_i, poster_s, new_key, int(show_id)),
    )
    conn.commit()

def update_show_poster_url(conn, show_id: int, poster_url: str | None):
    conn.execute(
        "UPDATE shows SET poster_url = ? WHERE id = ?",
        (poster_url, int(show_id)),
    )

def upsert_review(conn: sqlite3.Connection, show_id: int, user_id: int, review_text: str) -> None:
    text = (review_text or "").strip()
    if not text:
        raise ValueError("Review cannot be empty.")
    if len(text) > 5000:
        raise ValueError("Review is too long (max 5000 chars).")

    conn.execute(
        """
        INSERT INTO reviews(show_id, user_id, review_text, ts)
        VALUES (?,?,?,?)
        ON CONFLICT(show_id, user_id) DO UPDATE SET
          review_text=excluded.review_text,
          ts=excluded.ts
        """,
        (int(show_id), int(user_id), text, now_ts()),
    )
    conn.commit()


def delete_review(conn: sqlite3.Connection, show_id: int, user_id: int) -> None:
    conn.execute("DELETE FROM reviews WHERE show_id=? AND user_id=?", (int(show_id), int(user_id)))
    conn.commit()


def my_review_for_show(conn: sqlite3.Connection, show_id: int, user_id: int) -> Optional[str]:
    row = conn.execute(
        "SELECT review_text FROM reviews WHERE show_id=? AND user_id=?",
        (int(show_id), int(user_id)),
    ).fetchone()
    return str(row["review_text"]) if row else None


def list_reviews_for_show(conn, show_id: int, viewer_user_id=None, limit: int = 30):
    viewer_user_id = int(viewer_user_id) if viewer_user_id is not None else None

    return conn.execute(
        """
        SELECT
          rv.review_text, rv.ts,
          u.id AS user_id, u.username, u.avatar_url,
          r.rating_half,

          -- primary role (first assigned)
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

          -- vote score for this review (up - down)
          COALESCE((
            SELECT SUM(v.vote)
            FROM review_votes v
            WHERE v.show_id = rv.show_id AND v.review_user_id = rv.user_id
          ), 0) AS vote_score,

          -- the viewer's vote on this review (+1/-1/NULL)
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
        """,
        (viewer_user_id, int(show_id), int(limit)),
    ).fetchall()

def recent_ratings_for_user(conn: sqlite3.Connection, user_id: int, limit: int = 24) -> List[sqlite3.Row]:
    return conn.execute(
        """
        SELECT
          s.id AS show_id, s.title, s.corps, s.year, s.poster_url,
          r.rating_half, r.ts
        FROM ratings r
        JOIN shows s ON s.id = r.show_id
        WHERE r.user_id = ?
        ORDER BY r.ts DESC
        LIMIT ?
        """,
        (int(user_id), int(limit)),
    ).fetchall()


def recent_reviews_for_user(conn: sqlite3.Connection, user_id: int, limit: int = 12) -> List[sqlite3.Row]:
    return conn.execute(
        """
        SELECT
          s.id AS show_id, s.title, s.corps, s.year, s.poster_url,
          rv.review_text, rv.ts,
          r.rating_half
        FROM reviews rv
        JOIN shows s ON s.id = rv.show_id
        LEFT JOIN ratings r ON r.show_id = rv.show_id AND r.user_id = rv.user_id
        WHERE rv.user_id = ?
        ORDER BY rv.ts DESC
        LIMIT ?
        """,
        (int(user_id), int(limit)),
    ).fetchall()



def ensure_reviews_table(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
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
        """
    )
    conn.commit()


def ensure_profile_columns(conn: sqlite3.Connection) -> None:
    cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
    if "avatar_url" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN avatar_url TEXT;")
    if "banner_url" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN banner_url TEXT;")
    if "theme_color" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN theme_color TEXT;")
    conn.commit()


_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{6})$")

def _clean_color(s: str) -> str:
    s = (s or "").strip()
    if not s:
        return ""
    return s if _HEX_COLOR_RE.match(s) else ""

def update_user_profile_style(
    conn: sqlite3.Connection,
    user_id: int,
    avatar_url: str,
    banner_url: str,
    theme_color: str,
) -> None:
    a = (avatar_url or "").strip() or None
    b = (banner_url or "").strip() or None
    c = _clean_color(theme_color) or None

    conn.execute(
        """
        UPDATE users
        SET avatar_url = ?, banner_url = ?, theme_color = ?
        WHERE id = ?
        """,
        (a, b, c, int(user_id)),
    )
    conn.commit()


_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{6})$")

def _slugify(name: str) -> str:
    s = (name or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "role"

def _clean_hex_color(s: str) -> str:
    s = (s or "").strip()
    return s if _HEX_COLOR_RE.match(s) else ""

def update_user_avatar_url(conn, user_id: int, avatar_url: str | None):
    conn.execute(
        "UPDATE users SET avatar_url = ? WHERE id = ?",
        (avatar_url, int(user_id)),
    )

def pfp_url_for_username(username: str) -> str | None:
    key = slugify(username)
    base = f"pfp_{key}"
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        abs_path = PFP_DIR / (base + ext)
        if abs_path.is_file():
            return url_for("uploads", filename=f"pfps/{base}{ext}")
    return None

def poster_url_for_show(corps: str, year: int) -> str | None:
    key = slugify(corps)
    base = f"{key}{int(year)}"
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        abs_path = POSTER_DIR / (base + ext)
        if abs_path.is_file():
            return url_for("uploads", filename=f"posters/{base}{ext}")
    return None


def list_recent_ratings_for_user(conn, user_id: int, limit: int = 20):
    return conn.execute(
        """
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
        """,
        (int(user_id), int(limit)),
    ).fetchall()


def list_recent_reviews_for_user(conn, user_id: int, limit: int = 20):
    return conn.execute(
        """
        SELECT
          rv.show_id,
          rv.review_text,
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
        """,
        (int(user_id), int(limit)),
    ).fetchall()

def user_stats(conn, user_id: int):
    row = conn.execute(
        """
        SELECT
          (SELECT COUNT(*) FROM ratings WHERE user_id = ?) AS ratings_count,
          (SELECT COUNT(*) FROM reviews WHERE user_id = ?) AS reviews_count,
          (SELECT COALESCE(ROUND(AVG(rating_half)/2.0, 2), 0) FROM ratings WHERE user_id = ?) AS avg_rating_given
        """,
        (int(user_id), int(user_id), int(user_id)),
    ).fetchone()

    if not row:
        return {"ratings_count": 0, "reviews_count": 0, "avg_rating_given": 0}

    return dict(row)


def ensure_roles_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
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
        """
    )
    conn.commit()


def list_roles(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM roles ORDER BY name ASC").fetchall()


def create_role(conn: sqlite3.Connection, name: str, color: str = "") -> None:
    nm = (name or "").strip()
    if not nm:
        raise ValueError("Role name is required.")

    slug = _slugify(nm)
    col = _clean_hex_color(color) or None

    # Ensure unique slug; if collision, add -2, -3, ...
    base = slug
    n = 2
    while conn.execute("SELECT 1 FROM roles WHERE slug = ?", (slug,)).fetchone():
        slug = f"{base}-{n}"
        n += 1

    conn.execute(
        "INSERT INTO roles(name, slug, color, created_ts) VALUES (?,?,?,?)",
        (nm, slug, col, now_ts()),
    )
    conn.commit()


def delete_role(conn: sqlite3.Connection, role_id: int) -> None:
    conn.execute("DELETE FROM roles WHERE id = ?", (int(role_id),))
    conn.commit()


def assign_role_to_user(conn: sqlite3.Connection, user_id: int, role_id: int, assigned_by_user_id: int | None) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO user_roles(user_id, role_id, assigned_ts, assigned_by_user_id)
        VALUES (?,?,?,?)
        """,
        (int(user_id), int(role_id), now_ts(), int(assigned_by_user_id) if assigned_by_user_id is not None else None),
    )
    conn.commit()


def remove_role_from_user(conn: sqlite3.Connection, user_id: int, role_id: int) -> None:
    conn.execute(
        "DELETE FROM user_roles WHERE user_id = ? AND role_id = ?",
        (int(user_id), int(role_id)),
    )
    conn.commit()


def roles_for_user(conn: sqlite3.Connection, user_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT r.*
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ?
        ORDER BY ur.assigned_ts ASC
        """,
        (int(user_id),),
    ).fetchall()


def primary_role_for_user(conn: sqlite3.Connection, user_id: int) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT r.*
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id = ?
        ORDER BY ur.assigned_ts ASC
        LIMIT 1
        """,
        (int(user_id),),
    ).fetchone()


def role_by_id(conn: sqlite3.Connection, role_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM roles WHERE id = ?", (int(role_id),)).fetchone()


def update_role(conn: sqlite3.Connection, role_id: int, name: str, color: str = "") -> None:
    nm = (name or "").strip()
    if not nm:
        raise ValueError("Role name is required.")

    col = _clean_hex_color(color) or None  # uses your existing validator

    conn.execute(
        """
        UPDATE roles
        SET name = ?, color = ?
        WHERE id = ?
        """,
        (nm, col, int(role_id)),
    )
    conn.commit()



def ensure_review_votes_table(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
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
        """
    )
    conn.commit()


def set_review_vote(conn: sqlite3.Connection, show_id: int, review_user_id: int, voter_user_id: int, vote: int) -> None:
    """
    vote: +1 (upvote) or -1 (downvote)
    Toggle behavior:
      - If same vote already exists -> remove vote
      - If opposite vote exists -> switch to new vote
      - If none -> insert
    """
    show_id = int(show_id)
    review_user_id = int(review_user_id)
    voter_user_id = int(voter_user_id)
    vote = 1 if int(vote) > 0 else -1

    cur = conn.execute(
        """
        SELECT vote
        FROM review_votes
        WHERE show_id = ? AND review_user_id = ? AND voter_user_id = ?
        """,
        (show_id, review_user_id, voter_user_id),
    ).fetchone()

    if cur is None:
        conn.execute(
            """
            INSERT INTO review_votes(show_id, review_user_id, voter_user_id, vote, ts)
            VALUES (?,?,?,?,?)
            """,
            (show_id, review_user_id, voter_user_id, vote, now_ts()),
        )
    else:
        existing = int(cur["vote"])
        if existing == vote:
            conn.execute(
                """
                DELETE FROM review_votes
                WHERE show_id = ? AND review_user_id = ? AND voter_user_id = ?
                """,
                (show_id, review_user_id, voter_user_id),
            )
        else:
            conn.execute(
                """
                UPDATE review_votes
                SET vote = ?, ts = ?
                WHERE show_id = ? AND review_user_id = ? AND voter_user_id = ?
                """,
                (vote, now_ts(), show_id, review_user_id, voter_user_id),
            )

    conn.commit()


def list_users(conn):
    return conn.execute(
        "SELECT id, username, is_admin, created_ts FROM users ORDER BY username COLLATE NOCASE"
    ).fetchall()


def list_top_shows_with_top_review(conn, limit: int = 25, mode: str = "top"):
    limit = int(limit)
    mode = (mode or "top").strip().lower()

    # Top: highest avg first; Bottom: lowest avg first
    if mode == "bottom":
        order_sql = "ss.avg_rating ASC, ss.cnt DESC, ss.year DESC, ss.id ASC"
    else:
        order_sql = "ss.avg_rating DESC, ss.cnt DESC, ss.year DESC, ss.id ASC"

    sql = f"""
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
        ORDER BY {order_sql}
        LIMIT ?
    """

    return conn.execute(sql, (limit,)).fetchall()

# =========================================================
# SOCIAL — follows + friends
# =========================================================

import time
import sqlite3


def ensure_social_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS follows (
          follower_id INTEGER NOT NULL,
          followed_id INTEGER NOT NULL,
          created_ts  INTEGER NOT NULL,
          PRIMARY KEY (follower_id, followed_id),
          FOREIGN KEY (follower_id) REFERENCES users(id),
          FOREIGN KEY (followed_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);
        CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);

        -- status: 'pending' or 'accepted'
        CREATE TABLE IF NOT EXISTS friend_requests (
          requester_id INTEGER NOT NULL,
          addressee_id INTEGER NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending',
          requested_ts INTEGER NOT NULL,
          responded_ts INTEGER,
          PRIMARY KEY (requester_id, addressee_id),
          FOREIGN KEY (requester_id) REFERENCES users(id),
          FOREIGN KEY (addressee_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_friendreq_addressee ON friend_requests(addressee_id);
        CREATE INDEX IF NOT EXISTS idx_friendreq_requester ON friend_requests(requester_id);
        """
    )

def list_all_ratings_for_user(conn, user_id: int, sort: str = "high", corps_q: str = ""):
    sort = (sort or "high").strip().lower()
    corps_q = (corps_q or "").strip()

    if sort == "low":
        order_sql = "r.rating_half ASC, r.ts DESC, s.year DESC, s.id ASC"
    else:
        order_sql = "r.rating_half DESC, r.ts DESC, s.year DESC, s.id ASC"

    sql = f"""
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
        AND ( ? = '' OR LOWER(s.corps) LIKE '%' || LOWER(?) || '%' )
      ORDER BY {order_sql}
    """

    params = (user_id, corps_q, corps_q)
    return conn.execute(sql, params).fetchall()



# -------------------------
# FOLLOWING
# -------------------------

def follow(conn, follower_id: int, followed_id: int) -> None:
    if int(follower_id) == int(followed_id):
        raise ValueError("You can't follow yourself.")
    conn.execute(
        "INSERT OR IGNORE INTO follows(follower_id, followed_id, created_ts) VALUES(?,?,?)",
        (int(follower_id), int(followed_id), int(time.time())),
    )


def unfollow(conn, follower_id: int, followed_id: int) -> None:
    conn.execute(
        "DELETE FROM follows WHERE follower_id=? AND followed_id=?",
        (int(follower_id), int(followed_id)),
    )


def is_following(conn, follower_id: int, followed_id: int) -> bool:
    row = conn.execute(
        "SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?",
        (int(follower_id), int(followed_id)),
    ).fetchone()
    return row is not None


def follower_count(conn, user_id: int) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM follows WHERE followed_id=?",
        (int(user_id),),
    ).fetchone()
    return int(row["c"] if row else 0)


def following_count(conn, user_id: int) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM follows WHERE follower_id=?",
        (int(user_id),),
    ).fetchone()
    return int(row["c"] if row else 0)


def list_followers(conn, user_id: int, limit: int = 200):
    return conn.execute(
        """
        SELECT u.id, u.username, u.avatar_url
        FROM follows f
        JOIN users u ON u.id = f.follower_id
        WHERE f.followed_id = ?
        ORDER BY f.created_ts DESC
        LIMIT ?
        """,
        (int(user_id), int(limit)),
    ).fetchall()


def list_following(conn, user_id: int, limit: int = 200):
    return conn.execute(
        """
        SELECT u.id, u.username, u.avatar_url
        FROM follows f
        JOIN users u ON u.id = f.followed_id
        WHERE f.follower_id = ?
        ORDER BY f.created_ts DESC
        LIMIT ?
        """,
        (int(user_id), int(limit)),
    ).fetchall()


# -------------------------
# FRIENDS (requests -> accepted)
# -------------------------

def send_friend_request(conn, requester_id: int, addressee_id: int) -> None:
    if int(requester_id) == int(addressee_id):
        raise ValueError("You can't friend yourself.")

    # If they already requested you, accept immediately (auto-accept convenience)
    existing = conn.execute(
        "SELECT status FROM friend_requests WHERE requester_id=? AND addressee_id=?",
        (int(addressee_id), int(requester_id)),
    ).fetchone()
    if existing and existing["status"] == "pending":
        accept_friend_request(conn, addressee_id, requester_id)
        return

    # Create pending request if not already
    conn.execute(
        """
        INSERT OR IGNORE INTO friend_requests(requester_id, addressee_id, status, requested_ts)
        VALUES(?, ?, 'pending', ?)
        """,
        (int(requester_id), int(addressee_id), int(time.time())),
    )


def accept_friend_request(conn, requester_id: int, addressee_id: int) -> None:
    # requester_id = the one who sent it; addressee_id = the one accepting
    conn.execute(
        """
        UPDATE friend_requests
        SET status='accepted', responded_ts=?
        WHERE requester_id=? AND addressee_id=? AND status='pending'
        """,
        (int(time.time()), int(requester_id), int(addressee_id)),
    )


def decline_friend_request(conn, requester_id: int, addressee_id: int) -> None:
    conn.execute(
        """
        DELETE FROM friend_requests
        WHERE requester_id=? AND addressee_id=? AND status='pending'
        """,
        (int(requester_id), int(addressee_id)),
    )


def remove_friend(conn, user_id: int, other_id: int) -> None:
    # remove accepted in either direction
    conn.execute(
        """
        DELETE FROM friend_requests
        WHERE status='accepted'
          AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))
        """,
        (int(user_id), int(other_id), int(other_id), int(user_id)),
    )


def friends_status(conn, a_id: int, b_id: int):
    """
    Returns: 'none' | 'pending_out' | 'pending_in' | 'friends'
    pending_out means a->b pending
    pending_in  means b->a pending
    """
    if int(a_id) == int(b_id):
        return "none"

    row = conn.execute(
        """
        SELECT requester_id, addressee_id, status
        FROM friend_requests
        WHERE (requester_id=? AND addressee_id=?)
           OR (requester_id=? AND addressee_id=?)
        """,
        (int(a_id), int(b_id), int(b_id), int(a_id)),
    ).fetchone()

    if not row:
        return "none"
    if row["status"] == "accepted":
        return "friends"
    # pending
    return "pending_out" if int(row["requester_id"]) == int(a_id) else "pending_in"


def list_friends(conn, user_id: int, limit: int = 500):
    return conn.execute(
        """
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
        """,
        (int(user_id), int(user_id), int(user_id), int(limit)),
    ).fetchall()


def list_incoming_friend_requests(conn, user_id: int, limit: int = 200):
    return conn.execute(
        """
        SELECT u.id, u.username, u.avatar_url, fr.requested_ts
        FROM friend_requests fr
        JOIN users u ON u.id = fr.requester_id
        WHERE fr.addressee_id=? AND fr.status='pending'
        ORDER BY fr.requested_ts DESC
        LIMIT ?
        """,
        (int(user_id), int(limit)),
    ).fetchall()


def ensure_review_comments_table(conn):
    conn.execute("""
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
    """)
    conn.execute("""
    CREATE INDEX IF NOT EXISTS idx_review_comments_target
    ON review_comments(show_id, review_user_id, created_at);
    """)
    conn.execute("""
    CREATE INDEX IF NOT EXISTS idx_review_comments_commenter
    ON review_comments(commenter_user_id, created_at);
    """)


def add_review_comment(conn, show_id: int, review_user_id: int, commenter_user_id: int, comment_text: str):
    text = (comment_text or "").strip()
    if not text:
        raise ValueError("Comment cannot be empty.")
    if len(text) > 1000:
        raise ValueError("Comment too long (max 1000 chars).")

    conn.execute("""
      INSERT INTO review_comments(show_id, review_user_id, commenter_user_id, comment_text)
      VALUES(?,?,?,?)
    """, (int(show_id), int(review_user_id), int(commenter_user_id), text))


def list_review_comments_for_show(conn, show_id: int, limit_total: int = 500):
    """
    Returns comments for all reviews on a show, newest first.
    Group them in app.py by review_user_id.
    """
    return conn.execute("""
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
      LIMIT ?;
    """, (int(show_id), int(limit_total))).fetchall()


def delete_review_comment(conn, comment_id: int, requester_user_id: int, is_admin: bool = False):
    """
    Allow deleting your own comment; admins can delete anything.
    """
    row = conn.execute("SELECT commenter_user_id FROM review_comments WHERE id = ?", (int(comment_id),)).fetchone()
    if not row:
        return False
    owner_id = int(row["commenter_user_id"] if isinstance(row, dict) else row[0])
    if (owner_id != int(requester_user_id)) and not is_admin:
        raise PermissionError("Not allowed.")
    conn.execute("DELETE FROM review_comments WHERE id = ?", (int(comment_id),))
    return True

def soft_delete_review_comment(conn, comment_id: int, requester_user_id: int):
    """
    Soft delete: only the comment author can do this.
    Sets text to "[comment deleted]" instead of removing the row.
    """
    cid = int(comment_id)
    uid = int(requester_user_id)

    row = conn.execute(
        "SELECT id, commenter_user_id FROM review_comments WHERE id=?",
        (cid,)
    ).fetchone()

    if not row:
        raise ValueError("Comment not found.")

    if int(row["commenter_user_id"]) != uid:
        raise ValueError("You can only delete your own comments.")

    conn.execute(
        "UPDATE review_comments SET comment_text='[comment deleted]' WHERE id=?",
        (cid,)
    )


def admin_hard_delete_review_comment(conn, comment_id: int):
    """
    Hard delete: admin can remove any comment entirely.
    """
    cid = int(comment_id)
    conn.execute("DELETE FROM review_comments WHERE id=?", (cid,))


def admin_delete_show(conn, show_id: int) -> None:
    """
    HARD delete a show and all dependent rows.
    Order matters (children first) to avoid FK issues.
    """
    sid = int(show_id)

    # Notifications referencing this show
    try:
        conn.execute("DELETE FROM notifications WHERE show_id = ?", (sid,))
    except Exception:
        pass  # if notifications table doesn't exist in some builds

    # Review comments (usually keyed by show_id)
    try:
        conn.execute("DELETE FROM review_comments WHERE show_id = ?", (sid,))
    except Exception:
        pass

    # Review votes (usually keyed by show_id)
    try:
        conn.execute("DELETE FROM review_votes WHERE show_id = ?", (sid,))
    except Exception:
        pass

    # Reviews for this show
    try:
        conn.execute("DELETE FROM reviews WHERE show_id = ?", (sid,))
    except Exception:
        pass

    # Ratings for this show
    try:
        conn.execute("DELETE FROM ratings WHERE show_id = ?", (sid,))
    except Exception:
        pass

    # Finally the show row
    conn.execute("DELETE FROM shows WHERE id = ?", (sid,))


def admin_delete_review(conn, show_id: int, review_user_id: int):
    """
    Admin delete: removes the review and all associated votes/comments for that review target.
    Review identity in this app is (show_id, review_user_id).
    """
    sid = int(show_id)
    ruid = int(review_user_id)

    # Remove votes on that review (if table exists)
    try:
        conn.execute("DELETE FROM review_votes WHERE show_id=? AND review_user_id=?", (sid, ruid))
    except Exception:
        pass

    # Remove comments on that review (if table exists)
    try:
        conn.execute("DELETE FROM review_comments WHERE show_id=? AND review_user_id=?", (sid, ruid))
    except Exception:
        pass

    # Remove the review itself (your reviews table uses user_id as author)
    conn.execute("DELETE FROM reviews WHERE show_id=? AND user_id=?", (sid, ruid))

def user_avg_rating(conn, user_id: int):
    """
    Returns (avg_rating_float, count_int) for a user's ratings.
    rating_half is stored 0..10 (half-stars). Avg is returned on 0..5 scale.
    """
    row = conn.execute(
        """
        SELECT
          COUNT(*) AS cnt,
          AVG(rating_half) / 2.0 AS avg_rating
        FROM ratings
        WHERE user_id = ?
        """,
        (int(user_id),),
    ).fetchone()

    cnt = int(row["cnt"] or 0) if row else 0
    avg = float(row["avg_rating"] or 0.0) if row else 0.0

    return avg, cnt



