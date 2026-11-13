//go:build !windows

package main

import (
	"encoding/base64"
	"errors"
	"fmt"
)

// sealedSecretPrefix exists on every platform so state.go stays platform agnostic;
// non-Windows builds never write a value with it.
const sealedSecretPrefix = "dpapi:"

// isSealedSecret always reports false: without DPAPI nothing is ever sealed.
func isSealedSecret(value string) bool {
	return false
}

// sealSecret is the non-Windows fallback. The Windows launcher is the shipped
// build; this keeps the package testable elsewhere and preserves the old plain
// base64 storage instead of pretending to protect the key.
func sealSecret(raw []byte) (string, error) {
	if len(raw) == 0 {
		return "", errors.New("state: refusing to seal an empty secret")
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

// openSecret decodes the base64 value stored on non-Windows builds.
func openSecret(stored string) ([]byte, error) {
	if stored == "" {
		return nil, errors.New("state: empty secret")
	}
	raw, err := base64.StdEncoding.DecodeString(stored)
	if err != nil {
		return nil, fmt.Errorf("state: secret is not base64: %w", err)
	}
	return raw, nil
}
