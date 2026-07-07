ALTER TABLE users ADD COLUMN signing_public_key TEXT;

CREATE TABLE IF NOT EXISTS auth_challenges (
    username TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
