package config

import (
	"net"
	"testing"
)

func TestSplitTurnURL(t *testing.T) {
	scheme, host, port, query, ok := splitTurnURL("turn:turn.example.com:3478?transport=udp")
	if !ok || scheme != "turn" || host != "turn.example.com" || port != "3478" || query != "?transport=udp" {
		t.Fatalf("got scheme=%q host=%q port=%q query=%q ok=%v", scheme, host, port, query, ok)
	}
	scheme, host, port, query, ok = splitTurnURL("turns:turn.example.com:5349")
	if !ok || scheme != "turns" || host != "turn.example.com" || port != "5349" || query != "" {
		t.Fatalf("turns: got scheme=%q host=%q port=%q query=%q ok=%v", scheme, host, port, query, ok)
	}
}

func TestTurnIPURLFallbacks(t *testing.T) {
	prev := lookupHostIPs
	lookupHostIPs = func(host string) ([]net.IP, error) {
		if host != "turn.example.com" {
			t.Fatalf("unexpected host %q", host)
		}
		return []net.IP{net.ParseIP("62.173.150.42")}, nil
	}
	t.Cleanup(func() {
		lookupHostIPs = prev
		turnIPCacheMu.Lock()
		turnIPCache = map[string]turnIPCacheEntry{}
		turnIPCacheMu.Unlock()
	})

	got := turnIPURLFallbacks("turn:turn.example.com:3478?transport=udp")
	if len(got) != 1 || got[0] != "turn:62.173.150.42:3478?transport=udp" {
		t.Fatalf("got %#v", got)
	}
	if turnIPURLFallbacks("turns:turn.example.com:5349") != nil {
		t.Fatal("turns: must not expand to IP")
	}
	if turnIPURLFallbacks("turn:62.173.150.42:3478") != nil {
		t.Fatal("already-IP must not expand")
	}
}

func TestWithTurnIPFallbacks(t *testing.T) {
	prev := lookupHostIPs
	lookupHostIPs = func(host string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("10.0.0.1")}, nil
	}
	t.Cleanup(func() {
		lookupHostIPs = prev
		turnIPCacheMu.Lock()
		turnIPCache = map[string]turnIPCacheEntry{}
		turnIPCacheMu.Unlock()
	})

	in := []IceServer{
		{URLs: "stun:stun.l.google.com:19302"},
		{URLs: "turn:turn.example.com:3478", Username: "u", Credential: "p"},
		{URLs: "turns:turn.example.com:5349", Username: "u", Credential: "p"},
	}
	out := withTurnIPFallbacks(in)
	if len(out) != 4 {
		t.Fatalf("len=%d want 4: %#v", len(out), out)
	}
	last := out[3]
	if last.URLs != "turn:10.0.0.1:3478" || last.Username != "u" || last.Credential != "p" {
		t.Fatalf("fallback entry %#v", last)
	}
}
