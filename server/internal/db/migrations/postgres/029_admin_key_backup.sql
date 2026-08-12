CREATE TABLE IF NOT EXISTS admin_key_backup (
    user_id TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    iv TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
);
