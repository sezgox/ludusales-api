CREATE TABLE prizes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL,
  gamification_id INTEGER NOT NULL REFERENCES gamifications(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  picture_key TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  ranking_position INTEGER CHECK (ranking_position >= 1),
  estimated_value_cents INTEGER CHECK (estimated_value_cents >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind TEXT NOT NULL DEFAULT 'position' CHECK (kind IN ('position', 'milestone', 'zone', 'special', 'raffle')),
  description TEXT NOT NULL DEFAULT '',
  parameter TEXT NOT NULL DEFAULT '',
  CHECK ((kind = 'position') = (ranking_position IS NOT NULL))
);

INSERT INTO prizes_new (id, public_id, gamification_id, name, picture_key, sort_order, ranking_position, estimated_value_cents, created_at, updated_at)
SELECT id, public_id, gamification_id, name, picture_key, sort_order, ranking_position, estimated_value_cents, created_at, updated_at FROM prizes;

DROP TABLE prizes;
ALTER TABLE prizes_new RENAME TO prizes;
CREATE UNIQUE INDEX prizes_public_id_unique ON prizes(public_id);
CREATE INDEX prizes_gamification_order_idx ON prizes(gamification_id, ranking_position, id);
CREATE UNIQUE INDEX prizes_gamification_ranking_position_unique ON prizes(gamification_id, ranking_position);

CREATE TABLE prize_decisions (
  prize_public_id TEXT NOT NULL,
  update_id INTEGER NOT NULL REFERENCES data_updates(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  winners_json TEXT NOT NULL,
  pool_size INTEGER NOT NULL,
  administrator_public_id TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (prize_public_id, update_id)
);
