BEGIN TRANSACTION;

INSERT OR IGNORE INTO media_deletion_queue (object_key)
SELECT image_key FROM gamifications WHERE image_key IS NOT NULL
UNION
SELECT picture_key FROM prizes WHERE picture_key IS NOT NULL
UNION
SELECT picture_key FROM rankings WHERE picture_key IS NOT NULL;

DELETE FROM users;
DELETE FROM companies;

COMMIT;
