package config

import (
	"bufio"
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port                 string
	DBPath               string
	DatabaseURL          string
	RedisURL             string
	JWTSecret            string
	BootstrapToken       string
	AllowBootstrapRebind bool
	AllowBootstrapReset  bool
	DevMode              bool
	InviteTTLHours       int64
	CORSOrigins          []string
	S3                   S3Config
	// Photo direct-upload (browser → Yandex Object Storage) settings.
	CDNBaseURL            string        // public CDN origin for image object keys (may be empty for private-bucket mode)
	PhotoMaxFileSize      int64         // hard server-side limit for a single uploaded photo (bytes)
	PhotoUploadTTL        time.Duration // lifetime of a presigned PUT URL
	PhotoDownloadTTL      time.Duration // lifetime of a presigned GET URL
	VAPIDPublic           string
	VAPIDPrivate          string
	VAPIDSubject          string
	PWAManifestID         string
	FCMProjectID          string
	FCMServiceAccountJSON string
	// IceServers is a static snapshot (STUN + optional static TURN). Prefer IceServersNow().
	IceServers []IceServer
	Turn       TurnConfig
}

// TurnConfig holds TURN settings. Prefer Secret (coturn use-auth-secret) over static Credential.
type TurnConfig struct {
	URLs       []string
	Username   string // optional id part for REST API username (timestamp:id)
	Credential string // static password (long-term creds); ignored when Secret is set
	Secret     string // shared secret for ephemeral HMAC passwords
	TTLSeconds int64
}

// IceServer is a WebRTC ICE server entry exposed to the browser (TURN credentials included).
type IceServer struct {
	URLs       any    `json:"urls"`
	Username   string `json:"username,omitempty"`
	Credential string `json:"credential,omitempty"`
}

type S3Config struct {
	Endpoint    string
	AccessKey   string
	SecretKey   string
	Bucket      string
	Region      string
	UseSSL      bool
	PublicURL   string
	CORSOrigins []string // browser PUT/GET to the bucket (Yandex rejects AllowedOrigin "*")
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
			if len(val) >= 2 {
				if (val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'') {
					val = val[1 : len(val)-1]
				}
			}
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
	devMode := envTruthy("COACHMAN_DEV") || envTruthy("DEV")
	jwtSecret := os.Getenv("JWT_SECRET")
	const insecureDefaultJWT = "dev-secret-change-in-production"
	if jwtSecret == "" || jwtSecret == insecureDefaultJWT {
		if !devMode {
			panic("JWT_SECRET must be set to a strong unique value (set COACHMAN_DEV=1 only for local development)")
		}
		if jwtSecret == "" {
			jwtSecret = insecureDefaultJWT
		}
	}
	bootstrapToken := os.Getenv("BOOTSTRAP_TOKEN")
	allowBootstrapRebind := envTruthy("BOOTSTRAP_ALLOW_REBIND")
	allowBootstrapReset := envTruthy("BOOTSTRAP_ALLOW_RESET")
	inviteTTLHours := ParseInt64(os.Getenv("INVITE_TTL_HOURS"), 168)
	corsOrigins := []string{"http://localhost:5173", "http://localhost:3001"}
	if raw := os.Getenv("CORS_ORIGIN"); raw != "" {
		corsOrigins = strings.Split(raw, ",")
		for i := range corsOrigins {
			corsOrigins[i] = strings.TrimSpace(corsOrigins[i])
		}
	}
	// Endpoint/credentials accept both legacy S3_* and YANDEX_STORAGE_* names.
	endpoint, endpointSSL := normalizeS3Endpoint(firstEnv("S3_ENDPOINT", "YANDEX_STORAGE_ENDPOINT"))
	useSSL := endpointSSL || os.Getenv("S3_USE_SSL") == "true" || os.Getenv("S3_USE_SSL") == "1"
	// Yandex Object Storage is HTTPS-only; .env often omits S3_USE_SSL.
	if !useSSL && strings.Contains(endpoint, "yandexcloud.net") {
		useSSL = true
	}
	s3 := S3Config{
		Endpoint:    endpoint,
		AccessKey:   firstEnv("S3_ACCESS_KEY", "S3_ACCESS_KEY_ID", "YANDEX_STORAGE_ACCESS_KEY"),
		SecretKey:   firstEnv("S3_SECRET_KEY", "S3_SECRET_ACCESS_KEY", "YANDEX_STORAGE_SECRET_KEY"),
		Bucket:      firstEnv("S3_BUCKET", "YANDEX_STORAGE_BUCKET"),
		Region:      firstEnv("S3_REGION", "YANDEX_STORAGE_REGION"),
		UseSSL:      useSSL,
		PublicURL:   strings.TrimRight(strings.TrimSpace(firstEnv("S3_PUBLIC_URL", "YANDEX_CDN_BASE_URL")), "/"),
		CORSOrigins: corsOrigins,
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
	// Photo direct-upload limits (backend is the source of truth).
	cdnBaseURL := strings.TrimRight(strings.TrimSpace(firstEnv("YANDEX_CDN_BASE_URL", "PHOTO_CDN_BASE_URL")), "/")
	photoMaxFileSize := ParseInt64(os.Getenv("PHOTO_MAX_FILE_SIZE"), 30<<20) // 30 MB default
	photoUploadTTL := time.Duration(ParseInt64(os.Getenv("PHOTO_UPLOAD_URL_TTL"), 600)) * time.Second
	photoDownloadTTL := time.Duration(ParseInt64(os.Getenv("PHOTO_DOWNLOAD_URL_TTL"), 600)) * time.Second
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
	turn := loadTurnConfig()
	return Config{
		Port: port, DBPath: dbPath, DatabaseURL: databaseURL, RedisURL: redisURL,
		JWTSecret: jwtSecret, BootstrapToken: bootstrapToken,
		AllowBootstrapRebind: allowBootstrapRebind, AllowBootstrapReset: allowBootstrapReset,
		DevMode: devMode, InviteTTLHours: inviteTTLHours,
		CORSOrigins: corsOrigins, S3: s3,
		CDNBaseURL:       cdnBaseURL,
		PhotoMaxFileSize: photoMaxFileSize,
		PhotoUploadTTL:   photoUploadTTL,
		PhotoDownloadTTL: photoDownloadTTL,
		VAPIDPublic:      os.Getenv("VAPID_PUBLIC_KEY"), VAPIDPrivate: os.Getenv("VAPID_PRIVATE_KEY"),
		VAPIDSubject: vapidSubject, PWAManifestID: pwaManifestID,
		FCMProjectID:          strings.TrimSpace(os.Getenv("FCM_PROJECT_ID")),
		FCMServiceAccountJSON: strings.TrimSpace(firstEnv("FCM_SERVICE_ACCOUNT_JSON", "GOOGLE_APPLICATION_CREDENTIALS")),
		Turn:                  turn,
		IceServers:            loadIceServers(turn),
	}
}

func loadTurnConfig() TurnConfig {
	ttl := ParseInt64(os.Getenv("TURN_TTL_SECONDS"), 24*3600)
	if ttl < 60 {
		ttl = 3600
	}
	return TurnConfig{
		URLs:       splitCSV(firstEnv("TURN_URLS", "TURN_URL")),
		Username:   strings.TrimSpace(firstEnv("TURN_USERNAME", "TURN_USER")),
		Credential: strings.TrimSpace(firstEnv("TURN_CREDENTIAL", "TURN_PASSWORD")),
		Secret:     strings.TrimSpace(firstEnv("TURN_SECRET", "TURN_STATIC_AUTH_SECRET", "TURN_AUTH_SECRET")),
		TTLSeconds: ttl,
	}
}

// IceServersNow returns STUN/TURN ICE servers with fresh ephemeral TURN creds when Secret is set.
func (c Config) IceServersNow() []IceServer {
	return buildIceServers(c.Turn)
}

// GenerateTURNCredentials creates coturn REST API credentials from the shared secret.
// username = "<expiryUnix>:<id>", credential = base64(hmac-sha1(secret, username)).
func GenerateTURNCredentials(secret, userID string, ttlSeconds int64) (username, credential string) {
	if ttlSeconds < 60 {
		ttlSeconds = 3600
	}
	expiry := time.Now().UTC().Unix() + ttlSeconds
	id := strings.TrimSpace(userID)
	if id == "" {
		id = "coachman"
	}
	username = strconv.FormatInt(expiry, 10) + ":" + id
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(username))
	credential = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return username, credential
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

func loadIceServers(turn TurnConfig) []IceServer {
	return buildIceServers(turn)
}

func buildIceServers(turn TurnConfig) []IceServer {
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

	if len(turn.URLs) == 0 {
		return servers
	}

	user := turn.Username
	pass := turn.Credential
	if turn.Secret != "" {
		user, pass = GenerateTURNCredentials(turn.Secret, turn.Username, turn.TTLSeconds)
	}

	for _, u := range turn.URLs {
		entry := IceServer{URLs: u}
		if user != "" {
			entry.Username = user
		}
		if pass != "" {
			entry.Credential = pass
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

func envTruthy(name string) bool {
	v := strings.TrimSpace(strings.ToLower(os.Getenv(name)))
	return v == "1" || v == "true" || v == "yes" || v == "on"
}
