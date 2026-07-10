package blob

import "context"

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
