package ratelimit

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Limiter is a simple sliding-window counter keyed by client IP (or custom key).
type Limiter struct {
	mu       sync.Mutex
	window   time.Duration
	max      int
	requests map[string][]time.Time
}

func New(window time.Duration, max int) *Limiter {
	return &Limiter{
		window:   window,
		max:      max,
		requests: make(map[string][]time.Time),
	}
}

func (l *Limiter) Allow(key string) bool {
	now := time.Now()
	cutoff := now.Add(-l.window)

	l.mu.Lock()
	defer l.mu.Unlock()

	stamps := l.requests[key]
	kept := stamps[:0]
	for _, t := range stamps {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.max {
		l.requests[key] = kept
		return false
	}
	l.requests[key] = append(kept, now)
	return true
}

func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		return strings.TrimSpace(parts[0])
	}
	if xri := r.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// Middleware rejects with 429 when the key exceeds max requests per window.
func Middleware(l *Limiter, keyFn func(*http.Request) string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := keyFn(r)
			if key == "" {
				key = ClientIP(r)
			}
			if !l.Allow(key) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Retry-After", "60")
				w.WriteHeader(http.StatusTooManyRequests)
				_, _ = w.Write([]byte(`{"error":"too many requests"}`))
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
