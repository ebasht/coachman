package handler_test

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"

	"coachman/server/internal/config"
	"coachman/server/internal/db"
	"coachman/server/internal/handler"
	"coachman/server/internal/push"
	"coachman/server/internal/store"
	"coachman/server/internal/ws"
)

func newTestHandler(t *testing.T) (*handler.Handler, *store.Store, *httptest.Server) {
	t.Helper()
	conn, err := db.Open(config.Config{DBPath: filepath.Join(t.TempDir(), "test.db")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	st := store.New(conn, nil)
	const jwtSecret = "handler-test-jwt-secret"
	hub := ws.NewHub(st, jwtSecret, nil, nil)
	t.Cleanup(hub.Close)
	pusher := push.NewSender(st, "", "", "", "", "", "")
	cfg := config.Config{JWTSecret: jwtSecret}
	h := handler.New(st, hub, pusher, cfg)

	r := chi.NewRouter()
	r.Mount("/api", h.Routes())
	ts := httptest.NewServer(r)
	t.Cleanup(ts.Close)
	return h, st, ts
}

func ecdsaKeyPair(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pubDER, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return priv, base64.StdEncoding.EncodeToString(pubDER)
}

func signChallenge(t *testing.T, priv *ecdsa.PrivateKey, nonceB64 string) string {
	t.Helper()
	nonce, err := base64.StdEncoding.DecodeString(nonceB64)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(nonce)
	r, s, err := ecdsa.Sign(rand.Reader, priv, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	const curveSize = 32
	sig := make([]byte, curveSize*2)
	copy(sig[curveSize-len(r.Bytes()):curveSize], r.Bytes())
	copy(sig[curveSize*2-len(s.Bytes()):], s.Bytes())
	return base64.StdEncoding.EncodeToString(sig)
}

func postJSON(t *testing.T, url string, body any, bearer string) (*http.Response, []byte) {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(res.Body)
	if err != nil {
		_ = res.Body.Close()
		t.Fatal(err)
	}
	_ = res.Body.Close()
	return res, b
}

func getJSON(t *testing.T, url, bearer string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(res.Body)
	if err != nil {
		_ = res.Body.Close()
		t.Fatal(err)
	}
	_ = res.Body.Close()
	return res, b
}

// issueSessionToken runs challenge → verify (signing key) and returns a bearer JWT.
func issueSessionToken(t *testing.T, baseURL, username string, signingPriv *ecdsa.PrivateKey) string {
	t.Helper()
	res, body := postJSON(t, baseURL+"/api/auth/challenge", map[string]string{"username": username}, "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("challenge: status=%d body=%s", res.StatusCode, body)
	}
	var ch struct {
		Nonce string `json:"nonce"`
	}
	if err := json.Unmarshal(body, &ch); err != nil || ch.Nonce == "" {
		t.Fatalf("challenge response: %v body=%s", err, body)
	}

	sig := signChallenge(t, signingPriv, ch.Nonce)
	res, body = postJSON(t, baseURL+"/api/auth/verify", map[string]string{
		"username":  username,
		"signature": sig,
	}, "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("verify: status=%d body=%s", res.StatusCode, body)
	}
	var vr struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(body, &vr); err != nil || vr.Token == "" {
		t.Fatalf("verify response: %v body=%s", err, body)
	}
	return vr.Token
}

// End-to-end: register signing key → JWT via /auth/verify → POST /messages.
func TestIssueTokenViaChallengeAndSendMessage(t *testing.T) {
	_, st, ts := newTestHandler(t)

	signPriv, signPub := ecdsaKeyPair(t)
	alice, err := st.RegisterBootstrapUser("alice", "enc-pub-alice", signPub)
	if err != nil {
		t.Fatal(err)
	}
	bobUser, err := st.RegisterInvitedUser("enc-pub-bob", "sign-pub-bob", mustInvite(t, st, alice.ID, "bob"))
	if err != nil {
		t.Fatal(err)
	}
	chatID, err := st.CreateDirectChat(alice.ID, bobUser.ID)
	if err != nil {
		t.Fatal(err)
	}

	token := issueSessionToken(t, ts.URL, "alice", signPriv)

	clientID := "test-client-msg-1"
	res, body := postJSON(t, ts.URL+"/api/chats/"+chatID+"/messages", map[string]string{
		"ciphertext": "cipher-hello",
		"iv":         "iv-hello",
		"type":       "text",
		"clientId":   clientID,
	}, token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("send message: status=%d body=%s", res.StatusCode, body)
	}
	var sent struct {
		ID       string `json:"id"`
		ChatID   string `json:"chatId"`
		Sequence int64  `json:"sequence"`
		ClientID string `json:"clientId"`
	}
	if err := json.Unmarshal(body, &sent); err != nil {
		t.Fatal(err)
	}
	if sent.ID == "" || sent.ChatID != chatID {
		t.Fatalf("unexpected message body: %+v", sent)
	}
	if sent.Sequence < 1 {
		t.Fatalf("expected sequence >= 1, got %d", sent.Sequence)
	}

	res, body = getJSON(t, ts.URL+"/api/chats/"+chatID+"/messages?after=0", token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("get messages: status=%d body=%s", res.StatusCode, body)
	}
	var history []struct {
		ID       string `json:"id"`
		ClientID string `json:"clientId"`
	}
	if err := json.Unmarshal(body, &history); err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].ID != sent.ID {
		t.Fatalf("history: %+v want id=%s", history, sent.ID)
	}
}

// TestSendMessageHTTPIdempotency covers duplicate POSTs and a lost-ACK retry at
// the HTTP layer: same chat+sender+clientId must return the same message id and
// leave a single history row. Equal ciphertext with a different clientId creates
// a second message.
func TestSendMessageHTTPIdempotency(t *testing.T) {
	_, st, ts := newTestHandler(t)

	signPriv, signPub := ecdsaKeyPair(t)
	alice, err := st.RegisterBootstrapUser("alice", "enc-pub-alice", signPub)
	if err != nil {
		t.Fatal(err)
	}
	bobUser, err := st.RegisterInvitedUser("enc-pub-bob", "sign-pub-bob", mustInvite(t, st, alice.ID, "bob"))
	if err != nil {
		t.Fatal(err)
	}
	chatID, err := st.CreateDirectChat(alice.ID, bobUser.ID)
	if err != nil {
		t.Fatal(err)
	}
	token := issueSessionToken(t, ts.URL, "alice", signPriv)
	url := ts.URL + "/api/chats/" + chatID + "/messages"

	type msgResp struct {
		ID       string `json:"id"`
		ClientID string `json:"clientId"`
		Sequence int64  `json:"sequence"`
	}
	post := func(ciphertext, clientID string) msgResp {
		t.Helper()
		res, body := postJSON(t, url, map[string]string{
			"ciphertext": ciphertext,
			"iv":         "iv",
			"type":       "text",
			"clientId":   clientID,
		}, token)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("POST clientId=%s: status=%d body=%s", clientID, res.StatusCode, body)
		}
		var m msgResp
		if err := json.Unmarshal(body, &m); err != nil {
			t.Fatal(err)
		}
		if m.ID == "" {
			t.Fatalf("empty id in response: %s", body)
		}
		return m
	}
	historyLen := func() int {
		t.Helper()
		res, body := getJSON(t, ts.URL+"/api/chats/"+chatID+"/messages?after=0", token)
		if res.StatusCode != http.StatusOK {
			t.Fatalf("history: status=%d body=%s", res.StatusCode, body)
		}
		var history []msgResp
		if err := json.Unmarshal(body, &history); err != nil {
			t.Fatal(err)
		}
		return len(history)
	}

	// First send.
	first := post("cipher-hello", "http-idem-1")
	if historyLen() != 1 {
		t.Fatalf("after first: want 1 message, got %d", historyLen())
	}

	// Lost ACK: client never saw first response; retries identical logical op.
	retry := post("cipher-hello", "http-idem-1")
	if retry.ID != first.ID {
		t.Fatalf("lost-ACK retry: want id %s, got %s", first.ID, retry.ID)
	}
	if retry.Sequence != first.Sequence {
		t.Fatalf("lost-ACK retry: want sequence %d, got %d", first.Sequence, retry.Sequence)
	}
	if historyLen() != 1 {
		t.Fatalf("after lost-ACK retry: want 1 message, got %d", historyLen())
	}

	// Explicit duplicate with different ciphertext body still returns original.
	dup := post("cipher-other-body", "http-idem-1")
	if dup.ID != first.ID {
		t.Fatalf("duplicate: want id %s, got %s", first.ID, dup.ID)
	}
	if historyLen() != 1 {
		t.Fatalf("after duplicate: want 1 message, got %d", historyLen())
	}

	// Same text, different clientId → second logical message.
	other := post("cipher-hello", "http-idem-2")
	if other.ID == first.ID {
		t.Fatal("different clientId must create a distinct message")
	}
	if historyLen() != 2 {
		t.Fatalf("after second clientId: want 2 messages, got %d", historyLen())
	}
}

func mustInvite(t *testing.T, st *store.Store, inviterID, username string) string {
	t.Helper()
	token, err := st.CreateInvite(inviterID, username, 0)
	if err != nil {
		t.Fatal(err)
	}
	return token
}
