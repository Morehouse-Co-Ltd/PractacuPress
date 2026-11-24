// Command media-gc is a development wrapper around operator.MediaGC.
//
// Release builds compile only cmd/server; the wrapper exists so
// `go run ./cmd/media-gc` keeps working in a checkout.
package main

import (
	"fmt"
	"os"

	"github.com/practacu/practacu-press/internal/operator"
)

func main() {
	if err := operator.MediaGC(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "media-gc failed: %v\n", err)
		os.Exit(1)
	}
}
