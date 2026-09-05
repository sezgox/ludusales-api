CREATE TABLE gamifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  image_key TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  goal_value INTEGER NOT NULL CHECK (goal_value >= 0),
  value_precision INTEGER NOT NULL CHECK (value_precision BETWEEN 0 AND 6),
  goal_unit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'achieved', 'missed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT,
  CHECK (end_at > start_at),
  CHECK (
    (status = 'closed' AND outcome IN ('achieved', 'missed') AND closed_at IS NOT NULL)
    OR (status IN ('draft', 'active') AND outcome = 'pending' AND closed_at IS NULL)
  )
);

CREATE UNIQUE INDEX gamifications_public_id_unique ON gamifications (public_id);
CREATE INDEX gamifications_company_status_start_idx ON gamifications (company_id, status, start_at);

CREATE TABLE prizes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL,
  gamification_id INTEGER NOT NULL REFERENCES gamifications (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  picture_key TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX prizes_public_id_unique ON prizes (public_id);
CREATE INDEX prizes_gamification_order_idx ON prizes (gamification_id, sort_order, id);

CREATE TABLE rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gamification_id INTEGER NOT NULL REFERENCES gamifications (id) ON DELETE CASCADE,
  external_participant_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  score_value INTEGER NOT NULL CHECK (score_value >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX rankings_gamification_participant_unique
  ON rankings (gamification_id, external_participant_id);
CREATE INDEX rankings_gamification_score_idx ON rankings (gamification_id, score_value DESC);

CREATE TABLE media_deletion_queue (
  object_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
