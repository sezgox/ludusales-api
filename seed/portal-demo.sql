-- Local-only company and sample score data from the portal mockup.
INSERT OR IGNORE INTO companies (public_id, name)
VALUES ('11000000-0000-4000-8000-000000000014', 'Ludus Sales · Demo portal');

INSERT OR IGNORE INTO users (public_id, role, display_name, access_code_hash, company_id)
SELECT '11000000-0000-4000-8000-000000000015', 'company', 'Demo portal',
       '0xsfMCvl13ARG3WRD_YgZSVm9Rw-IMGj26qRyO4hBpg', id
FROM companies WHERE public_id = '11000000-0000-4000-8000-000000000014';

INSERT OR IGNORE INTO gamifications (
  public_id, company_id, title, description, start_at, end_at, goal_value, value_precision,
  goal_unit, ranking_unit, status, outcome, ranking_field_headers_json
)
SELECT '11000000-0000-4000-8000-000000000016', id, 'Super Reto Comercial',
       '<p>Reto comercial de demostración. Sigue tu clasificación, consulta los premios y revisa tu evolución.</p>',
       date('now', '-18 days'), date('now', '+12 days'), 4500, 0, 'pts', 'pts', 'active', 'pending', '["Zona"]'
FROM companies WHERE public_id = '11000000-0000-4000-8000-000000000014';

UPDATE gamifications SET tv_enabled = 1 WHERE public_id = '11000000-0000-4000-8000-000000000016';

INSERT OR IGNORE INTO gamifications (
  public_id, company_id, title, description, start_at, end_at, goal_value, value_precision,
  goal_unit, ranking_unit, status, outcome, closed_at, actual_end_at
)
SELECT '11000000-0000-4000-8000-000000000017', id, 'Reto de apertura',
       '<p>Primera campaña comercial de demostración.</p>', date('now', '-60 days'), date('now', '-31 days'),
       NULL, 0, NULL, 'pts', 'closed', 'not_applicable', datetime('now', '-31 days'), datetime('now', '-31 days')
FROM companies WHERE public_id = '11000000-0000-4000-8000-000000000014';

INSERT OR IGNORE INTO prizes (public_id, gamification_id, name, sort_order, ranking_position)
SELECT '11000000-0000-4000-8000-000000000018', id, 'Escapada de fin de semana', 1, 1
FROM gamifications WHERE public_id = '11000000-0000-4000-8000-000000000016';

WITH demo(participant_code, full_name, zone, score, week) AS (VALUES
    ('portal-01', 'Alejandro García Fernández', 'Madrid', 395, 48),
    ('portal-02', 'Lucía Martínez López', 'Barcelona', 372, 61),
    ('portal-03', 'Javier Rodríguez Sánchez', 'Madrid', 348, 22),
    ('portal-04', 'Carmen Jiménez Moreno', 'Valencia', 341, 39),
    ('portal-05', 'Álvaro Pérez Navarro', 'Sevilla', 302, 44),
    ('portal-06', 'Marta Ruiz Castillo', 'Barcelona', 278, 46),
    ('portal-07', 'Daniel Hernández Romero', 'Madrid', 254, 12),
    ('portal-08', 'Isabel Torres Delgado', 'Valencia', 231, 18),
    ('portal-09', 'Hugo Álvarez Domínguez', 'Sevilla', 207, 29),
    ('portal-10', 'Paula Sánchez Molina', 'Madrid', 184, 15),
    ('portal-11', 'Sergio Ortega Vázquez', 'Barcelona', 160, 10),
    ('portal-12', 'Elena Muñoz Herrera', 'Valencia', 137, 18),
    ('portal-13', 'Adrián Castro Serrano', 'Madrid', 112, 6),
    ('portal-14', 'Claudia Ramos Iglesias', 'Sevilla', 83, 9),
    ('portal-15', 'Nicolás Gutiérrez Medina', 'Barcelona', 64, 4)
)
INSERT OR IGNORE INTO participants (company_id, participant_code, full_name)
SELECT c.id, demo.participant_code, demo.full_name FROM demo CROSS JOIN companies c
WHERE c.public_id = '11000000-0000-4000-8000-000000000014';

WITH demo(participant_code, full_name, zone, score, week) AS (VALUES
    ('portal-01', 'Alejandro García Fernández', 'Madrid', 395, 48),
    ('portal-02', 'Lucía Martínez López', 'Barcelona', 372, 61),
    ('portal-03', 'Javier Rodríguez Sánchez', 'Madrid', 348, 22),
    ('portal-04', 'Carmen Jiménez Moreno', 'Valencia', 341, 39),
    ('portal-05', 'Álvaro Pérez Navarro', 'Sevilla', 302, 44),
    ('portal-06', 'Marta Ruiz Castillo', 'Barcelona', 278, 46),
    ('portal-07', 'Daniel Hernández Romero', 'Madrid', 254, 12),
    ('portal-08', 'Isabel Torres Delgado', 'Valencia', 231, 18),
    ('portal-09', 'Hugo Álvarez Domínguez', 'Sevilla', 207, 29),
    ('portal-10', 'Paula Sánchez Molina', 'Madrid', 184, 15),
    ('portal-11', 'Sergio Ortega Vázquez', 'Barcelona', 160, 10),
    ('portal-12', 'Elena Muñoz Herrera', 'Valencia', 137, 18),
    ('portal-13', 'Adrián Castro Serrano', 'Madrid', 112, 6),
    ('portal-14', 'Claudia Ramos Iglesias', 'Sevilla', 83, 9),
    ('portal-15', 'Nicolás Gutiérrez Medina', 'Barcelona', 64, 4)
)
INSERT OR IGNORE INTO rankings (gamification_id, participant_id, score_value, custom_fields_json)
SELECT g.id, p.id, demo.score, json_object('Zona', demo.zone)
FROM demo JOIN participants p ON p.participant_code = demo.participant_code
JOIN gamifications g ON g.company_id = p.company_id
WHERE g.public_id = '11000000-0000-4000-8000-000000000016';

INSERT OR IGNORE INTO challenge_members (gamification_id, participant_id, zone)
SELECT r.gamification_id, r.participant_id, json_extract(r.custom_fields_json, '$.Zona')
FROM rankings r JOIN gamifications g ON g.id = r.gamification_id
WHERE g.public_id = '11000000-0000-4000-8000-000000000016';

INSERT OR IGNORE INTO data_updates (public_id, gamification_id, published_at, value_precision, field_headers_json)
SELECT 'portal-demo-' || series.number, g.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', series.offset), 0, '["Zona"]'
FROM gamifications g CROSS JOIN (SELECT 1 AS number, '-7 days' AS offset UNION ALL SELECT 2, '-1 day') series
WHERE g.public_id = '11000000-0000-4000-8000-000000000016' ORDER BY series.number;

WITH demo(participant_code, full_name, zone, score, week) AS (VALUES
    ('portal-01', 'Alejandro García Fernández', 'Madrid', 395, 48),
    ('portal-02', 'Lucía Martínez López', 'Barcelona', 372, 61),
    ('portal-03', 'Javier Rodríguez Sánchez', 'Madrid', 348, 22),
    ('portal-04', 'Carmen Jiménez Moreno', 'Valencia', 341, 39),
    ('portal-05', 'Álvaro Pérez Navarro', 'Sevilla', 302, 44),
    ('portal-06', 'Marta Ruiz Castillo', 'Barcelona', 278, 46),
    ('portal-07', 'Daniel Hernández Romero', 'Madrid', 254, 12),
    ('portal-08', 'Isabel Torres Delgado', 'Valencia', 231, 18),
    ('portal-09', 'Hugo Álvarez Domínguez', 'Sevilla', 207, 29),
    ('portal-10', 'Paula Sánchez Molina', 'Madrid', 184, 15),
    ('portal-11', 'Sergio Ortega Vázquez', 'Barcelona', 160, 10),
    ('portal-12', 'Elena Muñoz Herrera', 'Valencia', 137, 18),
    ('portal-13', 'Adrián Castro Serrano', 'Madrid', 112, 6),
    ('portal-14', 'Claudia Ramos Iglesias', 'Sevilla', 83, 9),
    ('portal-15', 'Nicolás Gutiérrez Medina', 'Barcelona', 64, 4)
)
INSERT OR IGNORE INTO participant_results (update_id, participant_id, score_value, position, custom_fields_json)
SELECT u.id, p.id, demo.score - demo.week,
       RANK() OVER (ORDER BY demo.score - demo.week DESC), json_object('Zona', demo.zone)
FROM data_updates u JOIN gamifications g ON g.id = u.gamification_id
JOIN participants p ON p.company_id = g.company_id JOIN demo ON demo.participant_code = p.participant_code
WHERE u.public_id = 'portal-demo-1';

INSERT OR IGNORE INTO participant_results (update_id, participant_id, score_value, position, custom_fields_json)
SELECT u.id, r.participant_id, r.score_value, RANK() OVER (ORDER BY r.score_value DESC), r.custom_fields_json
FROM data_updates u JOIN rankings r ON r.gamification_id = u.gamification_id WHERE u.public_id = 'portal-demo-2';
