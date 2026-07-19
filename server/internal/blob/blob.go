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

// ObjectStat is the subset of object metadata used to validate a completed upload.
type ObjectStat struct {
	Size        int64
	ContentType string
}

// DirectUploader enables browser → object storage uploads (presigned PUT) and
// browser → object storage downloads (presigned GET), bypassing nginx and the Go backend.
type DirectUploader interface {
	// PresignPut issues an unbound PUT URL (any Content-Type). Prefer PresignPutContentType.
	PresignPut(ctx context.Context, key string, expiry time.Duration) (uploadURL string, err error)
	// PresignPutContentType signs the Content-Type into the URL — the browser must
	// send exactly the same Content-Type header on PUT or the signature is rejected.
	PresignPutContentType(ctx context.Context, key, contentType string, expiry time.Duration) (uploadURL string, err error)
	// PresignGet issues a short-lived GET URL for private-bucket downloads.
	PresignGet(ctx context.Context, key string, expiry time.Duration) (downloadURL string, err error)
	PublicObjectURL(key string) string
	// Head reports whether the object exists (used so GetImage does not return a URL before PUT finishes).
	Head(ctx context.Context, key string) error
	// Stat returns object size and Content-Type; used to validate a completed upload.
	Stat(ctx context.Context, key string) (ObjectStat, error)
	// Bucket returns the configured bucket name (recorded on the attachment row).
	Bucket() string
}
