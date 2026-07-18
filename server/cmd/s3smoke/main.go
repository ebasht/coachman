package main

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"coachman/server/internal/blob"
	"coachman/server/internal/config"
)

func main() {
	cfg := config.Load()
	if !cfg.S3.Enabled() {
		fatalf("S3 not configured")
	}
	// Yandex always needs TLS even if S3_USE_SSL is unset in .env.
	if strings.Contains(cfg.S3.Endpoint, "yandexcloud.net") {
		cfg.S3.UseSSL = true
	}

	store, err := blob.NewS3(cfg.S3)
	if err != nil {
		fatalf("s3 init: %v", err)
	}

	jpegBytes := mustJPEG()
	id := fmt.Sprintf("smoke-%d", time.Now().Unix())
	key := "images/" + id
	ctx := context.Background()

	fmt.Printf("upload key=%s bytes=%d endpoint=%s ssl=%v bucket=%s\n",
		key, len(jpegBytes), cfg.S3.Endpoint, cfg.S3.UseSSL, cfg.S3.Bucket)

	if err := store.PutWithOptions(ctx, key, jpegBytes, blob.PutOptions{
		ContentType:  "image/jpeg",
		CacheControl: "public, max-age=60",
	}); err != nil {
		fatalf("put failed: %v", err)
	}
	fmt.Println("put: ok")

	if err := store.Head(ctx, key); err != nil {
		fatalf("head failed: %v", err)
	}
	fmt.Println("head: ok")

	got, err := store.Get(ctx, key)
	if err != nil {
		fatalf("get failed: %v", err)
	}
	if !bytes.Equal(got, jpegBytes) {
		fatalf("get mismatch: got %d bytes, want %d", len(got), len(jpegBytes))
	}
	fmt.Printf("get: ok (%d bytes)\n", len(got))

	out := filepath.Join(os.TempDir(), id+".jpg")
	if err := os.WriteFile(out, got, 0o644); err != nil {
		fatalf("write local: %v", err)
	}
	fmt.Println("saved:", out)

	public := store.PublicObjectURL(key)
	fmt.Println("publicUrl:", public)
	if public != "" {
		resp, err := http.Get(public)
		if err != nil {
			fmt.Printf("public get: FAIL %v\n", err)
		} else {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
			_ = resp.Body.Close()
			fmt.Printf("public get: status=%d bytes=%d\n", resp.StatusCode, len(body))
			if resp.StatusCode == 200 && bytes.Equal(body, jpegBytes) {
				fmt.Println("public get: ok (body matches)")
			} else if resp.StatusCode == 200 {
				fmt.Println("public get: WARN body mismatch")
			} else {
				fmt.Println("public get: FAIL (need public-read on images/*)")
			}
		}
	}

	_ = store.Delete(ctx, key)
	fmt.Println("cleanup: deleted smoke object")
	fmt.Println("SMOKE OK")
}

func mustJPEG() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 64, 64))
	for y := 0; y < 64; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 4), G: uint8(y * 4), B: 180, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 90}); err != nil {
		fatalf("jpeg: %v", err)
	}
	return buf.Bytes()
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
