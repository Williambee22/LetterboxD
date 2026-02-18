# app.py — production-ready single-file Flask entrypoint (Railway / Render / Fly / etc.)
# Key fixes:
# - No url_for() or app usage at import-time (prevents gunicorn boot crashes)
# - DB schema initialized on EVERY boot (idempotent)
# - Persistent DB on volume via DATA_DIR/DB_PATH
# - Uploads served via /uploads/<path:filename> from persistent UPLOADS_DIR
# - Posters fallback: <corps><year> -> <corps>default -> default
# - Admin hard-delete show route included

import os, re, sqlite3
from functools import wraps
from pathlib import Path
from typing import Optional

from flask import (
    Flask, render_template, request, redirect, url_for,
    session, flash, abort, send_from_directory
)
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash

import db as dbx

# -----------------------
# Constants / Paths
# -----------------------

USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")
BASE_DIR = Path(__file__).resolve().parent

# Persistent storage root (Railway volume mount). Override with env if needed.
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))

# DB lives on the volume
DB_PATH = os.getenv("DB_PATH", str(DATA_DIR / "site.db"))

# Uploads live on the volume
UPLOADS_DIR = Path(os.getenv("UPLOADS_DIR", str(DATA_DIR / "uploads")))
POSTER_DIR  = UPLOADS_DIR / "posters"
PFP_DIR     = UPLOADS_DIR / "pfps"

UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
POSTER_DIR.mkdir(parents=True, exist_ok=True)
PFP_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
MAX_UPLOAD_MB = 5

APP_SECRET = os.getenv("APP_SECRET", "dev-secret-change-me")


# -----------------------
# Helpers (NO Flask globals at import-time)
# -----------------------

def slugify(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"&", "and", s)
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s

def pfp_filename_for_username(username: str, ext: str) -> str:
    ext = (ext or "").lower()
    if ext == ".jpeg":
        ext = ".jpg"
    key = slugify(username)
    return f"pfp_{key}{ext}"

def poster_filename_for_show(corps: str, year: int, ext: str) -> str:
    ext = (ext or "").lower()
    if ext == ".jpeg":
        ext = ".jpg"
    key = slugify(corps)
    return f"{key}{int(year)}{ext}"

# Profanity filter (unchanged)
BAD_WORDS = {
    "fuck", "shit", "bitch", "asshole", "bastard", "cunt", "dick", "pussy",
    "faggot", "nigger", "slut", "whore", "douchebag", "motherfucker", "twat",
    "cock", "piss", "fucker", "shitter", "bitchass", "asshat", "bullshit",
    "chink", "cocks", "niggers", "faggots", "sluts", "whores", "douchebags",
    "motherfuckers", "pussylicker", "pussylicking", "pussylicked", "nigglet", "nigglets",
    "nigga", "niggas", "niglet", "niglets", "faggotry", "fag", "fags",
    "jiggaboo", "jiggaboos", "spic", "spics", "gook", "gooks", "beaner", "beaners",
    "horseshit", "asswipe", "asswipes", "shithead", "shitheads", "dickhead", "dickheads",
    "dogshit", "cuntface", "cuntfaces", "pisshead", "pissheads", "twatface", "twatfaces", "twink", "twinks",
}

def _compile_bad_regex(words: set[str]) -> re.Pattern:
    parts = sorted((re.escape(w) for w in words if w), key=len, reverse=True)
    if not parts:
        return re.compile(r"^\b$")
    return re.compile(r"\b(" + "|".join(parts) + r")\b", re.IGNORECASE)

_BAD_RE = _compile_bad_regex(BAD_WORDS)

def contains_profanity(text: str) -> bool:
    if not text:
        return False
    return _BAD_RE.search(text) is not None

def find_profanity_in_json(obj):
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


# -----------------------
# App Factory
# -----------------------

def create_app() -> Flask:
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
    app.secret_key = APP_SECRET

    # ---- ALWAYS apply schema on boot (safe if schema.sql uses IF NOT EXISTS) ----
    dbx.init_db(DB_PATH, schema_path=str(BASE_DIR / "schema.sql"))

    def get_conn():
        conn = dbx.connect(DB_PATH)
        # Ensure your migrations/aux tables exist (idempotent)
        dbx.ensure_reviews_table(conn)
        dbx.ensure_profile_columns(conn)
        dbx.ensure_roles_tables(conn)
        dbx.ensure_review_votes_table(conn)
        dbx.ensure_review_comments_table(conn)
        dbx.ensure_social_tables(conn)
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

    # -----------------------
    # URL builders that need request/app context
    # -----------------------

    def pfp_url_for_username(username: str) -> Optional[str]:
        key = slugify(username)
        base = f"pfps/pfp_{key}"
        for ext in (".png", ".jpg", ".jpeg", ".webp"):
            rel = base + ext
            abs_path = PFP_DIR / f"pfp_{key}{ext}"
            if abs_path.is_file():
                # served from /uploads/
                return url_for("uploads", filename=rel)
        return None

    def poster_url_for_show(corps: str, year: int) -> Optional[str]:
        key = slugify(corps)

        # 1) year-specific upload: /uploads/posters/<corps><year>.<ext>
        for ext in (".png", ".jpg", ".jpeg", ".webp"):
            abs_path = POSTER_DIR / f"{key}{int(year)}{ext}"
            if abs_path.is_file():
                return url_for("uploads", filename=f"posters/{key}{int(year)}{ext}")

        # 2) corps default: /uploads/posters/<corps>default.<ext>
        for ext in (".png", ".jpg", ".jpeg", ".webp"):
            abs_path = POSTER_DIR / f"{key}default{ext}"
            if abs_path.is_file():
                return url_for("uploads", filename=f"posters/{key}default{ext}")

        # 3) global default: /uploads/posters/default.<ext>
        for ext in (".png", ".jpg", ".jpeg", ".webp"):
            abs_path = POSTER_DIR / f"default{ext}"
            if abs_path.is_file():
                return url_for("uploads", filename=f"posters/default{ext}")

        return None

    # -----------------------
    # Profanity guard
    # -----------------------

    @app.before_request
    def profanity_guard():
        if request.method not in ("POST", "PUT", "PATCH"):
            return None

        for k, v in request.args.items():
            if isinstance(v, str) and contains_profanity(v):
                return _profanity_block(f"query param '{k}'", v)

        for k, v in request.form.items():
            if isinstance(v, str) and contains_profanity(v):
                return _profanity_block(f"form field '{k}'", v)

        if request.is_json:
            payload = request.get_json(silent=True)
            if payload is not None:
                path, bad = find_profanity_in_json(payload)
                if path:
                    return _profanity_block(f"json field {path}", bad)

        return None

    def _profanity_block(where: str, _sample: str):
        wants_json = (
            request.path.startswith("/api/")
            or request.accept_mimetypes.best == "application/json"
            or request.headers.get("X-Requested-With") == "XMLHttpRequest"
        )
        if wants_json:
            abort(400, description=f"Profanity not allowed in {where}.")
        flash("Profanity is not allowed. Please remove it and try again.", "error")
        return redirect(request.referrer or url_for("shows"))

    # -----------------------
    # Template globals
    # -----------------------

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

        return {"me": u, "notif_count": notif_count, "notif_items": notif_items}

    # -----------------------
    # Static uploads route
    # -----------------------

    @app.get("/uploads/<path:filename>")
    def uploads(filename):
        # Security: send_from_directory prevents directory traversal
        return send_from_directory(str(UPLOADS_DIR), filename)

    # -----------------------
    # Routes
    # -----------------------

    @app.get("/")
    def home():
        return redirect(url_for("shows"))

    @app.get("/shows")
    def shows():
        sort = (request.args.get("sort") or "year_desc").strip()
        year_filter = (request.args.get("year") or "").strip()
        corps_q = (request.args.get("corps") or "").strip()

        conn = None
        try:
            conn = get_conn()
            rows = dbx.list_shows(conn, sort=sort, year=year_filter, corps=corps_q)

            rows2 = []
            for r in rows or []:
                d = dict(r)
                if not d.get("poster_url"):
                    d["poster_url"] = poster_url_for_show(d.get("corps", ""), d.get("year") or 0)
                rows2.append(d)

            friend_activity = []
            if session.get("uid"):
                # prefer dbx.list_friend_activity if present; else fallback to local SQL if you have it
                if hasattr(dbx, "list_friend_activity"):
                    friend_activity = [dict(x) for x in (dbx.list_friend_activity(conn, int(session["uid"]), limit=5) or [])]
                else:
                    friend_activity = []

                for a in friend_activity:
                    if not a.get("poster_url"):
                        a["poster_url"] = poster_url_for_show(a.get("corps", ""), a.get("year") or 0)

        finally:
            if conn is not None:
                conn.close()

        return render_template("shows.html", rows=rows2, sort=sort, year=year_filter, corps=corps_q, friend_activity=friend_activity)

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
            if not row.get("poster_url"):
                row["poster_url"] = poster_url_for_show(row.get("corps", ""), row.get("year") or 0)

            me = dbx.user_by_id(conn, viewer_uid) if viewer_uid else None
            my_rating = dbx.user_rating_for_show(conn, show_id, viewer_uid) if viewer_uid else None

            reviews = dbx.list_reviews_for_show(conn, show_id, viewer_user_id=viewer_uid, limit=30)

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

            comments = dbx.list_review_comments_for_show(conn, show_id, limit_total=500) or []
            comments_map = {}
            for c in comments:
                cd = dict(c)
                if not cd.get("commenter_avatar_url"):
                    cd["commenter_avatar_url"] = pfp_url_for_username(cd.get("commenter_username", ""))
                comments_map.setdefault(int(cd["review_user_id"]), []).append(cd)

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

        return render_template("show_detail.html", row=row, me=me, my_rating=my_rating, reviews=reviews)

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
            conn.commit()
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
            conn.commit()
        finally:
            conn.close()
        flash("Removed your rating.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))

    @app.post("/show/<int:show_id>/review")
    @login_required
    def review_show(show_id: int):
        text = (request.form.get("review_text") or "").strip()
        conn = None
        try:
            conn = get_conn()
            if not dbx.show_detail(conn, show_id):
                abort(404)
            dbx.upsert_review(conn, show_id, int(session["uid"]), text)
            conn.commit()
        except ValueError as e:
            flash(str(e), "error")
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
            conn.commit()
        finally:
            if conn is not None:
                conn.close()
        flash("Deleted your review.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))

    @app.post("/show/<int:show_id>/review/<int:review_user_id>/comment")
    @login_required
    def add_review_comment(show_id: int, review_user_id: int):
        text = (request.form.get("comment_text") or "").strip()
        commenter_id = int(session["uid"])
        conn = None
        try:
            conn = get_conn()
            if not dbx.get_show_by_id(conn, show_id):
                abort(404)
            dbx.add_review_comment(conn, show_id, review_user_id, commenter_id, text)

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
                    pass

            conn.commit()
        except ValueError as e:
            flash(str(e), "error")
        finally:
            if conn is not None:
                conn.close()
        return redirect(url_for("show_detail", show_id=show_id))

    @app.post("/show/<int:show_id>/comment/<int:comment_id>/delete")
    @login_required
    def delete_my_comment(show_id: int, comment_id: int):
        conn = None
        try:
            conn = get_conn()
            if not dbx.get_show_by_id(conn, show_id):
                abort(404)
            dbx.soft_delete_review_comment(conn, comment_id, requester_user_id=int(session["uid"]))
            conn.commit()
            flash("Comment deleted.", "ok")
        except ValueError as e:
            flash(str(e), "error")
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

            avatar_url = url_for("uploads", filename=f"pfps/{out_name}")
            dbx.update_user_avatar_url(conn, uid, avatar_url)
            conn.commit()

            flash("Profile picture updated.", "ok")
        except Exception as e:
            flash(f"Upload failed: {e}", "error")
        finally:
            if conn is not None:
                conn.close()

        return redirect(url_for("me_profile"))

    # -----------------------
    # Auth
    # -----------------------

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

            make_admin = dbx.is_first_user(conn)
            uid = dbx.create_user(conn, username, generate_password_hash(password), make_admin=make_admin)
            conn.commit()
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

    # -----------------------
    # Admin: show edit / upload poster / delete show
    # -----------------------

    @app.get("/admin/show/<int:show_id>/edit")
    @admin_required
    def admin_edit_show(show_id: int):
        conn = get_conn()
        try:
            s = dbx.get_show_by_id(conn, show_id)
            if not s:
                abort(404)
            s = dict(s)
            if not s.get("poster_url"):
                s["poster_url"] = poster_url_for_show(s.get("corps", ""), s.get("year") or 0)
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
            dbx.update_show(conn, show_id, int(year), corps, title, poster_url=poster_url)
            conn.commit()
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

            file.save(out_path)

            poster_url = url_for("uploads", filename=f"posters/{out_name}")
            dbx.update_show_poster_url(conn, show_id, poster_url)
            conn.commit()

            flash("Poster uploaded.", "ok")
        finally:
            if conn is not None:
                conn.close()

        return redirect(url_for("admin_edit_show", show_id=show_id))

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

            # Optional: delete uploaded poster file if it matches our /uploads/ path
            poster_url = (s.get("poster_url") or "").strip()
            if poster_url.startswith("/uploads/posters/") or "/uploads/posters/" in poster_url:
                try:
                    # normalize to just filename after "/uploads/"
                    rel = poster_url.split("/uploads/", 1)[1]  # "posters/xyz.webp"
                    abs_path = UPLOADS_DIR / rel
                    if abs_path.is_file():
                        abs_path.unlink()
                except Exception:
                    pass

            # HARD delete show + dependent data
            dbx.admin_delete_show(conn, int(show_id))
            conn.commit()

            flash("Show deleted permanently.", "ok")
        finally:
            if conn is not None:
                conn.close()

        return redirect(url_for("shows"))

    # -----------------------
    # Profiles / customize / friends / roles etc.
    # NOTE: Keep your existing routes here; this file is structured to avoid boot-time errors.
    # -----------------------

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

    @app.errorhandler(403)
    def forbidden(_e):
        return render_template("base.html", body="Forbidden"), 403

    return app


# Gunicorn entrypoint
app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=True)
