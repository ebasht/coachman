-- Per-chat monotonic sequence for ordering, sync, and gap recovery.
ALTER TABLE messages ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;

UPDATE messages
SET sequence = (
  SELECT seq FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY created_at ASC, id ASC) AS seq
    FROM messages
  ) ranked
  WHERE ranked.id = messages.id
)
WHERE sequence = 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_sequence
  ON messages(chat_id, sequence);

CREATE TABLE IF NOT EXISTS chat_sequences (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    next_seq INTEGER NOT NULL
);

INSERT OR IGNORE INTO chat_sequences (chat_id, next_seq)
SELECT chat_id, COALESCE(MAX(sequence), 0) + 1
FROM messages
GROUP BY chat_id;

INSERT OR IGNORE INTO chat_sequences (chat_id, next_seq)
SELECT id, 1 FROM chats;
