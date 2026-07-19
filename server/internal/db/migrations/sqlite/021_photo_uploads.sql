CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    object_key TEXT NOT NULL,
    bucket TEXT NOT NULL,
    content_type TEXT NOT NULL,
    expected_size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    image_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id);

ALTER TABLE images ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN width INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN height INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN original_name TEXT;
