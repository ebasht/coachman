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
		log.Fatalf("db: %v", err)
	}
	defer conn.Close()

	_, err = conn.Exec(`
		TRUNCATE TABLE
			auth_challenges,
			chat_read_state,
			push_subscriptions,
			hidden_direct_chats,
			invites,
			messages,
			images,
			chat_members,
			chats,
			users
		CASCADE
	`)
	if err != nil {
		log.Fatalf("truncate: %v", err)
	}

	fmt.Println("База данных очищена")
}
