ALTER TABLE gamifications ADD COLUMN tv_enabled INTEGER NOT NULL DEFAULT 0 CHECK (tv_enabled IN (0, 1));
