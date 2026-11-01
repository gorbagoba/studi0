CREATE TABLE groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
ALTER TABLE subjects ADD COLUMN group_id TEXT REFERENCES groups(id);
CREATE INDEX idx_subjects_group ON subjects(group_id);
