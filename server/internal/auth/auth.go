package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const UserIDKey contextKey = "userID"

type Claims struct {
	UserID       string `json:"sub"`
	Username     string `json:"username"`
	TokenVersion int64  `json:"tv"`
	jwt.RegisteredClaims
}

// TokenVersionLookup returns the current token_version for a user, or an error if the user is gone.
type TokenVersionLookup func(ctx context.Context, userID string) (int64, error)

func IssueToken(userID, username, secret string, ttl time.Duration, tokenVersion int64) (string, error) {
	claims := Claims{
		UserID:       userID,
		Username:     username,
		TokenVersion: tokenVersion,
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

func ParseToken(tokenStr, secret string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return []byte(secret), nil
	})
	if err != nil {
		return nil, err
	}
	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, errors.New("invalid token")
	}
	return claims, nil
}

func VerifyECDSASignature(signingPublicKeyB64, nonceB64, signatureB64 string) error {
	pubBytes, err := base64.StdEncoding.DecodeString(signingPublicKeyB64)
	if err != nil {
		return fmt.Errorf("decode public key: %w", err)
	}
	pubAny, err := x509.ParsePKIXPublicKey(pubBytes)
	if err != nil {
		return fmt.Errorf("parse public key: %w", err)
	}
	pub, ok := pubAny.(*ecdsa.PublicKey)
	if !ok {
		return errors.New("not ecdsa public key")
	}

	nonce, err := base64.StdEncoding.DecodeString(nonceB64)
	if err != nil {
		return fmt.Errorf("decode nonce: %w", err)
	}
	sig, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return fmt.Errorf("decode signature: %w", err)
	}

	hash := sha256.Sum256(nonce)
	if !verifyECDSASignature(pub, hash[:], sig) {
		return errors.New("invalid signature")
	}
	return nil
}

// verifyECDSASignature accepts IEEE P1363 (Web Crypto: r||s) and ASN.1 DER signatures.
func verifyECDSASignature(pub *ecdsa.PublicKey, hash, sig []byte) bool {
	curveSize := (pub.Curve.Params().BitSize + 7) / 8
	if len(sig) == curveSize*2 {
		r := new(big.Int).SetBytes(sig[:curveSize])
		s := new(big.Int).SetBytes(sig[curveSize:])
		if ecdsa.Verify(pub, hash, r, s) {
			return true
		}
	}
	return ecdsa.VerifyASN1(pub, hash, sig)
}

func unauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(`{"error":"unauthorized"}`))
}

func Middleware(secret string, lookup TokenVersionLookup) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if !strings.HasPrefix(header, "Bearer ") {
				unauthorized(w)
				return
			}
			tokenStr := strings.TrimPrefix(header, "Bearer ")
			claims, err := ParseToken(tokenStr, secret)
			if err != nil {
				unauthorized(w)
				return
			}
			if lookup != nil {
				ver, err := lookup(r.Context(), claims.UserID)
				if err != nil || ver != claims.TokenVersion {
					unauthorized(w)
					return
				}
			}
			ctx := context.WithValue(r.Context(), UserIDKey, claims.UserID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func UserIDFromContext(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(UserIDKey).(string)
	return id, ok
}

func ParseTokenFromHeader(header, secret string) (*Claims, error) {
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, errors.New("missing bearer token")
	}
	return ParseToken(strings.TrimPrefix(header, "Bearer "), secret)
}
