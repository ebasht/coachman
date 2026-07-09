CREATE TABLE IF NOT EXISTS hidden_direct_chats (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    peer_user_id TEXT NOT NULL,
    hidden_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, peer_user_id)
);

CREATE INDEX IF NOT EXISTS idx_hidden_direct_chats_user ON hidden_direct_chats(user_id);
