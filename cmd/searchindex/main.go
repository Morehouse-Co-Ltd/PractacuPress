// Command searchindex is a development wrapper around operator.SearchIndex.
//
// Release builds compile only cmd/server; the wrapper exists so
// `go run ./cmd/searchindex` keeps working in a checkout.
package main

import (
	"fmt"
	"os"

	"github.com/practacu/practacu-press/internal/operator"
)

func main() {
	if err := operator.SearchIndex(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "searchindex failed: %v\n", err)
		os.Exit(1)
	}
}
