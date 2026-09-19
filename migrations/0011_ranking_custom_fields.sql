-- Dynamic ranking fields are scoped to a gamification.  Their display order is
-- stored on the gamification, while each ranking relationship stores its values.
ALTER TABLE gamifications
  ADD COLUMN ranking_field_headers_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE rankings
  ADD COLUMN custom_fields_json TEXT NOT NULL DEFAULT '{}';
