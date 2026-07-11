package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/redis/go-redis/v9"

	"coachman/server/internal/blob"
	"coachman/server/internal/config"
	"coachman/server/internal/db"
	"coachman/server/internal/handler"
	"coachman/server/internal/push"
	"coachman/server/internal/store"
	"coachman/server/internal/ws"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	cfg := config.Load()

	conn, err := db.Open(cfg)
	if err != nil {
		slog.Error("database", "err", err)
		os.Exit(1)
	}
	defer conn.Close()

	if cfg.DatabaseURL != "" {
		slog.Info("database", "driver", "postgres")
	} else {
		slog.Info("database", "driver", "sqlite", "path", cfg.DBPath)
	}

	var blobs blob.Storage
	if cfg.S3.Enabled() {
		s3store, err := blob.NewS3(cfg.S3)
		if err != nil {
			slog.Error("s3", "err", err)
			os.Exit(1)
		}
		blobs = s3store
		slog.Info("object storage enabled", "endpoint", cfg.S3.Endpoint, "bucket", cfg.S3.Bucket, "publicURL", cfg.S3.PublicURL)
	}

	st := store.New(conn, blobs)
	if cfg.S3.PublicURL != "" {
		st.SetPublicBaseURL(cfg.S3.PublicURL)
	}
	if blobs != nil {
		if n, err := st.PublishAvatarsPublic(context.Background()); err != nil {
			slog.Warn("publish avatars", "err", err)
		} else if n > 0 {
			slog.Info("avatars published", "count", n)
		}
	}

	var rdb *redis.Client
	if cfg.RedisURL != "" {
		rdb, err = ws.ParseRedisClient(cfg.RedisURL)
		if err != nil {
			slog.Error("redis", "err", err)
			os.Exit(1)
		}
	}

	hub := ws.NewHub(st, cfg.JWTSecret, rdb)
	defer hub.Close()
	pusher := push.NewSender(st, cfg.VAPIDPublic, cfg.VAPIDPrivate, cfg.VAPIDSubject, cfg.PWAManifestID)
	hub.SetCallPusher(pusher)
	if pusher.Enabled() {
		slog.Info("web push enabled",
			"pwaManifestId", cfg.PWAManifestID,
			"vapidSubject", pusher.VAPIDSubject(),
		)
	}
	h := handler.New(st, cfg.JWTSecret, hub, pusher, cfg.BootstrapToken, cfg.InviteTTLHours)

	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   cfg.CORSOrigins,
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: true,
	}))

	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})

	r.Mount("/api", h.Routes())

	r.Get("/runtime-config.js", handler.RuntimeConfigJS(cfg))
	slog.Info("webrtc ice servers",
		"stun_turn_urls", len(cfg.IceServersNow()),
		"turn_urls", len(cfg.Turn.URLs),
		"turn_secret", cfg.Turn.Secret != "",
		"turn_static", cfg.Turn.Secret == "" && cfg.Turn.Credential != "",
	)

	distDir := filepath.Join("..", "client", "dist")
	_, distErr := os.Stat(distDir)
	hasDist := distErr == nil

	r.HandleFunc("/*", func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("Upgrade") == "websocket" {
			hub.Handle(w, req)
			return
		}
		if hasDist {
			handler.ServeSPA(distDir).ServeHTTP(w, req)
			return
		}
		http.NotFound(w, req)
	})

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      r,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		slog.Info("server running", "addr", "http://localhost:"+cfg.Port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("listen", "err", err)
			os.Exit(1)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("shutdown", "err", err)
	}
}
