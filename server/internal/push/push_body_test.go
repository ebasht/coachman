package push

import (
	"strings"
	"testing"

	"coachman/server/internal/store"
)

func TestTruncatePushBody(t *testing.T) {
	t.Parallel()
	if got := truncatePushBody("  hello   world  "); got != "hello world" {
		t.Fatalf("normalize whitespace: got %q", got)
	}
	if got := truncatePushBody(""); got != "" {
		t.Fatalf("empty: got %q", got)
	}
	long := strings.Repeat("あ", maxPushBodyRunes+10)
	got := truncatePushBody(long)
	runes := []rune(got)
	if len(runes) != maxPushBodyRunes {
		t.Fatalf("length: got %d want %d (%q)", len(runes), maxPushBodyRunes, got)
	}
	if runes[len(runes)-1] != '…' {
		t.Fatalf("ellipsis missing: %q", got)
	}
}

func TestMessagePushBody(t *testing.T) {
	t.Parallel()
	if got := messagePushBody("text", "Привет"); got != "Привет" {
		t.Fatalf("preview: got %q", got)
	}
	if got := messagePushBody("text", "  "); got != "Новое сообщение" {
		t.Fatalf("fallback text: got %q", got)
	}
	if got := messagePushBody("image", ""); got != "Фото" {
		t.Fatalf("fallback image: got %q", got)
	}
	if got := messagePushBody("video", ""); got != "Видео" {
		t.Fatalf("fallback video: got %q", got)
	}
	if got := messagePushBody("list", "Добавлено в список: молоко"); got != "Добавлено в список: молоко" {
		t.Fatalf("list preview: got %q", got)
	}
}

func TestApplyDeclarative(t *testing.T) {
	t.Parallel()
	s := &Sender{publicOrigin: "https://coachman.example"}
	pl := payload{Title: "Аня", Body: "Уже выхожу", Badge: 3}
	s.applyDeclarative(&pl, chatNavigatePath("chat 1"), "chat-1")
	if pl.WebPush != 8030 {
		t.Fatalf("web_push: got %d", pl.WebPush)
	}
	if pl.Notification == nil {
		t.Fatal("notification missing")
	}
	if pl.Notification.Body != "Уже выхожу" {
		t.Fatalf("body: %q", pl.Notification.Body)
	}
	if pl.Notification.Navigate != "https://coachman.example/c/chat%201" {
		t.Fatalf("navigate: %q", pl.Notification.Navigate)
	}
	if pl.Notification.AppBadge != "3" {
		t.Fatalf("badge: %q", pl.Notification.AppBadge)
	}

	raw, err := s.marshalWebPush(payload{Title: "Аня", Body: "Привет"}, "/", "t")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"web_push":8030`) {
		t.Fatalf("marshal missing web_push: %s", raw)
	}
	if !strings.Contains(string(raw), `"body":"Привет"`) {
		t.Fatalf("marshal missing body: %s", raw)
	}
}

func TestAttachMessageEnvelope(t *testing.T) {
	t.Parallel()
	pl := payload{}
	attachMessageEnvelope(&pl, &store.Message{
		ID:         "m1",
		SenderID:   "u2",
		Ciphertext: "abc",
		IV:         "iv",
		Type:       "text",
		Sequence:   4,
		CreatedAt:  9,
	})
	if pl.MessageID != "m1" || pl.Ciphertext != "abc" || pl.IV != "iv" || pl.Sequence != 4 {
		t.Fatalf("short text envelope: %+v", pl)
	}

	pl = payload{}
	attachMessageEnvelope(&pl, &store.Message{
		ID:         "m2",
		Type:       "image",
		Ciphertext: "abc",
		IV:         "iv",
	})
	if pl.MessageID != "m2" || pl.Ciphertext != "" {
		t.Fatalf("image must not carry ciphertext: %+v", pl)
	}

	pl = payload{}
	long := strings.Repeat("x", maxPushCiphertextBytes+1)
	attachMessageEnvelope(&pl, &store.Message{ID: "m3", Type: "text", Ciphertext: long, IV: "iv"})
	if pl.Ciphertext != "" {
		t.Fatal("oversized ciphertext should be omitted")
	}
}

func TestPublicHTTPSOrigin(t *testing.T) {
	t.Parallel()
	if got := publicHTTPSOrigin("https://app.example/", "mailto:a@b.c"); got != "https://app.example" {
		t.Fatalf("got %q", got)
	}
	if got := publicHTTPSOrigin("/", "http://localhost"); got != "" {
		t.Fatalf("http should not count: %q", got)
	}
}
