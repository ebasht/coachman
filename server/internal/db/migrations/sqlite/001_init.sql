CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    public_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
    name TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_members (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_group_key TEXT,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text' CHECK(type IN ('text', 'image')),
    image_id TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    uploader_id TEXT NOT NULL REFERENCES users(id),
    ciphertext BLOB NOT NULL,
    iv TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
