package unfurl

import (
	"context"
	"net"
	"net/url"
	"strings"
	"testing"
)

func TestValidateURL(t *testing.T) {
	if _, err := validateURL("ftp://example.com"); err == nil {
		t.Fatal("expected scheme error")
	}
	if _, err := validateURL("https://example.com/path"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestParseHTML(t *testing.T) {
	body := `<html><head>
<title>Page title</title>
<meta property="og:title" content="OG title" />
<meta property="og:description" content="Desc" />
<meta property="og:image" content="/img.png" />
</head></html>`
	meta := parseHTML(body)
	if meta["og:title"] != "OG title" {
		t.Fatalf("og:title = %q", meta["og:title"])
	}
	if meta["title"] != "Page title" {
		t.Fatalf("title = %q", meta["title"])
	}
}

func TestResolveURL(t *testing.T) {
	base, _ := url.Parse("https://example.com/a/b")
	got := resolveURL(base, "/img.png")
	if got != "https://example.com/img.png" {
		t.Fatalf("resolve = %q", got)
	}
}

func TestIsBlockedIP(t *testing.T) {
	if !isBlockedIP(net.ParseIP("127.0.0.1")) {
		t.Fatal("loopback should be blocked")
	}
	if isBlockedIP(net.ParseIP("8.8.8.8")) {
		t.Fatal("public ip should be allowed")
	}
}

func TestFetchBlockedHost(t *testing.T) {
	_, err := Fetch(context.Background(), "http://127.0.0.1/")
	if err == nil || !strings.Contains(err.Error(), "blocked") {
		t.Fatalf("expected blocked error, got %v", err)
	}
}
