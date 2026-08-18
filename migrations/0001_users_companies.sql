CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS companies_public_id_unique ON companies (public_id);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('company', 'superuser')),
  display_name TEXT NOT NULL,
  email TEXT,
  access_code_hash TEXT NOT NULL,
  company_id INTEGER REFERENCES companies (id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (role = 'company' AND company_id IS NOT NULL)
    OR (role = 'superuser' AND company_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS users_public_id_unique ON users (public_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_access_code_hash_unique ON users (access_code_hash);
CREATE INDEX IF NOT EXISTS users_company_id_idx ON users (company_id);
