PRAGMA defer_foreign_keys = ON;

CREATE TABLE gamifications_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Gamificación',
  description TEXT NOT NULL,
  image_key TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  goal_value INTEGER CHECK (goal_value IS NULL OR goal_value >= 0),
  value_precision INTEGER NOT NULL CHECK (value_precision BETWEEN 0 AND 6),
  goal_unit TEXT,
  max_live_ranking INTEGER NOT NULL DEFAULT 5 CHECK (max_live_ranking BETWEEN 3 AND 1000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'achieved', 'missed', 'not_applicable')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT,
  actual_end_at TEXT,
  CHECK (end_at > start_at),
  CHECK (
    (status = 'closed' AND (
      (goal_value IS NULL AND outcome = 'not_applicable')
      OR (goal_value IS NOT NULL AND outcome IN ('achieved', 'missed'))
    ) AND closed_at IS NOT NULL)
    OR (status IN ('draft', 'active') AND outcome = 'pending' AND closed_at IS NULL)
  )
);

INSERT INTO gamifications_new (
  id, public_id, company_id, title, description, image_key, start_at, end_at,
  goal_value, value_precision, goal_unit, max_live_ranking, status, outcome,
  created_at, updated_at, closed_at, actual_end_at
)
SELECT
  id, public_id, company_id, title, description, image_key, start_at, end_at,
  goal_value, value_precision, goal_unit, max_live_ranking, status, outcome,
  created_at, updated_at, closed_at, actual_end_at
FROM gamifications;

DROP TABLE gamifications;
ALTER TABLE gamifications_new RENAME TO gamifications;

CREATE UNIQUE INDEX gamifications_public_id_unique ON gamifications (public_id);
CREATE INDEX gamifications_company_status_start_idx ON gamifications (company_id, status, start_at);

CREATE TABLE gamification_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gamification_id INTEGER NOT NULL REFERENCES gamifications (id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 1),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  icon_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (gamification_id, position)
);

CREATE INDEX gamification_rules_gamification_position_idx
  ON gamification_rules (gamification_id, position);

INSERT INTO gamification_rules (gamification_id, position, title, description, icon_name)
SELECT id, 1, 'Ventas cerradas', 'Suma puntos por cada venta realizada.', 'chart-column'
FROM gamifications;

INSERT INTO gamification_rules (gamification_id, position, title, description, icon_name)
SELECT id, 2, 'Productos estratégicos', 'Multiplica tus puntos al vender productos clave.', 'award'
FROM gamifications;

INSERT INTO gamification_rules (gamification_id, position, title, description, icon_name)
SELECT id, 3, 'Calidad y satisfacción', 'Las encuestas y la calidad también cuentan.', 'star'
FROM gamifications;
