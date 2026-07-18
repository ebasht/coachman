package blob

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/cors"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"coachman/server/internal/config"
)

type S3 struct {
	client    *minio.Client
	bucket    string
	publicURL string
}

func NewS3(cfg config.S3Config) (*S3, error) {
	if cfg.Endpoint == "" {
		return nil, fmt.Errorf("s3 endpoint is empty")
	}
	if cfg.AccessKey == "" || cfg.SecretKey == "" {
		return nil, fmt.Errorf("s3 credentials are not configured")
	}

	region := cfg.Region
	if region == "" && strings.Contains(cfg.Endpoint, "yandexcloud.net") {
		region = "ru-central1"
	}

	// Yandex Object Storage requires path-style URLs for reliable browser/presign use.
	lookup := minio.BucketLookupAuto
	if strings.Contains(cfg.Endpoint, "yandexcloud.net") {
		lookup = minio.BucketLookupPath
	}

	client, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:        credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure:       cfg.UseSSL,
		Region:       region,
		BucketLookup: lookup,
	})
	if err != nil {
		return nil, fmt.Errorf("s3 client: %w", err)
	}

	ctx := context.Background()
	exists, err := client.BucketExists(ctx, cfg.Bucket)
	if err != nil {
		return nil, fmt.Errorf("bucket check: %w", err)
	}
	if !exists {
		if err := client.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{Region: region}); err != nil {
			return nil, fmt.Errorf("create bucket: %w", err)
		}
	}

	publicURL := strings.TrimRight(strings.TrimSpace(cfg.PublicURL), "/")
	s3 := &S3{client: client, bucket: cfg.Bucket, publicURL: publicURL}
	if err := s3.ensurePublicReadPolicy(ctx); err != nil {
		slog.Warn("s3 public read policy skipped", "err", err)
	} else {
		slog.Info("s3 public read policy ok", "bucket", cfg.Bucket)
	}
	if err := s3.ensureCORS(ctx, cfg.CORSOrigins); err != nil {
		slog.Warn("s3 cors skipped", "err", err, "hint", "set bucket CORS in Yandex console for browser PUT")
	} else {
		slog.Info("s3 cors ok", "bucket", cfg.Bucket, "origins", cfg.CORSOrigins)
	}
	return s3, nil
}

func (s *S3) ensurePublicReadPolicy(ctx context.Context) error {
	const sid = "PublicReadAvatarsAndImages"
	desired := fmt.Sprintf(`{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": %q,
      "Effect": "Allow",
      "Principal": "*",
      "Action": ["s3:GetObject"],
      "Resource": [
        "arn:aws:s3:::%s/avatars/*",
        "arn:aws:s3:::%s/images/*"
      ]
    }
  ]
}`, sid, s.bucket, s.bucket)

	existing, err := s.client.GetBucketPolicy(ctx, s.bucket)
	if err == nil && strings.Contains(existing, sid) {
		return nil
	}
	return s.client.SetBucketPolicy(ctx, s.bucket, desired)
}

func (s *S3) ensureCORS(ctx context.Context, origins []string) error {
	allowed := make([]string, 0, len(origins)+1)
	for _, o := range origins {
		o = strings.TrimSpace(o)
		if o == "" || o == "*" {
			continue
		}
		allowed = append(allowed, strings.TrimSuffix(o, "/"))
	}
	// Local Vite / Capacitor WebView helpers.
	for _, o := range []string{
		"http://localhost:5173",
		"http://127.0.0.1:5173",
		"https://localhost",
		"capacitor://localhost",
	} {
		allowed = append(allowed, o)
	}
	if len(allowed) == 0 {
		allowed = []string{"*"}
	}

	cfg := cors.NewConfig([]cors.Rule{{
		AllowedOrigin: allowed,
		AllowedMethod: []string{"GET", "PUT", "HEAD", "POST"},
		AllowedHeader: []string{"*"},
		ExposeHeader:  []string{"ETag", "x-amz-request-id"},
		MaxAgeSeconds: 3600,
	}})
	return s.client.SetBucketCors(ctx, s.bucket, cfg)
}

func (s *S3) Put(ctx context.Context, key string, data []byte) error {
	return s.PutWithOptions(ctx, key, data, PutOptions{ContentType: "application/octet-stream"})
}

func (s *S3) PutWithOptions(ctx context.Context, key string, data []byte, opts PutOptions) error {
	contentType := opts.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	putOpts := minio.PutObjectOptions{
		ContentType:  contentType,
		CacheControl: opts.CacheControl,
	}
	if opts.PublicRead {
		putOpts.UserMetadata = map[string]string{
			"x-amz-acl": "public-read",
		}
	}
	_, err := s.client.PutObject(ctx, s.bucket, key, bytes.NewReader(data), int64(len(data)), putOpts)
	return err
}

func (s *S3) Get(ctx context.Context, key string) ([]byte, error) {
	obj, err := s.client.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer obj.Close()
	return io.ReadAll(obj)
}

func (s *S3) Delete(ctx context.Context, key string) error {
	return s.client.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{})
}

// MakePublic re-uploads an object with a public-read ACL (same key).
func (s *S3) MakePublic(ctx context.Context, key, contentType string) error {
	data, err := s.Get(ctx, key)
	if err != nil {
		return err
	}
	return s.PutWithOptions(ctx, key, data, PutOptions{
		ContentType:  contentType,
		CacheControl: "public, max-age=31536000, immutable",
		PublicRead:   true,
	})
}

func (s *S3) PresignPut(ctx context.Context, key string, expiry time.Duration) (string, error) {
	if expiry <= 0 {
		expiry = 15 * time.Minute
	}
	u, err := s.client.PresignedPutObject(ctx, s.bucket, key, expiry)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

func (s *S3) PublicObjectURL(key string) string {
	if s.publicURL == "" || key == "" {
		return ""
	}
	return s.publicURL + "/" + strings.TrimPrefix(key, "/")
}

func (s *S3) Head(ctx context.Context, key string) error {
	_, err := s.client.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	return err
}
