ALTER TABLE gamifications
  ADD COLUMN max_live_ranking INTEGER NOT NULL DEFAULT 5
  CHECK (max_live_ranking BETWEEN 3 AND 1000);

CREATE TABLE prizes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL,
  gamification_id INTEGER NOT NULL REFERENCES gamifications (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  picture_key TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  ranking_position INTEGER NOT NULL CHECK (ranking_position >= 1),
  estimated_value_cents INTEGER CHECK (estimated_value_cents >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO prizes_new (
  id, public_id, gamification_id, name, picture_key, sort_order, ranking_position, created_at, updated_at
)
SELECT
  id,
  public_id,
  gamification_id,
  name,
  picture_key,
  sort_order,
  ROW_NUMBER() OVER (PARTITION BY gamification_id ORDER BY sort_order ASC, id ASC),
  created_at,
  updated_at
FROM prizes;

DROP TABLE prizes;
ALTER TABLE prizes_new RENAME TO prizes;

CREATE UNIQUE INDEX prizes_public_id_unique ON prizes (public_id);
CREATE INDEX prizes_gamification_order_idx ON prizes (gamification_id, ranking_position, id);
CREATE UNIQUE INDEX prizes_gamification_ranking_position_unique ON prizes (gamification_id, ranking_position);
