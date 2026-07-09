package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"

	"coachman/server/internal/blob"
	"coachman/server/internal/db"
)

type Store struct {
	db    *db.DB
	blobs blob.Storage
}

func New(database *db.DB, blobs blob.Storage) *Store {
	return &Store{db: database, blobs: blobs}
}

func NormalizeUsername(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

func (s *Store) findUserIDByUsername(username string) (string, error) {
	username = NormalizeUsername(username)
	if username == "" {
		return "", errors.New("user not found")
	}
	var id string
	err := s.db.QueryRow(`SELECT id FROM users WHERE lower(username) = lower(?)`, username).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("user not found")
	}
	return id, err
}

type User struct {
	ID        string `json:"id"`
	Username  string `json:"username"`
	PublicKey string `json:"publicKey"`
	IsAdmin   bool   `json:"isAdmin,omitempty"`
	RootUserID string `json:"-"`
}

type ChatMember struct {
	ID                 string  `json:"id"`
	Username           string  `json:"username"`
	PublicKey          string  `json:"publicKey"`
	EncryptedGroupKey  *string `json:"encryptedGroupKey,omitempty"`
}

type LastMessage struct {
	ID        string `json:"id"`
	SenderID  string `json:"senderId"`
	Type      string `json:"type"`
	CreatedAt int64  `json:"createdAt"`
}

type Chat struct {
	ID              string        `json:"id"`
	Type            string        `json:"type"`
	Name            *string       `json:"name"`
	CreatedAt       int64         `json:"createdAt"`
	CreatedByUserID *string       `json:"createdByUserId,omitempty"`
	GroupKeyEpoch   *int64        `json:"groupKeyEpoch,omitempty"`
	DisplayName     string        `json:"displayName"`
	Members         []ChatMember  `json:"members"`
	LastMessage     *LastMessage  `json:"lastMessage"`
	PeerLastReadAt  *int64        `json:"peerLastReadAt,omitempty"`
}

type Message struct {
	ID         string  `json:"id"`
	ChatID     string  `json:"chatId"`
	SenderID   string  `json:"senderId"`
	Ciphertext string  `json:"ciphertext"`
	IV         string  `json:"iv"`
	Type       string  `json:"type"`
	ImageID    *string `json:"imageId,omitempty"`
	CreatedAt  int64   `json:"createdAt"`
}

type ImageMeta struct {
	Ciphertext []byte `json:"-"`
	IV         string `json:"iv"`
	MimeType   string `json:"mimeType"`
}

func (s *Store) RegisterUser(username, publicKey, signingPublicKey string) (*User, error) {
	count, err := s.UserCount()
	if err != nil {
		return nil, err
	}
	if count == 0 {
		return s.RegisterBootstrapUser(username, publicKey, signingPublicKey)
	}
	return nil, errors.New("invite required")
}

func (s *Store) GetUserSigningPublicKey(username string) (string, error) {
	var key sql.NullString
	err := s.db.QueryRow(`SELECT signing_public_key FROM users WHERE lower(username) = lower(?)`, NormalizeUsername(username)).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("user not found")
	}
	if err != nil {
		return "", err
	}
	if !key.Valid || key.String == "" {
		return "", errors.New("signing key not configured")
	}
	return key.String, nil
}

func (s *Store) SaveChallenge(username, nonce string, expiresAt int64) error {
	username = NormalizeUsername(username)
	_, err := s.db.Exec(`
		INSERT INTO auth_challenges (username, nonce, expires_at) VALUES (?, ?, ?)
		ON CONFLICT(username) DO UPDATE SET nonce = excluded.nonce, expires_at = excluded.expires_at
	`, username, nonce, expiresAt)
	return err
}

func (s *Store) ConsumeChallenge(username string) (string, error) {
	var nonce string
	var expiresAt int64
	err := s.db.QueryRow(`SELECT nonce, expires_at FROM auth_challenges WHERE lower(username) = lower(?)`, NormalizeUsername(username)).Scan(&nonce, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("challenge not found")
	}
	if err != nil {
		return "", err
	}
	_, _ = s.db.Exec(`DELETE FROM auth_challenges WHERE lower(username) = lower(?)`, NormalizeUsername(username))
	if time.Now().UnixMilli() > expiresAt {
		return "", errors.New("challenge expired")
	}
	return nonce, nil
}

func (s *Store) AttachSigningKey(username, publicKey, signingPublicKey string) error {
	var id string
	var storedPub sql.NullString
	var storedSigning sql.NullString
	err := s.db.QueryRow(`SELECT id, public_key, signing_public_key FROM users WHERE lower(username) = lower(?)`, NormalizeUsername(username)).
		Scan(&id, &storedPub, &storedSigning)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("user not found")
	}
	if err != nil {
		return err
	}
	if storedPub.String != publicKey {
		return errors.New("public key mismatch")
	}
	if storedSigning.Valid && storedSigning.String != "" {
		return errors.New("signing key already set")
	}
	_, err = s.db.Exec(`UPDATE users SET signing_public_key = ? WHERE id = ?`, signingPublicKey, id)
	return err
}

func (s *Store) LoginUser(username string) (*User, error) {
	var u User
	var admin bool
	err := s.db.QueryRow(
		`SELECT id, username, public_key, is_admin FROM users WHERE lower(username) = lower(?)`, NormalizeUsername(username),
	).Scan(&u.ID, &u.Username, &u.PublicKey, &admin)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("user not found")
	}
	u.IsAdmin = admin
	return &u, err
}

func (s *Store) GetUser(id string) (*User, error) {
	var u User
	var admin bool
	err := s.db.QueryRow(
		`SELECT id, username, public_key, is_admin FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Username, &u.PublicKey, &admin)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("not found")
	}
	u.IsAdmin = admin
	return &u, err
}

func (s *Store) SearchUsers(query string) ([]User, error) {
	return nil, errors.New("use SearchUsersInCircle")
}

func (s *Store) FindDirectChat(userID, otherUserID string) (string, bool, error) {
	var id string
	err := s.db.QueryRow(`
		SELECT c.id FROM chats c
		JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = ?
		JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = ?
		WHERE c.type = 'direct'
	`, userID, otherUserID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return id, true, err
}

func (s *Store) CreateDirectChat(userID, otherUserID string) (string, error) {
	ok, err := s.IsMemberOfCircle(userID, otherUserID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", errors.New("not in circle")
	}
	if id, ok, err := s.FindDirectChat(userID, otherUserID); err != nil || ok {
		return id, err
	}

	chatID := uuid.New().String()
	now := time.Now().UnixMilli()
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`INSERT INTO chats (id, type, name, created_at) VALUES (?, 'direct', NULL, ?)`, chatID, now); err != nil {
		return "", err
	}
	for _, uid := range []string{userID, otherUserID} {
		if _, err := tx.Exec(`INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)`, chatID, uid, now); err != nil {
			return "", err
		}
	}
	return chatID, tx.Commit()
}

type GroupMemberInput struct {
	UserID            string `json:"userId"`
	EncryptedGroupKey string `json:"encryptedGroupKey"`
}

func (s *Store) CreateGroup(creatorID, name string, members []GroupMemberInput) (string, error) {
	chatID := uuid.New().String()
	now := time.Now().UnixMilli()
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`INSERT INTO chats (id, type, name, created_at, group_key_epoch, created_by_user_id) VALUES (?, 'group', ?, ?, 1, ?)`,
		chatID, name, now, creatorID,
	); err != nil {
		return "", err
	}
	for _, m := range members {
		if _, err := tx.Exec(
			`INSERT INTO chat_members (chat_id, user_id, encrypted_group_key, joined_at) VALUES (?, ?, ?, ?)`,
			chatID, m.UserID, m.EncryptedGroupKey, now,
		); err != nil {
			return "", err
		}
	}
	return chatID, tx.Commit()
}

func (s *Store) HideDirectChat(userID, peerUserID string) error {
	now := time.Now().UnixMilli()
	_, err := s.db.Exec(
		`INSERT INTO hidden_direct_chats (user_id, peer_user_id, hidden_at) VALUES (?, ?, ?)
		 ON CONFLICT(user_id, peer_user_id) DO UPDATE SET hidden_at = excluded.hidden_at`,
		userID, peerUserID, now,
	)
	return err
}

func (s *Store) IsDirectChatHidden(userID, peerUserID string) (bool, error) {
	var exists string
	err := s.db.QueryRow(
		`SELECT peer_user_id FROM hidden_direct_chats WHERE user_id = ? AND peer_user_id = ?`,
		userID, peerUserID,
	).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) EnsureCircleDirectChats(userID string) error {
	users, err := s.ListCircleUsers(userID)
	if err != nil {
		return err
	}
	for _, u := range users {
		if u.ID == userID {
			continue
		}
		hidden, err := s.IsDirectChatHidden(userID, u.ID)
		if err != nil {
			return err
		}
		if hidden {
			continue
		}
		if _, err := s.CreateDirectChat(userID, u.ID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) pruneSolitaryDirectChats(userID string) error {
	rows, err := s.db.Query(`
		SELECT c.id FROM chats c
		JOIN chat_members m ON m.chat_id = c.id AND m.user_id = ?
		WHERE c.type = 'direct'
		AND (SELECT COUNT(*) FROM chat_members cm WHERE cm.chat_id = c.id) = 1
	`, userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := s.db.Exec(`DELETE FROM chats WHERE id = ? AND type = 'direct'`, id); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) GetChats(userID string) ([]Chat, error) {
	if err := s.pruneSolitaryDirectChats(userID); err != nil {
		return nil, err
	}
	if err := s.EnsureCircleDirectChats(userID); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`
		SELECT c.id, c.type, c.name, c.created_at, c.group_key_epoch, c.created_by_user_id
		FROM chats c
		JOIN chat_members m ON m.chat_id = c.id
		WHERE m.user_id = ?
		ORDER BY c.created_at DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var pending []Chat
	for rows.Next() {
		var c Chat
		var epoch int64
		var createdBy sql.NullString
		if err := rows.Scan(&c.ID, &c.Type, &c.Name, &c.CreatedAt, &epoch, &createdBy); err != nil {
			return nil, err
		}
		if c.Type == "group" {
			c.GroupKeyEpoch = &epoch
			if createdBy.Valid {
				c.CreatedByUserID = &createdBy.String
			}
		}
		pending = append(pending, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	chats := make([]Chat, 0, len(pending))
	for _, c := range pending {
		members, err := s.getChatMembers(c.ID)
		if err != nil {
			return nil, err
		}
		c.Members = members
		c.DisplayName = chatDisplayName(c, userID, members)
		last, err := s.getLastMessage(c.ID)
		if err != nil {
			return nil, err
		}
		c.LastMessage = last
		if c.Type == "direct" {
			peerAt, err := s.GetPeerLastReadAt(c.ID, userID)
			if err != nil {
				return nil, err
			}
			if peerAt > 0 {
				c.PeerLastReadAt = &peerAt
			}
		}
		chats = append(chats, c)
	}
	if chats == nil {
		chats = []Chat{}
	}
	return chats, nil
}

func chatDisplayName(c Chat, userID string, members []ChatMember) string {
	if c.Type == "group" && c.Name != nil {
		return *c.Name
	}
	for _, m := range members {
		if m.ID != userID {
			return m.Username
		}
	}
	return "Чат"
}

func (s *Store) getChatMembers(chatID string) ([]ChatMember, error) {
	rows, err := s.db.Query(`
		SELECT u.id, u.username, u.public_key, cm.encrypted_group_key
		FROM chat_members cm
		JOIN users u ON u.id = cm.user_id
		WHERE cm.chat_id = ?
		ORDER BY cm.joined_at ASC
	`, chatID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var members []ChatMember
	for rows.Next() {
		var m ChatMember
		var encKey sql.NullString
		if err := rows.Scan(&m.ID, &m.Username, &m.PublicKey, &encKey); err != nil {
			return nil, err
		}
		if encKey.Valid {
			m.EncryptedGroupKey = &encKey.String
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

func (s *Store) getLastMessage(chatID string) (*LastMessage, error) {
	var lm LastMessage
	err := s.db.QueryRow(`
		SELECT id, sender_id, type, created_at
		FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1
	`, chatID).Scan(&lm.ID, &lm.SenderID, &lm.Type, &lm.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &lm, nil
}

func (s *Store) GetMessages(chatID string, after int64) ([]Message, error) {
	rows, err := s.db.Query(`
		SELECT id, chat_id, sender_id, ciphertext, iv, type, image_id, created_at
		FROM messages
		WHERE chat_id = ? AND created_at > ?
		ORDER BY created_at ASC
		LIMIT 100
	`, chatID, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []Message
	for rows.Next() {
		var m Message
		var imageID sql.NullString
		if err := rows.Scan(&m.ID, &m.ChatID, &m.SenderID, &m.Ciphertext, &m.IV, &m.Type, &imageID, &m.CreatedAt); err != nil {
			return nil, err
		}
		if imageID.Valid {
			m.ImageID = &imageID.String
		}
		messages = append(messages, m)
	}
	if messages == nil {
		messages = []Message{}
	}
	return messages, rows.Err()
}

func (s *Store) SendMessage(chatID, senderID, ciphertext, iv, msgType string, imageID *string) (*Message, error) {
	id := uuid.New().String()
	now := time.Now().UnixMilli()
	if msgType == "" {
		msgType = "text"
	}
	_, err := s.db.Exec(`
		INSERT INTO messages (id, chat_id, sender_id, ciphertext, iv, type, image_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, id, chatID, senderID, ciphertext, iv, msgType, imageID, now)
	if err != nil {
		return nil, err
	}
	return &Message{
		ID: id, ChatID: chatID, SenderID: senderID,
		Ciphertext: ciphertext, IV: iv, Type: msgType, ImageID: imageID, CreatedAt: now,
	}, nil
}

func (s *Store) SaveImage(chatID, uploaderID, iv, mimeType string, data []byte) (string, int64, error) {
	id := uuid.New().String()
	now := time.Now().UnixMilli()
	var storageKey sql.NullString
	ciphertext := data

	if s.blobs != nil {
		key := "images/" + id
		if err := s.blobs.Put(context.Background(), key, data); err != nil {
			return "", 0, err
		}
		storageKey = sql.NullString{String: key, Valid: true}
		ciphertext = []byte{}
	}

	_, err := s.db.Exec(`
		INSERT INTO images (id, chat_id, uploader_id, ciphertext, iv, mime_type, created_at, storage_key)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, id, chatID, uploaderID, ciphertext, iv, mimeType, now, storageKey)
	return id, now, err
}

func (s *Store) GetImage(imageID string) (*ImageMeta, error) {
	var img ImageMeta
	var storageKey sql.NullString
	err := s.db.QueryRow(`
		SELECT ciphertext, iv, mime_type, storage_key FROM images WHERE id = ?
	`, imageID).Scan(&img.Ciphertext, &img.IV, &img.MimeType, &storageKey)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("not found")
	}
	if err != nil {
		return nil, err
	}
	if storageKey.Valid && s.blobs != nil {
		img.Ciphertext, err = s.blobs.Get(context.Background(), storageKey.String)
		if err != nil {
			return nil, errors.New("not found")
		}
	} else if len(img.Ciphertext) == 0 {
		return nil, errors.New("not found")
	}
	return &img, nil
}

func (s *Store) IsUsernameTaken(username string) bool {
	_, err := s.findUserIDByUsername(username)
	return err == nil
}

func (s *Store) IsMember(chatID, userID string) (bool, error) {
	var exists string
	err := s.db.QueryRow(`SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id = ?`, chatID, userID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) GetMemberIDs(chatID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT user_id FROM chat_members WHERE chat_id = ?`, chatID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) GetChatType(chatID string) (string, error) {
	var chatType string
	err := s.db.QueryRow(`SELECT type FROM chats WHERE id = ?`, chatID).Scan(&chatType)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("not found")
	}
	return chatType, err
}

func (s *Store) CountMembers(chatID string) (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM chat_members WHERE chat_id = ?`, chatID).Scan(&count)
	return count, err
}

func (s *Store) GetGroupKeyEpoch(chatID string) (int64, error) {
	var epoch int64
	err := s.db.QueryRow(`SELECT group_key_epoch FROM chats WHERE id = ?`, chatID).Scan(&epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, errors.New("not found")
	}
	return epoch, err
}

func (s *Store) applyGroupRekey(tx *db.Tx, chatID string, newEpoch int64, updates []GroupMemberInput) error {
	if len(updates) == 0 {
		return nil
	}
	var current int64
	if err := tx.QueryRow(`SELECT group_key_epoch FROM chats WHERE id = ?`, chatID).Scan(&current); err != nil {
		return err
	}
	if newEpoch != current+1 {
		return errors.New("invalid epoch")
	}
	for _, m := range updates {
		res, err := tx.Exec(
			`UPDATE chat_members SET encrypted_group_key = ? WHERE chat_id = ? AND user_id = ?`,
			m.EncryptedGroupKey, chatID, m.UserID,
		)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n == 0 {
			return errors.New("member not found")
		}
	}
	_, err := tx.Exec(`UPDATE chats SET group_key_epoch = ? WHERE id = ?`, newEpoch, chatID)
	return err
}

func (s *Store) GetGroupCreator(chatID string) (string, error) {
	chatType, err := s.GetChatType(chatID)
	if err != nil {
		return "", err
	}
	if chatType != "group" {
		return "", errors.New("not a group")
	}
	var creator sql.NullString
	err = s.db.QueryRow(`SELECT created_by_user_id FROM chats WHERE id = ?`, chatID).Scan(&creator)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("not found")
	}
	if err != nil {
		return "", err
	}
	if creator.Valid && creator.String != "" {
		return creator.String, nil
	}
	err = s.db.QueryRow(
		`SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY joined_at ASC LIMIT 1`,
		chatID,
	).Scan(&creator.String)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("not found")
	}
	return creator.String, err
}

func (s *Store) assertGroupCreator(chatID, actorID string) error {
	creator, err := s.GetGroupCreator(chatID)
	if err != nil {
		return err
	}
	if creator != actorID {
		return errors.New("forbidden")
	}
	return nil
}

func (s *Store) DeleteChat(chatID, actorID string) ([]string, error) {
	ok, err := s.IsMember(chatID, actorID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("forbidden")
	}
	chatType, err := s.GetChatType(chatID)
	if err != nil {
		return nil, err
	}
	memberIDs, err := s.GetMemberIDs(chatID)
	if err != nil {
		return nil, err
	}

	switch chatType {
	case "group":
		if err := s.assertGroupCreator(chatID, actorID); err != nil {
			return nil, err
		}
	case "direct":
		// any member may delete a direct chat
		for _, memberID := range memberIDs {
			if memberID == actorID {
				continue
			}
			if err := s.HideDirectChat(actorID, memberID); err != nil {
				return nil, err
			}
		}
	default:
		return nil, errors.New("not found")
	}

	if s.blobs != nil {
		imgRows, err := s.db.Query(`SELECT storage_key FROM images WHERE chat_id = ? AND storage_key IS NOT NULL`, chatID)
		if err != nil {
			return nil, err
		}
		var keys []string
		for imgRows.Next() {
			var key string
			if err := imgRows.Scan(&key); err != nil {
				imgRows.Close()
				return nil, err
			}
			keys = append(keys, key)
		}
		imgRows.Close()
		ctx := context.Background()
		for _, key := range keys {
			_ = s.blobs.Delete(ctx, key)
		}
	}

	var res sql.Result
	if chatType == "group" {
		res, err = s.db.Exec(`DELETE FROM chats WHERE id = ? AND type = 'group'`, chatID)
	} else {
		res, err = s.db.Exec(`DELETE FROM chats WHERE id = ? AND type = 'direct'`, chatID)
	}
	if err != nil {
		return nil, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, errors.New("not found")
	}
	return memberIDs, nil
}

func (s *Store) DeleteGroup(chatID, actorID string) ([]string, error) {
	return s.DeleteChat(chatID, actorID)
}

func (s *Store) AddGroupMember(chatID, actorID, userID, encryptedGroupKey string) error {
	return s.AddGroupMemberWithRekey(chatID, actorID, userID, encryptedGroupKey, 0, nil)
}

func (s *Store) AddGroupMemberWithRekey(chatID, actorID, userID, encryptedGroupKey string, newEpoch int64, updates []GroupMemberInput) error {
	if err := s.assertGroupCreator(chatID, actorID); err != nil {
		return err
	}
	chatType, err := s.GetChatType(chatID)
	if err != nil {
		return err
	}
	if chatType != "group" {
		return errors.New("not a group")
	}
	var exists string
	err = s.db.QueryRow(`SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id = ?`, chatID, userID).Scan(&exists)
	if err == nil {
		return errors.New("already member")
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var userExists string
	err = s.db.QueryRow(`SELECT id FROM users WHERE id = ?`, userID).Scan(&userExists)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("user not found")
	}
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if newEpoch > 0 {
		if err := s.applyGroupRekey(tx, chatID, newEpoch, updates); err != nil {
			return err
		}
	}

	_, err = tx.Exec(
		`INSERT INTO chat_members (chat_id, user_id, encrypted_group_key, joined_at) VALUES (?, ?, ?, ?)`,
		chatID, userID, encryptedGroupKey, now,
	)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) RemoveGroupMember(chatID, actorID, userID string) error {
	return s.RemoveGroupMemberWithRekey(chatID, actorID, userID, 0, nil)
}

func (s *Store) RemoveGroupMemberWithRekey(chatID, actorID, userID string, newEpoch int64, updates []GroupMemberInput) error {
	if err := s.assertGroupCreator(chatID, actorID); err != nil {
		return err
	}
	if actorID == userID {
		return errors.New("use delete group")
	}
	chatType, err := s.GetChatType(chatID)
	if err != nil {
		return err
	}
	if chatType != "group" {
		return errors.New("not a group")
	}
	count, err := s.CountMembers(chatID)
	if err != nil {
		return err
	}
	if count <= 1 {
		return errors.New("last member")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.Exec(`DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?`, chatID, userID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return errors.New("not a member")
	}

	if newEpoch > 0 {
		if err := s.applyGroupRekey(tx, chatID, newEpoch, updates); err != nil {
			return err
		}
	}

	var remaining int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_members WHERE chat_id = ?`, chatID).Scan(&remaining); err != nil {
		return err
	}
	if remaining == 0 {
		if _, err := tx.Exec(`DELETE FROM chats WHERE id = ?`, chatID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) GetImageChatID(imageID string) (string, error) {
	var chatID string
	err := s.db.QueryRow(`SELECT chat_id FROM images WHERE id = ?`, imageID).Scan(&chatID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("not found")
	}
	return chatID, err
}

func (s *Store) ResetSigningKey(username, publicKey, signingPublicKey string) error {
	var id string
	var storedPub string
	err := s.db.QueryRow(`SELECT id, public_key FROM users WHERE lower(username) = lower(?)`, NormalizeUsername(username)).Scan(&id, &storedPub)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("user not found")
	}
	if err != nil {
		return err
	}
	if storedPub != publicKey {
		return errors.New("public key mismatch")
	}
	_, err = s.db.Exec(`UPDATE users SET signing_public_key = ? WHERE id = ?`, signingPublicKey, id)
	return err
}

func (s *Store) DeleteUser(userID string) error {
	var username string
	err := s.db.QueryRow(`SELECT username FROM users WHERE id = ?`, userID).Scan(&username)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("user not found")
	}
	if err != nil {
		return err
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM messages WHERE sender_id = ?`, userID); err != nil {
		return err
	}
	if s.blobs != nil {
		imgRows, err := tx.Query(`SELECT storage_key FROM images WHERE uploader_id = ? AND storage_key IS NOT NULL`, userID)
		if err != nil {
			return err
		}
		var keys []string
		for imgRows.Next() {
			var key string
			if err := imgRows.Scan(&key); err != nil {
				imgRows.Close()
				return err
			}
			keys = append(keys, key)
		}
		imgRows.Close()
		ctx := context.Background()
		for _, key := range keys {
			_ = s.blobs.Delete(ctx, key)
		}
	}
	if _, err := tx.Exec(`DELETE FROM images WHERE uploader_id = ?`, userID); err != nil {
		return err
	}

	rows, err := tx.Query(`SELECT chat_id FROM chat_members WHERE user_id = ?`, userID)
	if err != nil {
		return err
	}
	var chatIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		chatIDs = append(chatIDs, id)
	}
	rows.Close()

	if _, err := tx.Exec(`DELETE FROM chat_members WHERE user_id = ?`, userID); err != nil {
		return err
	}

	for _, chatID := range chatIDs {
		var count int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM chat_members WHERE chat_id = ?`, chatID).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			if _, err := tx.Exec(`DELETE FROM chats WHERE id = ?`, chatID); err != nil {
				return err
			}
		}
	}

	if _, err := tx.Exec(`DELETE FROM auth_challenges WHERE username = ?`, username); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE users SET invited_by_user_id = NULL WHERE invited_by_user_id = ?`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE users SET root_user_id = NULL WHERE root_user_id = ?`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE invites SET used_by_user_id = NULL WHERE used_by_user_id = ?`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM invites WHERE created_by_user_id = ?`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE chats SET created_by_user_id = NULL WHERE created_by_user_id = ?`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM users WHERE id = ?`, userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DeleteAccountByCredentials(username, publicKey string) error {
	var id, storedKey string
	err := s.db.QueryRow(
		`SELECT id, public_key FROM users WHERE lower(username) = lower(?)`,
		NormalizeUsername(username),
	).Scan(&id, &storedKey)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("user not found")
	}
	if err != nil {
		return err
	}
	if storedKey != publicKey {
		return errors.New("public key mismatch")
	}
	return s.DeleteUser(id)
}

func (s *Store) DeleteAccountByUsername(username string) error {
	id, err := s.findUserIDByUsername(username)
	if err != nil {
		return err
	}
	return s.DeleteUser(id)
}
