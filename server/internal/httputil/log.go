package httputil

import (
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5/middleware"
)

// LogErrors logs HTTP responses with status >= 400 (skips 401 to reduce noise).
func LogErrors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		status := ww.Status()
		if status == 0 || status < 400 || status == http.StatusUnauthorized {
			return
		}
		attrs := []any{
			"method", r.Method,
			"path", r.URL.Path,
			"status", status,
			"request_id", middleware.GetReqID(r.Context()),
		}
		if status >= 500 {
			slog.Error("http", attrs...)
		} else {
			slog.Warn("http", attrs...)
		}
	})
}
