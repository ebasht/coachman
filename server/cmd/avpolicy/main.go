package main

import (
	"fmt"
	"io"
	"net/http"
	"time"

	"coachman/server/internal/blob"
	"coachman/server/internal/config"
	"coachman/server/internal/db"
)

func main() {
	cfg := config.Load()
	s3, err := blob.NewS3(cfg.S3)
	if err != nil {
		panic(err)
	}
	_ = s3
	fmt.Println("policy applied")

	conn, err := db.Open(cfg)
	if err != nil {
		panic(err)
	}
	defer conn.Close()
	var key string
	var updated int64
	err = conn.QueryRow(`SELECT avatar_key, avatar_updated_at FROM users WHERE avatar_key IS NOT NULL LIMIT 1`).Scan(&key, &updated)
	if err != nil {
		fmt.Println("no avatar rows:", err)
		return
	}
	url := cfg.S3.PublicURL + "/" + key + fmt.Sprintf("?v=%d", updated)
	fmt.Println("test", url)
	resp, err := http.Get(url)
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 80))
	fmt.Println("status", resp.StatusCode, resp.Header.Get("Content-Type"), string(b))
	_ = time.Second
}
