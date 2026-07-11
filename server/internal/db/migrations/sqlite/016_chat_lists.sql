CREATE TABLE IF NOT EXISTS chat_lists (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    title_ciphertext TEXT NOT NULL,
    title_iv TEXT NOT NULL,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_lists_chat ON chat_lists(chat_id);

CREATE TABLE IF NOT EXISTS chat_list_items (
    id TEXT PRIMARY KEY,
    list_id TEXT NOT NULL REFERENCES chat_lists(id) ON DELETE CASCADE,
    text_ciphertext TEXT NOT NULL,
    text_iv TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_list_items_list ON chat_list_items(list_id, position, created_at);
