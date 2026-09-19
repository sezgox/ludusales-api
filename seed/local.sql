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

-- Keep these demo gamifications deterministic on every local seed run:
-- Beta has one active and one finished gamification; Gamma has one active gamification.
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
  outcome,
  closed_at,
  actual_end_at
)
SELECT
  '99999999-0000-4000-8000-000000000001',
  companies.id,
  '<h2>Reto de verano Beta</h2><p>Gamificación finalizada tras alcanzar el objetivo del equipo comercial.</p>',
  NULL,
  '2026-06-01T00:00:00.000Z',
  '2026-07-31T23:59:59.000Z',
  1800000,
  2,
  '€ en ventas',
  'closed',
  'achieved',
  '2026-07-31T23:59:59.000Z',
  '2026-07-31T23:59:59.000Z'
FROM companies
WHERE companies.public_id = '11111111-1111-4111-8111-111111111111';

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
  'aaaaaaaa-0000-4000-8000-000000000002',
  companies.id,
  '<h2>Reto comercial Gamma</h2><p>Suma nuevas oportunidades, colabora con el equipo y alcanza la meta mensual.</p>',
  NULL,
  '2026-09-01T00:00:00.000Z',
  '2027-01-31T23:59:59.000Z',
  1200000,
  2,
  '€ en ventas',
  'active',
  'pending'
FROM companies
WHERE companies.public_id = '22222222-2222-4222-8222-222222222222';

INSERT INTO gamification_rules (gamification_id, position, title, description, icon_name) VALUES
  ((SELECT id FROM gamifications WHERE public_id = '33333333-3333-4333-8333-333333333333'), 1, 'Ventas cerradas', 'Suma puntos por cada venta realizada.', 'chart-column'),
  ((SELECT id FROM gamifications WHERE public_id = '33333333-3333-4333-8333-333333333333'), 2, 'Productos estratégicos', 'Multiplica tus puntos al vender productos clave.', 'award'),
  ((SELECT id FROM gamifications WHERE public_id = '33333333-3333-4333-8333-333333333333'), 3, 'Calidad y satisfacción', 'Las encuestas y la calidad también cuentan.', 'star');

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

INSERT INTO prizes (public_id, gamification_id, name, picture_key, sort_order, ranking_position, estimated_value_cents)
VALUES
  (
    '99999999-0000-4000-8000-000000000002',
    (SELECT id FROM gamifications WHERE public_id = '99999999-0000-4000-8000-000000000001'),
    'Experiencia de bienestar',
    NULL,
    0,
    1,
    12000
  ),
  (
    '99999999-0000-4000-8000-000000000003',
    (SELECT id FROM gamifications WHERE public_id = '99999999-0000-4000-8000-000000000001'),
    'Día libre',
    NULL,
    1,
    2,
    NULL
  ),
  (
    'aaaaaaaa-0000-4000-8000-000000000003',
    (SELECT id FROM gamifications WHERE public_id = 'aaaaaaaa-0000-4000-8000-000000000002'),
    'Escapada de fin de semana',
    NULL,
    0,
    1,
    25000
  ),
  (
    'aaaaaaaa-0000-4000-8000-000000000004',
    (SELECT id FROM gamifications WHERE public_id = 'aaaaaaaa-0000-4000-8000-000000000002'),
    'Tarjeta regalo',
    NULL,
    1,
    2,
    12000
  );

INSERT INTO participants (company_id, participant_code, full_name)
VALUES
  ((SELECT id FROM companies WHERE public_id = '11111111-1111-4111-8111-111111111111'), '66666666-6666-4666-8666-666666666666', 'Ana García'),
  ((SELECT id FROM companies WHERE public_id = '11111111-1111-4111-8111-111111111111'), '77777777-7777-4777-8777-777777777777', 'Bruno López'),
  ((SELECT id FROM companies WHERE public_id = '11111111-1111-4111-8111-111111111111'), '88888888-8888-4888-8888-888888888888', 'Carla Martín'),
  ((SELECT id FROM companies WHERE public_id = '11111111-1111-4111-8111-111111111111'), 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Diego Sánchez'),
  ((SELECT id FROM companies WHERE public_id = '11111111-1111-4111-8111-111111111111'), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'Elena Ruiz'),
  ((SELECT id FROM companies WHERE public_id = '11111111-1111-4111-8111-111111111111'), 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'Fernando Vega'),
  ((SELECT id FROM companies WHERE public_id = '11111111-1111-4111-8111-111111111111'), '12121212-1212-4212-8212-121212121212', 'Gabriela Torres'),
  ((SELECT id FROM companies WHERE public_id = '11111111-1111-4111-8111-111111111111'), '34343434-3434-4434-8434-343434343434', 'Hugo Martín')
ON CONFLICT(company_id, participant_code) DO UPDATE SET
  full_name = excluded.full_name,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO rankings (gamification_id, participant_id, score_value) VALUES
  ((SELECT id FROM gamifications WHERE public_id = '33333333-3333-4333-8333-333333333333'), (SELECT id FROM participants WHERE participant_code = '66666666-6666-4666-8666-666666666666'), 425000),
  ((SELECT id FROM gamifications WHERE public_id = '33333333-3333-4333-8333-333333333333'), (SELECT id FROM participants WHERE participant_code = '77777777-7777-4777-8777-777777777777'), 425000),
  ((SELECT id FROM gamifications WHERE public_id = '33333333-3333-4333-8333-333333333333'), (SELECT id FROM participants WHERE participant_code = '88888888-8888-4888-8888-888888888888'), 350050),
  ((SELECT id FROM gamifications WHERE public_id = '33333333-3333-4333-8333-333333333333'), (SELECT id FROM participants WHERE participant_code = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'), 275000),
  ((SELECT id FROM gamifications WHERE public_id = '33333333-3333-4333-8333-333333333333'), (SELECT id FROM participants WHERE participant_code = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'), 235000),
  ((SELECT id FROM gamifications WHERE public_id = '33333333-3333-4333-8333-333333333333'), (SELECT id FROM participants WHERE participant_code = 'ffffffff-ffff-4fff-8fff-ffffffffffff'), 195000),
  ((SELECT id FROM gamifications WHERE public_id = '33333333-3333-4333-8333-333333333333'), (SELECT id FROM participants WHERE participant_code = '12121212-1212-4212-8212-121212121212'), 160000),
  ((SELECT id FROM gamifications WHERE public_id = '33333333-3333-4333-8333-333333333333'), (SELECT id FROM participants WHERE participant_code = '34343434-3434-4434-8434-343434343434'), 120000);

INSERT INTO rankings (gamification_id, participant_id, score_value) VALUES
  ((SELECT id FROM gamifications WHERE public_id = '99999999-0000-4000-8000-000000000001'), (SELECT id FROM participants WHERE participant_code = '66666666-6666-4666-8666-666666666666'), 700000),
  ((SELECT id FROM gamifications WHERE public_id = '99999999-0000-4000-8000-000000000001'), (SELECT id FROM participants WHERE participant_code = '77777777-7777-4777-8777-777777777777'), 600000),
  ((SELECT id FROM gamifications WHERE public_id = '99999999-0000-4000-8000-000000000001'), (SELECT id FROM participants WHERE participant_code = '88888888-8888-4888-8888-888888888888'), 500000);

INSERT INTO participants (company_id, participant_code, full_name) VALUES
  ((SELECT id FROM companies WHERE public_id = '22222222-2222-4222-8222-222222222222'), '00000000-0000-4000-8000-000000000010', 'Irene Navarro'),
  ((SELECT id FROM companies WHERE public_id = '22222222-2222-4222-8222-222222222222'), '00000000-0000-4000-8000-000000000011', 'Jorge Molina'),
  ((SELECT id FROM companies WHERE public_id = '22222222-2222-4222-8222-222222222222'), '00000000-0000-4000-8000-000000000012', 'Lucía Romero')
ON CONFLICT(company_id, participant_code) DO UPDATE SET
  full_name = excluded.full_name,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO rankings (gamification_id, participant_id, score_value) VALUES
  ((SELECT id FROM gamifications WHERE public_id = 'aaaaaaaa-0000-4000-8000-000000000002'), (SELECT id FROM participants WHERE participant_code = '00000000-0000-4000-8000-000000000010'), 310000),
  ((SELECT id FROM gamifications WHERE public_id = 'aaaaaaaa-0000-4000-8000-000000000002'), (SELECT id FROM participants WHERE participant_code = '00000000-0000-4000-8000-000000000011'), 270000),
  ((SELECT id FROM gamifications WHERE public_id = 'aaaaaaaa-0000-4000-8000-000000000002'), (SELECT id FROM participants WHERE participant_code = '00000000-0000-4000-8000-000000000012'), 220000);

UPDATE gamifications
SET ranking_field_headers_json = '["Email","Localización","Equipo"]'
WHERE public_id = '33333333-3333-4333-8333-333333333333';

UPDATE rankings
SET custom_fields_json = CASE participant_id
  WHEN (SELECT id FROM participants WHERE participant_code = '66666666-6666-4666-8666-666666666666') THEN '{"Email":"ana@ludusales.local","Localización":"Valencia","Equipo":"Levante"}'
  WHEN (SELECT id FROM participants WHERE participant_code = '77777777-7777-4777-8777-777777777777') THEN '{"Email":"bruno@ludusales.local","Localización":"Madrid","Equipo":"Centro"}'
  ELSE '{}'
END
WHERE gamification_id = (SELECT id FROM gamifications WHERE public_id = '33333333-3333-4333-8333-333333333333');

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
