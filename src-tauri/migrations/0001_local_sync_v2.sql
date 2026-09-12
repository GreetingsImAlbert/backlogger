PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS local_sync_categories (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  sort_key TEXT NOT NULL CHECK (length(sort_key) > 0),
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  deleted_at TEXT,
  updated_by_device_id TEXT NOT NULL CHECK (length(updated_by_device_id) > 0),
  field_updated_at_json TEXT NOT NULL CHECK (json_valid(field_updated_at_json)),
  change_seq INTEGER NOT NULL CHECK (change_seq >= 0)
);

CREATE TABLE IF NOT EXISTS local_sync_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  category_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  scheduled_dates_json TEXT NOT NULL CHECK (json_valid(scheduled_dates_json)),
  deadline_date TEXT,
  sort_key TEXT NOT NULL CHECK (length(sort_key) > 0),
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 0),
  deleted_at TEXT,
  updated_by_device_id TEXT NOT NULL CHECK (length(updated_by_device_id) > 0),
  field_updated_at_json TEXT NOT NULL CHECK (json_valid(field_updated_at_json)),
  change_seq INTEGER NOT NULL CHECK (change_seq >= 0),
  FOREIGN KEY (category_id) REFERENCES local_sync_categories(id) ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS local_sync_bases (
  record_type TEXT NOT NULL CHECK (record_type IN ('category', 'task')),
  record_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (record_type, record_id)
);

CREATE TABLE IF NOT EXISTS local_sync_outbox (
  record_type TEXT NOT NULL CHECK (record_type IN ('category', 'task')),
  record_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  project_ref TEXT NOT NULL,
  notebook_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, project_ref, notebook_id, record_type, record_id)
);

CREATE TABLE IF NOT EXISTS local_sync_meta (
  singleton INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  device_id TEXT NOT NULL CHECK (length(device_id) > 0),
  account_id TEXT,
  project_ref TEXT,
  notebook_id TEXT,
  last_change_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_change_seq >= 0),
  state TEXT NOT NULL,
  last_error TEXT,
  legacy_import_complete INTEGER NOT NULL DEFAULT 0 CHECK (legacy_import_complete IN (0, 1)),
  legacy_imported_at TEXT
);

CREATE TABLE IF NOT EXISTS local_preferences (
  singleton INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK (singleton = 1),
  view_mode TEXT NOT NULL CHECK (view_mode IN ('all', 'today', 'tomorrow')),
  theme TEXT NOT NULL CHECK (theme IN ('dark', 'light')),
  color_theme TEXT NOT NULL CHECK (color_theme IN ('neutral', 'violet', 'ocean', 'forest', 'rose'))
);

CREATE TABLE IF NOT EXISTS local_recovery_backups (
  backup_id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) > 0),
  document_json TEXT NOT NULL CHECK (json_valid(document_json))
);

CREATE INDEX IF NOT EXISTS local_sync_categories_order_idx
  ON local_sync_categories(deleted_at, sort_key, id);
CREATE INDEX IF NOT EXISTS local_sync_tasks_category_order_idx
  ON local_sync_tasks(category_id, deleted_at, sort_key, id);
CREATE INDEX IF NOT EXISTS local_sync_outbox_updated_idx
  ON local_sync_outbox(account_id, project_ref, notebook_id, updated_at, record_type, record_id);
CREATE INDEX IF NOT EXISTS local_recovery_backups_created_idx
  ON local_recovery_backups(created_at, backup_id);
