-- Per-chat monotonic sequence for ordering, sync, and gap recovery.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sequence BIGINT;

UPDATE messages m
SET sequence = r.seq
FROM (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY created_at ASC, id ASC) AS seq
  FROM messages
  WHERE sequence IS NULL
) r
WHERE m.id = r.id;

-- Safety for any leftover NULLs (should be none after backfill).
UPDATE messages m
SET sequence = r.seq
FROM (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY created_at ASC, id ASC) AS seq
  FROM messages
) r
WHERE m.id = r.id AND m.sequence IS NULL;

ALTER TABLE messages ALTER COLUMN sequence SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_sequence
  ON messages(chat_id, sequence);

CREATE TABLE IF NOT EXISTS chat_sequences (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    next_seq BIGINT NOT NULL
);

INSERT INTO chat_sequences (chat_id, next_seq)
SELECT chat_id, COALESCE(MAX(sequence), 0) + 1
FROM messages
GROUP BY chat_id
ON CONFLICT (chat_id) DO UPDATE
SET next_seq = GREATEST(chat_sequences.next_seq, EXCLUDED.next_seq);

INSERT INTO chat_sequences (chat_id, next_seq)
SELECT id, 1 FROM chats
ON CONFLICT (chat_id) DO NOTHING;
