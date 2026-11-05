-- Local chat transcript. The opencode engine keeps messages in opencode's own
-- store; the native chat engine (CHAT_ENGINE=native) has no such store, so its
-- turns persist user/assistant texts here. GET /messages serves these rows when
-- present and falls back to opencode otherwise.
CREATE TABLE chat_messages (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_messages_s ON chat_messages(session_id);
