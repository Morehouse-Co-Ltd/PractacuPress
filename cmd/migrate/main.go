// Command migrate is a development wrapper around operator.Migrate.
//
// Release builds compile only cmd/server; the wrapper exists so
// `go run ./cmd/migrate` keeps working in a checkout.
package main

import (
	"fmt"
	"os"

	"github.com/practacu/practacu-press/internal/operator"
)

func main() {
	if err := operator.Migrate(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "migrate failed: %v\n", err)
		os.Exit(1)
	}
}
