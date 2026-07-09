CREATE TABLE IF NOT EXISTS chat_read_state (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_read_state_chat ON chat_read_state(chat_id);
