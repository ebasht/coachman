package db

import (
	"fmt"
	"strings"
)

const (
	DriverSQLite  = "sqlite"
	DriverPostgres = "postgres"
)

func Rebind(driver, query string) string {
	if driver != DriverPostgres {
		return query
	}
	n := 1
	var b strings.Builder
	for _, c := range query {
		if c == '?' {
			b.WriteString(fmt.Sprintf("$%d", n))
			n++
		} else {
			b.WriteRune(c)
		}
	}
	return b.String()
}
