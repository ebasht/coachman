package auth_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"testing"
	"time"

	"coachman/server/internal/auth"
)

func TestIssueAndParseToken(t *testing.T) {
	const userID = "user-id-123"
	token, err := auth.IssueToken(userID, "testuser", "secret", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := auth.ParseToken(token, "secret")
	if err != nil {
		t.Fatal(err)
	}
	if claims.UserID != userID {
		t.Fatalf("expected UserID %q, got %q (Subject=%q)", userID, claims.UserID, claims.Subject)
	}
}

func TestVerifyECDSASignatureP1363(t *testing.T) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	pubDER, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pubB64 := base64.StdEncoding.EncodeToString(pubDER)

	nonce := []byte("random-challenge-nonce-32bytes!!")
	nonceB64 := base64.StdEncoding.EncodeToString(nonce)
	hash := sha256.Sum256(nonce)
	r, s, err := ecdsa.Sign(rand.Reader, priv, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	curveSize := 32
	sig := make([]byte, curveSize*2)
	copy(sig[curveSize-len(r.Bytes()):curveSize], r.Bytes())
	copy(sig[curveSize*2-len(s.Bytes()):], s.Bytes())
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	if err := auth.VerifyECDSASignature(pubB64, nonceB64, sigB64); err != nil {
		t.Fatalf("expected valid P1363 signature, got %v", err)
	}
}
