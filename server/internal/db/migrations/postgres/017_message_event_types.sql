-- Allow encrypted system markers for calls and shared lists.
-- Include 'video' so re-running this migration stays compatible after 027
-- (migrate() re-applies every file on startup; a narrower CHECK would fail
-- once video rows exist).
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text', 'image', 'call', 'list', 'video'));
