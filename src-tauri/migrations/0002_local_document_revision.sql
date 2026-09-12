ALTER TABLE local_sync_meta
ADD COLUMN document_revision INTEGER NOT NULL DEFAULT 0 CHECK (document_revision >= 0);
