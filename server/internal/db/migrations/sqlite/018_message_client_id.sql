-- Idempotent client-originated message id (outbox retries / reconnect).
ALTER TABLE messages ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id
  ON messages(chat_id, sender_id, client_id)
  WHERE client_id IS NOT NULL AND client_id != '';
