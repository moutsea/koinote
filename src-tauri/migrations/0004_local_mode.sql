CREATE TABLE IF NOT EXISTS local_mode_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  salt_base64 TEXT NOT NULL,
  verifier_base64 TEXT NOT NULL,
  iterations INTEGER NOT NULL CHECK (iterations >= 100000),
  created_at TEXT NOT NULL
);
