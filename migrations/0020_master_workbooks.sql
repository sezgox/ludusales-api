CREATE TABLE master_workbook_parts (
  update_id INTEGER NOT NULL REFERENCES data_updates(id) ON DELETE CASCADE,
  part_index INTEGER NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (update_id, part_index)
);
