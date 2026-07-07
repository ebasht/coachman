package db

import (
	"database/sql"
)

type DB struct {
	*sql.DB
	Driver string
}

type Tx struct {
	*sql.Tx
	driver string
}

func (d *DB) Exec(query string, args ...any) (sql.Result, error) {
	return d.DB.Exec(Rebind(d.Driver, query), args...)
}

func (d *DB) Query(query string, args ...any) (*sql.Rows, error) {
	return d.DB.Query(Rebind(d.Driver, query), args...)
}

func (d *DB) QueryRow(query string, args ...any) *sql.Row {
	return d.DB.QueryRow(Rebind(d.Driver, query), args...)
}

func (d *DB) Begin() (*Tx, error) {
	tx, err := d.DB.Begin()
	if err != nil {
		return nil, err
	}
	return &Tx{Tx: tx, driver: d.Driver}, nil
}

func (t *Tx) Exec(query string, args ...any) (sql.Result, error) {
	return t.Tx.Exec(Rebind(t.driver, query), args...)
}

func (t *Tx) Query(query string, args ...any) (*sql.Rows, error) {
	return t.Tx.Query(Rebind(t.driver, query), args...)
}

func (t *Tx) QueryRow(query string, args ...any) *sql.Row {
	return t.Tx.QueryRow(Rebind(t.driver, query), args...)
}
