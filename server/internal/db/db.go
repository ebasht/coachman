package db

import (
	"database/sql"
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"

	"coachman/server/internal/config"
)

//go:embed migrations/sqlite/*.sql
var sqliteMigrations embed.FS

//go:embed migrations/postgres/*.sql
var postgresMigrations embed.FS

func Open(cfg config.Config) (*DB, error) {
	if cfg.DatabaseURL != "" {
		return openPostgres(cfg.DatabaseURL)
	}
	return openSQLite(cfg.DBPath)
}

func openSQLite(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create db dir: %w", err)
	}
	dsn := fmt.Sprintf("file:%s?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)", path)
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// SQLite allows one writer; unlimited pool causes lock hangs under concurrent HTTP/WS.
	conn.SetMaxOpenConns(1)
	conn.SetMaxIdleConns(1)
	if err := conn.Ping(); err != nil {
		return nil, err
	}
	db := &DB{DB: conn, Driver: DriverSQLite}
	if err := migrate(db, sqliteMigrations, "migrations/sqlite"); err != nil {
		conn.Close()
		return nil, err
	}
	return db, nil
}

func openPostgres(url string) (*DB, error) {
	conn, err := sql.Open("pgx", url)
	if err != nil {
		return nil, err
	}
	if err := conn.Ping(); err != nil {
		return nil, fmt.Errorf("postgres ping: %w", err)
	}
	db := &DB{DB: conn, Driver: DriverPostgres}
	if err := migrate(db, postgresMigrations, "migrations/postgres"); err != nil {
		conn.Close()
		return nil, err
	}
	return db, nil
}

func migrate(conn *DB, fs embed.FS, dir string) error {
	files := []string{
		dir + "/001_init.sql",
		dir + "/002_auth.sql",
		dir + "/003_storage.sql",
		dir + "/004_group_epoch.sql",
		dir + "/005_invites.sql",
		dir + "/006_group_creator.sql",
		dir + "/007_push.sql",
		dir + "/008_push_badge.sql",
	}
	for _, file := range files {
		data, err := fs.ReadFile(file)
		if err != nil {
			return err
		}
		if _, err := conn.Exec(string(data)); err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
				continue
			}
			return fmt.Errorf("%s: %w", file, err)
		}
	}
	return nil
}
