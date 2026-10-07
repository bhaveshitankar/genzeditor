-- Client failure telemetry (no IP or user identifiers stored) and user feedback.
CREATE TABLE IF NOT EXISTS client_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  app TEXT NOT NULL,
  version TEXT,
  type TEXT NOT NULL,
  where_ TEXT,
  message TEXT,
  kind TEXT,
  platform TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_events_ts ON client_events(ts);

CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  email TEXT,
  user_id TEXT,
  app TEXT,
  version TEXT,
  file_kind TEXT,
  platform TEXT,
  path TEXT,
  status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS idx_feedback_ts ON feedback(ts);
