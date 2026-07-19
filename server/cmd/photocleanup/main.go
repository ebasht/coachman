// Command photocleanup removes expired pending photo uploads and their orphaned
// objects. Run it manually or from cron; the API server also sweeps periodically.
//
//	go run ./server/cmd/photocleanup
package main

import (
	"fmt"
	"log"
	"time"

	"coachman/server/internal/blob"
	"coachman/server/internal/config"
	"coachman/server/internal/db"
	"coachman/server/internal/store"
)

func main() {
	cfg := config.Load()

	conn, err := db.Open(cfg)
	if err != nil {
		log.Fatalf("photocleanup: open db: %v", err)
	}
	defer conn.Close()

	var blobs blob.Storage
	if cfg.S3.Enabled() {
		s3store, err := blob.NewS3(cfg.S3)
		if err != nil {
			log.Fatalf("photocleanup: object storage: %v", err)
		}
		blobs = s3store
	}

	st := store.New(conn, blobs)
	st.SetPhotoLimits(cfg.CDNBaseURL, cfg.PhotoMaxFileSize, cfg.PhotoUploadTTL, cfg.PhotoDownloadTTL)

	n, err := st.CleanupExpiredUploads(time.Now().UnixMilli())
	if err != nil {
		log.Fatalf("photocleanup: %v", err)
	}
	fmt.Printf("Удалено просроченных загрузок: %d\n", n)
}
