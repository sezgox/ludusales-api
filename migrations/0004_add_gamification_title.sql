ALTER TABLE gamifications
ADD COLUMN title TEXT NOT NULL DEFAULT 'Gamificación';

UPDATE gamifications
SET title = CASE public_id
  WHEN 'b1000000-0000-4000-8000-000000000001' THEN 'Reto de crecimiento Beta'
  WHEN 'b1000000-0000-4000-8000-000000000002' THEN 'Reto de verano Beta'
  WHEN 'c1000000-0000-4000-8000-000000000001' THEN 'Reto comercial Gamma'
  ELSE 'Gamificación'
END;
