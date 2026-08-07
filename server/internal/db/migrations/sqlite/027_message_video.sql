-- SQLite cannot ALTER CHECK constraints; rebuild messages to allow video type.
PRAGMA foreign_keys=OFF;

CREATE TABLE IF NOT EXISTS messages__video (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'image', 'call', 'list', 'video')),
    image_id TEXT,
    created_at INTEGER NOT NULL,
    album_id TEXT,
    client_id TEXT,
    sequence INTEGER NOT NULL DEFAULT 0,
    reply_to_message_id TEXT
);

INSERT OR IGNORE INTO messages__video
SELECT id, chat_id, sender_id, ciphertext, iv, type, image_id, created_at,
       album_id, client_id, sequence, reply_to_message_id
FROM messages;

DROP TABLE IF EXISTS messages;
ALTER TABLE messages__video RENAME TO messages;

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_album ON messages(album_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id
  ON messages(chat_id, sender_id, client_id)
  WHERE client_id IS NOT NULL AND client_id != '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_sequence
  ON messages(chat_id, sequence);
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to_message_id);

PRAGMA foreign_keys=ON;
