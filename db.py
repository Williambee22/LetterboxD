import sqlite3
import time
import re
from typing import Optional, Tuple, List


# -------------------------
# Core helpers
# -------------------------

def now_ts() -> int:
    return int(time.time())


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    cols = set()
    for r in rows or []:
        name = r["name"] if isinstance(r, sqlite3.Row) else r[1]
        cols.add(str(name))
    return cols


def init_db(db_path: str, schema_path: str | None = None) -> None:
    """
    Bootstrap the DB without schema.sql.
    Creates all tables used by the app if they don't exist.
    """
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA journal_mode=WAL;")

    try:
        # ---- base tables ----
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE,
              pass_hash TEXT NOT NULL,
              is_admin INTEGER NOT NULL DEFAULT 0,
              created_ts INTEGER NOT NULL DEFAULT 0,
              avatar_url TEXT,
              banner_url TEXT,
              theme_color TEXT
            );

            CREATE TABLE IF NOT EXISTS shows (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              title TEXT NOT NULL,
              corps TEXT NOT NULL,
              year INTEGER NOT NULL,
              poster_url TEXT,
              norm_key TEXT NOT NULL UNIQUE,
              created_ts INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS ratings (
              show_id INTEGER NOT NULL,
              user_id INTEGER NOT NULL,
              rating_half INTEGER NOT NULL DEFAULT 0,
              ts INTEGER NOT NULL DEFAULT 0,
              PRIMARY KEY (show_id, user_id),
              FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_shows_year ON shows(year);
            CREATE INDEX IF NOT EXISTS idx_shows_corps ON shows(corps);
            CREATE INDEX IF NOT EXISTS idx_ratings_show ON ratings(show_id);
            CREATE INDEX IF NOT EXISTS idx_ratings_user ON ratings(user_id);
            CREATE INDEX IF NOT EXISTS idx_ratings_ts ON ratings(ts);
            """
        )

        # ---- feature tables ----
        ensure_reviews_table(conn)
        ensure_review_votes_table(conn)
        ensure_review_comments_table(conn)
        ensure_roles_tables(conn)
        ensure_social_tables(conn)
        ensure_notifications_table(conn)

        conn.commit()

    finally:
        conn.close()


# -------------------------
# Users
# -------------------------

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


def users_password_col(conn: sqlite3.Connection) -> str:
    cols = _table_columns(conn, "users")
    # allow legacy column name if you ever had it
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


def update_user_avatar_url(conn: sqlite3.Connection, user_id: int, avatar_url: str | None):
    conn.execute("UPDATE users SET avatar_url=? WHERE id=?", (avatar_url, int(user_id)))


def user_avg_rating(conn: sqlite3.Connection, user_id: int):
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


def list_users(conn):
    return conn.execute(
        "SELECT id, username, is_admin, created_ts, avatar_url FROM users ORDER BY username COLLATE NOCASE"
    ).fetchall()


# -------------------------
# Shows
# -------------------------

def norm_key(year: int, corps: str, title: str) -> str:
    def norm(s: str) -> str:
        s = s.strip().lower()
        s = re.sub(r"\s+", " ", s)
        s = re.sub(r"[^a-z0-9 \-]", "", s)
        return s.strip()
    return f"{int(year)}|{norm(corps)}|{norm(title)}"


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
        row = conn.execute("SELECT id, poster_url FROM shows WHERE norm_key = ?", (key,)).fetchone()
        if row and poster_s and (row["poster_url"] is None or str(row["poster_url"]).strip() == ""):
            conn.execute("UPDATE shows SET poster_url=? WHERE id=?", (poster_s, int(row["id"])))
            conn.commit()
            return (False, int(row["id"]), "Duplicate (poster updated)")
        return (False, int(row["id"]) if row else None, "Duplicate")


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
    row = conn.execute(
        "SELECT id FROM shows WHERE norm_key=? AND id<>?",
        (new_key, int(show_id)),
    ).fetchone()
    if row:
        raise ValueError("Another show already exists with the same year/corps/title (duplicate).")

    conn.execute(
        """
        UPDATE shows
        SET title=?, corps=?, year=?, poster_url=?, norm_key=?
        WHERE id=?
        """,
        (title_s, corps_s, year_i, poster_s, new_key, int(show_id)),
    )
    conn.commit()


def update_show_poster_url(conn: sqlite3.Connection, show_id: int, poster_url: str | None):
    conn.execute("UPDATE shows SET poster_url=? WHERE id=?", (poster_url, int(show_id)))


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


def show_detail(conn: sqlite3.Connection, show_id: int):
    return get_show_by_id(conn, show_id)


# -------------------------
# Ratings
# -------------------------

def upsert_rating(conn: sqlite3.Connection, show_id: int, user_id: int, rating_half: int) -> None:
    rh = max(0, min(10, int(rating_half)))
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


def delete_rating(conn: sqlite3.Connection, show_id: int, user_id: int) -> None:
    conn.execute("DELETE FROM ratings WHERE show_id=? AND user_id=?", (int(show_id), int(user_id)))
    conn.commit()


def user_rating_for_show(conn: sqlite3.Connection, show_id: int, user_id: int) -> Optional[int]:
    row = conn.execute(
        "SELECT rating_half FROM ratings WHERE show_id=? AND user_id=?",
        (int(show_id), int(user_id)),
    ).fetchone()
    return int(row["rating_half"]) if row else None


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

    params = (int(user_id), corps_q, corps_q)
    return conn.execute(sql, params).fetchall()


# -------------------------
# Reviews
# -------------------------

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


def list_reviews_for_show(conn, show_id: int, viewer_user_id=None, limit: int = 30):
    viewer_user_id = int(viewer_user_id) if viewer_user_id is not None else None

    return conn.execute(
        """
        SELECT
          rv.review_text, rv.ts,
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
        """,
        (viewer_user_id, int(show_id), int(limit)),
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


# -------------------------
# Review votes
# -------------------------

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


def set_review_vote(conn: sqlite3.Connection, show_id: int, review_user_id: int, voter_user_id: int, vote: int) -> None:
    show_id = int(show_id)
    review_user_id = int(review_user_id)
    voter_user_id = int(voter_user_id)
    vote = 1 if int(vote) > 0 else -1

    cur = conn.execute(
        """
        SELECT vote
        FROM review_votes
        WHERE show_id=? AND review_user_id=? AND voter_user_id=?
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
                "DELETE FROM review_votes WHERE show_id=? AND review_user_id=? AND voter_user_id=?",
                (show_id, review_user_id, voter_user_id),
            )
        else:
            conn.execute(
                """
                UPDATE review_votes
                SET vote=?, ts=?
                WHERE show_id=? AND review_user_id=? AND voter_user_id=?
                """,
                (vote, now_ts(), show_id, review_user_id, voter_user_id),
            )

    conn.commit()


# -------------------------
# Review comments
# -------------------------

def ensure_review_comments_table(conn: sqlite3.Connection):
    conn.executescript(
        """
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
        """
    )


def add_review_comment(conn, show_id: int, review_user_id: int, commenter_user_id: int, comment_text: str):
    text = (comment_text or "").strip()
    if not text:
        raise ValueError("Comment cannot be empty.")
    if len(text) > 1000:
        raise ValueError("Comment too long (max 1000 chars).")

    conn.execute(
        """
        INSERT INTO review_comments(show_id, review_user_id, commenter_user_id, comment_text)
        VALUES(?,?,?,?)
        """,
        (int(show_id), int(review_user_id), int(commenter_user_id), text),
    )


def list_review_comments_for_show(conn, show_id: int, limit_total: int = 500):
    return conn.execute(
        """
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
        """,
        (int(show_id), int(limit_total)),
    ).fetchall()


def delete_review_comment(conn, comment_id: int, requester_user_id: int, is_admin: bool = False):
    row = conn.execute("SELECT commenter_user_id FROM review_comments WHERE id=?", (int(comment_id),)).fetchone()
    if not row:
        return False
    owner_id = int(row["commenter_user_id"])
    if (owner_id != int(requester_user_id)) and not is_admin:
        raise PermissionError("Not allowed.")
    conn.execute("DELETE FROM review_comments WHERE id=?", (int(comment_id),))
    return True


def soft_delete_review_comment(conn, comment_id: int, requester_user_id: int):
    cid = int(comment_id)
    uid = int(requester_user_id)

    row = conn.execute("SELECT commenter_user_id FROM review_comments WHERE id=?", (cid,)).fetchone()
    if not row:
        raise ValueError("Comment not found.")
    if int(row["commenter_user_id"]) != uid:
        raise ValueError("You can only delete your own comments.")

    conn.execute("UPDATE review_comments SET comment_text='[comment deleted]' WHERE id=?", (cid,))


def admin_hard_delete_review_comment(conn, comment_id: int):
    conn.execute("DELETE FROM review_comments WHERE id=?", (int(comment_id),))


# -------------------------
# Roles
# -------------------------

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


def _slugify(name: str) -> str:
    s = (name or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "role"


def _clean_hex_color(s: str) -> str:
    s = (s or "").strip()
    return s if _HEX_COLOR_RE.match(s) else ""


def list_roles(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM roles ORDER BY name ASC").fetchall()


def create_role(conn: sqlite3.Connection, name: str, color: str = "") -> None:
    nm = (name or "").strip()
    if not nm:
        raise ValueError("Role name is required.")

    slug = _slugify(nm)
    col = _clean_hex_color(color) or None

    base = slug
    n = 2
    while conn.execute("SELECT 1 FROM roles WHERE slug=?", (slug,)).fetchone():
        slug = f"{base}-{n}"
        n += 1

    conn.execute(
        "INSERT INTO roles(name, slug, color, created_ts) VALUES (?,?,?,?)",
        (nm, slug, col, now_ts()),
    )
    conn.commit()


def delete_role(conn: sqlite3.Connection, role_id: int) -> None:
    conn.execute("DELETE FROM roles WHERE id=?", (int(role_id),))
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
    conn.execute("DELETE FROM user_roles WHERE user_id=? AND role_id=?", (int(user_id), int(role_id)))
    conn.commit()


def roles_for_user(conn: sqlite3.Connection, user_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT r.*
        FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id
        WHERE ur.user_id=?
        ORDER BY ur.assigned_ts ASC
        """,
        (int(user_id),),
    ).fetchall()


def role_by_id(conn: sqlite3.Connection, role_id: int):
    return conn.execute("SELECT * FROM roles WHERE id=?", (int(role_id),)).fetchone()


def update_role(conn: sqlite3.Connection, role_id: int, name: str, color: str = "") -> None:
    nm = (name or "").strip()
    if not nm:
        raise ValueError("Role name is required.")
    col = _clean_hex_color(color) or None

    conn.execute(
        "UPDATE roles SET name=?, color=? WHERE id=?",
        (nm, col, int(role_id)),
    )
    conn.commit()


# -------------------------
# Social (follows + friends)
# -------------------------

def ensure_social_tables(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS follows (
          follower_id INTEGER NOT NULL,
          followed_id INTEGER NOT NULL,
          created_ts  INTEGER NOT NULL,
          PRIMARY KEY (follower_id, followed_id),
          FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (followed_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);
        CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);

        CREATE TABLE IF NOT EXISTS friend_requests (
          requester_id INTEGER NOT NULL,
          addressee_id INTEGER NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending',
          requested_ts INTEGER NOT NULL,
          responded_ts INTEGER,
          PRIMARY KEY (requester_id, addressee_id),
          FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (addressee_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_friendreq_addressee ON friend_requests(addressee_id);
        CREATE INDEX IF NOT EXISTS idx_friendreq_requester ON friend_requests(requester_id);
        """
    )


def follow(conn, follower_id: int, followed_id: int) -> None:
    if int(follower_id) == int(followed_id):
        raise ValueError("You can't follow yourself.")
    conn.execute(
        "INSERT OR IGNORE INTO follows(follower_id, followed_id, created_ts) VALUES(?,?,?)",
        (int(follower_id), int(followed_id), now_ts()),
    )


def unfollow(conn, follower_id: int, followed_id: int) -> None:
    conn.execute("DELETE FROM follows WHERE follower_id=? AND followed_id=?", (int(follower_id), int(followed_id)))


def is_following(conn, follower_id: int, followed_id: int) -> bool:
    row = conn.execute(
        "SELECT 1 FROM follows WHERE follower_id=? AND followed_id=?",
        (int(follower_id), int(followed_id)),
    ).fetchone()
    return row is not None


def follower_count(conn, user_id: int) -> int:
    row = conn.execute("SELECT COUNT(*) AS c FROM follows WHERE followed_id=?", (int(user_id),)).fetchone()
    return int(row["c"] if row else 0)


def following_count(conn, user_id: int) -> int:
    row = conn.execute("SELECT COUNT(*) AS c FROM follows WHERE follower_id=?", (int(user_id),)).fetchone()
    return int(row["c"] if row else 0)


def list_followers(conn, user_id: int, limit: int = 200):
    return conn.execute(
        """
        SELECT u.id, u.username, u.avatar_url
        FROM follows f
        JOIN users u ON u.id = f.follower_id
        WHERE f.followed_id=?
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
        WHERE f.follower_id=?
        ORDER BY f.created_ts DESC
        LIMIT ?
        """,
        (int(user_id), int(limit)),
    ).fetchall()


def send_friend_request(conn, requester_id: int, addressee_id: int) -> None:
    if int(requester_id) == int(addressee_id):
        raise ValueError("You can't friend yourself.")

    existing = conn.execute(
        "SELECT status FROM friend_requests WHERE requester_id=? AND addressee_id=?",
        (int(addressee_id), int(requester_id)),
    ).fetchone()
    if existing and existing["status"] == "pending":
        accept_friend_request(conn, addressee_id, requester_id)
        return

    conn.execute(
        """
        INSERT OR IGNORE INTO friend_requests(requester_id, addressee_id, status, requested_ts)
        VALUES(?, ?, 'pending', ?)
        """,
        (int(requester_id), int(addressee_id), now_ts()),
    )


def accept_friend_request(conn, requester_id: int, addressee_id: int) -> None:
    conn.execute(
        """
        UPDATE friend_requests
        SET status='accepted', responded_ts=?
        WHERE requester_id=? AND addressee_id=? AND status='pending'
        """,
        (now_ts(), int(requester_id), int(addressee_id)),
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
    conn.execute(
        """
        DELETE FROM friend_requests
        WHERE status='accepted'
          AND ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))
        """,
        (int(user_id), int(other_id), int(other_id), int(user_id)),
    )


def friends_status(conn, a_id: int, b_id: int):
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


def list_friend_activity(conn: sqlite3.Connection, viewer_id: int, limit: int = 10):
    return conn.execute(
        """
        WITH friend_ids AS (
          SELECT CASE
                   WHEN requester_id = ? THEN addressee_id
                   ELSE requester_id
                 END AS fid
          FROM friend_requests
          WHERE status='accepted'
            AND (requester_id=? OR addressee_id=?)
        ),
        review_feed AS (
          SELECT
            'review' AS kind,
            r.user_id AS actor_id,
            u.username AS actor_username,
            s.id AS show_id,
            s.year AS year,
            s.corps AS corps,
            s.title AS title,
            NULL AS rating_half,
            r.review_text AS review_text,
            r.ts AS ts
          FROM reviews r
          JOIN friend_ids f ON f.fid = r.user_id
          JOIN users u ON u.id = r.user_id
          JOIN shows s ON s.id = r.show_id
          WHERE TRIM(COALESCE(r.review_text,'')) <> ''
        ),
        rating_feed AS (
          SELECT
            'rating' AS kind,
            rt.user_id AS actor_id,
            u.username AS actor_username,
            s.id AS show_id,
            s.year AS year,
            s.corps AS corps,
            s.title AS title,
            rt.rating_half AS rating_half,
            NULL AS review_text,
            rt.ts AS ts
          FROM ratings rt
          JOIN friend_ids f ON f.fid = rt.user_id
          JOIN users u ON u.id = rt.user_id
          JOIN shows s ON s.id = rt.show_id
        )
        SELECT * FROM review_feed
        UNION ALL
        SELECT * FROM rating_feed
        ORDER BY ts DESC
        LIMIT ?;
        """,
        (int(viewer_id), int(viewer_id), int(viewer_id), int(limit)),
    ).fetchall()


# -------------------------
# Notifications
# -------------------------

def ensure_notifications_table(conn: sqlite3.Connection):
    conn.executescript(
        """
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
        """
    )


def add_notification(
    conn: sqlite3.Connection,
    user_id: int,
    kind: str,
    actor_user_id: int | None = None,
    show_id: int | None = None,
    review_user_id: int | None = None,
    vote: int | None = None,
):
    conn.execute(
        """
        INSERT INTO notifications(user_id, actor_user_id, kind, show_id, review_user_id, vote)
        VALUES(?, ?, ?, ?, ?, ?)
        """,
        (int(user_id), actor_user_id, kind, show_id, review_user_id, vote),
    )


def unread_notifications_count(conn: sqlite3.Connection, user_id: int) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS c FROM notifications WHERE user_id=? AND is_read=0",
        (int(user_id),),
    ).fetchone()
    return int(row["c"] if row else 0)


def list_unread_notifications(conn: sqlite3.Connection, user_id: int, limit: int = 30):
    return conn.execute(
        """
        SELECT id, kind, actor_user_id, show_id, review_user_id, vote, created_at, is_read
        FROM notifications
        WHERE user_id=? AND is_read=0
        ORDER BY id DESC
        LIMIT ?
        """,
        (int(user_id), int(limit)),
    ).fetchall()


def mark_all_notifications_read(conn: sqlite3.Connection, user_id: int):
    conn.execute("UPDATE notifications SET is_read=1 WHERE user_id=? AND is_read=0", (int(user_id),))


# -------------------------
# Leaderboards
# -------------------------

def list_top_shows_with_top_review(conn, limit: int = 25, mode: str = "top"):
    limit = int(limit)
    mode = (mode or "top").strip().lower()

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


def list_top_users_by_review_upvotes(conn, limit: int = 25):
    sql = """
    WITH review_vote_totals AS (
      SELECT
        r.user_id AS review_user_id,
        r.show_id AS show_id,
        r.review_text AS review_text,
        SUM(CASE WHEN rv.vote = 1 THEN 1 ELSE 0 END)  AS upvotes,
        SUM(CASE WHEN rv.vote = -1 THEN 1 ELSE 0 END) AS downvotes,
        SUM(CASE WHEN rv.vote = 1 THEN 1
                 WHEN rv.vote = -1 THEN -1
                 ELSE 0 END) AS net_score
      FROM reviews r
      LEFT JOIN review_votes rv
        ON rv.show_id = r.show_id
       AND rv.review_user_id = r.user_id
      WHERE TRIM(COALESCE(r.review_text, '')) <> ''
      GROUP BY r.user_id, r.show_id, r.review_text
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


# -------------------------
# Admin deletes
# -------------------------

def admin_delete_show(conn, show_id: int) -> None:
    sid = int(show_id)

    # children first (even though FK cascade exists, keep it safe)
    conn.execute("DELETE FROM notifications WHERE show_id=?", (sid,))
    conn.execute("DELETE FROM review_comments WHERE show_id=?", (sid,))
    conn.execute("DELETE FROM review_votes WHERE show_id=?", (sid,))
    conn.execute("DELETE FROM reviews WHERE show_id=?", (sid,))
    conn.execute("DELETE FROM ratings WHERE show_id=?", (sid,))
    conn.execute("DELETE FROM shows WHERE id=?", (sid,))


def admin_delete_review(conn, show_id: int, review_user_id: int):
    sid = int(show_id)
    ruid = int(review_user_id)
    conn.execute("DELETE FROM review_votes WHERE show_id=? AND review_user_id=?", (sid, ruid))
    conn.execute("DELETE FROM review_comments WHERE show_id=? AND review_user_id=?", (sid, ruid))
    conn.execute("DELETE FROM reviews WHERE show_id=? AND user_id=?", (sid, ruid))
