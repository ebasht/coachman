-- Native Android video-call capability on device push tokens.
ALTER TABLE device_push_tokens ADD COLUMN native_video_call INTEGER NOT NULL DEFAULT 0;
ALTER TABLE device_push_tokens ADD COLUMN native_call_protocol INTEGER NOT NULL DEFAULT 0;
