ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN invited_by_user_id TEXT REFERENCES users(id);
ALTER TABLE users ADD COLUMN root_user_id TEXT REFERENCES users(id);

CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    used_by_user_id TEXT REFERENCES users(id),
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_root ON users(root_user_id);
CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
