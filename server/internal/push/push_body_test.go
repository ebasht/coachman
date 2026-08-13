package push

import (
	"strings"
	"testing"
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
