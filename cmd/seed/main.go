// Command seed is a development wrapper around operator.Seed.
//
// Release builds compile only cmd/server; the wrapper exists so
// `go run ./cmd/seed` keeps working in a checkout.
package main

import (
	"fmt"
	"os"

	"github.com/practacu/practacu-press/internal/operator"
)

func main() {
	if err := operator.Seed(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "seed failed: %v\n", err)
		os.Exit(1)
	}
}
