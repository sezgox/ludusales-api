ALTER TABLE gamifications ADD COLUMN ranking_unit TEXT NOT NULL DEFAULT 'Ludu Points';

UPDATE gamifications
SET start_at = substr(start_at, 1, 10),
    end_at = substr(end_at, 1, 10);
