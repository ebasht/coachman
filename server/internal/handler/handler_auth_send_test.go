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

func mustInvite(t *testing.T, st *store.Store, inviterID, username string) string {
	t.Helper()
	token, err := st.CreateInvite(inviterID, username, 0)
	if err != nil {
		t.Fatal(err)
	}
	return token
}
