INSERT INTO companies (public_id, name)
VALUES
  ('00000000-0000-4000-8000-000000000001', 'Empresa demo'),
  ('11111111-1111-4111-8111-111111111111', 'Ludus Sales Beta'),
  ('22222222-2222-4222-8222-222222222222', 'Ludus Sales Gamma')
ON CONFLICT(public_id) DO UPDATE SET
  name = excluded.name;

INSERT INTO users (public_id, role, display_name, email, access_code_hash, company_id)
VALUES
  (
    '99999999-9999-4999-8999-999999999999',
    'superuser',
    'Owner local',
    'owner@ludusales.local',
    'CaOHpuTkYPpTsPnn2_ySLAxTL5FDgbQUKJUtI0njtdU',
    NULL
  )
ON CONFLICT(public_id) DO UPDATE SET
  display_name = excluded.display_name,
  email = excluded.email,
  access_code_hash = excluded.access_code_hash,
  is_active = 1;

INSERT INTO users (public_id, role, display_name, email, access_code_hash, company_id)
SELECT
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'company',
  'Empresa demo',
  'demo@ludusales.local',
  'z2jjggVZ7dLgb7GtG2nIZklvToG8uRj9udau8ChlP10',
  companies.id
FROM companies
WHERE companies.public_id = '00000000-0000-4000-8000-000000000001'
ON CONFLICT(public_id) DO UPDATE SET
  display_name = excluded.display_name,
  email = excluded.email,
  access_code_hash = excluded.access_code_hash,
  company_id = excluded.company_id,
  is_active = 1;

INSERT INTO users (public_id, role, display_name, email, access_code_hash, company_id)
SELECT
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'company',
  'Ludus Sales Beta',
  'beta@ludusales.local',
  'eA3nO87J49DXP1blyxB9BmzBgcEApuUi88n8NGZvLHI',
  companies.id
FROM companies
WHERE companies.public_id = '11111111-1111-4111-8111-111111111111'
ON CONFLICT(public_id) DO UPDATE SET
  display_name = excluded.display_name,
  email = excluded.email,
  access_code_hash = excluded.access_code_hash,
  company_id = excluded.company_id,
  is_active = 1;

INSERT INTO users (public_id, role, display_name, email, access_code_hash, company_id)
SELECT
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'company',
  'Ludus Sales Gamma',
  'gamma@ludusales.local',
  'ruafH4ifA80G43UNbb0xizq5kclpj6En-Vg7yBVQMV0',
  companies.id
FROM companies
WHERE companies.public_id = '22222222-2222-4222-8222-222222222222'
ON CONFLICT(public_id) DO UPDATE SET
  display_name = excluded.display_name,
  email = excluded.email,
  access_code_hash = excluded.access_code_hash,
  company_id = excluded.company_id,
  is_active = 1;
