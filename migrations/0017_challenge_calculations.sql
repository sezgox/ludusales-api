CREATE TABLE challenge_settings (
  gamification_id INTEGER PRIMARY KEY NOT NULL REFERENCES gamifications(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL,
  revision TEXT NOT NULL
);

CREATE TABLE challenge_members (
  gamification_id INTEGER NOT NULL REFERENCES gamifications(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  zone TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (gamification_id, participant_id)
);

INSERT INTO challenge_members (gamification_id, participant_id, zone)
SELECT gamification_id, participant_id, COALESCE(json_extract(custom_fields_json, '$.Zona'), json_extract(custom_fields_json, '$.Zone'), '')
FROM rankings;

ALTER TABLE data_updates ADD COLUMN data_date TEXT;
ALTER TABLE data_updates ADD COLUMN import_mode TEXT CHECK (import_mode IN ('accumulated', 'period'));
ALTER TABLE data_updates ADD COLUMN source_name TEXT;
ALTER TABLE data_updates ADD COLUMN author_public_id TEXT;
ALTER TABLE data_updates ADD COLUMN projection_json TEXT;
ALTER TABLE data_updates ADD COLUMN preview_token TEXT;
CREATE UNIQUE INDEX data_updates_preview_token ON data_updates (preview_token) WHERE preview_token IS NOT NULL;
ALTER TABLE participant_results ADD COLUMN calculation_json TEXT;
ALTER TABLE participant_results ADD COLUMN sort_order INTEGER;
