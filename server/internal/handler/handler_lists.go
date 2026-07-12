package handler

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"coachman/server/internal/auth"
)

func (h *Handler) listChatLists(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chatID := chi.URLParam(r, "chatId")
	lists, err := h.store.ListChatLists(chatID, userID)
	if err != nil {
		switch err.Error() {
		case "forbidden":
			writeError(w, http.StatusForbidden, "forbidden")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	writeJSON(w, http.StatusOK, lists)
}

func (h *Handler) createChatList(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chatID := chi.URLParam(r, "chatId")
	var body struct {
		TitleCiphertext string `json:"titleCiphertext"`
		TitleIV         string `json:"titleIv"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	list, err := h.store.CreateChatList(chatID, userID, body.TitleCiphertext, body.TitleIV)
	if err != nil {
		switch err.Error() {
		case "forbidden":
			writeError(w, http.StatusForbidden, "forbidden")
		case "lists not allowed":
			writeError(w, http.StatusBadRequest, "lists not allowed")
		case "title required":
			writeError(w, http.StatusBadRequest, "title required")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	memberIDs, _ := h.store.GetMemberIDs(chatID)
	h.hub.BroadcastEvent(memberIDs, "chat_list", map[string]any{
		"action":      "upsert",
		"chatId":      chatID,
		"list":        list,
		"actorUserId": userID,
	})
	writeJSON(w, http.StatusOK, list)
}

func (h *Handler) deleteChatList(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	listID := chi.URLParam(r, "listId")
	chatID, err := h.store.DeleteChatList(listID, userID)
	if err != nil {
		switch err.Error() {
		case "forbidden":
			writeError(w, http.StatusForbidden, "forbidden")
		case "lists not allowed":
			writeError(w, http.StatusBadRequest, "lists not allowed")
		case "not found":
			writeError(w, http.StatusNotFound, "not found")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	memberIDs, _ := h.store.GetMemberIDs(chatID)
	h.hub.BroadcastEvent(memberIDs, "chat_list", map[string]any{
		"action":      "delete",
		"chatId":      chatID,
		"listId":      listID,
		"actorUserId": userID,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) addChatListItem(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	listID := chi.URLParam(r, "listId")
	var body struct {
		TextCiphertext string `json:"textCiphertext"`
		TextIV         string `json:"textIv"`
		Position       *int   `json:"position"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	position := -1
	if body.Position != nil {
		position = *body.Position
	}
	item, chatID, err := h.store.AddChatListItem(listID, userID, body.TextCiphertext, body.TextIV, position)
	if err != nil {
		switch err.Error() {
		case "forbidden":
			writeError(w, http.StatusForbidden, "forbidden")
		case "lists not allowed":
			writeError(w, http.StatusBadRequest, "lists not allowed")
		case "not found":
			writeError(w, http.StatusNotFound, "not found")
		case "text required":
			writeError(w, http.StatusBadRequest, "text required")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	memberIDs, _ := h.store.GetMemberIDs(chatID)
	h.hub.BroadcastEvent(memberIDs, "chat_list", map[string]any{
		"action":      "item_upsert",
		"chatId":      chatID,
		"listId":      listID,
		"item":        item,
		"actorUserId": userID,
	})
	// Push comes from the encrypted list system message (NotifyNewMessage).
	writeJSON(w, http.StatusOK, item)
}

func (h *Handler) setChatListItemDone(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	listID := chi.URLParam(r, "listId")
	itemID := chi.URLParam(r, "itemId")
	var body struct {
		Done bool `json:"done"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	item, chatID, err := h.store.SetChatListItemDone(listID, itemID, userID, body.Done)
	if err != nil {
		switch err.Error() {
		case "forbidden":
			writeError(w, http.StatusForbidden, "forbidden")
		case "lists not allowed":
			writeError(w, http.StatusBadRequest, "lists not allowed")
		case "not found":
			writeError(w, http.StatusNotFound, "not found")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	memberIDs, _ := h.store.GetMemberIDs(chatID)
	h.hub.BroadcastEvent(memberIDs, "chat_list", map[string]any{
		"action":      "item_upsert",
		"chatId":      chatID,
		"listId":      listID,
		"item":        item,
		"actorUserId": userID,
	})
	// Push comes from the encrypted list system message (NotifyNewMessage).
	writeJSON(w, http.StatusOK, item)
}

func (h *Handler) deleteChatListItem(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	listID := chi.URLParam(r, "listId")
	itemID := chi.URLParam(r, "itemId")
	chatID, err := h.store.DeleteChatListItem(listID, itemID, userID)
	if err != nil {
		switch err.Error() {
		case "forbidden":
			writeError(w, http.StatusForbidden, "forbidden")
		case "lists not allowed":
			writeError(w, http.StatusBadRequest, "lists not allowed")
		case "not found":
			writeError(w, http.StatusNotFound, "not found")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	memberIDs, _ := h.store.GetMemberIDs(chatID)
	h.hub.BroadcastEvent(memberIDs, "chat_list", map[string]any{
		"action":      "item_delete",
		"chatId":      chatID,
		"listId":      listID,
		"itemId":      itemID,
		"actorUserId": userID,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
