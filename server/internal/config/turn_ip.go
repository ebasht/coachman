package config

import (
	"net"
	"strings"
	"sync"
	"time"
)

// Clients sometimes fail to resolve the TURN hostname (Android Private DNS /
// OEM blocks) even while the API host still works. Publish turn: URLs with
// literal IPs so WebRTC never needs that DNS lookup. turns: stays on hostname
// (TLS cert / SNI).

const turnIPCacheTTL = 5 * time.Minute

var (
	lookupHostIPs = net.LookupIP

	turnIPCacheMu sync.Mutex
	turnIPCache   = map[string]turnIPCacheEntry{}
)

type turnIPCacheEntry struct {
	ips []string
	at  time.Time
}

// withTurnIPFallbacks appends turn:<ip>:… duplicates for hostname-based turn: URLs.
func withTurnIPFallbacks(servers []IceServer) []IceServer {
	if len(servers) == 0 {
		return servers
	}
	extra := make([]IceServer, 0, len(servers))
	seen := map[string]struct{}{}
	for _, s := range servers {
		for _, u := range iceURLs(s.URLs) {
			seen[u] = struct{}{}
		}
	}
	for _, s := range servers {
		for _, u := range iceURLs(s.URLs) {
			for _, ipURL := range turnIPURLFallbacks(u) {
				if _, ok := seen[ipURL]; ok {
					continue
				}
				seen[ipURL] = struct{}{}
				entry := IceServer{URLs: ipURL, Username: s.Username, Credential: s.Credential}
				extra = append(extra, entry)
			}
		}
	}
	if len(extra) == 0 {
		return servers
	}
	out := make([]IceServer, 0, len(servers)+len(extra))
	out = append(out, servers...)
	out = append(out, extra...)
	return out
}

func iceURLs(v any) []string {
	switch t := v.(type) {
	case string:
		if t == "" {
			return nil
		}
		return []string{t}
	case []string:
		return t
	case []any:
		out := make([]string, 0, len(t))
		for _, x := range t {
			if s, ok := x.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

// turnIPURLFallbacks returns turn: URLs with the host replaced by resolved A/AAAA
// literals. Only plain turn: (not turns:) — IP + TLS usually fails cert checks.
func turnIPURLFallbacks(raw string) []string {
	scheme, host, port, query, ok := splitTurnURL(raw)
	if !ok || !strings.EqualFold(scheme, "turn") {
		return nil
	}
	if net.ParseIP(host) != nil {
		return nil
	}
	ips := cachedHostIPs(host)
	if len(ips) == 0 {
		return nil
	}
	out := make([]string, 0, len(ips))
	for _, ip := range ips {
		hostPort := ip
		if port != "" {
			hostPort = net.JoinHostPort(ip, port)
		} else if strings.Contains(ip, ":") {
			hostPort = "[" + ip + "]"
		}
		u := "turn:" + hostPort + query
		out = append(out, u)
	}
	return out
}

func splitTurnURL(raw string) (scheme, host, port, query string, ok bool) {
	raw = strings.TrimSpace(raw)
	i := strings.Index(raw, ":")
	if i <= 0 {
		return "", "", "", "", false
	}
	scheme = raw[:i]
	rest := raw[i+1:]
	if q := strings.Index(rest, "?"); q >= 0 {
		query = rest[q:]
		rest = rest[:q]
	}
	if rest == "" {
		return "", "", "", "", false
	}
	// Bracketed IPv6: [addr]:port
	if strings.HasPrefix(rest, "[") {
		end := strings.Index(rest, "]")
		if end < 0 {
			return "", "", "", "", false
		}
		host = rest[1:end]
		after := rest[end+1:]
		if strings.HasPrefix(after, ":") {
			port = after[1:]
		}
		return scheme, host, port, query, true
	}
	if h, p, err := net.SplitHostPort(rest); err == nil {
		return scheme, h, p, query, true
	}
	// No port (unusual for TURN).
	return scheme, rest, "", query, true
}

func cachedHostIPs(host string) []string {
	host = strings.TrimSpace(strings.ToLower(host))
	if host == "" {
		return nil
	}
	now := time.Now()
	turnIPCacheMu.Lock()
	if e, ok := turnIPCache[host]; ok && now.Sub(e.at) < turnIPCacheTTL {
		ips := append([]string(nil), e.ips...)
		turnIPCacheMu.Unlock()
		return mergeIPStrings(ips, staticTurnFallbackIPs())
	}
	turnIPCacheMu.Unlock()

	resolved, err := lookupHostIPs(host)
	ips := make([]string, 0, 4)
	seen := map[string]struct{}{}
	if err == nil {
		for _, ip := range resolved {
			s := ip.String()
			if _, ok := seen[s]; ok {
				continue
			}
			seen[s] = struct{}{}
			ips = append(ips, s)
		}
	}
	ips = mergeIPStrings(ips, staticTurnFallbackIPs())
	if len(ips) == 0 {
		return nil
	}

	turnIPCacheMu.Lock()
	turnIPCache[host] = turnIPCacheEntry{ips: ips, at: now}
	turnIPCacheMu.Unlock()
	return ips
}

func staticTurnFallbackIPs() []string {
	return splitCSV(firstEnv("TURN_FALLBACK_IPS", "TURN_IPS"))
}

func mergeIPStrings(base, extra []string) []string {
	if len(extra) == 0 {
		return base
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, len(base)+len(extra))
	for _, s := range base {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	for _, s := range extra {
		s = strings.TrimSpace(s)
		if s == "" || net.ParseIP(s) == nil {
			continue
		}
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}
