CREATE TABLE data_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  gamification_id INTEGER NOT NULL REFERENCES gamifications(id) ON DELETE CASCADE,
  published_at TEXT NOT NULL,
  value_precision INTEGER NOT NULL,
  field_headers_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'reverted'))
);

CREATE INDEX data_updates_gamification_status ON data_updates (gamification_id, status, id DESC);

CREATE TABLE participant_results (
  update_id INTEGER NOT NULL REFERENCES data_updates(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  score_value INTEGER NOT NULL,
  position INTEGER NOT NULL,
  custom_fields_json TEXT NOT NULL,
  PRIMARY KEY (update_id, participant_id)
);

INSERT INTO data_updates (public_id, gamification_id, published_at, value_precision, field_headers_json)
SELECT 'legacy-' || g.public_id, g.id, strftime('%Y-%m-%dT%H:%M:%fZ', MAX(r.updated_at)),
       g.value_precision, g.ranking_field_headers_json
FROM gamifications g JOIN rankings r ON r.gamification_id = g.id
GROUP BY g.id;

INSERT INTO participant_results (update_id, participant_id, score_value, position, custom_fields_json)
SELECT d.id, r.participant_id, r.score_value,
       RANK() OVER (PARTITION BY r.gamification_id ORDER BY r.score_value DESC), r.custom_fields_json
FROM data_updates d JOIN rankings r ON r.gamification_id = d.gamification_id;
