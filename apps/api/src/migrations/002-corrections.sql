CREATE TABLE IF NOT EXISTS corrections (
  receipt_id TEXT NOT NULL,
  category TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY (receipt_id, category)
);
