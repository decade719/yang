CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 24),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 2 AND 500),
  created_at INTEGER NOT NULL,
  client_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  session_nonce TEXT NOT NULL UNIQUE
);

CREATE INDEX messages_chronological ON messages(created_at DESC, id DESC);
CREATE INDEX messages_client_time ON messages(client_hash, created_at DESC);
CREATE INDEX messages_duplicate ON messages(client_hash, content_hash, created_at DESC);
