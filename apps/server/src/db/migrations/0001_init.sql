CREATE TABLE subjects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  path          TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_built_at TEXT
);
CREATE TABLE files (
  id         TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id),
  rel_path   TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  mtime      TEXT NOT NULL,
  origin     TEXT NOT NULL,
  UNIQUE (subject_id, rel_path)
);
CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,
  subject_id     TEXT NOT NULL REFERENCES subjects(id),
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL,
  progress_done  INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  current_file   TEXT,
  partial_json   TEXT,
  error          TEXT,
  pid            TEXT,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);
CREATE TABLE lessons (
  id             TEXT PRIMARY KEY,
  subject_id     TEXT NOT NULL REFERENCES subjects(id),
  rel_path       TEXT NOT NULL,
  title          TEXT NOT NULL,
  node_tags_json TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (subject_id, rel_path)
);
CREATE TABLE chat_sessions (
  id            TEXT PRIMARY KEY,
  subject_id    TEXT NOT NULL REFERENCES subjects(id),
  lesson_id     TEXT REFERENCES lessons(id),
  oc_session_id TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  msg_count     INTEGER NOT NULL DEFAULT 0,
  summary_path  TEXT,
  created_at    TEXT NOT NULL,
  rotated_at    TEXT
);
CREATE TABLE questions (
  id           TEXT PRIMARY KEY,
  subject_id   TEXT NOT NULL REFERENCES subjects(id),
  lesson_id    TEXT REFERENCES lessons(id),
  topic        TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  key_json     TEXT NOT NULL,
  key_status   TEXT NOT NULL,
  source       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE attempts (
  id          TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES questions(id),
  subject_id  TEXT NOT NULL,
  answer      TEXT NOT NULL,
  grade_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE schedule (
  question_id    TEXT PRIMARY KEY REFERENCES questions(id),
  subject_id     TEXT NOT NULL,
  due_at         TEXT NOT NULL,
  interval_index INTEGER NOT NULL DEFAULT 0,
  correct_streak INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_jobs_sub    ON jobs(subject_id, status);
CREATE INDEX idx_sched_due   ON schedule(subject_id, due_at);
CREATE INDEX idx_attempts_q  ON attempts(question_id);
CREATE INDEX idx_questions_s ON questions(subject_id, topic);
