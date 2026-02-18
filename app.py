import os, re
import sqlite3
from functools import wraps
from typing import Optional, Tuple, List
from pathlib import Path
from flask import request, redirect, url_for, session, flash, abort
from werkzeug.utils import secure_filename
from flask import request
from flask import app, url_for
from flask import send_from_directory
from flask import Flask, render_template, request, redirect, url_for, session, flash, abort
from werkzeug.security import generate_password_hash, check_password_hash

import db as dbx

from pathlib import Path

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")

def get_conn():
    # timeout helps with brief lock contention
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL;")  # better concurrency than default
    return conn

import os, re
from flask import url_for

def slugify(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"&", "and", s)
    s = re.sub(r"[^a-z0-9]+", "_", s)   # spaces/punct -> _
    s = re.sub(r"_+", "_", s).strip("_")
    return s

def static_file_exists(rel_path: str) -> bool:
    # rel_path like "posters/blue_devils2014.png"
    abs_path = os.path.join(app.root_path, "static", rel_path)
    return os.path.isfile(abs_path)

def pfp_filename_for_username(username: str, ext: str) -> str:
    ext = ext.lower()
    if ext == ".jpeg":
        ext = ".jpg"
    key = slugify(username)
    return f"pfp_{key}{ext}"


def pfp_url_for_username(username: str) -> str | None:
    key = slugify(username)
    base = f"pfps/pfp_{key}"
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        rel = base + ext                          # rel like "pfps/pfp_will.png"
        abs_path = Path(app.root_path) / "static" / rel  # correct absolute path
        if abs_path.is_file():
            return url_for("static", filename=rel)
    return None

# Keep lowercase. Add/remove words as you want.
BAD_WORDS = {
    "fuck", "shit", "bitch", "asshole", "bastard", "cunt", "dick", "pussy",
    "faggot", "nigger", "slut", "whore", "douchebag", "motherfucker", "twat",
    "cock", "piss", "fucker", "shitter", "bitchass", "asshat", "bullshit",
    "chink", "cocks", "niggers", "faggots", "sluts", "whores", "douchebags",
    "motherfuckers", "pussylicker", "pussylicking", "pussylicked", "nigglet", "nigglets",
    "nigga", "niggas", "niglet", "niglets", "faggotry", "faggotry", "fag", "fags",
    "jiggaboo", "jiggaboos","spic", "spics", "gook", "gooks", "beaner", "beaners",
    "horseshit", "bullshit", "asswipe", "asswipes", "shithead", "shitheads", "dickhead", "dickheads",
    "dogshit", "cuntface", "cuntfaces", "pisshead", "pissheads", "twatface", "twatfaces", "twink", "twinks",
    # add more...
}

# ---- Persistent storage root (Railway Volume mount) ----
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))

# DB lives on the volume
DB_PATH = os.getenv("DB_PATH", str(DATA_DIR / "site.db"))

# Uploads live on the volume
UPLOADS_DIR = Path(os.getenv("UPLOADS_DIR", str(DATA_DIR / "uploads")))
POSTER_DIR  = UPLOADS_DIR / "posters"
PFP_DIR     = UPLOADS_DIR / "pfps"

POSTER_DIR.mkdir(parents=True, exist_ok=True)
PFP_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
MAX_UPLOAD_MB = 5

APP_SECRET = os.getenv("APP_SECRET", "dev-secret-change-me")


def _compile_bad_regex(words: set[str]) -> re.Pattern:
    # Whole-word match. If you want partial matches, remove \b boundaries.
    parts = sorted((re.escape(w) for w in words if w), key=len, reverse=True)
    if not parts:
        # never matches
        return re.compile(r"^\b$")
    return re.compile(r"\b(" + "|".join(parts) + r")\b", re.IGNORECASE)

_BAD_RE = _compile_bad_regex(BAD_WORDS)

def contains_profanity(text: str) -> bool:
    if not text:
        return False
    return _BAD_RE.search(text) is not None

def find_profanity_in_json(obj):
    """
    Returns a tuple (path, bad_fragment) if profanity is found, else (None, None).
    path is a string like $.comment or $.items[0].text
    """
    def _walk(x, path="$"):
        if isinstance(x, dict):
            for k, v in x.items():
                p, bad = _walk(v, f"{path}.{k}")
                if p:
                    return p, bad
        elif isinstance(x, list):
            for i, v in enumerate(x):
                p, bad = _walk(v, f"{path}[{i}]")
                if p:
                    return p, bad
        elif isinstance(x, str):
            m = _BAD_RE.search(x)
            if m:
                return path, m.group(0)
        return None, None

    return _walk(obj, "$")

# db.py

def list_friend_activity(conn: sqlite3.Connection, viewer_id: int, limit: int = 10):
    """
    Returns a unified feed of friends' recent ratings + reviews.
    """
    return conn.execute("""
    WITH friend_ids AS (
      SELECT CASE
               WHEN user_id_a = ? THEN user_id_b
               ELSE user_id_a
             END AS fid
      FROM friends
      WHERE user_id_a = ? OR user_id_b = ?
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
        r.text AS review_text,
        COALESCE(r.updated_at, r.created_at, datetime('now')) AS ts
      FROM reviews r
      JOIN friend_ids f ON f.fid = r.user_id
      JOIN users u ON u.id = r.user_id
      JOIN shows s ON s.id = r.show_id
      WHERE TRIM(COALESCE(r.text,'')) <> ''
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
        COALESCE(rt.updated_at, rt.created_at, datetime('now')) AS ts
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
    """, (viewer_id, viewer_id, viewer_id, int(limit))).fetchall()

def poster_url_for_show(corps: str, year: int) -> str | None:
    key = slugify(corps)

    # 1) Try year-specific poster first: posters/<corpsslug><year>.<ext>
    base_year = f"posters/{key}{int(year)}"
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        rel = base_year + ext
        abs_path = Path(app.root_path) / "static" / rel
        if abs_path.is_file():
            return url_for("static", filename=rel)

    # 2) Fallback: corps default poster: posters/<corpsslug>default.<ext>
    base_default = f"posters/{key}default"
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        rel = base_default + ext
        abs_path = Path(app.root_path) / "static" / rel
        if abs_path.is_file():
            return url_for("static", filename=rel)

    # 3) Optional final fallback: posters/default.<ext>
    base_global = "posters/default"
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        rel = base_global + ext
        abs_path = Path(app.root_path) / "static" / rel
        if abs_path.is_file():
            return url_for("static", filename=rel)

    return None


def poster_filename_for_show(corps: str, year: int, ext: str) -> str:
    ext = ext.lower()
    if ext == ".jpeg":
        ext = ".jpg"
    key = slugify(corps)
    return f"{key}{int(year)}{ext}"

def create_app() -> Flask:
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
    app.secret_key = APP_SECRET
    @app.before_request
    def profanity_guard():
        # Only enforce on requests that can change data
        if request.method not in ("POST", "PUT", "PATCH"):
            return None

        # OPTIONAL: allow admins to bypass (comment out if you want NO bypass)
        # u = current_user()
        # if u and int(u.get("is_admin", 0)) == 1:
        #     return None

        # 1) Scan query string params too (people can submit via ?q=...)
        for k, v in request.args.items():
            if isinstance(v, str) and contains_profanity(v):
                return _profanity_block(f"query param '{k}'", v)

        # 2) Scan form fields
        # request.form covers application/x-www-form-urlencoded and multipart/form-data
        for k, v in request.form.items():
            if isinstance(v, str) and contains_profanity(v):
                return _profanity_block(f"form field '{k}'", v)

        # 3) Scan JSON bodies
        if request.is_json:
            payload = request.get_json(silent=True)
            if payload is not None:
                path, bad = find_profanity_in_json(payload)
                if path:
                    return _profanity_block(f"json field {path}", bad)

        return None

    def _profanity_block(where: str, sample: str):
        """
        For normal browser form posts: flash + redirect back.
        For API requests: abort 400.
        """
        # crude API detection (tweak as needed)
        wants_json = (
            request.path.startswith("/api/")
            or request.accept_mimetypes.best == "application/json"
            or request.headers.get("X-Requested-With") == "XMLHttpRequest"
        )

        if wants_json:
            abort(400, description=f"Profanity not allowed in {where}.")

        flash("Profanity is not allowed. Please remove it and try again.", "error")
        return redirect(request.referrer or url_for("shows"))

    # Ensure DB exists
    if not os.path.exists(DB_PATH):
        dbx.init_db(DB_PATH, schema_path=os.path.join(os.path.dirname(__file__), "schema.sql"))


    def get_conn():
        conn = dbx.connect(DB_PATH)
        dbx.ensure_reviews_table(conn)
        dbx.ensure_profile_columns(conn)
        dbx.ensure_roles_tables(conn)
        dbx.ensure_review_votes_table(conn)
        dbx.ensure_review_comments_table(conn)  # NEW
        dbx.ensure_social_tables(conn)       # NEW
        dbx.ensure_notifications_table(conn)
        return conn

    def current_user():
        uid = session.get("uid")
        if not uid:
            return None
        conn = get_conn()
        try:
            return dbx.user_by_id(conn, int(uid))
        finally:
            conn.close()



    def login_required(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if not session.get("uid"):
                flash("Please log in to do that.", "warn")
                return redirect(url_for("login", next=request.path))
            return fn(*args, **kwargs)
        return wrapper

    def admin_required(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            u = current_user()
            if not u or int(u["is_admin"]) != 1:
                abort(403)
            return fn(*args, **kwargs)
        return wrapper

    @app.context_processor
    def inject_globals():
        u = current_user()

        notif_items = []
        notif_count = 0

        if u:
            conn = None
            try:
                conn = get_conn()
                notif_count = dbx.unread_notifications_count(conn, int(u["id"]))
                notif_items = [dict(x) for x in (dbx.list_unread_notifications(conn, int(u["id"]), limit=20) or [])]
            finally:
                if conn is not None:
                    conn.close()

        return {
            "me": u,
            "notif_count": notif_count,
            "notif_items": notif_items,
        }

    

    @app.get("/")
    def home():
        return redirect(url_for("shows"))

    # =========================================================
# STEP 4A — app.py — PATCH posters in shows listing
# =========================================================

    @app.get("/shows")
    def shows():
        sort = (request.args.get("sort") or "year_desc").strip()
        year_filter = (request.args.get("year") or "").strip()
        corps = (request.args.get("corps") or "").strip()

        conn = None
        try:
            conn = get_conn()

            # Your existing DB query here that returns show rows
            # Example:
            rows = dbx.list_shows(conn, sort=sort, year=year_filter, corps=corps)

            # PATCH poster_url from filesystem when missing
            rows2 = []
            for r in rows:
                d = dict(r)
                if not d.get("poster_url"):
                    d["poster_url"] = poster_url_for_show(d.get("corps", ""), d.get("year") or 0)
                rows2.append(d)
            
            friend_activity = []
            if session.get("uid"):
                friend_activity = [dict(x) for x in (dbx.list_friend_activity(conn, int(session["uid"]), limit=5) or [])]

                for a in friend_activity:
                    if not a.get("poster_url"):
                        a["poster_url"] = poster_url_for_show(a.get("corps", ""), a.get("year") or 0)

        finally:
            if conn is not None:
                conn.close()

        return render_template("shows.html",
                       rows=rows2,
                       sort=sort,
                       year=year_filter,
                       corps=corps,
                       friend_activity=friend_activity)

    # =========================================================
# STEP 4B — app.py — PATCH poster in show detail
# =========================================================
    @app.get("/show/<int:show_id>")
    def show_detail(show_id: int):
        viewer_uid = session.get("uid")

        conn = None
        try:
            conn = get_conn()

            row = dbx.get_show_by_id(conn, show_id)
            if not row:
                abort(404)

            row = dict(row)

            # ✅ Ensure show page always has a poster_url (DB value OR filesystem fallback)
            if not row.get("poster_url"):
                row["poster_url"] = poster_url_for_show(row.get("corps", ""), row.get("year") or 0)

            me = dbx.user_by_id(conn, viewer_uid) if viewer_uid else None
            my_rating = dbx.user_rating_for_show(conn, show_id, viewer_uid) if viewer_uid else None

            # Reviews (your existing helper already includes vote_score + my_vote)
            reviews = dbx.list_reviews_for_show(conn, show_id, viewer_user_id=viewer_uid, limit=30)

            # =========================================================
            # PATCH avatar_url for me + reviews
            # =========================================================
            if me:
                me = dict(me)
                if not me.get("avatar_url"):
                    me["avatar_url"] = pfp_url_for_username(me.get("username", ""))

            reviews2 = []
            for rv in reviews or []:
                d = dict(rv)
                if not d.get("avatar_url"):
                    d["avatar_url"] = pfp_url_for_username(d.get("username", ""))
                reviews2.append(d)

            # =========================================================
            # NEW: Fetch comments for this show and attach them to reviews
            # =========================================================
            comments = dbx.list_review_comments_for_show(conn, show_id, limit_total=500) or []

            # Group comments by review_user_id (the review author)
            comments_map = {}
            for c in comments:
                cd = dict(c)
                if not cd.get("commenter_avatar_url"):
                    cd["commenter_avatar_url"] = pfp_url_for_username(cd.get("commenter_username", ""))
                comments_map.setdefault(int(cd["review_user_id"]), []).append(cd)

            # Attach onto each review dict
            reviews3 = []
            for rv in reviews2:
                review_uid = int(rv.get("user_id", 0))
                rv["comments"] = comments_map.get(review_uid, [])
                rv["comment_count"] = len(rv["comments"])
                reviews3.append(rv)

            reviews = reviews3

        finally:
            if conn is not None:
                conn.close()

        return render_template(
            "show_detail.html",
            row=row,
            me=me,
            my_rating=my_rating,
            reviews=reviews,
        )


    @app.post("/show/<int:show_id>/comment/<int:comment_id>/delete")
    @login_required
    def delete_my_comment(show_id: int, comment_id: int):
        conn = None
        try:
            conn = get_conn()

            # optional: ensure show exists
            if not dbx.get_show_by_id(conn, show_id):
                abort(404)

            try:
                dbx.soft_delete_review_comment(conn, comment_id, requester_user_id=int(session["uid"]))
            except ValueError as e:
                flash(str(e), "error")
                return redirect(url_for("show_detail", show_id=show_id))

            conn.commit()
            flash("Comment deleted.", "ok")
        finally:
            if conn is not None:
                conn.close()

        return redirect(url_for("show_detail", show_id=show_id))


    @app.post("/admin/show/<int:show_id>/review/<int:review_user_id>/delete")
    @admin_required
    def admin_delete_review(show_id: int, review_user_id: int):
        conn = None
        try:
            conn = get_conn()

            # optional: ensure show exists
            if not dbx.get_show_by_id(conn, show_id):
                abort(404)

            dbx.admin_delete_review(conn, show_id, review_user_id)
            conn.commit()
            flash("Review deleted.", "ok")
        finally:
            if conn is not None:
                conn.close()

        return redirect(url_for("show_detail", show_id=show_id))


    @app.post("/admin/show/<int:show_id>/comment/<int:comment_id>/delete")
    @admin_required
    def admin_delete_comment(show_id: int, comment_id: int):
        conn = None
        try:
            conn = get_conn()

            # Use your existing helper if you added it earlier (supports admin flag)
            try:
                dbx.delete_review_comment(conn, comment_id, requester_user_id=int(session["uid"]), is_admin=True)
            except Exception:
                # Fallback: direct delete if you don't have delete_review_comment()
                conn.execute("DELETE FROM review_comments WHERE id=?", (int(comment_id),))

            conn.commit()
            flash("Comment deleted.", "ok")
        finally:
            if conn is not None:
                conn.close()

        return redirect(url_for("show_detail", show_id=show_id))

    @app.post("/show/<int:show_id>/review/<int:review_user_id>/comment")
    @login_required
    def add_review_comment(show_id: int, review_user_id: int):
        text = (request.form.get("comment_text") or "").strip()
        commenter_id = int(session["uid"])

        conn = None
        try:
            conn = get_conn()

            # Validate show exists
            if not dbx.get_show_by_id(conn, show_id):
                abort(404)

            # Optional: stop empty comments in db.py too; but we also validate here
            try:
                dbx.add_review_comment(conn, show_id, review_user_id, commenter_id, text)
            except ValueError as e:
                flash(str(e), "error")
                return redirect(url_for("show_detail", show_id=show_id))

            # Optional notification for the review author
            if commenter_id != int(review_user_id):
                try:
                    dbx.add_notification(
                        conn,
                        user_id=int(review_user_id),
                        kind="review_comment",
                        actor_user_id=commenter_id,
                        show_id=int(show_id),
                        review_user_id=int(review_user_id),
                    )
                except Exception:
                    # If your notifications system doesn't support this kind, ignore silently
                    pass

            conn.commit()

        finally:
            if conn is not None:
                conn.close()

        return redirect(url_for("show_detail", show_id=show_id))


    @app.post("/me/upload_pfp")
    @login_required
    def upload_my_pfp():
        uid = int(session.get("uid"))

        if "pfp_file" not in request.files:
            flash("Upload failed: form did not send a file. Make sure your form uses enctype='multipart/form-data'.", "error")
            return redirect(url_for("me_profile"))

        file = request.files.get("pfp_file")
        if not file or not file.filename:
            flash("No file selected.", "error")
            return redirect(url_for("me_profile"))

        filename = secure_filename(file.filename)
        ext = os.path.splitext(filename)[1].lower()

        if ext not in ALLOWED_IMAGE_EXTS:
            flash("Profile picture must be PNG, JPG, JPEG, or WEBP.", "error")
            return redirect(url_for("me_profile"))

        conn = None
        try:
            conn = get_conn()
            me = dbx.user_by_id(conn, uid)
            if not me:
                abort(404)
            me = dict(me)

            out_name = pfp_filename_for_username(me.get("username", ""), ext)
            out_path = PFP_DIR / out_name

            file.save(out_path)

            avatar_url = url_for("static", filename=f"pfps/{out_name}")
            dbx.update_user_avatar_url(conn, uid, avatar_url)
            conn.commit()

            flash("Profile picture updated.", "ok")
        except Exception as e:
            flash(f"Upload failed: {e}", "error")
        finally:
            if conn is not None:
                conn.close()

        return redirect(url_for("me_profile"))

    @app.post("/show/<int:show_id>/rate")
    @login_required
    def rate_show(show_id: int):
        rating_half = (request.form.get("rating_half") or "").strip()

        if not rating_half.isdigit():
            flash("Rating must be in half-star steps.", "error")
            return redirect(url_for("show_detail", show_id=show_id))

        rh = int(rating_half)
        if rh < 0 or rh > 10:
            flash("Rating must be between 0 and 5 stars (half steps).", "error")
            return redirect(url_for("show_detail", show_id=show_id))

        conn = get_conn()
        try:
            if not dbx.get_show_by_id(conn, show_id):
                abort(404)
            dbx.upsert_rating(conn, show_id, int(session["uid"]), rh)
        finally:
            conn.close()

        flash("Saved your rating.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))

    @app.post("/show/<int:show_id>/unrate")
    @login_required
    def unrate_show(show_id: int):
        conn = get_conn()
        try:
            dbx.delete_rating(conn, show_id, int(session["uid"]))
        finally:
            conn.close()
        flash("Removed your rating.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))

    @app.get("/register")
    def register():
        return render_template("auth_register.html")

    @app.post("/register")
    def register_post():
        username = (request.form.get("username") or "").strip()
        password = (request.form.get("password") or "").strip()

        if len(username) < 3:
            flash("Username must be at least 3 characters.", "error")
            return redirect(url_for("register"))
        if len(password) < 6:
            flash("Password must be at least 6 characters.", "error")
            return redirect(url_for("register"))

        conn = get_conn()
        try:
            if dbx.user_by_username(conn, username):
                flash("That username is taken.", "error")
                return redirect(url_for("register"))

            make_admin = dbx.is_first_user(conn)  # first account becomes admin
            uid = dbx.create_user(conn, username, generate_password_hash(password), make_admin=make_admin)
        finally:
            conn.close()

        session["uid"] = uid
        flash("Account created. You're logged in.", "ok")
        if make_admin:
            flash("First user created: you are admin (can mass add shows).", "ok")
        return redirect(url_for("shows"))

    @app.get("/login")
    def login():
        return render_template("auth_login.html", next=request.args.get("next"))

    @app.post("/login")
    def login_post():
        username = (request.form.get("username") or "").strip()
        password = (request.form.get("password") or "").strip()
        nxt = (request.form.get("next") or "").strip()

        conn = get_conn()
        try:
            u = dbx.user_by_username(conn, username)
        finally:
            conn.close()

        if not u or not check_password_hash(u["pass_hash"], password):
            flash("Invalid username/password.", "error")
            return redirect(url_for("login"))

        session["uid"] = int(u["id"])
        flash("Logged in.", "ok")
        return redirect(nxt or url_for("shows"))

    @app.get("/logout")
    def logout():
        session.pop("uid", None)
        flash("Logged out.", "ok")
        return redirect(url_for("shows"))

    @app.get("/admin/bulk_add")
    @admin_required
    def bulk_add():
        return render_template("bulk_add.html")

    def parse_bulk_lines(text: str):
        """
        Accepts lines like:
        2017, Blue Devils, Metamorph
        2016|Carolina Crown|Relentless
        2017, Blue Devils, Metamorph, https://.../image.jpg
        2017|Blue Devils|Metamorph|https://.../image.jpg

        Fields:
        year, corps, title, [optional poster_url]
        """
        items = []
        errors = []

        for i, raw in enumerate((text or "").splitlines(), start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue

            if "|" in line:
                parts = [p.strip() for p in line.split("|")]
            else:
                parts = [p.strip() for p in line.split(",")]

            if len(parts) not in (3, 4):
                errors.append(f"Line {i}: expected 3 or 4 fields (year, corps, title, [poster_url]). Got: {raw}")
                continue

            y, c, t = parts[0], parts[1], parts[2]
            poster = parts[3] if len(parts) == 4 else None

            if not y.isdigit():
                errors.append(f"Line {i}: year must be a number. Got: {y}")
                continue

            items.append((int(y), c, t, poster))

        return items, errors

    @app.post("/admin/bulk_add")
    @admin_required
    def bulk_add_post():
        text = request.form.get("bulk_text") or ""
        items, errors = parse_bulk_lines(text)
        if errors:
            for e in errors[:10]:
                flash(e, "error")
            if len(errors) > 10:
                flash(f"...and {len(errors)-10} more errors.", "error")
            return redirect(url_for("bulk_add"))

        conn = get_conn()
        inserted = 0
        dupes = 0
        other_bad = 0
        try:
            for (y, c, t, poster) in items:
                ok, _sid, msg = dbx.add_show(conn, y, c, t, poster_url=poster)
                if ok:
                    inserted += 1
                else:
                    if msg == "Duplicate":
                        dupes += 1
                    else:
                        other_bad += 1
        finally:
            conn.close()

        flash(f"Bulk add done. Inserted: {inserted}. Duplicates skipped: {dupes}. Other issues: {other_bad}.", "ok")
        return redirect(url_for("shows"))


    @app.get("/admin/show/<int:show_id>/edit")
    @admin_required
    def admin_edit_show(show_id: int):
        conn = get_conn()
        try:
            s = dbx.get_show_by_id(conn, show_id)
            if not s:
                abort(404)
            s = dict(s)
        finally:
            conn.close()

        return render_template("admin_edit_show.html", s=s)


    @app.post("/admin/show/<int:show_id>/edit")
    @admin_required
    def admin_edit_show_post(show_id: int):
        title = (request.form.get("title") or "").strip()
        corps = (request.form.get("corps") or "").strip()
        year  = (request.form.get("year") or "").strip()
        poster_url = (request.form.get("poster_url") or "").strip()

        if not year.isdigit():
            flash("Year must be a number.", "error")
            return redirect(url_for("admin_edit_show", show_id=show_id))

        conn = get_conn()
        try:
            if not dbx.get_show_by_id(conn, show_id):
                abort(404)
            try:
                dbx.update_show(conn, show_id, int(year), corps, title, poster_url=poster_url)
            except ValueError as e:
                flash(str(e), "error")
                return redirect(url_for("admin_edit_show", show_id=show_id))
        finally:
            conn.close()

        flash("Show updated.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))
    
    @app.post("/admin/show/<int:show_id>/upload_poster")
    @admin_required
    def admin_upload_show_poster(show_id: int):
        file = request.files.get("poster_file")
        if not file or not file.filename:
            flash("No file selected.", "error")
            return redirect(url_for("admin_edit_show", show_id=show_id))

        filename = secure_filename(file.filename)
        ext = os.path.splitext(filename)[1].lower()

        if ext not in ALLOWED_IMAGE_EXTS:
            flash("Poster must be PNG, JPG, JPEG, or WEBP.", "error")
            return redirect(url_for("admin_edit_show", show_id=show_id))

        conn = None
        try:
            conn = get_conn()
            row = dbx.get_show_by_id(conn, show_id)
            if not row:
                abort(404)
            row = dict(row)

            corps = row.get("corps", "")
            year = row.get("year") or 0
            out_name = poster_filename_for_show(corps, year, ext)
            out_path = POSTER_DIR / out_name

            # Save file
            file.save(out_path)

            # Save poster_url as a local static URL (this will work in templates)
            poster_url = url_for("static", filename=f"posters/{out_name}")

            # Update DB (use your actual db function name)
            dbx.update_show_poster_url(conn, show_id, poster_url)
            conn.commit()

            flash("Poster uploaded.", "ok")
        finally:
            if conn is not None:
                conn.close()

        return redirect(url_for("admin_edit_show", show_id=show_id))

    @app.route("/u/<username>/ratings")
    def user_all_ratings(username):
        sort = (request.args.get("sort") or "high").strip().lower()
        q = (request.args.get("q") or "").strip()

        conn = get_conn()

        me = current_user()  # your function takes 0 args
        profile_user = dbx.user_by_username(conn, username)
        if not profile_user:
            abort(404)

        rows = dbx.list_all_ratings_for_user(conn, profile_user["id"], sort=sort, corps_q=q)

        # ✅ IMPORTANT: normalize sqlite3.Row -> dict for templates
        if me is not None:
            me = dict(me)
        profile_user = dict(profile_user)
        rows = [dict(r) for r in (rows or [])]

        return render_template(
            "user_all_ratings.html",
            me=me,
            profile_user=profile_user,
            sort=sort,
            q=q,
            rows=rows
        )




    @app.post("/show/<int:show_id>/review")
    @login_required
    def review_show(show_id: int):
        text = (request.form.get("review_text") or "").strip()

        conn = None
        try:
            conn = get_conn()
            if not dbx.show_detail(conn, show_id):
                abort(404)
            try:
                dbx.upsert_review(conn, show_id, int(session["uid"]), text)
            except ValueError as e:
                flash(str(e), "error")
                return redirect(url_for("show_detail", show_id=show_id))
        finally:
            if conn is not None:
                conn.close()

        flash("Saved your review.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))


    @app.post("/show/<int:show_id>/review/delete")
    @login_required
    def delete_my_review(show_id: int):
        conn = None
        try:
            conn = get_conn()
            dbx.delete_review(conn, show_id, int(session["uid"]))
        finally:
            if conn is not None:
                conn.close()

        flash("Deleted your review.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))

    from flask import send_from_directory  # make sure this import exists at top

    UPLOADS_DIR = BASE_DIR / "uploads"
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    
    @app.get("/uploads/<path:filename>")
    def uploads(filename):
        return send_from_directory(str(UPLOADS_DIR), filename)

    
    @app.get("/admin/roles")
    @admin_required
    def admin_roles():
        conn = None
        try:
            conn = get_conn()
            roles = dbx.list_roles(conn)
        finally:
            if conn is not None:
                conn.close()
        return render_template("admin_roles.html", roles=roles)


    @app.post("/admin/roles")
    @admin_required
    def admin_roles_post():
        name = (request.form.get("name") or "").strip()
        color = (request.form.get("color") or "").strip()

        conn = None
        try:
            conn = get_conn()
            try:
                dbx.create_role(conn, name, color)
            except ValueError as e:
                flash(str(e), "error")
                return redirect(url_for("admin_roles"))
            except sqlite3.IntegrityError:
                flash("Role name already exists.", "error")
                return redirect(url_for("admin_roles"))
        finally:
            if conn is not None:
                conn.close()

        flash("Role created.", "ok")
        return redirect(url_for("admin_roles"))


    @app.post("/admin/roles/<int:role_id>/delete")
    @admin_required
    def admin_delete_role(role_id: int):
        conn = None
        try:
            conn = get_conn()
            dbx.delete_role(conn, role_id)
        finally:
            if conn is not None:
                conn.close()
        flash("Role deleted.", "ok")
        return redirect(url_for("admin_roles"))


    @app.get("/admin/user/<username>/roles")
    @admin_required
    def admin_user_roles(username: str):
        conn = None
        try:
            conn = get_conn()
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)

            roles = dbx.list_roles(conn)
            user_roles = dbx.roles_for_user(conn, int(u["id"]))
            user_role_ids = {int(r["id"]) for r in user_roles}

        finally:
            if conn is not None:
                conn.close()

        return render_template(
            "admin_user_roles.html",
            u=u,
            roles=roles,
            user_roles=user_roles,
            user_role_ids=user_role_ids,
        )



    @app.post("/admin/user/<username>/roles/assign")
    @admin_required
    def admin_user_roles_assign(username: str):
        role_id = int(request.form.get("role_id") or "0")
        conn = None
        try:
            conn = get_conn()
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.assign_role_to_user(conn, int(u["id"]), role_id, assigned_by_user_id=int(session["uid"]))
        finally:
            if conn is not None:
                conn.close()
        flash("Role assigned.", "ok")
        return redirect(url_for("admin_user_roles", username=username))


    @app.post("/admin/user/<username>/roles/remove")
    @admin_required
    def admin_user_roles_remove(username: str):
        role_id = int(request.form.get("role_id") or "0")
        conn = None
        try:
            conn = get_conn()
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.remove_role_from_user(conn, int(u["id"]), role_id)
        finally:
            if conn is not None:
                conn.close()
        flash("Role removed.", "ok")
        return redirect(url_for("admin_user_roles", username=username))





    @app.get("/me")
    @login_required
    def me_profile():
        conn = None
        u = None
        recent_ratings = []
        recent_reviews = []
        roles_for_me = []

        try:
            conn = get_conn()
            uid = int(session["uid"])

            u = dbx.user_by_id(conn, uid)
            if not u:
                abort(404)
            u = dict(u)

            avg, cnt = dbx.user_avg_rating(conn, uid)
            u["avg_rating"] = avg
            u["avg_rating_cnt"] = cnt

            viewer_id = int(session["uid"]) if session.get("uid") else None

            u["followers_count"] = dbx.follower_count(conn, int(u["id"]))
            u["following_count"] = dbx.following_count(conn, int(u["id"]))

            if viewer_id:
                u["viewer_is_following"] = dbx.is_following(conn, viewer_id, int(u["id"]))
                u["viewer_friend_status"] = dbx.friends_status(conn, viewer_id, int(u["id"]))
            else:
                u["viewer_is_following"] = False
                u["viewer_friend_status"] = "none"

            # ✅ roles list for this user
            roles_for_me = [dict(x) for x in (dbx.roles_for_user(conn, uid) or [])]

            recent_ratings = [dict(x) for x in dbx.list_recent_ratings_for_user(conn, uid, limit=8)]
            recent_reviews = [dict(x) for x in dbx.list_recent_reviews_for_user(conn, uid, limit=8)]

            for rr in recent_ratings:
                if not rr.get("poster_url"):
                    rr["poster_url"] = poster_url_for_show(rr.get("corps", ""), rr.get("year") or 0)

            for rv in recent_reviews:
                if not rv.get("poster_url"):
                    rv["poster_url"] = poster_url_for_show(rv.get("corps", ""), rv.get("year") or 0)

            if not u.get("avatar_url"):
                u["avatar_url"] = pfp_url_for_username(u.get("username", ""))

        finally:
            if conn is not None:
                conn.close()

        return render_template(
            "profile.html",
            profile_user=u,
            user_roles=roles_for_me,
            recent_ratings=recent_ratings,
            recent_reviews=recent_reviews,
            me=u,
            is_me=True,
        )

    @app.get("/u/<username>")
    def user_profile(username: str):
        conn = None
        profile = None
        recent_ratings = []
        recent_reviews = []
        roles_for_user = []
        me = None

        
        try:
            conn = get_conn()

            profile = dbx.user_by_username(conn, username)
            if not profile:
                abort(404)
            profile = dict(profile)

            avg, cnt = dbx.user_avg_rating(conn, int(profile["id"]))
            profile["avg_rating"] = avg
            profile["avg_rating_cnt"] = cnt


            viewer_id = int(session["uid"]) if session.get("uid") else None

            profile["followers_count"] = dbx.follower_count(conn, int(profile["id"]))
            profile["following_count"] = dbx.following_count(conn, int(profile["id"]))

            if viewer_id:
                profile["viewer_is_following"] = dbx.is_following(conn, viewer_id, int(profile["id"]))
                profile["viewer_friend_status"] = dbx.friends_status(conn, viewer_id, int(profile["id"]))
            else:
                profile["viewer_is_following"] = False
                profile["viewer_friend_status"] = "none"



            roles_for_user = [dict(x) for x in (dbx.roles_for_user(conn, int(profile["id"])) or [])]

            recent_ratings = [dict(x) for x in dbx.list_recent_ratings_for_user(conn, int(profile["id"]), limit=7)]
            recent_reviews = [dict(x) for x in dbx.list_recent_reviews_for_user(conn, int(profile["id"]), limit=8)]

            for rr in recent_ratings:
                if not rr.get("poster_url"):
                    rr["poster_url"] = poster_url_for_show(rr.get("corps", ""), rr.get("year") or 0)

            for rv in recent_reviews:
                if not rv.get("poster_url"):
                    rv["poster_url"] = poster_url_for_show(rv.get("corps", ""), rv.get("year") or 0)

            if not profile.get("avatar_url"):
                profile["avatar_url"] = pfp_url_for_username(profile.get("username", ""))

            if session.get("uid"):
                me_row = dbx.user_by_id(conn, int(session["uid"]))
                me = dict(me_row) if me_row else None

                

        finally:
            if conn is not None:
                conn.close()

        is_me = bool(me and me.get("username") == profile.get("username"))

        return render_template(
            "profile.html",
            profile_user=profile,
            user_roles=roles_for_user,
            recent_ratings=recent_ratings,
            recent_reviews=recent_reviews,
            me=me,
            is_me=is_me,
        )
    

    @app.get("/me/customize")
    @login_required
    def customize_profile():
        conn = None
        try:
            conn = get_conn()
            u = dbx.user_by_id(conn, int(session["uid"]))
            if not u:
                abort(404)
        finally:
            if conn is not None:
                conn.close()

        return render_template("profile_customize.html", u=u)


    @app.post("/me/customize")
    @login_required
    def customize_profile_post():
        avatar_url  = (request.form.get("avatar_url") or "").strip()
        banner_url  = (request.form.get("banner_url") or "").strip()
        theme_color = (request.form.get("theme_color") or "").strip()

        conn = None
        try:
            conn = get_conn()
            dbx.update_user_profile_style(conn, int(session["uid"]), avatar_url, banner_url, theme_color)
        finally:
            if conn is not None:
                conn.close()

        flash("Profile updated.", "ok")
        return redirect(url_for("me_profile"))




    # =========================================================
# Admin: list users so admin can assign roles
# =========================================================
    @app.get("/admin/users")
    @admin_required
    def admin_users():
        conn = None
        try:
            conn = get_conn()
            users = dbx.list_users(conn)  # you need this helper (below)
            users = [dict(u) for u in users]
        finally:
            if conn is not None:
                conn.close()

        return render_template("admin_users.html", users=users)

    @app.get("/admin/roles/<int:role_id>/edit")
    @admin_required
    def admin_edit_role(role_id: int):
        conn = None
        try:
            conn = get_conn()
            r = dbx.role_by_id(conn, role_id)
            if not r:
                abort(404)
        finally:
            if conn is not None:
                conn.close()

        return render_template("admin_role_edit.html", r=r)


    @app.post("/admin/roles/<int:role_id>/edit")
    @admin_required
    def admin_edit_role_post(role_id: int):
        name = (request.form.get("name") or "").strip()
        color = (request.form.get("color") or "").strip()

        conn = None
        try:
            conn = get_conn()
            try:
                dbx.update_role(conn, role_id, name, color)
            except ValueError as e:
                flash(str(e), "error")
                return redirect(url_for("admin_edit_role", role_id=role_id))
            except sqlite3.IntegrityError:
                flash("That role name already exists.", "error")
                return redirect(url_for("admin_edit_role", role_id=role_id))
        finally:
            if conn is not None:
                conn.close()

        flash("Role updated.", "ok")
        return redirect(url_for("admin_roles"))


    @app.post("/show/<int:show_id>/review/<int:review_user_id>/vote")
    @login_required
    def vote_review(show_id: int, review_user_id: int):
        vote = int(request.form.get("vote") or "0")
        if vote not in (1, -1):
            abort(400)

        voter_user_id = int(session["uid"])

        # Optional: prevent voting on your own review
        if voter_user_id == int(review_user_id):
            flash("You can't vote on your own review.", "error")
            return redirect(url_for("show_detail", show_id=show_id))

        conn = None
        try:
            conn = get_conn()
            dbx.set_review_vote(conn, show_id, review_user_id, voter_user_id, vote)
            if vote == 1:
                dbx.add_notification(
                conn,
                user_id=int(review_user_id),      # recipient = review author
                kind="review_upvote",
                actor_user_id=voter_user_id,
                show_id=int(show_id),
                review_user_id=int(review_user_id),
                vote=1
        )
            conn.commit()
        finally:
            if conn is not None:
                conn.close()

        return redirect(url_for("show_detail", show_id=show_id))



    @app.get("/top")
    def top_shows():
        mode = (request.args.get("mode") or "top").strip().lower()
        if mode not in ("top", "bottom"):
            mode = "top"

        conn = None
        try:
            conn = get_conn()

            rows = dbx.list_top_shows_with_top_review(conn, limit=50, mode=mode)

            # ---- PATCH: ensure poster + avatar URLs exist for template ----
            rows2 = []
            for r in rows or []:
                d = dict(r)

                # Posters: prefer DB URL, else filesystem fallback
                if not d.get("poster_url"):
                    d["poster_url"] = poster_url_for_show(d.get("corps", ""), d.get("year") or 0)

                # Top review avatar: prefer DB URL, else filesystem fallback by username
                if d.get("top_review_username") and not d.get("top_review_avatar_url"):
                    d["top_review_avatar_url"] = pfp_url_for_username(d.get("top_review_username", ""))

                rows2.append(d)

            rows = rows2

        finally:
            if conn is not None:
                conn.close()

        return render_template("top_shows.html", rows=rows, mode=mode)
    


    @app.get("/top_users")
    def top_users():
        conn = None
        try:
            conn = get_conn()
            rows = dbx.list_top_users_by_review_upvotes(conn, limit=25)

            rows2 = []
            for r in rows or []:
                d = dict(r)

                # Ensure avatar URL exists (DB value OR filesystem fallback)
                if not d.get("avatar_url"):
                    d["avatar_url"] = pfp_url_for_username(d.get("username", ""))

                # Ensure poster URL for their displayed "top review" show (DB OR filesystem fallback)
                if d.get("top_show_id") and not d.get("top_poster_url"):
                    d["top_poster_url"] = poster_url_for_show(d.get("top_corps", ""), d.get("top_year") or 0)

                rows2.append(d)

            rows = rows2

        finally:
            if conn is not None:
                conn.close()

        return render_template("top_users.html", rows=rows)




    # =========================================================
# SOCIAL ROUTES — follow + friends
# =========================================================

    @app.post("/u/<username>/follow")
    @login_required
    def follow_user(username: str):
        conn = None
        try:
            conn = get_conn()
            me_id = int(session["uid"])
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.follow(conn, me_id, int(u["id"]))
            # notify them that I followed them
            dbx.add_notification(
                conn,
                user_id=int(u["id"]),                 # recipient = them
                kind="follow",
                actor_user_id=me_id                   # actor = me
            )
            conn.commit()
        finally:
            if conn is not None:
                conn.close()
        return redirect(url_for("user_profile", username=username))


    @app.post("/u/<username>/unfollow")
    @login_required
    def unfollow_user(username: str):
        conn = None
        try:
            conn = get_conn()
            me_id = int(session["uid"])
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.unfollow(conn, me_id, int(u["id"]))
            conn.commit()
        finally:
            if conn is not None:
                conn.close()
        return redirect(url_for("user_profile", username=username))


    @app.get("/u/<username>/followers")
    def user_followers(username: str):
        conn = None
        try:
            conn = get_conn()
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            u = dict(u)

            
            rows = [dict(x) for x in dbx.list_followers(conn, int(u["id"]), limit=500)]
            return render_template("followers.html", profile_user=u, rows=rows)
        finally:
            if conn is not None:
                conn.close()


    @app.get("/u/<username>/following")
    def user_following(username: str):
        conn = None
        try:
            conn = get_conn()
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            u = dict(u)
            rows = [dict(x) for x in dbx.list_following(conn, int(u["id"]), limit=500)]
            return render_template("following.html", profile_user=u, rows=rows)
        finally:
            if conn is not None:
                conn.close()


    @app.get("/me/friends")
    @login_required
    def my_friends():
        conn = None
        try:
            conn = get_conn()
            me_id = int(session["uid"])
            me = dbx.user_by_id(conn, me_id)
            me = dict(me) if me else None

            friends = [dict(x) for x in dbx.list_friends(conn, me_id, limit=500)]
            incoming = [dict(x) for x in dbx.list_incoming_friend_requests(conn, me_id, limit=200)]

            return render_template("friends.html", me=me, friends=friends, incoming=incoming)
        finally:
            if conn is not None:
                conn.close()


    @app.post("/u/<username>/friend/request")
    @login_required
    def friend_request(username: str):
        conn = None
        try:
            conn = get_conn()
            me_id = int(session["uid"])
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.send_friend_request(conn, me_id, int(u["id"]))
            dbx.add_notification(conn, user_id=int(u["id"]), kind="friend_request", actor_user_id=me_id)
            conn.commit()
        finally:
            if conn is not None:
                conn.close()
        return redirect(url_for("user_profile", username=username))




    @app.post("/u/<username>/friend/accept")
    @login_required
    def friend_accept(username: str):
        conn = None
        try:
            conn = get_conn()
            me_id = int(session["uid"])
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            # requester = them, addressee = me
            dbx.accept_friend_request(conn, int(u["id"]), me_id)
            conn.commit()
        finally:
            if conn is not None:
                conn.close()
        return redirect(url_for("my_friends"))


    @app.post("/u/<username>/friend/decline")
    @login_required
    def friend_decline(username: str):
        conn = None
        try:
            conn = get_conn()
            me_id = int(session["uid"])
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.decline_friend_request(conn, int(u["id"]), me_id)
            conn.commit()
        finally:
            if conn is not None:
                conn.close()
        return redirect(url_for("my_friends"))


    @app.post("/u/<username>/friend/remove")
    @login_required
    def friend_remove(username: str):
        conn = None
        try:
            conn = get_conn()
            me_id = int(session["uid"])
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.remove_friend(conn, me_id, int(u["id"]))
            conn.commit()
        finally:
            if conn is not None:
                conn.close()
        return redirect(url_for("user_profile", username=username))

    @app.post("/me/notifications/read")
    @login_required
    def notifications_mark_read():
        uid = int(session["uid"])
        conn = None
        try:
            conn = get_conn()
            dbx.mark_all_notifications_read(conn, uid)
            conn.commit()
        finally:
            if conn is not None:
                conn.close()

        # optional flash; comment out if you want it silent
        # flash("Notifications cleared.", "ok")

        # Go back to the page you were on (or shows)
        return redirect(request.referrer or url_for("shows"))
    

    @app.post("/admin/show/<int:show_id>/delete")
    @admin_required
    def admin_delete_show(show_id: int):
        conn = None
        try:
            conn = get_conn()

            s = dbx.get_show_by_id(conn, show_id)
            if not s:
                abort(404)
            s = dict(s)

            # Optional: if the poster is a LOCAL /static file, delete it too
            poster_url = (s.get("poster_url") or "").strip()
            if poster_url and "/static/" in poster_url:
                try:
                    rel = poster_url.split("/static/", 1)[1]  # e.g. "posters/bluedevils2014.webp"
                    abs_path = Path(app.root_path) / "static" / rel
                    if abs_path.is_file():
                        abs_path.unlink()
                except Exception:
                    # Don't block deletion if file removal fails
                    pass

            # HARD delete show + dependent data
            dbx.admin_delete_show(conn, int(show_id))
            conn.commit()

            flash("Show deleted permanently.", "ok")
        finally:
            if conn is not None:
                conn.close()

        return redirect(url_for("shows"))


    @app.post("/me/change_username")
    @login_required
    def change_username():
        uid = int(session["uid"])
        new_username = (request.form.get("new_username") or "").strip()
        current_password = (request.form.get("current_password") or "").strip()

        if not USERNAME_RE.match(new_username):
            flash("Username must be 3–20 chars and only letters, numbers, underscore.", "error")
            return redirect(url_for("me_profile"))

        if not current_password:
            flash("Enter your current password to change your username.", "error")
            return redirect(url_for("me_profile"))

        conn = None
        try:
            conn = get_conn()
            me = dbx.user_by_id(conn, uid)
            if not me:
                abort(404)
            me = dict(me)

            # verify current password against whichever column exists
            pass_col = dbx.users_password_col(conn)
            stored_hash = me.get(pass_col)
            if not stored_hash or not check_password_hash(stored_hash, current_password):
                flash("Current password is incorrect.", "error")
                return redirect(url_for("me_profile"))

            # unchanged?
            if me.get("username", "").lower() == new_username.lower():
                flash("That is already your username.", "warn")
                return redirect(url_for("me_profile"))

            # unique?
            if dbx.user_by_username(conn, new_username):
                flash("That username is already taken.", "error")
                return redirect(url_for("me_profile"))

            dbx.update_user_username(conn, uid, new_username)
            conn.commit()

            flash("Username updated.", "ok")
            return redirect(url_for("me_profile"))

        finally:
            if conn is not None:
                conn.close()


    @app.post("/me/change_password")
    @login_required
    def change_password():
        uid = int(session["uid"])
        current_password = (request.form.get("current_password") or "").strip()
        new_password = (request.form.get("new_password") or "").strip()
        new_password2 = (request.form.get("new_password2") or "").strip()

        if not current_password:
            flash("Enter your current password.", "error")
            return redirect(url_for("me_profile"))

        if len(new_password) < 6:
            flash("New password must be at least 6 characters.", "error")
            return redirect(url_for("me_profile"))

        if new_password != new_password2:
            flash("New passwords do not match.", "error")
            return redirect(url_for("me_profile"))

        conn = None
        try:
            conn = get_conn()
            me = dbx.user_by_id(conn, uid)
            if not me:
                abort(404)
            me = dict(me)

            pass_col = dbx.users_password_col(conn)
            stored_hash = me.get(pass_col)
            if not stored_hash or not check_password_hash(stored_hash, current_password):
                flash("Current password is incorrect.", "error")
                return redirect(url_for("me_profile"))

            dbx.update_user_password_hash(conn, uid, generate_password_hash(new_password))
            conn.commit()

            flash("Password updated.", "ok")
            return redirect(url_for("me_profile"))

        finally:
            if conn is not None:
                conn.close()





    @app.errorhandler(403)
    def forbidden(_e):
        return render_template("base.html", body="Forbidden"), 403

    return app

from flask import Flask

app = create_app()





if __name__ == "__main__":
    # Local dev only
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=True)

