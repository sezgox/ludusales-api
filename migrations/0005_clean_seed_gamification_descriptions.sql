UPDATE gamifications
SET description = CASE public_id
  WHEN 'b1000000-0000-4000-8000-000000000001' THEN '<p>Impulsa las ventas, supera el objetivo comercial y escala posiciones en el ranking.</p>'
  WHEN 'b1000000-0000-4000-8000-000000000002' THEN '<p>Gamificación finalizada tras alcanzar el objetivo del equipo comercial.</p>'
  WHEN 'c1000000-0000-4000-8000-000000000001' THEN '<p>Suma nuevas oportunidades, colabora con el equipo y alcanza la meta mensual.</p>'
  ELSE description
END,
updated_at = CURRENT_TIMESTAMP
WHERE public_id IN (
  'b1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000001'
);
