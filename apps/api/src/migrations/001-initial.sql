CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data))
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data))
);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data))
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data))
);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data))
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data))
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

INSERT OR IGNORE INTO counters (name, value) VALUES ('upload_order', 0);

CREATE INDEX IF NOT EXISTS receipt_sha
  ON receipts(json_extract(data, '$.original.sha256'));
CREATE INDEX IF NOT EXISTS receipt_month
  ON receipts(json_extract(data, '$.month'));
CREATE INDEX IF NOT EXISTS receipt_status
  ON receipts(json_extract(data, '$.status'));
CREATE INDEX IF NOT EXISTS receipt_batch
  ON receipts(json_extract(data, '$.batchId'));
