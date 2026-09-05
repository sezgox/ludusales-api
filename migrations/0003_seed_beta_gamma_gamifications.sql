INSERT INTO companies (public_id, name)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'Ludus Sales Beta'),
  ('22222222-2222-4222-8222-222222222222', 'Ludus Sales Gamma')
ON CONFLICT(public_id) DO UPDATE SET
  name = excluded.name;

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
  closed_at
)
SELECT
  'b1000000-0000-4000-8000-000000000001',
  companies.id,
  '<h2>Reto de crecimiento Beta</h2><p>Impulsa las ventas, supera el objetivo comercial y escala posiciones en el ranking.</p>',
  NULL,
  '2026-09-01T00:00:00.000Z',
  '2026-12-31T23:59:59.000Z',
  2500000,
  2,
  'EUR en ventas',
  'active',
  'pending',
  NULL
FROM companies
WHERE companies.public_id = '11111111-1111-4111-8111-111111111111'
ON CONFLICT(public_id) DO UPDATE SET
  company_id = excluded.company_id,
  description = excluded.description,
  image_key = excluded.image_key,
  start_at = excluded.start_at,
  end_at = excluded.end_at,
  goal_value = excluded.goal_value,
  value_precision = excluded.value_precision,
  goal_unit = excluded.goal_unit,
  status = excluded.status,
  outcome = excluded.outcome,
  updated_at = CURRENT_TIMESTAMP,
  closed_at = excluded.closed_at;

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
  closed_at
)
SELECT
  'b1000000-0000-4000-8000-000000000002',
  companies.id,
  '<h2>Reto de verano Beta</h2><p>Gamificacion finalizada tras alcanzar el objetivo del equipo comercial.</p>',
  NULL,
  '2026-06-01T00:00:00.000Z',
  '2026-07-31T23:59:59.000Z',
  1800000,
  2,
  'EUR en ventas',
  'closed',
  'achieved',
  '2026-07-31T23:59:59.000Z'
FROM companies
WHERE companies.public_id = '11111111-1111-4111-8111-111111111111'
ON CONFLICT(public_id) DO UPDATE SET
  company_id = excluded.company_id,
  description = excluded.description,
  image_key = excluded.image_key,
  start_at = excluded.start_at,
  end_at = excluded.end_at,
  goal_value = excluded.goal_value,
  value_precision = excluded.value_precision,
  goal_unit = excluded.goal_unit,
  status = excluded.status,
  outcome = excluded.outcome,
  updated_at = CURRENT_TIMESTAMP,
  closed_at = excluded.closed_at;

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
  closed_at
)
SELECT
  'c1000000-0000-4000-8000-000000000001',
  companies.id,
  '<h2>Reto comercial Gamma</h2><p>Suma nuevas oportunidades, colabora con el equipo y alcanza la meta mensual.</p>',
  NULL,
  '2026-09-01T00:00:00.000Z',
  '2027-01-31T23:59:59.000Z',
  1200000,
  2,
  'EUR en ventas',
  'active',
  'pending',
  NULL
FROM companies
WHERE companies.public_id = '22222222-2222-4222-8222-222222222222'
ON CONFLICT(public_id) DO UPDATE SET
  company_id = excluded.company_id,
  description = excluded.description,
  image_key = excluded.image_key,
  start_at = excluded.start_at,
  end_at = excluded.end_at,
  goal_value = excluded.goal_value,
  value_precision = excluded.value_precision,
  goal_unit = excluded.goal_unit,
  status = excluded.status,
  outcome = excluded.outcome,
  updated_at = CURRENT_TIMESTAMP,
  closed_at = excluded.closed_at;
