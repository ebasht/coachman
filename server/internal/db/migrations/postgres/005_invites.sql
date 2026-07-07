ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by_user_id TEXT REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS root_user_id TEXT REFERENCES users(id);

CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    created_by_user_id TEXT NOT NULL REFERENCES users(id),
    used_by_user_id TEXT REFERENCES users(id),
    expires_at BIGINT,
    created_at BIGINT NOT NULL,
    used_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_users_root ON users(root_user_id);
CREATE INDEX IF NOT EXISTS idx_invites_token ON invites(token);
