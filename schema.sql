PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL,
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
  created_ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shows_year ON shows(year);
CREATE INDEX IF NOT EXISTS idx_shows_corps ON shows(corps);

CREATE TABLE IF NOT EXISTS ratings (
  show_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  rating_half INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (show_id, user_id),
  FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ratings_show_id ON ratings(show_id);
CREATE INDEX IF NOT EXISTS idx_ratings_user_id ON ratings(user_id);

CREATE TABLE IF NOT EXISTS reviews (
  show_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  review_text TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (show_id, user_id),
  FOREIGN KEY (show_id) REFERENCES shows(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reviews_show_id ON reviews(show_id);
CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON reviews(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_ts ON reviews(ts);

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
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles(role_id);

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

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  actor_user_id INTEGER,
  kind TEXT NOT NULL,
  show_id INTEGER,
  review_user_id INTEGER,
  vote INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_read INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
ON notifications(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread



SELECT username, theme_color
FROM users
WHERE username = 'yourusername';

ON notifications(user_id, is_read);
