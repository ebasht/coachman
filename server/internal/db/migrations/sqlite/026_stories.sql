CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    width INTEGER NOT NULL DEFAULT 0,
    height INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS story_views (
    story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at INTEGER NOT NULL,
    PRIMARY KEY (story_id, viewer_id)
);

CREATE INDEX IF NOT EXISTS idx_stories_user_expires ON stories(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_stories_expires ON stories(expires_at);
CREATE INDEX IF NOT EXISTS idx_story_views_viewer ON story_views(viewer_id, story_id);
