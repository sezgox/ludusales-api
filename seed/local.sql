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

-- Keep these two demo companies deterministic on every local seed run:
-- Beta has one active gamification; Gamma has none.
DELETE FROM gamifications
WHERE company_id IN (
  SELECT id
  FROM companies
  WHERE public_id IN (
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222'
  )
);

INSERT INTO gamifications (
  public_id,
  company_id,
  description,
  image_key,
  start_at,
  end_at,
  goal_value,
  value_precision,
  goal_unit,
  status,
  outcome
)
SELECT
  '33333333-3333-4333-8333-333333333333',
  companies.id,
  '<h2>Reto comercial Beta</h2><p>Supera el objetivo de ventas y escala posiciones en el ranking.</p><blockquote>Cada venta suma. El trabajo en equipo marca la diferencia.</blockquote>',
  NULL,
  '2026-09-01T00:00:00.000Z',
  '2099-12-31T23:59:59.000Z',
  1500000,
  2,
  '€ en ventas',
  'active',
  'pending'
FROM companies
WHERE companies.public_id = '11111111-1111-4111-8111-111111111111';

INSERT INTO prizes (public_id, gamification_id, name, picture_key, sort_order, ranking_position, estimated_value_cents)
SELECT
  seed_prizes.public_id,
  gamifications.id,
  seed_prizes.name,
  NULL,
  seed_prizes.sort_order,
  seed_prizes.ranking_position,
  seed_prizes.estimated_value_cents
FROM gamifications
JOIN (
  SELECT
    '44444444-4444-4444-8444-444444444444' AS public_id,
    'Experiencia gastronómica' AS name,
    0 AS sort_order,
    1 AS ranking_position,
    15000 AS estimated_value_cents
  UNION ALL
  SELECT
    '55555555-5555-4555-8555-555555555555',
    'Tarjeta regalo',
    1,
    2,
    NULL
) AS seed_prizes
WHERE gamifications.public_id = '33333333-3333-4333-8333-333333333333';

INSERT INTO rankings (gamification_id, external_participant_id, full_name, score_value)
SELECT
  gamifications.id,
  seed_rankings.external_participant_id,
  seed_rankings.full_name,
  seed_rankings.score_value
FROM gamifications
JOIN (
  SELECT
    '66666666-6666-4666-8666-666666666666' AS external_participant_id,
    'Ana García' AS full_name,
    425000 AS score_value
  UNION ALL
  SELECT
    '77777777-7777-4777-8777-777777777777',
    'Bruno López',
    425000
  UNION ALL
  SELECT
    '88888888-8888-4888-8888-888888888888',
    'Carla Martín',
    350050
  UNION ALL
  SELECT
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'Diego Sánchez',
    275000
) AS seed_rankings
WHERE gamifications.public_id = '33333333-3333-4333-8333-333333333333';

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
