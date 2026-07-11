package config

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Port           string
	DBPath         string
	DatabaseURL    string
	RedisURL       string
	JWTSecret      string
	BootstrapToken string
	InviteTTLHours int64
	CORSOrigins    []string
	S3             S3Config
	VAPIDPublic    string
	VAPIDPrivate   string
	VAPIDSubject   string
	PWAManifestID  string
	IceServers     []IceServer
}

// IceServer is a WebRTC ICE server entry exposed to the browser (TURN credentials included).
type IceServer struct {
	URLs       any    `json:"urls"`
	Username   string `json:"username,omitempty"`
	Credential string `json:"credential,omitempty"`
}

type S3Config struct {
	Endpoint  string
	AccessKey string
	SecretKey string
	Bucket    string
	Region    string
	UseSSL    bool
	PublicURL string
}

func (c S3Config) Enabled() bool {
	return c.Endpoint != ""
}

func loadDotEnv() {
	for _, path := range []string{".env", filepath.Join("server", ".env")} {
		f, err := os.Open(path)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(f)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			key, val, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			key = strings.TrimSpace(key)
			val = strings.TrimSpace(val)
			if key != "" && os.Getenv(key) == "" {
				_ = os.Setenv(key, val)
			}
		}
		_ = f.Close()
		return
	}
}

func normalizeS3Endpoint(raw string) (host string, secure bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", false
	}
	secure = strings.HasPrefix(raw, "https://")
	if strings.HasPrefix(raw, "https://") {
		raw = strings.TrimPrefix(raw, "https://")
	} else if strings.HasPrefix(raw, "http://") {
		raw = strings.TrimPrefix(raw, "http://")
		secure = false
	}
	if i := strings.Index(raw, "/"); i >= 0 {
		raw = raw[:i]
	}
	return raw, secure
}

func firstEnv(keys ...string) string {
	for _, key := range keys {
		if v := strings.TrimSpace(os.Getenv(key)); v != "" {
			return v
		}
	}
	return ""
}

func Load() Config {
	loadDotEnv()
	port := os.Getenv("PORT")
	if port == "" {
		port = "3001"
	}
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "data/coachman.db"
	}
	databaseURL := os.Getenv("DATABASE_URL")
	redisURL := os.Getenv("REDIS_URL")
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		jwtSecret = "dev-secret-change-in-production"
	}
	bootstrapToken := os.Getenv("BOOTSTRAP_TOKEN")
	inviteTTLHours := ParseInt64(os.Getenv("INVITE_TTL_HOURS"), 168)
	corsOrigins := []string{"http://localhost:5173", "http://localhost:3001"}
	if raw := os.Getenv("CORS_ORIGIN"); raw != "" {
		corsOrigins = strings.Split(raw, ",")
		for i := range corsOrigins {
			corsOrigins[i] = strings.TrimSpace(corsOrigins[i])
		}
	}
	endpoint, endpointSSL := normalizeS3Endpoint(os.Getenv("S3_ENDPOINT"))
	useSSL := endpointSSL || os.Getenv("S3_USE_SSL") == "true" || os.Getenv("S3_USE_SSL") == "1"
	s3 := S3Config{
		Endpoint:  endpoint,
		AccessKey: firstEnv("S3_ACCESS_KEY", "S3_ACCESS_KEY_ID"),
		SecretKey: firstEnv("S3_SECRET_KEY", "S3_SECRET_ACCESS_KEY"),
		Bucket:    os.Getenv("S3_BUCKET"),
		Region:    os.Getenv("S3_REGION"),
		UseSSL:    useSSL,
		PublicURL: strings.TrimRight(strings.TrimSpace(os.Getenv("S3_PUBLIC_URL")), "/"),
	}
	if s3.Bucket == "" {
		s3.Bucket = "coachman"
	}
	if s3.PublicURL == "" && s3.Endpoint != "" {
		scheme := "https"
		if !s3.UseSSL {
			scheme = "http"
		}
		s3.PublicURL = scheme + "://" + s3.Endpoint + "/" + s3.Bucket
	}
	vapidSubject := os.Getenv("VAPID_SUBJECT")
	if vapidSubject == "" {
		vapidSubject = "mailto:admin@coachman.local"
	}
	pwaManifestID := os.Getenv("PWA_MANIFEST_ID")
	if pwaManifestID == "" {
		for _, origin := range corsOrigins {
			origin = strings.TrimSpace(origin)
			if strings.HasPrefix(origin, "https://") {
				pwaManifestID = strings.TrimSuffix(origin, "/") + "/"
				break
			}
		}
	}
	if pwaManifestID == "" {
		pwaManifestID = "/"
	}
	return Config{
		Port: port, DBPath: dbPath, DatabaseURL: databaseURL, RedisURL: redisURL,
		JWTSecret: jwtSecret, BootstrapToken: bootstrapToken, InviteTTLHours: inviteTTLHours,
		CORSOrigins: corsOrigins, S3: s3,
		VAPIDPublic: os.Getenv("VAPID_PUBLIC_KEY"), VAPIDPrivate: os.Getenv("VAPID_PRIVATE_KEY"),
		VAPIDSubject: vapidSubject, PWAManifestID: pwaManifestID,
		IceServers: loadIceServers(),
	}
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func loadIceServers() []IceServer {
	// Full JSON override, e.g. [{"urls":"turn:host:3478","username":"u","credential":"p"}]
	if raw := strings.TrimSpace(os.Getenv("ICE_SERVERS_JSON")); raw != "" {
		var servers []IceServer
		if err := json.Unmarshal([]byte(raw), &servers); err == nil && len(servers) > 0 {
			return servers
		}
	}

	stunURLs := splitCSV(os.Getenv("STUN_URLS"))
	if len(stunURLs) == 0 {
		stunURLs = []string{
			"stun:stun.l.google.com:19302",
			"stun:stun1.l.google.com:19302",
		}
	}

	servers := make([]IceServer, 0, 4)
	for _, u := range stunURLs {
		servers = append(servers, IceServer{URLs: u})
	}

	turnURLs := splitCSV(firstEnv("TURN_URLS", "TURN_URL"))
	turnUser := strings.TrimSpace(os.Getenv("TURN_USERNAME"))
	turnPass := strings.TrimSpace(firstEnv("TURN_CREDENTIAL", "TURN_PASSWORD"))
	for _, u := range turnURLs {
		entry := IceServer{URLs: u}
		if turnUser != "" {
			entry.Username = turnUser
		}
		if turnPass != "" {
			entry.Credential = turnPass
		}
		servers = append(servers, entry)
	}
	return servers
}

func ParseInt64(s string, defaultVal int64) int64 {
	if s == "" {
		return defaultVal
	}
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return defaultVal
	}
	return v
}
