package blob

import (
	"context"
	"time"
)

type PutOptions struct {
	ContentType  string
	CacheControl string
	PublicRead   bool
}

type Storage interface {
	Put(ctx context.Context, key string, data []byte) error
	PutWithOptions(ctx context.Context, key string, data []byte, opts PutOptions) error
	Get(ctx context.Context, key string) ([]byte, error)
	Delete(ctx context.Context, key string) error
	MakePublic(ctx context.Context, key, contentType string) error
}

// DirectUploader enables browser → CDN uploads (presigned PUT) and public GET URLs.
type DirectUploader interface {
	PresignPut(ctx context.Context, key string, expiry time.Duration) (uploadURL string, err error)
	PublicObjectURL(key string) string
	// Head reports whether the object exists (used so GetImage does not return a URL before PUT finishes).
	Head(ctx context.Context, key string) error
}
