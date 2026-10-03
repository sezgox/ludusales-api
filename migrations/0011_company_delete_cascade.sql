-- A company owns its account, gamifications and participant profiles. Rebuild
-- the original users FK so deleting a company removes its company users too.
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('company', 'superuser')),
  display_name TEXT NOT NULL,
  email TEXT,
  access_code_hash TEXT NOT NULL,
  company_id INTEGER REFERENCES companies (id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (role = 'company' AND company_id IS NOT NULL)
    OR (role = 'superuser' AND company_id IS NULL)
  )
);

INSERT INTO users_new (id, public_id, role, display_name, email, access_code_hash, company_id, is_active, created_at)
SELECT id, public_id, role, display_name, email, access_code_hash, company_id, is_active, created_at
FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

CREATE UNIQUE INDEX users_public_id_unique ON users (public_id);
CREATE UNIQUE INDEX users_access_code_hash_unique ON users (access_code_hash);
CREATE INDEX users_company_id_idx ON users (company_id);
