package blob

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"coachman/server/internal/config"
)

type S3 struct {
	client *minio.Client
	bucket string
}

func NewS3(cfg config.S3Config) (*S3, error) {
	if cfg.Endpoint == "" {
		return nil, fmt.Errorf("s3 endpoint is empty")
	}
	if cfg.AccessKey == "" || cfg.SecretKey == "" {
		return nil, fmt.Errorf("s3 credentials are not configured")
	}

	client, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
		Region: cfg.Region,
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
		if err := client.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{Region: cfg.Region}); err != nil {
			return nil, fmt.Errorf("create bucket: %w", err)
		}
	}

	s3 := &S3{client: client, bucket: cfg.Bucket}
	if err := s3.ensurePublicAvatarsPolicy(ctx); err != nil {
		// Credentials may lack s3:PutBucketPolicy; avatars still work via ACL or API proxy.
		fmt.Printf("avatar bucket policy skipped: %v\n", err)
	}
	return s3, nil
}

func (s *S3) ensurePublicAvatarsPolicy(ctx context.Context) error {
	const sid = "PublicReadAvatars"
	desired := fmt.Sprintf(`{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": %q,
      "Effect": "Allow",
      "Principal": "*",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::%s/avatars/*"]
    }
  ]
}`, sid, s.bucket)

	existing, err := s.client.GetBucketPolicy(ctx, s.bucket)
	if err == nil && strings.Contains(existing, sid) {
		return nil
	}
	return s.client.SetBucketPolicy(ctx, s.bucket, desired)
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
