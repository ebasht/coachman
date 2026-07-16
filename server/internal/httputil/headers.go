package httputil

import "net/http"

// SecurityHeaders sets baseline browser hardening headers for all responses.
func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
		// Notes:
		// - script-src needs 'unsafe-inline' for Capacitor bridge injection + small boot scripts
		// - fonts.googleapis.com / fonts.gstatic.com for UI fonts
		// - storage.yandexcloud.net for private/object images when served from S3 public URL
		// - connect-src covers API, WebSocket, TURN/ICE, and blob: (e.g. save chat photo)
		h.Set(
			"Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; "+
				"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "+
				"img-src 'self' data: blob: https://storage.yandexcloud.net; "+
				"font-src 'self' data: https://fonts.gstatic.com; "+
				"connect-src 'self' blob: ws: wss: https://storage.yandexcloud.net; "+
				"media-src 'self' blob:; "+
				"worker-src 'self' blob:; "+
				"frame-ancestors 'none'; "+
				"base-uri 'self'; "+
				"form-action 'self'",
		)
		next.ServeHTTP(w, r)
	})
}
