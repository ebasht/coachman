package handler_test

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"

	"coachman/server/internal/blob"
	"coachman/server/internal/config"
	"coachman/server/internal/db"
	"coachman/server/internal/handler"
	"coachman/server/internal/push"
	"coachman/server/internal/store"
	"coachman/server/internal/ws"
)

func newTestHandlerWithStore(t *testing.T, st *store.Store) (*handler.Handler, *httptest.Server) {
	t.Helper()
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
	return h, ts
}

func TestRecipientDownloadsImageBytes(t *testing.T) {
	mem := blob.NewMemory()
	conn, err := db.Open(config.Config{DBPath: filepath.Join(t.TempDir(), "test.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	st := store.New(conn, mem)

	alicePriv, aliceSignPub := ecdsaKeyPair(t)
	bobPriv, bobSignPub := ecdsaKeyPair(t)

	alice, err := st.RegisterBootstrapUser("alice", "enc-alice", aliceSignPub)
	if err != nil {
		t.Fatal(err)
	}
	bobUser, err := st.RegisterInvitedUser("enc-bob", bobSignPub, mustInvite(t, st, alice.ID, "bob"))
	if err != nil {
		t.Fatal(err)
	}
	chatID, err := st.CreateDirectChat(alice.ID, bobUser.ID)
	if err != nil {
		t.Fatal(err)
	}

	payload := []byte{0xff, 0xd8, 0xff, 0x00, 0x01, 0x02}
	imageID, _, err := st.SaveImage(chatID, alice.ID, "plain", "image/jpeg", payload)
	if err != nil {
		t.Fatal(err)
	}

	_, ts := newTestHandlerWithStore(t, st)

	bobToken := issueSessionToken(t, ts.URL, "bob", bobPriv)
	aliceToken := issueSessionToken(t, ts.URL, "alice", alicePriv)

	res, body := getJSON(t, ts.URL+"/api/images/"+imageID, bobToken)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("getImage meta: %d %s", res.StatusCode, body)
	}

	res, body = getJSON(t, ts.URL+"/api/images/"+imageID+"/bytes", bobToken)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("recipient bytes: %d %s", res.StatusCode, body)
	}
	if ct := res.Header.Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("content-type: %q", ct)
	}
	if string(body) != string(payload) {
		t.Fatalf("payload mismatch len=%d", len(body))
	}

	res, _ = getJSON(t, ts.URL+"/api/images/"+imageID+"/bytes", aliceToken)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("sender bytes: %d", res.StatusCode)
	}

	res, _ = getJSON(t, ts.URL+"/api/images/"+imageID+"/bytes", "")
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", res.StatusCode)
	}
}
