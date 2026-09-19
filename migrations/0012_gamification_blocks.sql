CREATE TABLE block_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  image_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE gamification_metric_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  gamification_id INTEGER NOT NULL REFERENCES gamifications(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  icon_name TEXT NOT NULL,
  value TEXT NOT NULL,
  subvalue TEXT,
  progress_current TEXT,
  progress_max TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((progress_current IS NULL AND progress_max IS NULL) OR (progress_current IS NOT NULL AND progress_max IS NOT NULL))
);
CREATE INDEX gamification_metric_cards_order_idx ON gamification_metric_cards(gamification_id, sort_order);

CREATE TABLE gamification_promo_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL UNIQUE,
  gamification_id INTEGER NOT NULL REFERENCES gamifications(id) ON DELETE CASCADE,
  image_id INTEGER NOT NULL REFERENCES block_images(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX gamification_promo_cards_order_idx ON gamification_promo_cards(gamification_id, sort_order);
