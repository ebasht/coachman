-- SQLite cannot ALTER CHECK constraints; rebuild messages to allow call/list types.
PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS messages__event_types (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'image', 'call', 'list')),
    image_id TEXT,
    created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO messages__event_types
SELECT id, chat_id, sender_id, ciphertext, iv, type, image_id, created_at
FROM messages;

DROP TABLE IF EXISTS messages;
ALTER TABLE messages__event_types RENAME TO messages;

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

PRAGMA foreign_keys=ON;
