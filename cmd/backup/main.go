// Command backup is a development wrapper around operator.Backup.
//
// Release builds compile only cmd/server; the wrapper exists so
// `go run ./cmd/backup` keeps working in a checkout.
package main

import (
	"fmt"
	"os"

	"github.com/practacu/practacu-press/internal/operator"
)

func main() {
	if err := operator.Backup(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "backup failed: %v\n", err)
		os.Exit(1)
	}
}
