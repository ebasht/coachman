package handler_test

import (
	"io"
	"net/http"
	"path/filepath"
	"testing"

	"coachman/server/internal/blob"
	"coachman/server/internal/config"
	"coachman/server/internal/db"
	"coachman/server/internal/store"
)

func deleteReq(t *testing.T, url, bearer string) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodDelete, url, nil)
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

func TestAdminDeleteUserHTTPWithUploads(t *testing.T) {
	mem := blob.NewMemory()
	conn, err := db.Open(config.Config{DBPath: filepath.Join(t.TempDir(), "test.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	st := store.New(conn, mem)

	alicePriv, alicePub := ecdsaKeyPair(t)
	_, bobPub := ecdsaKeyPair(t)

	alice, err := st.RegisterBootstrapUser("alice", "enc-alice", alicePub)
	if err != nil {
		t.Fatal(err)
	}
	bob, err := st.RegisterInvitedUser("enc-bob", bobPub, mustInvite(t, st, alice.ID, "bob"))
	if err != nil {
		t.Fatal(err)
	}
	chatID, err := st.CreateDirectChat(alice.ID, bob.ID)
	if err != nil {
		t.Fatal(err)
	}
	imgID, _, err := st.SaveImage(chatID, bob.ID, "plain", "image/jpeg", []byte{1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = st.SendMessage(chatID, bob.ID, "c", "iv", "image", &imgID, "cid-http", nil)
	if err != nil {
		t.Fatal(err)
	}
	_, err = conn.Exec(`
		INSERT INTO uploads (id, user_id, chat_id, object_key, bucket, content_type, expected_size, status, created_at, expires_at)
		VALUES ('up-http', ?, ?, 'k', 'b', 'image/jpeg', 3, 'completed', 1, 9999999999999)
	`, bob.ID, chatID)
	if err != nil {
		t.Fatal(err)
	}

	_, ts := newTestHandlerWithStore(t, st)
	token := issueSessionToken(t, ts.URL, "alice", alicePriv)

	res, body := deleteReq(t, ts.URL+"/api/admin/users/"+bob.ID, token)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin delete: status=%d body=%s", res.StatusCode, body)
	}
	if _, err := st.LoginUser("bob"); err == nil {
		t.Fatal("bob still exists")
	}
}
