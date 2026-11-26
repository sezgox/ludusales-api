CREATE TABLE challenge_tv_access (
  gamification_id INTEGER PRIMARY KEY NOT NULL REFERENCES gamifications(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
