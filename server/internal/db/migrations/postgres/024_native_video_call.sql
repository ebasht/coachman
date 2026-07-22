-- Native Android video-call capability on device push tokens.
ALTER TABLE device_push_tokens ADD COLUMN IF NOT EXISTS native_video_call BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE device_push_tokens ADD COLUMN IF NOT EXISTS native_call_protocol INTEGER NOT NULL DEFAULT 0;
