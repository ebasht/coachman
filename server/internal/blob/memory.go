package blob

import (
	"context"
	"fmt"
	"sync"
)

type Memory struct {
	mu   sync.Mutex
	objs map[string][]byte
}

func NewMemory() *Memory {
	return &Memory{objs: make(map[string][]byte)}
}

func (m *Memory) Put(ctx context.Context, key string, data []byte) error {
	return m.PutWithOptions(ctx, key, data, PutOptions{})
}

func (m *Memory) PutWithOptions(_ context.Context, key string, data []byte, _ PutOptions) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	m.objs[key] = cp
	return nil
}

func (m *Memory) Get(_ context.Context, key string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, ok := m.objs[key]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	return cp, nil
}

func (m *Memory) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objs, key)
	return nil
}

func (m *Memory) MakePublic(_ context.Context, _, _ string) error {
	return nil
}
