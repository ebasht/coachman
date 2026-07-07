ALTER TABLE chats ADD COLUMN IF NOT EXISTS created_by_user_id TEXT REFERENCES users(id);

UPDATE chats
SET created_by_user_id = (
    SELECT cm.user_id
    FROM chat_members cm
    WHERE cm.chat_id = chats.id
    ORDER BY cm.joined_at ASC
    LIMIT 1
)
WHERE type = 'group' AND created_by_user_id IS NULL;
