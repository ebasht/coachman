package blob

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"sync"
)

type Memory struct {
	mu   sync.Mutex
	objs map[string][]byte
	meta map[string]ObjectStat
}

func NewMemory() *Memory {
	return &Memory{objs: make(map[string][]byte), meta: make(map[string]ObjectStat)}
}

func (m *Memory) Put(ctx context.Context, key string, data []byte) error {
	return m.PutWithOptions(ctx, key, data, PutOptions{})
}

func (m *Memory) PutWithOptions(_ context.Context, key string, data []byte, opts PutOptions) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	m.objs[key] = cp
	ct := opts.ContentType
	if ct == "" {
		ct = "application/octet-stream"
	}
	m.meta[key] = ObjectStat{Size: int64(len(cp)), ContentType: ct}
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

func (m *Memory) Open(_ context.Context, key string) (io.ReadCloser, ObjectStat, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, ok := m.objs[key]
	if !ok {
		return nil, ObjectStat{}, fmt.Errorf("not found")
	}
	st := m.meta[key]
	if st.Size == 0 {
		st = ObjectStat{Size: int64(len(data)), ContentType: "application/octet-stream"}
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	return io.NopCloser(bytes.NewReader(cp)), st, nil
}

func (m *Memory) OpenRange(_ context.Context, key string, start, end int64) (io.ReadCloser, ObjectStat, int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, ok := m.objs[key]
	if !ok {
		return nil, ObjectStat{}, 0, fmt.Errorf("not found")
	}
	total := int64(len(data))
	if start < 0 {
		start = 0
	}
	if end < 0 || end >= total {
		end = total - 1
	}
	if total == 0 || start > end {
		return nil, ObjectStat{}, total, fmt.Errorf("range not satisfiable")
	}
	ct := m.meta[key].ContentType
	if ct == "" {
		ct = "application/octet-stream"
	}
	slice := data[start : end+1]
	cp := make([]byte, len(slice))
	copy(cp, slice)
	return io.NopCloser(bytes.NewReader(cp)), ObjectStat{Size: int64(len(cp)), ContentType: ct}, total, nil
}

func (m *Memory) Delete(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.objs, key)
	delete(m.meta, key)
	return nil
}

func (m *Memory) MakePublic(_ context.Context, _, _ string) error {
	return nil
}
