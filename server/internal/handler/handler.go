package handler

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"coachman/server/internal/auth"
	"coachman/server/internal/config"
	"coachman/server/internal/push"
	"coachman/server/internal/store"
	"coachman/server/internal/unfurl"
	"coachman/server/internal/ws"
)

const maxUploadSize = 25 << 20 // 25 MB
const maxAvatarSize = 1 << 20  // 1 MB
const tokenTTL = 24 * time.Hour
const challengeTTL = 5 * time.Minute

type Handler struct {
	store          *store.Store
	jwtSecret      string
	hub            *ws.Hub
	push           *push.Sender
	bootstrapToken string
	inviteTTLHours int64
}

func New(s *store.Store, jwtSecret string, hub *ws.Hub, pusher *push.Sender, bootstrapToken string, inviteTTLHours int64) *Handler {
	return &Handler{
		store: s, jwtSecret: jwtSecret, hub: hub, push: pusher,
		bootstrapToken: bootstrapToken, inviteTTLHours: inviteTTLHours,
	}
}

func (h *Handler) Routes() chi.Router {
	r := chi.NewRouter()

	r.Post("/auth/register", h.register)
	r.Get("/auth/setup-status", h.setupStatus)
	r.Post("/auth/bootstrap-reset", h.bootstrapReset)
	r.Get("/invites/validate", h.validateInvite)
	r.Post("/auth/challenge", h.challenge)
	r.Post("/auth/verify", h.verify)
	r.Post("/auth/attach-signing", h.attachSigning)
	r.Post("/auth/reset-signing", h.resetSigning)
	r.Post("/auth/delete-account", h.deleteAccountByCredentials)
	r.Get("/push/vapid-public-key", h.pushVapidPublicKey)

	r.Group(func(r chi.Router) {
		r.Use(auth.Middleware(h.jwtSecret))

		r.Delete("/account", h.deleteAccount)
		r.Get("/users/me", h.getMe)
		r.Post("/users/me/avatar", h.uploadAvatar)
		r.Delete("/users/me/avatar", h.deleteAvatar)
		r.Get("/users/{id}/avatar", h.getAvatar)
		r.Get("/users", h.searchUsers)
		r.Get("/circle", h.listCircle)
		r.Post("/invites", h.createInvite)
		r.Get("/admin/users", h.listAdminUsers)
		r.Delete("/admin/users/{id}", h.adminDeleteUser)
		r.Get("/users/{id}", h.getUser)

		r.Post("/chats/direct", h.createDirectChat)
		r.Post("/chats/group", h.createGroup)
		r.Delete("/chats/{chatId}", h.deleteChat)
		r.Delete("/chats/{chatId}/messages", h.clearChatMessages)
		r.Post("/chats/{chatId}/members", h.addGroupMember)
		r.Delete("/chats/{chatId}/members/{userId}", h.removeGroupMember)
		r.Post("/chats/{chatId}/system-keys", h.distributeSystemGroupKeys)
		r.Get("/chats", h.getChats)
		r.Get("/chats/{chatId}/messages", h.getMessages)
		r.Post("/chats/{chatId}/messages", h.sendMessage)
		r.Delete("/chats/{chatId}/messages/{messageId}", h.deleteMessage)
		r.Post("/chats/{chatId}/read", h.markChatRead)
		r.Post("/chats/{chatId}/images", h.uploadImage)

		r.Post("/push/subscribe", h.pushSubscribe)
		r.Delete("/push/subscribe", h.pushUnsubscribe)
		r.Post("/push/badge-reset", h.pushBadgeReset)

		r.Get("/images/{imageId}", h.getImage)
		r.Get("/unfurl", h.unfurlURL)
	})

	return r
}

func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username         string `json:"username"`
		PublicKey        string `json:"publicKey"`
		SigningPublicKey string `json:"signingPublicKey"`
		BootstrapToken   string `json:"bootstrapToken,omitempty"`
		InviteToken      string `json:"inviteToken,omitempty"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Username = store.NormalizeUsername(body.Username)
	if body.PublicKey == "" || body.SigningPublicKey == "" {
		writeError(w, http.StatusBadRequest, "publicKey and signingPublicKey required")
		return
	}

	count, err := h.store.UserCount()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	var user *store.User
	if body.BootstrapToken != "" {
		if h.bootstrapToken == "" || body.BootstrapToken != h.bootstrapToken {
			writeError(w, http.StatusForbidden, "Bootstrap token required")
			return
		}
		username := body.Username
		if username == "" {
			username = "admin"
		}
		if count == 0 {
			user, err = h.store.RegisterBootstrapUser(username, body.PublicKey, body.SigningPublicKey)
		} else {
			// Same bootstrap link on any device: rotate admin device keys and continue as admin.
			user, err = h.store.RebindAdminKeys(body.PublicKey, body.SigningPublicKey)
		}
	} else if count == 0 {
		writeError(w, http.StatusForbidden, "Bootstrap token required")
		return
	} else {
		if body.InviteToken == "" {
			writeError(w, http.StatusForbidden, "Invite token required")
			return
		}
		user, err = h.store.RegisterInvitedUser(body.PublicKey, body.SigningPublicKey, body.InviteToken)
	}
	if err != nil {
		switch err.Error() {
		case "username taken":
			writeError(w, http.StatusConflict, "Username taken")
		case "username reserved":
			writeError(w, http.StatusConflict, "Username reserved")
		case "invalid invite", "invite already used", "invite expired", "bootstrap required":
			writeError(w, http.StatusForbidden, err.Error())
		case "bootstrap not allowed", "admin not found":
			writeError(w, http.StatusForbidden, err.Error())
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (h *Handler) setupStatus(w http.ResponseWriter, r *http.Request) {
	count, err := h.store.UserCount()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"hasUsers":       count > 0,
		"needsBootstrap": count == 0,
	})
}

// bootstrapReset clears all data when a valid bootstrap token is provided,
// so the bootstrap link can recreate the admin on a fresh device.
func (h *Handler) bootstrapReset(w http.ResponseWriter, r *http.Request) {
	var body struct {
		BootstrapToken string `json:"bootstrapToken"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if h.bootstrapToken == "" || body.BootstrapToken != h.bootstrapToken {
		writeError(w, http.StatusForbidden, "Bootstrap token required")
		return
	}
	if err := h.store.ResetAllData(); err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "needsBootstrap": true})
}

func (h *Handler) validateInvite(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	info, err := h.store.ValidateInviteToken(token)
	if err != nil {
		writeError(w, http.StatusNotFound, "Invalid invite")
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (h *Handler) challenge(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Username = store.NormalizeUsername(body.Username)
	if body.Username == "" {
		writeError(w, http.StatusBadRequest, "username required")
		return
	}

	if _, err := h.store.GetUserSigningPublicKey(body.Username); err != nil {
		if err.Error() == "user not found" {
			writeError(w, http.StatusNotFound, "User not found")
			return
		}
		if err.Error() == "signing key not configured" {
			writeError(w, http.StatusBadRequest, "Signing key not configured")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	nonceB64 := base64.StdEncoding.EncodeToString(nonce)
	expiresAt := time.Now().Add(challengeTTL).UnixMilli()
	if err := h.store.SaveChallenge(body.Username, nonceB64, expiresAt); err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"nonce": nonceB64, "expiresAt": expiresAt})
}

func (h *Handler) verify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username  string `json:"username"`
		Signature string `json:"signature"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Username = store.NormalizeUsername(body.Username)
	if body.Username == "" || body.Signature == "" {
		writeError(w, http.StatusBadRequest, "username and signature required")
		return
	}

	signingPub, err := h.store.GetUserSigningPublicKey(body.Username)
	if err != nil {
		switch err.Error() {
		case "user not found":
			writeError(w, http.StatusNotFound, "User not found")
		case "signing key not configured":
			writeError(w, http.StatusBadRequest, "Signing key not configured")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	nonce, err := h.store.ConsumeChallenge(body.Username)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "invalid or expired challenge")
		return
	}
	if err := auth.VerifyECDSASignature(signingPub, nonce, body.Signature); err != nil {
		writeError(w, http.StatusUnauthorized, "invalid signature")
		return
	}

	user, err := h.store.LoginUser(body.Username)
	if err != nil {
		switch err.Error() {
		case "user not found":
			writeError(w, http.StatusNotFound, "User not found")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	token, err := auth.IssueToken(user.ID, user.Username, h.jwtSecret, tokenTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": user})
}

func (h *Handler) attachSigning(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username         string `json:"username"`
		PublicKey        string `json:"publicKey"`
		SigningPublicKey string `json:"signingPublicKey"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Username = store.NormalizeUsername(body.Username)
	if body.Username == "" || body.PublicKey == "" || body.SigningPublicKey == "" {
		writeError(w, http.StatusBadRequest, "username, publicKey and signingPublicKey required")
		return
	}
	if err := h.store.AttachSigningKey(body.Username, body.PublicKey, body.SigningPublicKey); err != nil {
		switch err.Error() {
		case "user not found":
			writeError(w, http.StatusNotFound, "User not found")
		case "public key mismatch":
			writeError(w, http.StatusForbidden, "public key mismatch")
		case "signing key already set":
			writeError(w, http.StatusConflict, "Signing key already set")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) resetSigning(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username         string `json:"username"`
		PublicKey        string `json:"publicKey"`
		SigningPublicKey string `json:"signingPublicKey"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Username = store.NormalizeUsername(body.Username)
	if body.Username == "" || body.PublicKey == "" || body.SigningPublicKey == "" {
		writeError(w, http.StatusBadRequest, "username, publicKey and signingPublicKey required")
		return
	}
	if err := h.store.ResetSigningKey(body.Username, body.PublicKey, body.SigningPublicKey); err != nil {
		switch err.Error() {
		case "user not found":
			writeError(w, http.StatusNotFound, "User not found")
		case "public key mismatch":
			writeError(w, http.StatusForbidden, "public key mismatch")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) deleteAccountByCredentials(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username  string `json:"username"`
		PublicKey string `json:"publicKey"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Username = store.NormalizeUsername(body.Username)
	if body.Username == "" {
		writeError(w, http.StatusBadRequest, "username required")
		return
	}

	var err error
	if body.PublicKey != "" {
		err = h.store.DeleteAccountByCredentials(body.Username, body.PublicKey)
		if err != nil && err.Error() == "public key mismatch" {
			err = h.store.DeleteAccountByUsername(body.Username)
		}
	} else {
		err = h.store.DeleteAccountByUsername(body.Username)
	}
	if err != nil {
		if err.Error() == "user not found" {
			writeError(w, http.StatusNotFound, "User not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) deleteAccount(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := h.store.DeleteUser(userID); err != nil {
		if err.Error() == "user not found" {
			writeError(w, http.StatusNotFound, "User not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) getMe(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	user, err := h.store.GetUser(userID)
	if err != nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func allowedAvatarMIME(mime string) bool {
	switch strings.ToLower(mime) {
	case "image/jpeg", "image/png", "image/webp":
		return true
	default:
		return false
	}
}

func (h *Handler) uploadAvatar(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxAvatarSize)
	if err := r.ParseMultipartForm(maxAvatarSize); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "Файл слишком большой (макс. 1 МБ)")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file required")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if len(data) == 0 {
		writeError(w, http.StatusBadRequest, "file required")
		return
	}

	mimeType := r.FormValue("mimeType")
	if mimeType == "" && header != nil {
		mimeType = header.Header.Get("Content-Type")
	}
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}
	if !allowedAvatarMIME(mimeType) {
		writeError(w, http.StatusBadRequest, "Допустимы JPEG, PNG или WebP")
		return
	}

	updatedAt, avatarURL, err := h.store.SetUserAvatar(userID, mimeType, data)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	resp := map[string]any{
		"hasAvatar":       true,
		"avatarUpdatedAt": updatedAt,
	}
	if avatarURL != "" {
		resp["avatarUrl"] = avatarURL
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) deleteAvatar(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := h.store.ClearUserAvatar(userID); err != nil {
		if err.Error() == "not found" {
			writeError(w, http.StatusNotFound, "Not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) getAvatar(w http.ResponseWriter, r *http.Request) {
	viewerID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	targetID := chi.URLParam(r, "id")
	if targetID == "" {
		writeError(w, http.StatusBadRequest, "id required")
		return
	}
	if targetID != viewerID {
		ok, err := h.store.IsMemberOfCircle(viewerID, targetID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal error")
			return
		}
		if !ok {
			writeError(w, http.StatusForbidden, "forbidden")
			return
		}
	}

	data, mimeType, updatedAt, err := h.store.GetUserAvatar(targetID)
	if err != nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	w.Header().Set("ETag", `"`+strings.ReplaceAll(targetID, `"`, "")+`-`+formatInt64(updatedAt)+`"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func formatInt64(v int64) string {
	return strconv.FormatInt(v, 10)
}

func (h *Handler) listCircle(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	users, err := h.store.ListCircleUsers(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (h *Handler) createInvite(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		Username string `json:"username"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	body.Username = store.NormalizeUsername(body.Username)
	if body.Username == "" {
		writeError(w, http.StatusBadRequest, "username required")
		return
	}
	token, err := h.store.CreateInvite(userID, body.Username, h.inviteTTLHours)
	if err != nil {
		switch err.Error() {
		case "forbidden":
			writeError(w, http.StatusForbidden, "Admin only")
		case "username taken":
			writeError(w, http.StatusConflict, "Username taken")
		case "username reserved":
			writeError(w, http.StatusConflict, "Username reserved")
		case "username required":
			writeError(w, http.StatusBadRequest, "username required")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"token": token})
}

func (h *Handler) listAdminUsers(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	users, err := h.store.ListUsersAdmin(userID)
	if err != nil {
		if err.Error() == "forbidden" {
			writeError(w, http.StatusForbidden, "forbidden")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (h *Handler) adminDeleteUser(w http.ResponseWriter, r *http.Request) {
	adminID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	targetID := chi.URLParam(r, "id")
	if targetID == "" {
		writeError(w, http.StatusBadRequest, "user id required")
		return
	}
	err := h.store.AdminDeleteUser(adminID, targetID)
	if err != nil {
		switch err.Error() {
		case "forbidden":
			writeError(w, http.StatusForbidden, "forbidden")
		case "cannot delete self":
			writeError(w, http.StatusBadRequest, "cannot delete yourself")
		case "cannot delete admin":
			writeError(w, http.StatusBadRequest, "cannot delete admin")
		case "user not found":
			writeError(w, http.StatusNotFound, "user not found")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) getUser(w http.ResponseWriter, r *http.Request) {
	user, err := h.store.GetUser(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (h *Handler) searchUsers(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	q := r.URL.Query().Get("q")
	var users []store.User
	var err error
	if q == "" {
		users, err = h.store.ListCircleUsers(userID)
	} else {
		users, err = h.store.SearchUsersInCircle(userID, q)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if users == nil {
		users = []store.User{}
	}
	writeJSON(w, http.StatusOK, users)
}

func (h *Handler) createDirectChat(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		OtherUserID string `json:"otherUserId"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.OtherUserID == "" {
		writeError(w, http.StatusBadRequest, "otherUserId required")
		return
	}
	id, err := h.store.CreateDirectChat(userID, body.OtherUserID)
	if err != nil {
		if err.Error() == "not in circle" {
			writeError(w, http.StatusForbidden, "User not in your circle")
			return
		}
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func (h *Handler) createGroup(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		Name    string                   `json:"name"`
		Members []store.GroupMemberInput `json:"members"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Name == "" || len(body.Members) == 0 {
		writeError(w, http.StatusBadRequest, "name and members required")
		return
	}
	id, err := h.store.CreateGroup(userID, body.Name, body.Members)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id})
}

func (h *Handler) deleteChat(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chatID := chi.URLParam(r, "chatId")
	memberIDs, err := h.store.DeleteChat(chatID, userID)
	if err != nil {
		switch err.Error() {
		case "not found":
			writeError(w, http.StatusNotFound, "Chat not found")
		case "forbidden":
			writeError(w, http.StatusForbidden, "Forbidden")
		case "system chat":
			writeError(w, http.StatusForbidden, "System group cannot be deleted")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	h.hub.BroadcastEvent(memberIDs, "members_changed", map[string]any{
		"chatId": chatID,
		"action": "deleted",
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) clearChatMessages(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chatID := chi.URLParam(r, "chatId")
	memberIDs, err := h.store.ClearChatMessages(chatID, userID)
	if err != nil {
		switch err.Error() {
		case "forbidden":
			writeError(w, http.StatusForbidden, "Forbidden")
		case "system chat":
			writeError(w, http.StatusForbidden, "System group cannot be cleared")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	h.hub.BroadcastEvent(memberIDs, "chat_cleared", map[string]any{
		"chatId": chatID,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) distributeSystemGroupKeys(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chatID := chi.URLParam(r, "chatId")
	systemID, found, err := h.store.GetSystemGroupID()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	if !found || systemID != chatID {
		writeError(w, http.StatusBadRequest, "Not a system group")
		return
	}
	var body struct {
		Members []store.GroupMemberInput `json:"members"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := h.store.DistributeSystemGroupKeys(userID, body.Members); err != nil {
		switch err.Error() {
		case "forbidden":
			writeError(w, http.StatusForbidden, "Forbidden")
		case "not found":
			writeError(w, http.StatusNotFound, "Chat not found")
		case "not a member":
			writeError(w, http.StatusBadRequest, "User is not a member")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	memberIDs, _ := h.store.GetMemberIDs(chatID)
	h.hub.BroadcastEvent(memberIDs, "members_changed", map[string]any{
		"chatId": chatID,
		"action": "system_keys",
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) addGroupMember(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chatID := chi.URLParam(r, "chatId")
	member, err := h.store.IsMember(chatID, userID)
	if err != nil || !member {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	var body struct {
		UserID            string                   `json:"userId"`
		EncryptedGroupKey string                   `json:"encryptedGroupKey"`
		RekeyEpoch        int64                    `json:"rekeyEpoch,omitempty"`
		MemberKeys        []store.GroupMemberInput `json:"memberKeys,omitempty"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.UserID == "" || body.EncryptedGroupKey == "" {
		writeError(w, http.StatusBadRequest, "userId and encryptedGroupKey required")
		return
	}
	if body.RekeyEpoch > 0 && len(body.MemberKeys) == 0 {
		writeError(w, http.StatusBadRequest, "memberKeys required when rekeyEpoch is set")
		return
	}
	if err := h.store.AddGroupMemberWithRekey(chatID, userID, body.UserID, body.EncryptedGroupKey, body.RekeyEpoch, body.MemberKeys); err != nil {
		switch err.Error() {
		case "not found":
			writeError(w, http.StatusNotFound, "Chat not found")
		case "not a group":
			writeError(w, http.StatusBadRequest, "Not a group chat")
		case "forbidden":
			writeError(w, http.StatusForbidden, "Only group creator can add members")
		case "system chat":
			writeError(w, http.StatusForbidden, "System group membership is automatic")
		case "already member":
			writeError(w, http.StatusConflict, "Already a member")
		case "user not found":
			writeError(w, http.StatusNotFound, "User not found")
		case "invalid epoch":
			writeError(w, http.StatusConflict, "Group key epoch mismatch")
		case "member not found":
			writeError(w, http.StatusBadRequest, "Invalid member in memberKeys")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	memberIDs, _ := h.store.GetMemberIDs(chatID)
	payload := map[string]any{
		"chatId": chatID,
		"action": "added",
		"userId": body.UserID,
	}
	if body.RekeyEpoch > 0 {
		payload["rekeyEpoch"] = body.RekeyEpoch
	}
	h.hub.BroadcastEvent(memberIDs, "members_changed", payload)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) removeGroupMember(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chatID := chi.URLParam(r, "chatId")
	targetID := chi.URLParam(r, "userId")
	member, err := h.store.IsMember(chatID, userID)
	if err != nil || !member {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	memberIDs, err := h.store.GetMemberIDs(chatID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	var rekeyBody struct {
		RekeyEpoch int64                    `json:"rekeyEpoch,omitempty"`
		MemberKeys []store.GroupMemberInput `json:"memberKeys,omitempty"`
	}
	if r.ContentLength > 0 {
		_ = json.NewDecoder(r.Body).Decode(&rekeyBody)
	}
	if rekeyBody.RekeyEpoch > 0 && len(rekeyBody.MemberKeys) == 0 {
		writeError(w, http.StatusBadRequest, "memberKeys required when rekeyEpoch is set")
		return
	}
	if err := h.store.RemoveGroupMemberWithRekey(chatID, userID, targetID, rekeyBody.RekeyEpoch, rekeyBody.MemberKeys); err != nil {
		switch err.Error() {
		case "not found":
			writeError(w, http.StatusNotFound, "Chat not found")
		case "not a group":
			writeError(w, http.StatusBadRequest, "Not a group chat")
		case "forbidden":
			writeError(w, http.StatusForbidden, "Only group creator can remove members")
		case "system chat":
			writeError(w, http.StatusForbidden, "System group membership is automatic")
		case "use delete group":
			writeError(w, http.StatusBadRequest, "Creator must delete the group instead of leaving")
		case "last member":
			writeError(w, http.StatusBadRequest, "Cannot remove last member")
		case "not a member":
			writeError(w, http.StatusNotFound, "Not a member")
		case "invalid epoch":
			writeError(w, http.StatusConflict, "Group key epoch mismatch")
		case "member not found":
			writeError(w, http.StatusBadRequest, "Invalid member in memberKeys")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	payload := map[string]any{
		"chatId": chatID,
		"action": "removed",
		"userId": targetID,
	}
	if rekeyBody.RekeyEpoch > 0 {
		payload["rekeyEpoch"] = rekeyBody.RekeyEpoch
	}
	h.hub.BroadcastEvent(memberIDs, "members_changed", payload)
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) getChats(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chats, err := h.store.GetChats(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	h.enrichChatsPresence(chats)
	writeJSON(w, http.StatusOK, chats)
}

func (h *Handler) enrichChatsPresence(chats []store.Chat) {
	ids := make([]string, 0)
	seen := make(map[string]struct{})
	for _, c := range chats {
		for _, m := range c.Members {
			if _, ok := seen[m.ID]; ok {
				continue
			}
			seen[m.ID] = struct{}{}
			ids = append(ids, m.ID)
		}
	}
	lastSeen, err := h.store.GetUsersLastSeen(ids)
	if err != nil {
		lastSeen = map[string]int64{}
	}
	for i := range chats {
		for j := range chats[i].Members {
			m := &chats[i].Members[j]
			m.Online = h.hub.IsUserOnline(m.ID)
			if at, ok := lastSeen[m.ID]; ok {
				v := at
				m.LastSeenAt = &v
			}
		}
	}
}

func (h *Handler) getMessages(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chatID := chi.URLParam(r, "chatId")
	member, err := h.store.IsMember(chatID, userID)
	if err != nil || !member {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	after := config.ParseInt64(r.URL.Query().Get("after"), 0)
	messages, err := h.store.GetMessages(chatID, after)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, messages)
}

func (h *Handler) markChatRead(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chatID := chi.URLParam(r, "chatId")
	var body struct {
		LastReadAt int64 `json:"lastReadAt"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if err := h.store.SetChatReadAt(chatID, userID, body.LastReadAt); err != nil {
		switch err.Error() {
		case "forbidden":
			writeError(w, http.StatusForbidden, "forbidden")
		case "invalid read time":
			writeError(w, http.StatusBadRequest, "invalid read time")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	memberIDs, _ := h.store.GetMemberIDs(chatID)
	h.hub.BroadcastEvent(memberIDs, "read", map[string]any{
		"chatId":     chatID,
		"userId":     userID,
		"lastReadAt": body.LastReadAt,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) sendMessage(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chatID := chi.URLParam(r, "chatId")
	member, err := h.store.IsMember(chatID, userID)
	if err != nil || !member {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	var body struct {
		Ciphertext string  `json:"ciphertext"`
		IV         string  `json:"iv"`
		Type       string  `json:"type"`
		ImageID    *string `json:"imageId"`
		PushBody   string  `json:"pushBody"` // optional plaintext preview for notification only (not stored)
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Ciphertext == "" {
		writeError(w, http.StatusBadRequest, "ciphertext required")
		return
	}
	msg, err := h.store.SendMessage(chatID, userID, body.Ciphertext, body.IV, body.Type, body.ImageID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	memberIDs, _ := h.store.GetMemberIDs(chatID)
	h.hub.BroadcastEvent(memberIDs, "message", msg)
	if h.push != nil {
		h.push.NotifyNewMessage(memberIDs, userID, chatID, body.Type, body.PushBody)
	}
	writeJSON(w, http.StatusOK, msg)
}

func (h *Handler) deleteMessage(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chatID := chi.URLParam(r, "chatId")
	messageID := chi.URLParam(r, "messageId")
	member, err := h.store.IsMember(chatID, userID)
	if err != nil || !member {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}
	if err := h.store.DeleteMessage(chatID, messageID, userID); err != nil {
		switch err.Error() {
		case "not found":
			writeError(w, http.StatusNotFound, "Not found")
		case "forbidden":
			writeError(w, http.StatusForbidden, "forbidden")
		default:
			writeError(w, http.StatusInternalServerError, "internal error")
		}
		return
	}
	memberIDs, _ := h.store.GetMemberIDs(chatID)
	h.hub.BroadcastEvent(memberIDs, "message_deleted", map[string]any{
		"chatId":    chatID,
		"messageId": messageID,
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) uploadImage(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	chatID := chi.URLParam(r, "chatId")
	member, err := h.store.IsMember(chatID, userID)
	if err != nil || !member {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "Файл слишком большой (макс. 25 МБ)")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file, iv, mimeType required")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	iv := r.FormValue("iv")
	mimeType := r.FormValue("mimeType")
	if len(data) == 0 || iv == "" || mimeType == "" {
		writeError(w, http.StatusBadRequest, "file, iv, mimeType required")
		return
	}

	id, createdAt, err := h.store.SaveImage(chatID, userID, iv, mimeType, data)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "chatId": chatID, "uploaderId": userID,
		"iv": iv, "mimeType": mimeType, "createdAt": createdAt,
	})
}

func (h *Handler) getImage(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	imageID := chi.URLParam(r, "imageId")
	chatID, err := h.store.GetImageChatID(imageID)
	if err != nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}
	member, err := h.store.IsMember(chatID, userID)
	if err != nil || !member {
		writeError(w, http.StatusForbidden, "forbidden")
		return
	}

	img, err := h.store.GetImage(imageID)
	if err != nil {
		writeError(w, http.StatusNotFound, "Not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"ciphertext": base64.StdEncoding.EncodeToString(img.Ciphertext),
		"iv":         img.IV,
		"mimeType":   img.MimeType,
	})
}

func (h *Handler) pushVapidPublicKey(w http.ResponseWriter, r *http.Request) {
	enabled := h.push != nil && h.push.Enabled()
	publicKey := ""
	if h.push != nil {
		publicKey = h.push.PublicKey()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":   enabled,
		"publicKey": publicKey,
	})
}

func (h *Handler) pushSubscribe(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if h.push == nil || !h.push.Enabled() {
		writeError(w, http.StatusServiceUnavailable, "Push notifications are not configured")
		return
	}
	var body struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Endpoint == "" || body.Keys.P256dh == "" || body.Keys.Auth == "" {
		writeError(w, http.StatusBadRequest, "endpoint and keys required")
		return
	}
	if err := h.store.UpsertPushSubscription(userID, body.Endpoint, body.Keys.P256dh, body.Keys.Auth); err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) pushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var body struct {
		Endpoint string `json:"endpoint"`
	}
	if !decodeJSON(w, r, &body) {
		return
	}
	if body.Endpoint == "" {
		writeError(w, http.StatusBadRequest, "endpoint required")
		return
	}
	if err := h.store.DeletePushSubscription(userID, body.Endpoint); err != nil {
		if err.Error() == "not found" {
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
			return
		}
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) pushBadgeReset(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if err := h.store.ResetPushBadge(userID); err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) unfurlURL(w http.ResponseWriter, r *http.Request) {
	_, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if rawURL == "" {
		writeError(w, http.StatusBadRequest, "url required")
		return
	}
	preview, err := unfurl.Fetch(r.Context(), rawURL)
	if err != nil {
		writeError(w, http.StatusBadGateway, "preview unavailable")
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 15<<20)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// RuntimeConfigJS exposes public runtime config (VAPID key, WebRTC ICE/TURN servers).
// TURN credentials are regenerated on each request when TURN_SECRET is configured.
func RuntimeConfigJS(cfg config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		payload, err := json.Marshal(map[string]any{
			"vapidPublicKey": strings.TrimSpace(cfg.VAPIDPublic),
			"iceServers":     cfg.IceServersNow(),
		})
		if err != nil {
			http.Error(w, "config error", http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte("window.__COACHMAN_RUNTIME__=" + string(payload) + ";"))
	}
}

// ServeSPA serves static assets and falls back to index.html for client-side routing.
func ServeSPA(distDir string) http.Handler {
	fileServer := http.FileServer(http.Dir(distDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/sw.js") || strings.Contains(r.URL.Path, "/workbox-") {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		}
		path := filepath.Join(distDir, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			fileServer.ServeHTTP(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(distDir, "index.html"))
	})
}
