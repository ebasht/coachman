package main

import (
	"fmt"
	"log"
	"os"

	"coachman/server/internal/config"
	"coachman/server/internal/db"
)

func main() {
	cfg := config.Load()
	if cfg.DatabaseURL == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL не задан. Укажите его в server/.env")
		os.Exit(1)
	}

	conn, err := db.Open(cfg)
	if err != nil {
		log.Fatalf("migrate: %v", err)
	}
	conn.Close()

	fmt.Println("Миграции применены успешно")
}
