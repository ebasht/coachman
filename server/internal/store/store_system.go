package store

import (
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
)

const SystemGroupName = "Общий"

func (s *Store) IsSystemChat(chatID string) (bool, error) {
	var isSystem bool
	err := s.db.QueryRow(`SELECT is_system FROM chats WHERE id = ?`, chatID).Scan(&isSystem)
	if errors.Is(err, sql.ErrNoRows) {
		return false, errors.New("not found")
	}
	return isSystem, err
}

func (s *Store) GetSystemGroupID() (string, bool, error) {
	var id string
	err := s.db.QueryRow(`SELECT id FROM chats WHERE is_system LIMIT 1`).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return id, true, err
}

// EnsureSystemGroup creates the global undeletable group if missing.
func (s *Store) EnsureSystemGroup() (string, error) {
	if id, ok, err := s.GetSystemGroupID(); err != nil {
		return "", err
	} else if ok {
		return id, nil
	}

	var adminID sql.NullString
	_ = s.db.QueryRow(`SELECT id FROM users WHERE is_admin ORDER BY created_at ASC LIMIT 1`).Scan(&adminID)

	chatID := uuid.New().String()
	now := time.Now().UnixMilli()
	name := SystemGroupName

	var createdBy any
	if adminID.Valid {
		createdBy = adminID.String
	}

	_, err := s.db.Exec(
		`INSERT INTO chats (id, type, name, created_at, group_key_epoch, created_by_user_id, is_system)
		 VALUES (?, 'group', ?, ?, 1, ?, ?)`,
		chatID, name, now, createdBy, true,
	)
	if err != nil {
		// Concurrent create — return the winner.
		if id, ok, findErr := s.GetSystemGroupID(); findErr != nil {
			return "", findErr
		} else if ok {
			return id, nil
		}
		return "", err
	}
	return chatID, nil
}

// EnsureAllUsersInSystemGroup adds every user to the system group (without keys).
func (s *Store) EnsureAllUsersInSystemGroup() error {
	chatID, err := s.EnsureSystemGroup()
	if err != nil {
		return err
	}
	now := time.Now().UnixMilli()
	_, err = s.db.Exec(`
		INSERT INTO chat_members (chat_id, user_id, encrypted_group_key, joined_at)
		SELECT ?, u.id, NULL, ?
		FROM users u
		WHERE NOT EXISTS (
			SELECT 1 FROM chat_members cm WHERE cm.chat_id = ? AND cm.user_id = u.id
		)
	`, chatID, now, chatID)
	return err
}

// DistributeSystemGroupKeys lets any member fill missing encrypted_group_key wraps.
// Existing non-empty keys are never overwritten (no rekey).
func (s *Store) DistributeSystemGroupKeys(actorID string, wraps []GroupMemberInput) error {
	chatID, ok, err := s.GetSystemGroupID()
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("not found")
	}
	member, err := s.IsMember(chatID, actorID)
	if err != nil {
		return err
	}
	if !member {
		return errors.New("forbidden")
	}
	if len(wraps) == 0 {
		return nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, w := range wraps {
		if w.UserID == "" || w.EncryptedGroupKey == "" {
			continue
		}
		var exists string
		err := tx.QueryRow(
			`SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id = ?`,
			chatID, w.UserID,
		).Scan(&exists)
		if errors.Is(err, sql.ErrNoRows) {
			return errors.New("not a member")
		}
		if err != nil {
			return err
		}
		_, err = tx.Exec(`
			UPDATE chat_members
			SET encrypted_group_key = ?
			WHERE chat_id = ?
			  AND user_id = ?
			  AND (encrypted_group_key IS NULL OR encrypted_group_key = '')
		`, w.EncryptedGroupKey, chatID, w.UserID)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}
