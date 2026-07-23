ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to_message_id);
