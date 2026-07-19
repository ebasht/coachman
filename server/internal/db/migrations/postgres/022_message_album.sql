ALTER TABLE messages ADD COLUMN IF NOT EXISTS album_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_album ON messages(album_id);
