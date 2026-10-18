// Package page implements opaque pagination cursors.
//
// Cursors are opaque on purpose: clients must treat them as tokens, so the shape can
// change (a new sort key, a different tie breaker) without breaking the contract.
// Encoding the sort key and the item id together is what makes a page boundary stable
// when several rows share the same timestamp.
package page

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
)

// ErrInvalidCursor is returned for a cursor that cannot be trusted.
var ErrInvalidCursor = errors.New("page: invalid cursor")

// maxCursorLength bounds the encoded input so a client cannot use the decoder as a
// memory amplifier.
const maxCursorLength = 512

// Cursor is the position after which the next page starts.
type Cursor struct {
	// Key is the sort value of the last row, for example an RFC 3339 timestamp.
	Key string `json:"k,omitempty"`
	// ID is the item id, the tie breaker when Key repeats.
	ID string `json:"id"`
}

// IsZero reports whether the cursor carries no position.
func (c Cursor) IsZero() bool { return c.Key == "" && c.ID == "" }

// Encode renders the cursor as an opaque URL safe string.
func (c Cursor) Encode() string {
	if c.IsZero() {
		return ""
	}
	payload, err := json.Marshal(c)
	if err != nil {
		// The struct has no field that can fail to marshal.
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(payload)
}

// Decode parses an opaque cursor.
//
// An empty string is not an error: it means "start from the beginning". Anything
// malformed returns ErrInvalidCursor so the handler can answer 400 instead of
// silently returning the first page, which would make an infinite scroll loop.
func Decode(raw string) (Cursor, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Cursor{}, nil
	}
	if len(raw) > maxCursorLength {
		return Cursor{}, ErrInvalidCursor
	}

	payload, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return Cursor{}, ErrInvalidCursor
	}

	var cursor Cursor
	if err := json.Unmarshal(payload, &cursor); err != nil {
		return Cursor{}, ErrInvalidCursor
	}
	if cursor.ID == "" {
		return Cursor{}, ErrInvalidCursor
	}
	return cursor, nil
}
