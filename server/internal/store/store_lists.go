package store

import (
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
)

type ChatListItem struct {
	ID             string `json:"id"`
	ListID         string `json:"listId"`
	TextCiphertext string `json:"textCiphertext"`
	TextIV         string `json:"textIv"`
	Done           bool   `json:"done"`
	Position       int    `json:"position"`
	CreatedBy      string `json:"createdByUserId,omitempty"`
	UpdatedAt      int64  `json:"updatedAt"`
	UpdatedBy      string `json:"updatedByUserId,omitempty"`
}

type ChatList struct {
	ID              string         `json:"id"`
	ChatID          string         `json:"chatId"`
	TitleCiphertext string         `json:"titleCiphertext"`
	TitleIV         string         `json:"titleIv"`
	CreatedBy       string         `json:"createdByUserId,omitempty"`
	CreatedAt       int64          `json:"createdAt"`
	UpdatedAt       int64          `json:"updatedAt"`
	Items           []ChatListItem `json:"items"`
}

func (s *Store) assertChatListsAllowed(chatID string) error {
	isSystem, err := s.IsSystemChat(chatID)
	if err != nil {
		return err
	}
	if isSystem {
		return errors.New("lists not allowed")
	}
	return nil
}

func (s *Store) ListChatLists(chatID, userID string) ([]ChatList, error) {
	ok, err := s.IsMember(chatID, userID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("forbidden")
	}
	if err := s.assertChatListsAllowed(chatID); err != nil {
		if err.Error() == "lists not allowed" {
			return []ChatList{}, nil
		}
		return nil, err
	}

	rows, err := s.db.Query(`
		SELECT id, chat_id, title_ciphertext, title_iv, created_by_user_id, created_at, updated_at
		FROM chat_lists
		WHERE chat_id = ?
		ORDER BY created_at ASC
	`, chatID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var lists []ChatList
	for rows.Next() {
		var list ChatList
		var createdBy sql.NullString
		if err := rows.Scan(
			&list.ID, &list.ChatID, &list.TitleCiphertext, &list.TitleIV,
			&createdBy, &list.CreatedAt, &list.UpdatedAt,
		); err != nil {
			return nil, err
		}
		if createdBy.Valid {
			list.CreatedBy = createdBy.String
		}
		list.Items = []ChatListItem{}
		lists = append(lists, list)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if lists == nil {
		lists = []ChatList{}
	}

	for i := range lists {
		items, err := s.listChatListItems(lists[i].ID)
		if err != nil {
			return nil, err
		}
		lists[i].Items = items
	}
	return lists, nil
}

func (s *Store) listChatListItems(listID string) ([]ChatListItem, error) {
	rows, err := s.db.Query(`
		SELECT id, list_id, text_ciphertext, text_iv, done, position,
		       created_by_user_id, updated_at, updated_by_user_id
		FROM chat_list_items
		WHERE list_id = ?
		ORDER BY position ASC, created_at ASC
	`, listID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []ChatListItem{}
	for rows.Next() {
		var item ChatListItem
		var createdBy, updatedBy sql.NullString
		var done any
		if err := rows.Scan(
			&item.ID, &item.ListID, &item.TextCiphertext, &item.TextIV,
			&done, &item.Position, &createdBy, &item.UpdatedAt, &updatedBy,
		); err != nil {
			return nil, err
		}
		item.Done = asBool(done)
		if createdBy.Valid {
			item.CreatedBy = createdBy.String
		}
		if updatedBy.Valid {
			item.UpdatedBy = updatedBy.String
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func asBool(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case int64:
		return t != 0
	case int:
		return t != 0
	case []byte:
		return len(t) > 0 && t[0] != 0 && string(t) != "false" && string(t) != "FALSE"
	default:
		return false
	}
}

func (s *Store) GetChatList(listID, userID string) (*ChatList, error) {
	var list ChatList
	var createdBy sql.NullString
	err := s.db.QueryRow(`
		SELECT id, chat_id, title_ciphertext, title_iv, created_by_user_id, created_at, updated_at
		FROM chat_lists WHERE id = ?
	`, listID).Scan(
		&list.ID, &list.ChatID, &list.TitleCiphertext, &list.TitleIV,
		&createdBy, &list.CreatedAt, &list.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errors.New("not found")
	}
	if err != nil {
		return nil, err
	}
	if createdBy.Valid {
		list.CreatedBy = createdBy.String
	}
	ok, err := s.IsMember(list.ChatID, userID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("forbidden")
	}
	items, err := s.listChatListItems(list.ID)
	if err != nil {
		return nil, err
	}
	list.Items = items
	return &list, nil
}

func (s *Store) CreateChatList(chatID, userID, titleCiphertext, titleIV string) (*ChatList, error) {
	ok, err := s.IsMember(chatID, userID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errors.New("forbidden")
	}
	if err := s.assertChatListsAllowed(chatID); err != nil {
		return nil, err
	}
	if titleCiphertext == "" || titleIV == "" {
		return nil, errors.New("title required")
	}

	existing, err := s.ListChatLists(chatID, userID)
	if err != nil {
		return nil, err
	}
	if len(existing) > 0 {
		return &existing[0], nil
	}

	now := time.Now().UnixMilli()
	list := &ChatList{
		ID:              uuid.New().String(),
		ChatID:          chatID,
		TitleCiphertext: titleCiphertext,
		TitleIV:         titleIV,
		CreatedBy:       userID,
		CreatedAt:       now,
		UpdatedAt:       now,
		Items:           []ChatListItem{},
	}
	_, err = s.db.Exec(`
		INSERT INTO chat_lists (id, chat_id, title_ciphertext, title_iv, created_by_user_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, list.ID, list.ChatID, list.TitleCiphertext, list.TitleIV, userID, list.CreatedAt, list.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Store) DeleteChatList(listID, userID string) (chatID string, err error) {
	list, err := s.GetChatList(listID, userID)
	if err != nil {
		return "", err
	}
	if err := s.assertChatListsAllowed(list.ChatID); err != nil {
		return "", err
	}
	if _, err := s.db.Exec(`DELETE FROM chat_lists WHERE id = ?`, listID); err != nil {
		return "", err
	}
	return list.ChatID, nil
}

func (s *Store) AddChatListItem(listID, userID, textCiphertext, textIV string, position int) (*ChatListItem, string, error) {
	list, err := s.GetChatList(listID, userID)
	if err != nil {
		return nil, "", err
	}
	if err := s.assertChatListsAllowed(list.ChatID); err != nil {
		return nil, "", err
	}
	if textCiphertext == "" || textIV == "" {
		return nil, "", errors.New("text required")
	}
	if position < 0 {
		position = len(list.Items)
	}
	now := time.Now().UnixMilli()
	item := &ChatListItem{
		ID:             uuid.New().String(),
		ListID:         listID,
		TextCiphertext: textCiphertext,
		TextIV:         textIV,
		Done:           false,
		Position:       position,
		CreatedBy:      userID,
		UpdatedAt:      now,
		UpdatedBy:      userID,
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, "", err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`
		INSERT INTO chat_list_items (
			id, list_id, text_ciphertext, text_iv, done, position,
			created_by_user_id, created_at, updated_at, updated_by_user_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, item.ID, item.ListID, item.TextCiphertext, item.TextIV, false, item.Position, userID, now, now, userID); err != nil {
		return nil, "", err
	}
	if _, err := tx.Exec(`UPDATE chat_lists SET updated_at = ? WHERE id = ?`, now, listID); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(); err != nil {
		return nil, "", err
	}
	return item, list.ChatID, nil
}

func (s *Store) SetChatListItemDone(listID, itemID, userID string, done bool) (*ChatListItem, string, error) {
	list, err := s.GetChatList(listID, userID)
	if err != nil {
		return nil, "", err
	}
	if err := s.assertChatListsAllowed(list.ChatID); err != nil {
		return nil, "", err
	}
	now := time.Now().UnixMilli()
	res, err := s.db.Exec(`
		UPDATE chat_list_items
		SET done = ?, updated_at = ?, updated_by_user_id = ?
		WHERE id = ? AND list_id = ?
	`, done, now, userID, itemID, listID)
	if err != nil {
		return nil, "", err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return nil, "", err
	}
	if n == 0 {
		return nil, "", errors.New("not found")
	}
	_, _ = s.db.Exec(`UPDATE chat_lists SET updated_at = ? WHERE id = ?`, now, listID)

	var item ChatListItem
	var createdBy, updatedBy sql.NullString
	var doneVal any
	err = s.db.QueryRow(`
		SELECT id, list_id, text_ciphertext, text_iv, done, position,
		       created_by_user_id, updated_at, updated_by_user_id
		FROM chat_list_items WHERE id = ?
	`, itemID).Scan(
		&item.ID, &item.ListID, &item.TextCiphertext, &item.TextIV,
		&doneVal, &item.Position, &createdBy, &item.UpdatedAt, &updatedBy,
	)
	if err != nil {
		return nil, "", err
	}
	item.Done = asBool(doneVal)
	if createdBy.Valid {
		item.CreatedBy = createdBy.String
	}
	if updatedBy.Valid {
		item.UpdatedBy = updatedBy.String
	}
	return &item, list.ChatID, nil
}

func (s *Store) DeleteChatListItem(listID, itemID, userID string) (chatID string, err error) {
	list, err := s.GetChatList(listID, userID)
	if err != nil {
		return "", err
	}
	if err := s.assertChatListsAllowed(list.ChatID); err != nil {
		return "", err
	}
	res, err := s.db.Exec(`DELETE FROM chat_list_items WHERE id = ? AND list_id = ?`, itemID, listID)
	if err != nil {
		return "", err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return "", err
	}
	if n == 0 {
		return "", errors.New("not found")
	}
	_, _ = s.db.Exec(`UPDATE chat_lists SET updated_at = ? WHERE id = ?`, time.Now().UnixMilli(), listID)
	return list.ChatID, nil
}
