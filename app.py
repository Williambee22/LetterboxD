import os
import re
import sqlite3
from functools import wraps
from pathlib import Path
from typing import Optional

from flask import Flask, render_template, request, redirect, url_for, session, flash, abort, send_from_directory, current_app
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash

import db as dbx


_slug_re = re.compile(r"[^a-z0-9_]+")

def slugify_corps(name: str) -> str:
    s = (name or "").strip().lower()
    s = s.replace("&", "and")
    s = re.sub(r"\s+", "_", s)
    s = _slug_re.sub("", s)
    return s.strip("_") or "unknown"

def poster_url_for_show(corps: str, year) -> str:
    """
    Returns a URL like /static/posters/blue_devils2017.png if it exists.
    Falls back to /static/posters/placeholder.png if missing.
    """
    fallback = url_for("static", filename="posters/placeholder.png")

    corps = (corps or "").strip()
    year_s = str(year).strip() if year is not None else ""
    if not corps or not year_s:
        return fallback

    key = f"{slugify_corps(corps)}{year_s}"
    posters_dir = Path(current_app.static_folder) / "posters"

    # Try common extensions
    for ext in ("png", "jpg", "jpeg", "webp"):
        fp = posters_dir / f"{key}.{ext}"
        if fp.is_file():
            return url_for("static", filename=f"posters/{key}.{ext}")

    return fallback
    
# -----------------------------
# Basics / Config
# -----------------------------
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")

APP_SECRET = os.getenv("APP_SECRET", "dev-secret-change-me")
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "5"))

# Persistent storage root (Railway Volume mount)
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = os.getenv("DB_PATH", str(DATA_DIR / "site.db"))

# Uploads live on the volume
BASE_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = BASE_DIR / "uploads"
PFP_DIR = UPLOADS_DIR / "pfps"
POSTER_DIR = UPLOADS_DIR / "posters"
POSTER_DIR.mkdir(parents=True, exist_ok=True)
PFP_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


# -----------------------------
# Helpers
# -----------------------------
def slugify(s: str) -> str:
    s = (s or "").strip().lower()
    s = re.sub(r"&", "and", s)
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s


def poster_filename_for_show(corps: str, year: int, ext: str) -> str:
    ext = ext.lower()
    if ext == ".jpeg":
        ext = ".jpg"
    key = slugify(corps)
    return f"{key}{int(year)}{ext}"


def pfp_filename_for_username(username: str, ext: str) -> str:
    ext = ext.lower()
    if ext == ".jpeg":
        ext = ".jpg"
    key = slugify(username)
    return f"pfp_{key}{ext}"


def create_app() -> Flask:
    app = Flask(__name__, static_folder="static", template_folder="templates")
    app.secret_key = APP_SECRET
    app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
    poster_fn = poster_url_for_show
    app.jinja_env.globals["poster_url_for_show"] = poster_url_for_show

    dbx.init_db(DB_PATH)
    return app

    # Make sure DB has required tables/columns on boot

    
    # -----------------------------
    # DB access
    # -----------------------------
    def get_conn() -> sqlite3.Connection:
        return dbx.connect(DB_PATH)

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

    # -----------------------------
    # URL helpers (need app context)
    # -----------------------------
    def pfp_url_for_username(username: str) -> Optional[str]:
        key = slugify(username)
        base = f"pfp_{key}"
        for ext in (".png", ".jpg", ".jpeg", ".webp"):
            fpath = PFP_DIR / (base + ext)
            if fpath.is_file():
                return url_for("uploads", filename=f"pfps/{base}{ext}")
        return None

    def poster_url_for_show(corps: str, year: int) -> str | None:
        key = slugify(corps)

    # 1) year-specific poster: uploads/posters/<corpsslug><year>.<ext>
        base_year = f"{key}{int(year)}"
        for ext in (".png", ".jpg", ".jpeg", ".webp"):
            abs_path = POSTER_DIR / (base_year + ext)
            if abs_path.is_file():
                return url_for("uploads", filename=f"posters/{base_year}{ext}")
    
        # 2) corps default: uploads/posters/<corpsslug>default.<ext>
        base_default = f"{key}default"
        for ext in (".png", ".jpg", ".jpeg", ".webp"):
            abs_path = POSTER_DIR / (base_default + ext)
            if abs_path.is_file():
                return url_for("uploads", filename=f"posters/{base_default}{ext}")
    
        # 3) global default: uploads/posters/default.<ext>
        base_global = "default"
        for ext in (".png", ".jpg", ".jpeg", ".webp"):
            abs_path = POSTER_DIR / (base_global + ext)
            if abs_path.is_file():
                return url_for("uploads", filename=f"posters/{base_global}{ext}")
    
        return None
    # -----------------------------
    # Global template injection
    # -----------------------------
    @app.context_processor
    def inject_globals():
        u = current_user()

        notif_items = []
        notif_count = 0
        if u:
            conn = get_conn()
            try:
                notif_count = dbx.unread_notifications_count(conn, int(u["id"]))
                notif_items = [dict(x) for x in dbx.list_unread_notifications(conn, int(u["id"]), limit=20)]
            finally:
                conn.close()

        return {"me": u, "notif_count": notif_count, "notif_items": notif_items}

    # -----------------------------
    # Routes
    # -----------------------------
    @app.get("/")
    def home():
        return redirect(url_for("shows"))

    @app.get("/uploads/<path:filename>")
    def uploads(filename):
        # serves /data/uploads/*
        return send_from_directory(str(UPLOADS_DIR), filename)

    # -----------------------------
    # Shows
    # -----------------------------
    @app.get("/shows")
    def shows():
        sort = (request.args.get("sort") or "year_desc").strip()
        year_filter = (request.args.get("year") or "").strip()
        corps = (request.args.get("corps") or "").strip()

        conn = get_conn()
        try:
            rows = dbx.list_shows(conn, sort=sort, year=year_filter, corps=corps)
            rows2 = []
            for r in rows:
                d = dict(r)
                if not d.get("poster_url"):
                    d["poster_url"] = poster_url_for_show(d.get("corps", ""), d.get("year") or 0)
                rows2.append(d)

            friend_activity = []
            if session.get("uid"):
                friend_activity = dbx.list_friend_activity(conn, int(session["uid"]), limit=5)
                for a in friend_activity:
                    if not a.get("poster_url"):
                        a["poster_url"] = poster_url_for_show(a.get("corps", ""), a.get("year") or 0)

        finally:
            conn.close()

        return render_template(
            "shows.html",
            rows=rows2,
            sort=sort,
            year=year_filter,
            corps=corps,
            friend_activity=friend_activity,
        )

    @app.get("/show/<int:show_id>")
    def show_detail(show_id: int):
        viewer_uid = session.get("uid")
        conn = get_conn()
        try:
            row = dbx.get_show_by_id(conn, show_id)
            if not row:
                abort(404)
            row = dict(row)
            if not row.get("poster_url"):
                row["poster_url"] = poster_url_for_show(row.get("corps", ""), row.get("year") or 0)

            me = dbx.user_by_id(conn, int(viewer_uid)) if viewer_uid else None
            if me:
                me = dict(me)
                if not me.get("avatar_url"):
                    me["avatar_url"] = pfp_url_for_username(me.get("username", ""))

            my_rating = dbx.user_rating_for_show(conn, show_id, int(viewer_uid)) if viewer_uid else None

            reviews = dbx.list_reviews_for_show(conn, show_id, viewer_user_id=int(viewer_uid) if viewer_uid else None, limit=30)
            reviews2 = []
            for rv in reviews:
                d = dict(rv)
                if not d.get("avatar_url"):
                    d["avatar_url"] = pfp_url_for_username(d.get("username", ""))
                reviews2.append(d)

            comments = dbx.list_review_comments_for_show(conn, show_id, limit_total=500)
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

        finally:
            conn.close()

        return render_template("show_detail.html", row=row, me=me, my_rating=my_rating, reviews=reviews3)

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

    @app.post("/show/<int:show_id>/review")
    @login_required
    def review_show(show_id: int):
        text = (request.form.get("review_text") or "").strip()
        conn = get_conn()
        try:
            if not dbx.get_show_by_id(conn, show_id):
                abort(404)
            dbx.upsert_review(conn, show_id, int(session["uid"]), text)
        finally:
            conn.close()
        flash("Saved your review.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))

    @app.post("/show/<int:show_id>/review/delete")
    @login_required
    def delete_my_review(show_id: int):
        conn = get_conn()
        try:
            dbx.delete_review(conn, show_id, int(session["uid"]))
        finally:
            conn.close()
        flash("Deleted your review.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))

    # Comments
    @app.post("/show/<int:show_id>/review/<int:review_user_id>/comment")
    @login_required
    def add_review_comment(show_id: int, review_user_id: int):
        text = (request.form.get("comment_text") or "").strip()
        commenter_id = int(session["uid"])

        conn = get_conn()
        try:
            if not dbx.get_show_by_id(conn, show_id):
                abort(404)
            dbx.add_review_comment(conn, show_id, review_user_id, commenter_id, text)

            if commenter_id != int(review_user_id):
                dbx.add_notification(
                    conn,
                    user_id=int(review_user_id),
                    kind="review_comment",
                    actor_user_id=commenter_id,
                    show_id=int(show_id),
                    review_user_id=int(review_user_id),
                )

            conn.commit()
        finally:
            conn.close()

        return redirect(url_for("show_detail", show_id=show_id))

    @app.post("/show/<int:show_id>/comment/<int:comment_id>/delete")
    @login_required
    def delete_my_comment(show_id: int, comment_id: int):
        conn = get_conn()
        try:
            dbx.soft_delete_review_comment(conn, comment_id, requester_user_id=int(session["uid"]))
            conn.commit()
        finally:
            conn.close()
        flash("Comment deleted.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))

    # Voting
    @app.post("/show/<int:show_id>/review/<int:review_user_id>/vote")
    @login_required
    def vote_review(show_id: int, review_user_id: int):
        vote = int(request.form.get("vote") or "0")
        if vote not in (1, -1):
            abort(400)

        voter_user_id = int(session["uid"])
        if voter_user_id == int(review_user_id):
            flash("You can't vote on your own review.", "error")
            return redirect(url_for("show_detail", show_id=show_id))

        conn = get_conn()
        try:
            dbx.set_review_vote(conn, show_id, review_user_id, voter_user_id, vote)
            if vote == 1:
                dbx.add_notification(
                    conn,
                    user_id=int(review_user_id),
                    kind="review_upvote",
                    actor_user_id=voter_user_id,
                    show_id=int(show_id),
                    review_user_id=int(review_user_id),
                    vote=1
                )
            conn.commit()
        finally:
            conn.close()

        return redirect(url_for("show_detail", show_id=show_id))

    # -----------------------------
    # Auth
    # -----------------------------
    @app.get("/register")
    def register():
        return render_template("auth_register.html")

    @app.post("/register")
    def register_post():
        username = (request.form.get("username") or "").strip()
        password = (request.form.get("password") or "").strip()

        if not USERNAME_RE.match(username):
            flash("Username must be 3–20 chars and only letters, numbers, underscore.", "error")
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
        finally:
            conn.close()

        session["uid"] = uid
        flash("Account created. You're logged in.", "ok")
        if make_admin:
            flash("First user created: you are admin.", "ok")
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

    # -----------------------------
    # Profiles
    # -----------------------------
    @app.get("/me")
    @login_required
    def me_profile():
        conn = get_conn()
        try:
            uid = int(session["uid"])
            u = dbx.user_by_id(conn, uid)
            if not u:
                abort(404)
            u = dict(u)

            avg, cnt = dbx.user_avg_rating(conn, uid)
            u["avg_rating"] = avg
            u["avg_rating_cnt"] = cnt

            u["followers_count"] = dbx.follower_count(conn, uid)
            u["following_count"] = dbx.following_count(conn, uid)

            roles_for_me = [dict(x) for x in dbx.roles_for_user(conn, uid)]
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
        conn = get_conn()
        try:
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

            roles_for_user = [dict(x) for x in dbx.roles_for_user(conn, int(profile["id"]))]
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

            me = None
            if viewer_id:
                me_row = dbx.user_by_id(conn, viewer_id)
                me = dict(me_row) if me_row else None

        finally:
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

    @app.get("/u/<username>/ratings")
    def user_all_ratings(username: str):
        sort = (request.args.get("sort") or "high").strip().lower()
        q = (request.args.get("q") or "").strip()

        conn = get_conn()
        try:
            me = current_user()
            profile_user = dbx.user_by_username(conn, username)
            if not profile_user:
                abort(404)

            rows = dbx.list_all_ratings_for_user(conn, int(profile_user["id"]), sort=sort, corps_q=q)
            rows = [dict(r) for r in rows]
            profile_user = dict(profile_user)
            if me is not None:
                me = dict(me)

            for r in rows:
                if not r.get("poster_url"):
                    r["poster_url"] = poster_url_for_show(r.get("corps", ""), r.get("year") or 0)
        finally:
            conn.close()

        return render_template("user_all_ratings.html", me=me, profile_user=profile_user, sort=sort, q=q, rows=rows)

    @app.get("/me/customize")
    @login_required
    def customize_profile():
        conn = get_conn()
        try:
            u = dbx.user_by_id(conn, int(session["uid"]))
            if not u:
                abort(404)
        finally:
            conn.close()
        return render_template("profile_customize.html", u=u)

    @app.post("/me/customize")
    @login_required
    def customize_profile_post():
        avatar_url = (request.form.get("avatar_url") or "").strip()
        banner_url = (request.form.get("banner_url") or "").strip()
        theme_color = (request.form.get("theme_color") or "").strip()

        conn = get_conn()
        try:
            dbx.update_user_profile_style(conn, int(session["uid"]), avatar_url, banner_url, theme_color)
        finally:
            conn.close()

        flash("Profile updated.", "ok")
        return redirect(url_for("me_profile"))

    @app.post("/me/upload_pfp")
    @login_required
    def upload_my_pfp():
        uid = int(session["uid"])

        if "pfp_file" not in request.files:
            flash("Upload failed: no file field.", "error")
            return redirect(url_for("me_profile"))

        file = request.files.get("pfp_file")
        if not file or not file.filename:
            flash("No file selected.", "error")
            return redirect(url_for("me_profile"))

        filename = secure_filename(file.filename)
        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_IMAGE_EXTS:
            flash("Profile picture must be PNG/JPG/JPEG/WEBP.", "error")
            return redirect(url_for("me_profile"))

        conn = get_conn()
        try:
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
        finally:
            conn.close()

        flash("Profile picture updated.", "ok")
        return redirect(url_for("me_profile"))

    # -----------------------------
    # Admin: bulk add, edit shows, posters
    # -----------------------------
    @app.get("/admin/bulk_add")
    @admin_required
    def bulk_add():
        return render_template("bulk_add.html")

    def parse_bulk_lines(text: str):
        items, errors = [], []
        for i, raw in enumerate((text or "").splitlines(), start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = [p.strip() for p in (line.split("|") if "|" in line else line.split(","))]
            if len(parts) not in (3, 4):
                errors.append(f"Line {i}: expected 3 or 4 fields. Got: {raw}")
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
            return redirect(url_for("bulk_add"))

        conn = get_conn()
        inserted = dupes = other_bad = 0
        try:
            for (y, c, t, poster) in items:
                ok, _sid, msg = dbx.add_show(conn, y, c, t, poster_url=poster)
                if ok:
                    inserted += 1
                else:
                    if msg.startswith("Duplicate"):
                        dupes += 1
                    else:
                        other_bad += 1
        finally:
            conn.close()

        flash(f"Bulk add done. Inserted: {inserted}. Duplicates: {dupes}. Other: {other_bad}.", "ok")
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
        year = (request.form.get("year") or "").strip()
        poster_url = (request.form.get("poster_url") or "").strip() or None

        if not year.isdigit():
            flash("Year must be a number.", "error")
            return redirect(url_for("admin_edit_show", show_id=show_id))

        conn = get_conn()
        try:
            if not dbx.get_show_by_id(conn, show_id):
                abort(404)
            dbx.update_show(conn, show_id, int(year), corps, title, poster_url=poster_url)
        except ValueError as e:
            flash(str(e), "error")
            return redirect(url_for("admin_edit_show", show_id=show_id))
        finally:
            conn.close()

        flash("Show updated.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))

    @app.post("/me/change_username", endpoint="change_username")
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
    
            pass_col = dbx.users_password_col(conn)
            stored_hash = me.get(pass_col)
            if not stored_hash or not check_password_hash(stored_hash, current_password):
                flash("Current password is incorrect.", "error")
                return redirect(url_for("me_profile"))
    
            if me.get("username", "").lower() == new_username.lower():
                flash("That is already your username.", "warn")
                return redirect(url_for("me_profile"))
    
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
            flash("Poster must be PNG/JPG/JPEG/WEBP.", "error")
            return redirect(url_for("admin_edit_show", show_id=show_id))

        conn = get_conn()
        try:
            row = dbx.get_show_by_id(conn, show_id)
            if not row:
                abort(404)
            row = dict(row)

            out_name = poster_filename_for_show(row.get("corps", ""), row.get("year") or 0, ext)
            out_path = POSTER_DIR / out_name
            file.save(out_path)

            poster_url = url_for("uploads", filename=f"posters/{out_name}")
            dbx.update_show_poster_url(conn, show_id, poster_url)
            conn.commit()
        finally:
            conn.close()

        flash("Poster uploaded.", "ok")
        return redirect(url_for("admin_edit_show", show_id=show_id))

    @app.post("/admin/show/<int:show_id>/delete")
    @admin_required
    def admin_delete_show(show_id: int):
        conn = get_conn()
        try:
            dbx.admin_delete_show(conn, show_id)
            conn.commit()
        finally:
            conn.close()
        flash("Show deleted permanently.", "ok")
        return redirect(url_for("shows"))

    @app.post("/admin/show/<int:show_id>/review/<int:review_user_id>/delete")
    @admin_required
    def admin_delete_review(show_id: int, review_user_id: int):
        conn = get_conn()
        try:
            dbx.admin_delete_review(conn, show_id, review_user_id)
            conn.commit()
        finally:
            conn.close()
        flash("Review deleted.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))

    @app.post("/admin/show/<int:show_id>/comment/<int:comment_id>/delete")
    @admin_required
    def admin_delete_comment(show_id: int, comment_id: int):
        conn = get_conn()
        try:
            dbx.admin_hard_delete_review_comment(conn, comment_id)
            conn.commit()
        finally:
            conn.close()
        flash("Comment deleted.", "ok")
        return redirect(url_for("show_detail", show_id=show_id))

    # -----------------------------
    # Admin: roles (THIS FIXES your BuildError admin_roles)
    # -----------------------------
    @app.get("/admin/roles")
    @admin_required
    def admin_roles():
        conn = get_conn()
        try:
            roles = dbx.list_roles(conn)
        finally:
            conn.close()
        return render_template("admin_roles.html", roles=roles)

    @app.post("/admin/roles")
    @admin_required
    def admin_roles_post():
        name = (request.form.get("name") or "").strip()
        color = (request.form.get("color") or "").strip()
        conn = get_conn()
        try:
            dbx.create_role(conn, name, color)
        except ValueError as e:
            flash(str(e), "error")
        except sqlite3.IntegrityError:
            flash("Role name already exists.", "error")
        finally:
            conn.close()
        return redirect(url_for("admin_roles"))

    @app.post("/admin/roles/<int:role_id>/delete")
    @admin_required
    def admin_delete_role(role_id: int):
        conn = get_conn()
        try:
            dbx.delete_role(conn, role_id)
        finally:
            conn.close()
        flash("Role deleted.", "ok")
        return redirect(url_for("admin_roles"))

    @app.get("/admin/roles/<int:role_id>/edit")
    @admin_required
    def admin_edit_role(role_id: int):
        conn = get_conn()
        try:
            r = dbx.role_by_id(conn, role_id)
            if not r:
                abort(404)
        finally:
            conn.close()
        return render_template("admin_role_edit.html", r=r)

    @app.post("/admin/roles/<int:role_id>/edit")
    @admin_required
    def admin_edit_role_post(role_id: int):
        name = (request.form.get("name") or "").strip()
        color = (request.form.get("color") or "").strip()
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
            conn.close()
        flash("Role updated.", "ok")
        return redirect(url_for("admin_roles"))

    @app.get("/admin/users")
    @admin_required
    def admin_users():
        conn = get_conn()
        try:
            users = [dict(u) for u in dbx.list_users(conn)]
        finally:
            conn.close()
        return render_template("admin_users.html", users=users)

    @app.get("/admin/user/<username>/roles")
    @admin_required
    def admin_user_roles(username: str):
        conn = get_conn()
        try:
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            roles = dbx.list_roles(conn)
            user_roles = dbx.roles_for_user(conn, int(u["id"]))
            user_role_ids = {int(r["id"]) for r in user_roles}
        finally:
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
        conn = get_conn()
        try:
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.assign_role_to_user(conn, int(u["id"]), role_id, assigned_by_user_id=int(session["uid"]))
        finally:
            conn.close()
        flash("Role assigned.", "ok")
        return redirect(url_for("admin_user_roles", username=username))

    @app.post("/admin/user/<username>/roles/remove")
    @admin_required
    def admin_user_roles_remove(username: str):
        role_id = int(request.form.get("role_id") or "0")
        conn = get_conn()
        try:
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.remove_role_from_user(conn, int(u["id"]), role_id)
        finally:
            conn.close()
        flash("Role removed.", "ok")
        return redirect(url_for("admin_user_roles", username=username))

    # -----------------------------
    # Social: follow + friends
    # -----------------------------
    @app.post("/u/<username>/follow")
    @login_required
    def follow_user(username: str):
        conn = get_conn()
        try:
            me_id = int(session["uid"])
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.follow(conn, me_id, int(u["id"]))
            dbx.add_notification(conn, user_id=int(u["id"]), kind="follow", actor_user_id=me_id)
            conn.commit()
        finally:
            conn.close()
        return redirect(url_for("user_profile", username=username))

    @app.post("/u/<username>/unfollow")
    @login_required
    def unfollow_user(username: str):
        conn = get_conn()
        try:
            me_id = int(session["uid"])
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.unfollow(conn, me_id, int(u["id"]))
            conn.commit()
        finally:
            conn.close()
        return redirect(url_for("user_profile", username=username))

    @app.get("/u/<username>/followers")
    def user_followers(username: str):
        conn = get_conn()
        try:
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            rows = [dict(x) for x in dbx.list_followers(conn, int(u["id"]), limit=500)]
        finally:
            conn.close()
        return render_template("followers.html", profile_user=dict(u), rows=rows)

    @app.get("/u/<username>/following")
    def user_following(username: str):
        conn = get_conn()
        try:
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            rows = [dict(x) for x in dbx.list_following(conn, int(u["id"]), limit=500)]
        finally:
            conn.close()
        return render_template("following.html", profile_user=dict(u), rows=rows)

    @app.get("/me/friends")
    @login_required
    def my_friends():
        conn = get_conn()
        try:
            me_id = int(session["uid"])
            me = dbx.user_by_id(conn, me_id)
            friends = [dict(x) for x in dbx.list_friends(conn, me_id, limit=500)]
            incoming = [dict(x) for x in dbx.list_incoming_friend_requests(conn, me_id, limit=200)]
        finally:
            conn.close()
        return render_template("friends.html", me=dict(me) if me else None, friends=friends, incoming=incoming)


    @app.post("/me/change-password")
    @login_required
    def change_password():
        """
        Template expects endpoint name: change_password
        POST handler that updates the current user's password.
        """
        old_pw = (request.form.get("old_password") or "").strip()
        new_pw = (request.form.get("new_password") or "").strip()
        new2   = (request.form.get("new_password2") or "").strip()
    
        if not old_pw or not new_pw or not new2:
            flash("Fill out all password fields.", "error")
            return redirect(url_for("me_profile"))
    
        if new_pw != new2:
            flash("New passwords do not match.", "error")
            return redirect(url_for("me_profile"))
    
        if len(new_pw) < 6:
            flash("Password must be at least 6 characters.", "error")
            return redirect(url_for("me_profile"))
    
        conn = dbx.connect(DB_PATH)
        try:
            me = dbx.user_by_id(conn, int(session["user_id"]))
            if not me:
                flash("Session user not found.", "error")
                return redirect(url_for("logout"))
    
            # detect which column your users table uses
            pw_col = dbx.users_password_col(conn)
            current_hash = me[pw_col]
    
            if not check_password_hash(current_hash, old_pw):
                flash("Current password is incorrect.", "error")
                return redirect(url_for("me_profile"))
    
            new_hash = generate_password_hash(new_pw)
            dbx.update_user_password_hash(conn, int(session["user_id"]), new_hash)
            conn.commit()
            flash("Password updated.", "ok")
            return redirect(url_for("me_profile"))
        finally:
            conn.close()


    
    @app.post("/u/<username>/friend/request")
    @login_required
    def friend_request(username: str):
        conn = get_conn()
        try:
            me_id = int(session["uid"])
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.send_friend_request(conn, me_id, int(u["id"]))
            dbx.add_notification(conn, user_id=int(u["id"]), kind="friend_request", actor_user_id=me_id)
            conn.commit()
        finally:
            conn.close()
        return redirect(url_for("user_profile", username=username))

    @app.post("/u/<username>/friend/accept")
    @login_required
    def friend_accept(username: str):
        conn = get_conn()
        try:
            me_id = int(session["uid"])
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.accept_friend_request(conn, int(u["id"]), me_id)
            conn.commit()
        finally:
            conn.close()
        return redirect(url_for("my_friends"))

    @app.post("/u/<username>/friend/decline")
    @login_required
    def friend_decline(username: str):
        conn = get_conn()
        try:
            me_id = int(session["uid"])
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.decline_friend_request(conn, int(u["id"]), me_id)
            conn.commit()
        finally:
            conn.close()
        return redirect(url_for("my_friends"))

    @app.post("/u/<username>/friend/remove")
    @login_required
    def friend_remove(username: str):
        conn = get_conn()
        try:
            me_id = int(session["uid"])
            u = dbx.user_by_username(conn, username)
            if not u:
                abort(404)
            dbx.remove_friend(conn, me_id, int(u["id"]))
            conn.commit()
        finally:
            conn.close()
        return redirect(url_for("user_profile", username=username))

    # Notifications
    @app.post("/me/notifications/read")
    @login_required
    def notifications_mark_read():
        conn = get_conn()
        try:
            dbx.mark_all_notifications_read(conn, int(session["uid"]))
            conn.commit()
        finally:
            conn.close()
        return redirect(request.referrer or url_for("shows"))

    # Top pages
    @app.get("/top")
    def top_shows():
        mode = (request.args.get("mode") or "top").strip().lower()
        if mode not in ("top", "bottom"):
            mode = "top"

        conn = get_conn()
        try:
            rows = dbx.list_top_shows_with_top_review(conn, limit=50, mode=mode)
            rows2 = []
            for r in rows:
                d = dict(r)
                if not d.get("poster_url"):
                    d["poster_url"] = poster_url_for_show(d.get("corps", ""), d.get("year") or 0)
                if d.get("top_review_username") and not d.get("top_review_avatar_url"):
                    d["top_review_avatar_url"] = pfp_url_for_username(d.get("top_review_username", ""))
                rows2.append(d)
        finally:
            conn.close()

        return render_template("top_shows.html", rows=rows2, mode=mode)

    @app.get("/top_users")
    def top_users():
        conn = get_conn()
        try:
            rows = dbx.list_top_users_by_review_upvotes(conn, limit=25)
            rows2 = []
            for r in rows:
                d = dict(r)
                if not d.get("avatar_url"):
                    d["avatar_url"] = pfp_url_for_username(d.get("username", ""))
                if d.get("top_show_id") and not d.get("top_poster_url"):
                    d["top_poster_url"] = poster_url_for_show(d.get("top_corps", ""), d.get("top_year") or 0)
                rows2.append(d)
        finally:
            conn.close()

        return render_template("top_users.html", rows=rows2)

    @app.errorhandler(403)
    def forbidden(_e):
        return render_template("base.html", body="Forbidden"), 403

    return app


app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port, debug=True)










