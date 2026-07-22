-- Native Android video-call capability on device push tokens.
-- INTEGER 0/1 (not BOOLEAN) so Go COALESCE(..., 0) / boolToInt work on Postgres+SQLite.
ALTER TABLE device_push_tokens ADD COLUMN IF NOT EXISTS native_video_call INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_push_tokens ADD COLUMN IF NOT EXISTS native_call_protocol INTEGER NOT NULL DEFAULT 0;
