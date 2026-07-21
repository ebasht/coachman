package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"coachman/server/internal/blob"
	"coachman/server/internal/db"
)

type Store struct {
	db         *db.DB
	blobs      blob.Storage
	publicBase string

	// Photo direct-upload limits (set from config via SetPhotoLimits).
	photoCDNBase     string
	photoMaxSize     int64
	photoUploadTTL   time.Duration
	photoDownloadTTL time.Duration
}

func New(database *db.DB, blobs blob.Storage) *Store {
	return &Store{db: database, blobs: blobs}
}

func (s *Store) SetPublicBaseURL(base string) {
	s.publicBase = strings.TrimRight(strings.TrimSpace(base), "/")
}

// SetPhotoLimits wires config-driven direct-upload limits into the store.
func (s *Store) SetPhotoLimits(cdnBase string, maxSize int64, uploadTTL, downloadTTL time.Duration) {
	s.photoCDNBase = strings.TrimRight(strings.TrimSpace(cdnBase), "/")
	// Avatar img URLs reuse the same public CDN origin unless set explicitly.
	if s.publicBase == "" {
		s.publicBase = s.photoCDNBase
	}
	if maxSize > 0 {
		s.photoMaxSize = maxSize
	}
	if uploadTTL > 0 {
		s.photoUploadTTL = uploadTTL
	}
	if downloadTTL > 0 {
		s.photoDownloadTTL = downloadTTL
	}
}

// PublishAvatarsPublic ensures existing avatar objects are publicly readable via CDN URL.
func (s *Store) PublishAvatarsPublic(ctx context.Context) (int, error) {
	if s.blobs == nil {
		return 0, nil
	}
	rows, err := s.db.Query(`SELECT avatar_key, avatar_mime FROM users WHERE avatar_key IS NOT NULL AND avatar_key != ''`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	n := 0
	for rows.Next() {
		var key, mime string
		if err := rows.Scan(&key, &mime); err != nil {
			return n, err
		}
		if mime == "" {
			mime = "image/jpeg"
		}
		if err := s.blobs.MakePublic(ctx, key, mime); err != nil {
			return n, fmt.Errorf("%s: %w", key, err)
		}
		n++
	}
	return n, rows.Err()
}

func NormalizeUsername(username string) string {
	// Preserve case; allow "Имя Фамилия". Collapse internal whitespace.
	parts := strings.Fields(username)
	if len(parts) == 0 {
		return ""
	}
	normalized := strings.Join(parts, " ")
	const maxRunes = 64
	runes := []rune(normalized)
	if len(runes) > maxRunes {
		return string(runes[:maxRunes])
	}
	return normalized
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
	ID              string `json:"id"`
	Username        string `json:"username"`
	PublicKey       string `json:"publicKey"`
	IsAdmin         bool   `json:"isAdmin,omitempty"`
	HasAvatar       bool   `json:"hasAvatar,omitempty"`
	AvatarUpdatedAt *int64 `json:"avatarUpdatedAt,omitempty"`
	AvatarURL       string `json:"avatarUrl,omitempty"`
	RootUserID      string `json:"-"`
}

type ChatMember struct {
	ID                string  `json:"id"`
	Username          string  `json:"username"`
	PublicKey         string  `json:"publicKey"`
	IsAdmin           bool    `json:"isAdmin,omitempty"`
	HasAvatar         bool    `json:"hasAvatar,omitempty"`
	AvatarUpdatedAt   *int64  `json:"avatarUpdatedAt,omitempty"`
	AvatarURL         string  `json:"avatarUrl,omitempty"`
	EncryptedGroupKey *string `json:"encryptedGroupKey,omitempty"`
	Online            bool    `json:"online,omitempty"`
	LastSeenAt        *int64  `json:"lastSeenAt,omitempty"`
}

type LastMessage struct {
	ID        string `json:"id"`
	SenderID  string `json:"senderId"`
	Type      string `json:"type"`
	CreatedAt int64  `json:"createdAt"`
}

type Chat struct {
	ID              string       `json:"id"`
	Type            string       `json:"type"`
	Name            *string      `json:"name"`
	CreatedAt       int64        `json:"createdAt"`
	CreatedByUserID *string      `json:"createdByUserId,omitempty"`
	GroupKeyEpoch   *int64       `json:"groupKeyEpoch,omitempty"`
	IsSystem        bool         `json:"isSystem,omitempty"`
	DisplayName     string       `json:"displayName"`
	Members         []ChatMember `json:"members"`
	LastMessage     *LastMessage `json:"lastMessage"`
	PeerLastReadAt  *int64       `json:"peerLastReadAt,omitempty"`
}

type Message struct {
	ID         string  `json:"id"`
	ChatID     string  `json:"chatId"`
	SenderID   string  `json:"senderId"`
	Ciphertext string  `json:"ciphertext"`
	IV         string  `json:"iv"`
	Type       string  `json:"type"`
	ImageID    *string `json:"imageId,omitempty"`
	// AlbumID groups several image messages sent together into one gallery (like a
	// Telegram media group). It is a random opaque id — no message content.
	AlbumID  *string `json:"albumId,omitempty"`
	ClientID *string `json:"clientId,omitempty"`
	// Sequence is a per-chat monotonic server counter (unique with chat_id).
	Sequence  int64 `json:"sequence"`
	CreatedAt int64 `json:"createdAt"`
}

type ImageMeta struct {
	Ciphertext []byte `json:"-"`
	IV         string `json:"iv"`
	MimeType   string `json:"mimeType"`
	// URL is a public CDN URL for ciphertext when direct/object storage is enabled.
	URL string `json:"url,omitempty"`
}

// CanDirectUpload reports whether clients can PUT ciphertext straight to object storage.
func (s *Store) CanDirectUpload() bool {
	du, ok := s.blobs.(blob.DirectUploader)
	return ok && du.PublicObjectURL("images/x") != ""
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
	uname := NormalizeUsername(username)
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	var nonce string
	var expiresAt int64
	err = tx.QueryRow(
		`SELECT nonce, expires_at FROM auth_challenges WHERE lower(username) = lower(?)`,
		uname,
	).Scan(&nonce, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", errors.New("challenge not found")
	}
	if err != nil {
		return "", err
	}
	if _, err := tx.Exec(`DELETE FROM auth_challenges WHERE lower(username) = lower(?)`, uname); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	if time.Now().UnixMilli() > expiresAt {
		return "", errors.New("challenge expired")
	}
	return nonce, nil
}

func (s *Store) GetTokenVersion(userID string) (int64, error) {
	var ver int64
	err := s.db.QueryRow(`SELECT token_version FROM users WHERE id = ?`, userID).Scan(&ver)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, errors.New("user not found")
	}
	return ver, err
}

func (s *Store) BumpTokenVersion(userID string) error {
	res, err := s.db.Exec(`UPDATE users SET token_version = token_version + 1 WHERE id = ?`, userID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return errors.New("user not found")
	}
	return nil
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
	var avatarUpdated sql.NullInt64
	var avatarKey sql.NullString
	err := s.db.QueryRow(
		`SELECT id, username, public_key, is_admin, avatar_updated_at, avatar_key FROM users WHERE lower(username) = lower(?)`, NormalizeUsername(username),
	).Scan(&u.ID, &u.Username, &u.PublicKey, &admin, &avatarUpdated, &avatarKey)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("user not found")
	}
	if err != nil {
		return nil, err
	}
	u.IsAdmin = admin
	s.applyAvatarFields(&u.HasAvatar, &u.AvatarUpdatedAt, &u.AvatarURL, avatarUpdated, avatarKey)
	return &u, nil
}

func (s *Store) GetUser(id string) (*User, error) {
	var u User
	var admin bool
	var avatarUpdated sql.NullInt64
	var avatarKey sql.NullString
	err := s.db.QueryRow(
		`SELECT id, username, public_key, is_admin, avatar_updated_at, avatar_key FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Username, &u.PublicKey, &admin, &avatarUpdated, &avatarKey)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("not found")
	}
	if err != nil {
		return nil, err
	}
	u.IsAdmin = admin
	s.applyAvatarFields(&u.HasAvatar, &u.AvatarUpdatedAt, &u.AvatarURL, avatarUpdated, avatarKey)
	return &u, nil
}

func (s *Store) applyAvatarFields(hasAvatar *bool, updatedAt **int64, avatarURL *string, updated sql.NullInt64, key sql.NullString) {
	hasKey := key.Valid && key.String != ""
	if !updated.Valid && !hasKey {
		return
	}
	*hasAvatar = true
	if updated.Valid {
		v := updated.Int64
		*updatedAt = &v
	}
	if hasKey {
		*avatarURL = s.buildAvatarURL(key.String, updated.Int64)
	}
}

func (s *Store) buildAvatarURL(key string, updatedAt int64) string {
	// Prefer CDN (bucket policy allows public GET on avatars/*). Clients still
	// fall back to authenticated /api/users/{id}/avatar when this is empty.
	base := s.publicBase
	if base == "" {
		base = s.photoCDNBase
	}
	if base == "" || key == "" {
		return ""
	}
	return fmt.Sprintf("%s/%s?v=%d", base, key, updatedAt)
}

func avatarExt(mimeType string) string {
	switch strings.ToLower(mimeType) {
	case "image/png":
		return "png"
	case "image/webp":
		return "webp"
	default:
		return "jpg"
	}
}

func (s *Store) SetUserAvatar(userID, mimeType string, data []byte) (updatedAt int64, avatarURL string, err error) {
	now := time.Now().UnixMilli()

	var oldKey sql.NullString
	_ = s.db.QueryRow(`SELECT avatar_key FROM users WHERE id = ?`, userID).Scan(&oldKey)

	if s.blobs != nil {
		key := "avatars/" + userID + "/" + strconv.FormatInt(now, 10) + "." + avatarExt(mimeType)
		if err := s.blobs.PutWithOptions(context.Background(), key, data, blob.PutOptions{
			ContentType:  mimeType,
			CacheControl: "public, max-age=31536000",
			PublicRead:   true,
		}); err != nil {
			return 0, "", err
		}
		res, err := s.db.Exec(
			`UPDATE users SET avatar_key = ?, avatar_mime = ?, avatar_updated_at = ?, avatar_data = NULL WHERE id = ?`,
			key, mimeType, now, userID,
		)
		if err != nil {
			_ = s.blobs.Delete(context.Background(), key)
			return 0, "", err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return 0, "", err
		}
		if n == 0 {
			_ = s.blobs.Delete(context.Background(), key)
			return 0, "", errors.New("not found")
		}
		if oldKey.Valid && oldKey.String != "" && oldKey.String != key {
			_ = s.blobs.Delete(context.Background(), oldKey.String)
		}
		return now, s.buildAvatarURL(key, now), nil
	}

	res, err := s.db.Exec(
		`UPDATE users SET avatar_data = ?, avatar_mime = ?, avatar_updated_at = ?, avatar_key = NULL WHERE id = ?`,
		data, mimeType, now, userID,
	)
	if err != nil {
		return 0, "", err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, "", err
	}
	if n == 0 {
		return 0, "", errors.New("not found")
	}
	return now, "", nil
}

func (s *Store) ClearUserAvatar(userID string) error {
	var oldKey sql.NullString
	err := s.db.QueryRow(`SELECT avatar_key FROM users WHERE id = ?`, userID).Scan(&oldKey)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("not found")
	}
	if err != nil {
		return err
	}

	res, err := s.db.Exec(
		`UPDATE users SET avatar_data = NULL, avatar_mime = NULL, avatar_updated_at = NULL, avatar_key = NULL WHERE id = ?`,
		userID,
	)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return errors.New("not found")
	}
	if oldKey.Valid && oldKey.String != "" && s.blobs != nil {
		_ = s.blobs.Delete(context.Background(), oldKey.String)
	}
	return nil
}

func (s *Store) GetUserAvatar(userID string) (data []byte, mimeType string, updatedAt int64, err error) {
	var mime sql.NullString
	var updated sql.NullInt64
	var key sql.NullString
	var blobData []byte
	err = s.db.QueryRow(
		`SELECT avatar_data, avatar_mime, avatar_updated_at, avatar_key FROM users WHERE id = ?`, userID,
	).Scan(&blobData, &mime, &updated, &key)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", 0, errors.New("not found")
	}
	if err != nil {
		return nil, "", 0, err
	}
	if !mime.Valid || !updated.Valid {
		return nil, "", 0, errors.New("not found")
	}
	if key.Valid && key.String != "" {
		if s.blobs == nil {
			return nil, "", 0, errors.New("not found")
		}
		data, err = s.blobs.Get(context.Background(), key.String)
		if err != nil {
			return nil, "", 0, errors.New("not found")
		}
		return data, mime.String, updated.Int64, nil
	}
	if len(blobData) == 0 {
		return nil, "", 0, errors.New("not found")
	}
	return blobData, mime.String, updated.Int64, nil
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

// repairSolitaryDirectChat re-adds otherUserID to the caller's only 1-member DM.
// Prevents EnsureCircleDirectChats from creating a duplicate empty chat after a leave.
func (s *Store) repairSolitaryDirectChat(userID, otherUserID string) (string, bool, error) {
	rows, err := s.db.Query(`
		SELECT c.id FROM chats c
		JOIN chat_members m ON m.chat_id = c.id AND m.user_id = ?
		WHERE c.type = 'direct'
		AND (SELECT COUNT(*) FROM chat_members cm WHERE cm.chat_id = c.id) = 1
	`, userID)
	if err != nil {
		return "", false, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return "", false, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return "", false, err
	}
	if len(ids) != 1 {
		return "", false, nil
	}
	id := ids[0]
	now := time.Now().UnixMilli()
	if _, err := s.db.Exec(
		`INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)
		 ON CONFLICT DO NOTHING`,
		id, otherUserID, now,
	); err != nil {
		return "", false, err
	}
	return id, true, nil
}

func (s *Store) CreateDirectChat(userID, otherUserID string) (string, error) {
	// API / explicit open: clear our hide so a deleted DM can be reopened by us.
	return s.createDirectChat(userID, otherUserID, true)
}

func (s *Store) ensureDirectChat(userID, otherUserID string) (string, error) {
	// Auto-provision from GetChats — never resurrect a chat either side deleted.
	return s.createDirectChat(userID, otherUserID, false)
}

func (s *Store) createDirectChat(userID, otherUserID string, reopen bool) (string, error) {
	ok, err := s.IsMemberOfCircle(userID, otherUserID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", errors.New("not in circle")
	}

	if reopen {
		// Explicit reopen: clear hide both ways so the DM is mutual again.
		_, _ = s.db.Exec(
			`DELETE FROM hidden_direct_chats
			 WHERE (user_id = ? AND peer_user_id = ?) OR (user_id = ? AND peer_user_id = ?)`,
			userID, otherUserID, otherUserID, userID,
		)
	} else {
		hidden, err := s.IsDirectChatHidden(userID, otherUserID)
		if err != nil {
			return "", err
		}
		if hidden {
			return "", nil
		}
		peerHidden, err := s.IsDirectChatHidden(otherUserID, userID)
		if err != nil {
			return "", err
		}
		if peerHidden {
			return "", nil
		}
	}

	if id, found, err := s.FindDirectChat(userID, otherUserID); err != nil || found {
		return id, err
	}

	// Peer left membership but the row survived — re-attach instead of a second empty DM.
	if id, repaired, err := s.repairSolitaryDirectChat(userID, otherUserID); err != nil {
		return "", err
	} else if repaired {
		return id, nil
	}

	if !reopen {
		peerHidden, err := s.IsDirectChatHidden(otherUserID, userID)
		if err != nil {
			return "", err
		}
		if peerHidden {
			return "", nil
		}
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
	for _, m := range members {
		if m.UserID == creatorID {
			continue
		}
		ok, err := s.IsMemberOfCircle(creatorID, m.UserID)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", errors.New("not in circle")
		}
	}

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
	// Small circle: only keep/create the support DM with admin (not peer↔peer 1:1).
	if len(users) < 3 {
		if err := s.prunePeerDirectChats(userID); err != nil {
			return err
		}
		return s.ensureAdminSupportChat(userID, users)
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
		// Peer deleted this DM — do not recreate membership for them (and bounce it back to us).
		peerHidden, err := s.IsDirectChatHidden(u.ID, userID)
		if err != nil {
			return err
		}
		if peerHidden {
			continue
		}
		if _, err := s.ensureDirectChat(userID, u.ID); err != nil {
			return err
		}
	}
	return nil
}

// ensureAdminSupportChat creates a 1:1 with the circle admin for non-admin users.
func (s *Store) ensureAdminSupportChat(userID string, users []User) error {
	isAdmin, err := s.IsAdmin(userID)
	if err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	for _, u := range users {
		if u.ID == userID || !u.IsAdmin {
			continue
		}
		_, err := s.ensureDirectChat(userID, u.ID)
		return err
	}
	return nil
}

// prunePeerDirectChats used to DELETE every DM that did not currently include an
// admin member. After leaveDirectChat kept n==1 for the peer, the survivor's
// admin-support chat looked "peer-only" and was wiped on the next GetChats —
// history gone, EnsureCircle spun up an empty DM. Do not GC from the list path.
func (s *Store) prunePeerDirectChats(userID string) error {
	_ = userID
	return nil
}

// pruneDirectChatsForUser removes all 1:1 chats for the user (legacy helper).
func (s *Store) pruneDirectChatsForUser(userID string) error {
	return s.prunePeerDirectChats(userID)
}

// pruneSolitaryDirectChats used to DELETE every 1-member DM on GetChats.
// That raced with leaveDirectChat (which correctly keeps n==1 for the peer)
// and wiped message history, then EnsureCircleDirectChats spun up empty DMs —
// the sidebar looked wrong and sends targeted a dead chat id. No-op now;
// empty chats are GC'd only when leaveDirectChat reaches n==0.
func (s *Store) pruneSolitaryDirectChats(userID string) error {
	_ = userID
	return nil
}

// ensureAdminIsCircleRoot keeps the invite circle under the current admin.
// Repairs root_user_id after admin transfer if an older build left the circle split.
func (s *Store) ensureAdminIsCircleRoot(userID string) error {
	isAdmin, err := s.IsAdmin(userID)
	if err != nil || !isAdmin {
		return err
	}
	systemID, ok, err := s.GetSystemGroupID()
	if err != nil || !ok {
		return err
	}
	_, err = s.db.Exec(`
		UPDATE users
		SET root_user_id = ?
		WHERE id IN (SELECT user_id FROM chat_members WHERE chat_id = ?)
	`, userID, systemID)
	return err
}

func (s *Store) GetChats(userID string) ([]Chat, error) {
	if err := s.ensureAdminIsCircleRoot(userID); err != nil {
		return nil, err
	}
	if err := s.pruneSolitaryDirectChats(userID); err != nil {
		return nil, err
	}
	if err := s.EnsureCircleDirectChats(userID); err != nil {
		return nil, err
	}
	if _, err := s.EnsureSystemGroup(); err != nil {
		return nil, err
	}
	if err := s.EnsureAllUsersInSystemGroup(); err != nil {
		return nil, err
	}
	rows, err := s.db.Query(`
		SELECT c.id, c.type, c.name, c.created_at, c.group_key_epoch, c.created_by_user_id, c.is_system
		FROM chats c
		JOIN chat_members m ON m.chat_id = c.id
		WHERE m.user_id = ?
		ORDER BY c.is_system DESC, c.created_at DESC
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
		var isSystem bool
		if err := rows.Scan(&c.ID, &c.Type, &c.Name, &c.CreatedAt, &epoch, &createdBy, &isSystem); err != nil {
			return nil, err
		}
		c.IsSystem = isSystem
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
	var leaveIDs []string
	for _, c := range pending {
		members, err := s.getChatMembers(c.ID)
		if err != nil {
			return nil, err
		}
		if c.Type == "direct" {
			keep, leave, err := s.directChatVisibility(userID, c.ID, members)
			if err != nil {
				return nil, err
			}
			if leave {
				leaveIDs = append(leaveIDs, c.ID)
			}
			if !keep {
				continue
			}
			// Keep 1-member DMs for the survivor (peer left). Hiding them used
			// to drop history from the list and confuse the client sync.
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
	// Leave after building the response so an in-flight send in a still-open
	// chat is not raced into "forbidden" by membership removal mid-request.
	for _, id := range leaveIDs {
		_ = s.leaveDirectChat(userID, id)
	}
	return chats, nil
}

// directChatVisibility decides whether a DM is shown and whether we should leave it.
// Does not mutate membership — caller leaves after the response is assembled.
//
// Hidden DMs are only filtered from the list (leave=false). DeleteChat already
// removes the row; leaving+deleting here used to destroy the peer's still-open DM
// whenever a hide flag lingered (n<=1 → DELETE chats).
func (s *Store) directChatVisibility(userID, chatID string, members []ChatMember) (keep bool, leave bool, err error) {
	var peerID string
	for _, m := range members {
		if m.ID != userID {
			peerID = m.ID
			break
		}
	}
	if peerID == "" {
		// Solitary DM — show it to the remaining member. Do not DELETE here:
		// that wiped history whenever the peer had already left membership.
		return true, false, nil
	}

	hidden, err := s.IsDirectChatHidden(userID, peerID)
	if err != nil {
		return false, false, err
	}
	if hidden {
		return false, false, nil
	}

	inCircle, err := s.IsMemberOfCircle(userID, peerID)
	if err != nil {
		return false, false, err
	}
	if !inCircle {
		// Out of circle — hide from the list but keep membership so history
		// survives. Leaving here produced solitary DMs that GetChats then
		// destroyed (or the client dropped via replaceLocalChatsFromApi).
		return false, false, nil
	}
	return true, false, nil
}

// Deprecated name kept for tests/callers that only need the keep bit.
func (s *Store) shouldExposeDirectChat(userID, chatID string, members []ChatMember) (bool, error) {
	keep, leave, err := s.directChatVisibility(userID, chatID, members)
	if err != nil {
		return false, err
	}
	if leave {
		if err := s.leaveDirectChat(userID, chatID); err != nil {
			return false, err
		}
	}
	return keep, nil
}

func (s *Store) leaveDirectChat(userID, chatID string) error {
	if _, err := s.db.Exec(`DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?`, chatID, userID); err != nil {
		return err
	}
	var n int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM chat_members WHERE chat_id = ?`, chatID).Scan(&n); err != nil {
		return err
	}
	// Only garbage-collect when nobody remains. Deleting at n<=1 destroyed the
	// peer's DM (and all messages) as soon as one side left the membership.
	if n == 0 {
		_, err := s.db.Exec(`DELETE FROM chats WHERE id = ? AND type = 'direct'`, chatID)
		return err
	}
	return nil
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
		SELECT u.id, u.username, u.public_key, u.is_admin, u.avatar_updated_at, u.avatar_key, cm.encrypted_group_key
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
		var avatarUpdated sql.NullInt64
		var avatarKey sql.NullString
		if err := rows.Scan(&m.ID, &m.Username, &m.PublicKey, &m.IsAdmin, &avatarUpdated, &avatarKey, &encKey); err != nil {
			return nil, err
		}
		s.applyAvatarFields(&m.HasAvatar, &m.AvatarUpdatedAt, &m.AvatarURL, avatarUpdated, avatarKey)
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

func scanMessageRow(scanner interface {
	Scan(dest ...any) error
}) (*Message, error) {
	var m Message
	var imageID, albumID, clientID sql.NullString
	if err := scanner.Scan(
		&m.ID, &m.ChatID, &m.SenderID, &m.Ciphertext, &m.IV, &m.Type,
		&imageID, &albumID, &clientID, &m.Sequence, &m.CreatedAt,
	); err != nil {
		return nil, err
	}
	if imageID.Valid {
		m.ImageID = &imageID.String
	}
	if albumID.Valid && albumID.String != "" {
		m.AlbumID = &albumID.String
	}
	if clientID.Valid && clientID.String != "" {
		m.ClientID = &clientID.String
	}
	return &m, nil
}

func (s *Store) GetMessages(chatID string, after int64) ([]Message, error) {
	return s.GetMessagesSince(chatID, after, 0, 100)
}

// GetMessagesSince returns messages after createdAt and/or sequence cursors.
// Prefer afterSequence when both are set — it is the authoritative sync cursor.
func (s *Store) GetMessagesSince(chatID string, afterCreatedAt, afterSequence int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var (
		rows *sql.Rows
		err  error
	)
	if afterSequence > 0 {
		rows, err = s.db.Query(`
			SELECT id, chat_id, sender_id, ciphertext, iv, type, image_id, album_id, client_id, sequence, created_at
			FROM messages
			WHERE chat_id = ? AND sequence > ?
			ORDER BY sequence ASC
			LIMIT ?
		`, chatID, afterSequence, limit)
	} else {
		rows, err = s.db.Query(`
			SELECT id, chat_id, sender_id, ciphertext, iv, type, image_id, album_id, client_id, sequence, created_at
			FROM messages
			WHERE chat_id = ? AND created_at > ?
			ORDER BY sequence ASC, created_at ASC
			LIMIT ?
		`, chatID, afterCreatedAt, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []Message
	for rows.Next() {
		m, err := scanMessageRow(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, *m)
	}
	if messages == nil {
		messages = []Message{}
	}
	return messages, rows.Err()
}

func (s *Store) getMessageByClientID(chatID, senderID, clientID string) (*Message, error) {
	row := s.db.QueryRow(`
		SELECT id, chat_id, sender_id, ciphertext, iv, type, image_id, album_id, client_id, sequence, created_at
		FROM messages
		WHERE chat_id = ? AND sender_id = ? AND client_id = ?
	`, chatID, senderID, clientID)
	m, err := scanMessageRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return m, err
}

func (s *Store) nextChatSequence(tx *db.Tx, chatID string) (int64, error) {
	var seq int64
	err := tx.QueryRow(`
		INSERT INTO chat_sequences (chat_id, next_seq) VALUES (?, 2)
		ON CONFLICT(chat_id) DO UPDATE SET next_seq = chat_sequences.next_seq + 1
		RETURNING next_seq - 1
	`, chatID).Scan(&seq)
	return seq, err
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "unique") || strings.Contains(msg, "duplicate key") || strings.Contains(msg, "23505")
}

// SendMessage inserts a message. When clientID is set, retries with the same id are idempotent:
// the existing row is returned and created=false (caller should not re-broadcast).
func (s *Store) SendMessage(chatID, senderID, ciphertext, iv, msgType string, imageID *string, clientID string, albumID *string) (*Message, bool, error) {
	if msgType == "" {
		msgType = "text"
	}
	clientID = strings.TrimSpace(clientID)
	if clientID == "" {
		return nil, false, errors.New("client id required")
	}
	if len(clientID) > 128 {
		return nil, false, errors.New("client id too long")
	}

	if existing, err := s.getMessageByClientID(chatID, senderID, clientID); err != nil {
		return nil, false, err
	} else if existing != nil {
		return existing, false, nil
	}

	id := uuid.New().String()
	now := time.Now().UnixMilli()
	var albumArg any
	if albumID != nil {
		aid := strings.TrimSpace(*albumID)
		if len(aid) > 64 {
			return nil, false, errors.New("album id too long")
		}
		if aid != "" {
			albumArg = aid
			albumID = &aid
		} else {
			albumID = nil
		}
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()

	seq, err := s.nextChatSequence(tx, chatID)
	if err != nil {
		return nil, false, err
	}

	_, err = tx.Exec(`
		INSERT INTO messages (id, chat_id, sender_id, ciphertext, iv, type, image_id, album_id, client_id, sequence, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, id, chatID, senderID, ciphertext, iv, msgType, imageID, albumArg, clientID, seq, now)
	if err != nil {
		if isUniqueViolation(err) {
			existing, getErr := s.getMessageByClientID(chatID, senderID, clientID)
			if getErr != nil {
				return nil, false, getErr
			}
			if existing != nil {
				return existing, false, nil
			}
		}
		return nil, false, err
	}
	if err := tx.Commit(); err != nil {
		return nil, false, err
	}

	msg := &Message{
		ID: id, ChatID: chatID, SenderID: senderID,
		Ciphertext: ciphertext, IV: iv, Type: msgType, ImageID: imageID,
		ClientID: &clientID, Sequence: seq, CreatedAt: now,
	}
	if albumID != nil && *albumID != "" {
		msg.AlbumID = albumID
	}
	return msg, true, nil
}

// DeleteMessage removes a message. Only the sender may delete it.
func (s *Store) DeleteMessage(chatID, messageID, userID string) error {
	var senderID string
	err := s.db.QueryRow(
		`SELECT sender_id FROM messages WHERE id = ? AND chat_id = ?`,
		messageID, chatID,
	).Scan(&senderID)
	if errors.Is(err, sql.ErrNoRows) {
		return errors.New("not found")
	}
	if err != nil {
		return err
	}
	if senderID != userID {
		return errors.New("forbidden")
	}
	res, err := s.db.Exec(`DELETE FROM messages WHERE id = ? AND chat_id = ?`, messageID, chatID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return errors.New("not found")
	}
	return nil
}

// ClearChatMessages deletes all messages (and related images) but keeps the chat.
func (s *Store) ClearChatMessages(chatID, actorID string) ([]string, error) {
	ok, err := s.IsMember(chatID, actorID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("forbidden")
	}
	system, err := s.IsSystemChat(chatID)
	if err != nil {
		return nil, err
	}
	if system {
		return nil, errors.New("system chat")
	}
	memberIDs, err := s.GetMemberIDs(chatID)
	if err != nil {
		return nil, err
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

	if _, err := s.db.Exec(`DELETE FROM images WHERE chat_id = ?`, chatID); err != nil {
		return nil, err
	}
	if _, err := s.db.Exec(`DELETE FROM messages WHERE chat_id = ?`, chatID); err != nil {
		return nil, err
	}
	return memberIDs, nil
}

func (s *Store) SaveImage(chatID, uploaderID, iv, mimeType string, data []byte) (string, int64, error) {
	id := uuid.New().String()
	now := time.Now().UnixMilli()
	var storageKey sql.NullString
	ciphertext := data

	if s.blobs != nil {
		key := "images/" + id
		ct := mimeType
		if ct == "" {
			ct = "application/octet-stream"
		}
		if err := s.blobs.PutWithOptions(context.Background(), key, data, blob.PutOptions{
			ContentType:  ct,
			CacheControl: "public, max-age=31536000, immutable",
		}); err != nil {
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

// IssueDirectImageUpload returns a CDN presigned PUT URL without writing DB.
// Call CompleteDirectImageUpload only after the client successfully PUTs the object.
func (s *Store) IssueDirectImageUpload() (id, uploadURL, publicURL, storageKey string, err error) {
	du, ok := s.blobs.(blob.DirectUploader)
	if !ok {
		return "", "", "", "", errors.New("direct upload unavailable")
	}
	id = uuid.New().String()
	storageKey = "images/" + id
	publicURL = du.PublicObjectURL(storageKey)
	if publicURL == "" {
		return "", "", "", "", errors.New("direct upload unavailable")
	}
	uploadURL, err = du.PresignPut(context.Background(), storageKey, 15*time.Minute)
	if err != nil {
		return "", "", "", "", err
	}
	return id, uploadURL, publicURL, storageKey, nil
}

// CompleteDirectImageUpload verifies the object exists on CDN, then stores image metadata.
func (s *Store) CompleteDirectImageUpload(chatID, uploaderID, imageID, iv, mimeType string) (createdAt int64, publicURL string, err error) {
	du, ok := s.blobs.(blob.DirectUploader)
	if !ok {
		return 0, "", errors.New("direct upload unavailable")
	}
	if _, err := uuid.Parse(imageID); err != nil {
		return 0, "", errors.New("invalid image id")
	}
	key := "images/" + imageID
	if err := du.Head(context.Background(), key); err != nil {
		return 0, "", errors.New("cdn object missing")
	}
	publicURL = du.PublicObjectURL(key)
	createdAt = time.Now().UnixMilli()
	_, err = s.db.Exec(`
		INSERT INTO images (id, chat_id, uploader_id, ciphertext, iv, mime_type, created_at, storage_key)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, imageID, chatID, uploaderID, []byte{}, iv, mimeType, createdAt, key)
	if err != nil {
		return 0, "", err
	}
	return createdAt, publicURL, nil
}

func (s *Store) imagePublicURL(storageKey string) string {
	du, ok := s.blobs.(blob.DirectUploader)
	if !ok || storageKey == "" {
		return ""
	}
	return du.PublicObjectURL(storageKey)
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
	if storageKey.Valid && storageKey.String != "" {
		// Direct download: hand the browser a short-lived presigned GET (private
		// bucket) or CDN URL so the object never streams back through Go/nginx.
		if du, ok := s.uploader(); ok {
			if url, uErr := s.photoDownloadURL(du, storageKey.String); uErr == nil && url != "" {
				img.URL = url
				return &img, nil
			}
		}
		// Legacy fallback: proxy the bytes with service credentials.
		if s.blobs != nil {
			img.Ciphertext, err = s.blobs.Get(context.Background(), storageKey.String)
			if err != nil {
				return nil, errors.New("not found")
			}
			return &img, nil
		}
	}
	if len(img.Ciphertext) == 0 {
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
	system, err := s.IsSystemChat(chatID)
	if err != nil {
		return nil, err
	}
	if system {
		return nil, errors.New("system chat")
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
	system, err := s.IsSystemChat(chatID)
	if err != nil {
		return err
	}
	if system {
		return errors.New("system chat")
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
	inCircle, err := s.IsMemberOfCircle(actorID, userID)
	if err != nil {
		return err
	}
	if !inCircle {
		return errors.New("not in circle")
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
	system, err := s.IsSystemChat(chatID)
	if err != nil {
		return err
	}
	if system {
		return errors.New("system chat")
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
	_, err = s.db.Exec(
		`UPDATE users SET signing_public_key = ?, token_version = token_version + 1 WHERE id = ?`,
		signingPublicKey, id,
	)
	return err
}

func (s *Store) DeleteUser(userID string) error {
	var username string
	var avatarKey sql.NullString
	err := s.db.QueryRow(`SELECT username, avatar_key FROM users WHERE id = ?`, userID).Scan(&username, &avatarKey)
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
		if avatarKey.Valid && avatarKey.String != "" {
			_ = s.blobs.Delete(context.Background(), avatarKey.String)
		}
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
	// Drop invites used by this user so reserved_username is freed.
	// Nulling used_by_user_id would revive the invite and block re-invites.
	if _, err := tx.Exec(`DELETE FROM invites WHERE used_by_user_id = ?`, userID); err != nil {
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
