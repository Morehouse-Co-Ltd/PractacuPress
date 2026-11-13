//go:build windows

package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// sealedSecretPrefix marks a value encrypted by sealSecret. It keeps older state
// files readable: a value without the prefix is treated as legacy plain base64.
const sealedSecretPrefix = "dpapi:"

// isSealedSecret reports whether a stored value is DPAPI ciphertext.
func isSealedSecret(value string) bool {
	return strings.HasPrefix(value, sealedSecretPrefix)
}

// sealSecret encrypts raw with Windows DPAPI (CryptProtectData) for the current
// user and returns a "dpapi:" prefixed base64 string.
//
// DPAPI binds the ciphertext to the logged-on Windows account, so another user on
// the same machine can no longer read the signing key out of practacu-web.json and
// mint themselves platform administrator tokens. The key is only ever unsealed by
// the same user that wrote it.
func sealSecret(raw []byte) (string, error) {
	if len(raw) == 0 {
		return "", errors.New("state: refusing to seal an empty secret")
	}
	in := windows.DataBlob{Size: uint32(len(raw)), Data: &raw[0]}
	var out windows.DataBlob
	if err := windows.CryptProtectData(
		&in,
		nil,
		nil,
		0,
		nil,
		windows.CRYPTPROTECT_UI_FORBIDDEN,
		&out,
	); err != nil {
		return "", fmt.Errorf("state: CryptProtectData: %w", err)
	}
	defer func() { _, _ = windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data))) }()

	cipher := unsafe.Slice(out.Data, int(out.Size))
	return sealedSecretPrefix + base64.StdEncoding.EncodeToString(cipher), nil
}

// openSecret reverses sealSecret. A value without the dpapi: prefix is legacy plain
// base64 metadata written by an older launcher and is accepted as is.
func openSecret(stored string) ([]byte, error) {
	if stored == "" {
		return nil, errors.New("state: empty secret")
	}
	if !isSealedSecret(stored) {
		raw, err := base64.StdEncoding.DecodeString(stored)
		if err != nil {
			return nil, fmt.Errorf("state: legacy secret is not base64: %w", err)
		}
		return raw, nil
	}

	cipher, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(stored, sealedSecretPrefix))
	if err != nil {
		return nil, fmt.Errorf("state: sealed secret is not base64: %w", err)
	}
	if len(cipher) == 0 {
		return nil, errors.New("state: sealed secret is empty")
	}

	in := windows.DataBlob{Size: uint32(len(cipher)), Data: &cipher[0]}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(
		&in,
		nil,
		nil,
		0,
		nil,
		windows.CRYPTPROTECT_UI_FORBIDDEN,
		&out,
	); err != nil {
		return nil, fmt.Errorf("state: CryptUnprotectData: %w", err)
	}
	defer func() { _, _ = windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data))) }()

	// Copy before the deferred LocalFree releases the DPAPI buffer: returning a
	// slice into it would hand the caller freed memory.
	plain := make([]byte, int(out.Size))
	copy(plain, unsafe.Slice(out.Data, int(out.Size)))
	return plain, nil
}
