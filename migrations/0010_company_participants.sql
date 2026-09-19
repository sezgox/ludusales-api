CREATE TABLE participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  participant_code TEXT NOT NULL,
  full_name TEXT NOT NULL,
  picture_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX participants_company_code_unique ON participants (company_id, participant_code);
CREATE INDEX participants_company_name_idx ON participants (company_id, full_name);

-- Existing ranking IDs become company-scoped participant codes. When a code
-- appeared in several rankings, retain the most recently updated profile.
INSERT INTO participants (company_id, participant_code, full_name, picture_key, created_at, updated_at)
SELECT company_id, external_participant_id, full_name, picture_key, created_at, updated_at
FROM (
  SELECT
    g.company_id,
    r.external_participant_id,
    r.full_name,
    r.picture_key,
    r.created_at,
    r.updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY g.company_id, r.external_participant_id
      ORDER BY r.updated_at DESC, r.id DESC
    ) AS profile_rank
  FROM rankings r
  INNER JOIN gamifications g ON g.id = r.gamification_id
)
WHERE profile_rank = 1;

DROP INDEX rankings_gamification_participant_unique;
DROP INDEX rankings_gamification_score_idx;
ALTER TABLE rankings RENAME TO rankings_legacy;

CREATE TABLE rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gamification_id INTEGER NOT NULL REFERENCES gamifications (id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
  score_value INTEGER NOT NULL CHECK (score_value >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO rankings (id, gamification_id, participant_id, score_value, created_at, updated_at)
SELECT r.id, r.gamification_id, p.id, r.score_value, r.created_at, r.updated_at
FROM rankings_legacy r
INNER JOIN gamifications g ON g.id = r.gamification_id
INNER JOIN participants p
  ON p.company_id = g.company_id
  AND p.participant_code = r.external_participant_id;

DROP TABLE rankings_legacy;

CREATE UNIQUE INDEX rankings_gamification_participant_unique ON rankings (gamification_id, participant_id);
CREATE INDEX rankings_gamification_score_idx ON rankings (gamification_id, score_value DESC);
