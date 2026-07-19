CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    object_key TEXT NOT NULL,
    bucket TEXT NOT NULL,
    content_type TEXT NOT NULL,
    expected_size BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    image_id TEXT,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id);

ALTER TABLE images ADD COLUMN IF NOT EXISTS size_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN IF NOT EXISTS width INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN IF NOT EXISTS height INTEGER NOT NULL DEFAULT 0;
ALTER TABLE images ADD COLUMN IF NOT EXISTS original_name TEXT;
