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
		// SPA loads same-origin assets; connect covers API/WS; img for avatars/OG may be same-origin only.
		h.Set(
			"Content-Security-Policy",
			"default-src 'self'; "+
				"script-src 'self'; "+
				"style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob:; "+
				"font-src 'self'; "+
				"connect-src 'self' ws: wss:; "+
				"media-src 'self' blob:; "+
				"worker-src 'self'; "+
				"frame-ancestors 'none'; "+
				"base-uri 'self'; "+
				"form-action 'self'",
		)
		next.ServeHTTP(w, r)
	})
}
