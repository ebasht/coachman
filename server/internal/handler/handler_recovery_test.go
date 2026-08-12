package handler_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

func TestLoginRecoveryHTTP(t *testing.T) {
	_, st, ts := newTestHandler(t)

	adminPriv, adminSignPub := ecdsaKeyPair(t)
	_, bobSignPub := ecdsaKeyPair(t)

	admin, err := st.RegisterBootstrapUser("admin", "enc-admin", adminSignPub)
	if err != nil {
		t.Fatal(err)
	}
	bob, err := st.RegisterInvitedUser("enc-bob", bobSignPub, mustInvite(t, st, admin.ID, "bob"))
	if err != nil {
		t.Fatal(err)
	}

	res, err := http.Get(ts.URL + "/api/auth/admin-public-key")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("admin-public-key: %d %s", res.StatusCode, body)
	}
	var pubResp struct {
		PublicKey string `json:"publicKey"`
	}
	if err := json.Unmarshal(body, &pubResp); err != nil || pubResp.PublicKey != "enc-admin" {
		t.Fatalf("pub resp: %v %s", err, body)
	}

	token := issueSessionToken(t, ts.URL, "admin", adminPriv)

	putReq, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/users/me/key-backup", bytes.NewReader([]byte(
		`{"ciphertext":"escrow-cipher"}`,
	)))
	putReq.Header.Set("Authorization", "Bearer "+token)
	putReq.Header.Set("Content-Type", "application/json")
	// Upload as bob — need bob session. Use store upsert for bob, admin creates recovery.
	_ = putReq
	if err := st.UpsertUserKeyBackup(bob.ID, "escrow-cipher"); err != nil {
		t.Fatal(err)
	}

	getReq, err := http.NewRequest(http.MethodGet, ts.URL+"/api/admin/users/"+bob.ID+"/key-backup", nil)
	if err != nil {
		t.Fatal(err)
	}
	getReq.Header.Set("Authorization", "Bearer "+token)
	getRes, err := http.DefaultClient.Do(getReq)
	if err != nil {
		t.Fatal(err)
	}
	getBody, _ := io.ReadAll(getRes.Body)
	_ = getRes.Body.Close()
	if getRes.StatusCode != http.StatusOK {
		t.Fatalf("get backup: %d %s", getRes.StatusCode, getBody)
	}

	createReq, err := http.NewRequest(http.MethodPost, ts.URL+"/api/admin/users/"+bob.ID+"/recovery", bytes.NewReader([]byte(
		`{"ciphertext":"{\"v\":1,\"ciphertext\":\"c\",\"iv\":\"i\"}"}`,
	)))
	if err != nil {
		t.Fatal(err)
	}
	createReq.Header.Set("Authorization", "Bearer "+token)
	createReq.Header.Set("Content-Type", "application/json")
	createRes, err := http.DefaultClient.Do(createReq)
	if err != nil {
		t.Fatal(err)
	}
	createBody, _ := io.ReadAll(createRes.Body)
	_ = createRes.Body.Close()
	if createRes.StatusCode != http.StatusOK {
		t.Fatalf("create recovery: %d %s", createRes.StatusCode, createBody)
	}
	var session struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(createBody, &session); err != nil || session.Token == "" {
		t.Fatalf("session: %v %s", err, createBody)
	}

	peekRes, err := http.Get(ts.URL + "/api/auth/recovery?token=" + session.Token)
	if err != nil {
		t.Fatal(err)
	}
	peekBody, _ := io.ReadAll(peekRes.Body)
	_ = peekRes.Body.Close()
	if peekRes.StatusCode != http.StatusOK {
		t.Fatalf("peek: %d %s", peekRes.StatusCode, peekBody)
	}

	consumeRes, err := http.Post(
		ts.URL+"/api/auth/recovery/consume",
		"application/json",
		bytes.NewReader([]byte(`{"token":"`+session.Token+`"}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	consumeBody, _ := io.ReadAll(consumeRes.Body)
	_ = consumeRes.Body.Close()
	if consumeRes.StatusCode != http.StatusOK {
		t.Fatalf("consume: %d %s", consumeRes.StatusCode, consumeBody)
	}
	var consumed struct {
		Username   string `json:"username"`
		Ciphertext string `json:"ciphertext"`
		PublicKey  string `json:"publicKey"`
	}
	if err := json.Unmarshal(consumeBody, &consumed); err != nil {
		t.Fatal(err)
	}
	if consumed.Username != "bob" || consumed.PublicKey != "enc-bob" || consumed.Ciphertext == "" {
		t.Fatalf("consumed: %+v", consumed)
	}

	reuse, err := http.Post(
		ts.URL+"/api/auth/recovery/consume",
		"application/json",
		bytes.NewReader([]byte(`{"token":"`+session.Token+`"}`)),
	)
	if err != nil {
		t.Fatal(err)
	}
	reuseBody, _ := io.ReadAll(reuse.Body)
	_ = reuse.Body.Close()
	if reuse.StatusCode != http.StatusOK {
		t.Fatalf("reuse expected 200 for multi-device, got %d %s", reuse.StatusCode, reuseBody)
	}
}
