package unfurl

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/html"
)

const maxHTMLBytes = 512 << 10

// Browser-like UA: many sites strip OG tags for obvious bots.
const browserUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1"

type Preview struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
	SiteName    string `json:"siteName,omitempty"`
}

func Fetch(ctx context.Context, rawURL string) (*Preview, error) {
	parsed, err := validateURL(rawURL)
	if err != nil {
		return nil, err
	}

	if err := assertPublicHost(ctx, parsed.Hostname()); err != nil {
		return nil, err
	}

	client := &http.Client{
		Timeout: 8 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			if err := assertPublicHost(req.Context(), req.URL.Hostname()); err != nil {
				return err
			}
			return nil
		},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", browserUA)
	req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7")

	resp, err := client.Do(req)
	if err != nil {
		return minimalPreview(parsed), nil
	}
	defer resp.Body.Close()

	finalURL := parsed
	if resp.Request != nil && resp.Request.URL != nil {
		finalURL = resp.Request.URL
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return minimalPreview(finalURL), nil
	}

	ctype := strings.ToLower(resp.Header.Get("Content-Type"))
	if ctype != "" && !strings.Contains(ctype, "html") && !strings.Contains(ctype, "xml") {
		return minimalPreview(finalURL), nil
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxHTMLBytes))
	if err != nil {
		return minimalPreview(finalURL), nil
	}

	meta := parseHTML(string(body))
	preview := &Preview{
		URL:         finalURL.String(),
		Title:       firstNonEmpty(meta["og:title"], meta["twitter:title"], meta["title"]),
		Description: firstNonEmpty(meta["og:description"], meta["twitter:description"], meta["description"]),
		Image:       resolveURL(finalURL, firstNonEmpty(meta["og:image:secure_url"], meta["og:image"], meta["twitter:image"])),
		SiteName:    firstNonEmpty(meta["og:site_name"], finalURL.Hostname()),
	}
	if preview.Title == "" {
		preview.Title = preview.SiteName
		if preview.Title == "" {
			preview.Title = finalURL.Hostname()
		}
	}
	if preview.SiteName == "" {
		preview.SiteName = finalURL.Hostname()
	}
	return preview, nil
}

func minimalPreview(u *url.URL) *Preview {
	host := u.Hostname()
	if host == "" {
		host = u.Host
	}
	return &Preview{
		URL:      u.String(),
		Title:    host,
		SiteName: host,
	}
}

func validateURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid url")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("unsupported scheme")
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("missing host")
	}
	return parsed, nil
}

func assertPublicHost(ctx context.Context, host string) error {
	host = strings.Trim(host, "[]")
	if host == "" {
		return fmt.Errorf("missing host")
	}
	if strings.EqualFold(host, "localhost") {
		return fmt.Errorf("blocked host")
	}

	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return fmt.Errorf("host lookup failed")
	}
	for _, addr := range ips {
		if ip := addr.IP; ip != nil && isBlockedIP(ip) {
			return fmt.Errorf("blocked host")
		}
	}
	return nil
}

func isBlockedIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return true
	}
	privateRanges := []string{
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"127.0.0.0/8",
		"169.254.0.0/16",
		"::1/128",
		"fc00::/7",
		"fe80::/10",
	}
	for _, cidr := range privateRanges {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func parseHTML(body string) map[string]string {
	meta := make(map[string]string)
	z := html.NewTokenizer(strings.NewReader(body))
	var inTitle bool
	var title strings.Builder

	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			if title.Len() > 0 {
				meta["title"] = strings.TrimSpace(title.String())
			}
			return meta
		case html.StartTagToken, html.SelfClosingTagToken:
			t := z.Token()
			if t.Data == "title" {
				inTitle = true
				continue
			}
			if t.Data != "meta" {
				continue
			}
			var name, property, content string
			for _, a := range t.Attr {
				switch strings.ToLower(a.Key) {
				case "name":
					name = strings.ToLower(a.Val)
				case "property":
					property = strings.ToLower(a.Val)
				case "content":
					content = strings.TrimSpace(a.Val)
				}
			}
			if content == "" {
				continue
			}
			if property != "" {
				meta[property] = content
			} else if name != "" {
				meta[name] = content
			}
		case html.TextToken:
			if inTitle {
				title.WriteString(z.Token().Data)
			}
		case html.EndTagToken:
			if z.Token().Data == "title" {
				inTitle = false
			}
		}
	}
}

func resolveURL(base *url.URL, raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	if parsed.IsAbs() {
		return parsed.String()
	}
	return base.ResolveReference(parsed).String()
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v != "" {
			return v
		}
	}
	return ""
}
