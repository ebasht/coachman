package handler

import (
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"coachman/server/internal/auth"
	"coachman/server/internal/store"
)

const maxStorySize = 12 << 20 // 12 MiB

func (h *Handler) listStoryFeed(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	feed, err := h.store.ListStoryFeed(userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"authors": feed})
}

func (h *Handler) createStory(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxStorySize)
	if err := r.ParseMultipartForm(maxStorySize); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "Фото слишком большое (макс. 12 МБ)")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file required")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error", err)
		return
	}
	if len(data) == 0 {
		writeError(w, http.StatusBadRequest, "file required")
		return
	}

	mimeType := detectAvatarMIME(data)
	if !allowedAvatarMIME(mimeType) {
		writeError(w, http.StatusBadRequest, "Допустимы JPEG, PNG или WebP")
		return
	}

	width, _ := strconv.Atoi(r.FormValue("width"))
	height, _ := strconv.Atoi(r.FormValue("height"))

	story, err := h.store.CreateStory(userID, mimeType, data, width, height)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrPhotoTooLarge):
			writeError(w, http.StatusRequestEntityTooLarge, "Фото слишком большое")
		case errors.Is(err, store.ErrStoryBadImage):
			writeError(w, http.StatusBadRequest, "Допустимы JPEG, PNG или WebP")
		case errors.Is(err, store.ErrStoryLimit):
			writeError(w, http.StatusBadRequest, "Слишком много историй (макс. 30)")
		default:
			writeError(w, http.StatusInternalServerError, "internal error", err)
		}
		return
	}
	writeJSON(w, http.StatusCreated, story)
}

func (h *Handler) viewStory(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	storyID := chi.URLParam(r, "storyId")
	if storyID == "" {
		writeError(w, http.StatusBadRequest, "storyId required")
		return
	}
	if err := h.store.MarkStoryViewed(userID, storyID); err != nil {
		switch {
		case errors.Is(err, store.ErrStoryNotFound), errors.Is(err, store.ErrStoryExpired):
			writeError(w, http.StatusNotFound, "not found")
		case errors.Is(err, store.ErrStoryForbidden):
			writeError(w, http.StatusForbidden, "forbidden")
		default:
			writeError(w, http.StatusInternalServerError, "internal error", err)
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (h *Handler) deleteStory(w http.ResponseWriter, r *http.Request) {
	userID, ok := auth.UserIDFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	storyID := chi.URLParam(r, "storyId")
	if storyID == "" {
		writeError(w, http.StatusBadRequest, "storyId required")
		return
	}
	if err := h.store.DeleteStory(userID, storyID); err != nil {
		switch {
		case errors.Is(err, store.ErrStoryNotFound):
			writeError(w, http.StatusNotFound, "not found")
		case errors.Is(err, store.ErrStoryForbidden):
			writeError(w, http.StatusForbidden, "forbidden")
		default:
			writeError(w, http.StatusInternalServerError, "internal error", err)
		}
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
