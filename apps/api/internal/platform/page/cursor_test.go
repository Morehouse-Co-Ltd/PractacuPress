package page

import (
	"encoding/base64"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestEncodeDecodeRoundTrip(t *testing.T) {
	original := Cursor{Key: "2026-10-18T12:00:00Z", ID: "01a14d55-c882"}

	encoded := original.Encode()
	require.NotEmpty(t, encoded)
	require.NotContains(t, encoded, "=", "cursors are url safe without padding")

	decoded, err := Decode(encoded)
	require.NoError(t, err)
	require.Equal(t, original, decoded)
}

func TestEmptyCursorMeansFirstPage(t *testing.T) {
	encoded := Cursor{}.Encode()
	require.Empty(t, encoded)

	decoded, err := Decode("")
	require.NoError(t, err)
	require.True(t, decoded.IsZero())

	decoded, err = Decode("   ")
	require.NoError(t, err)
	require.True(t, decoded.IsZero())
}

func TestDecodeRejectsMalformedCursors(t *testing.T) {
	cases := []string{
		"not base64!!",
		base64.RawURLEncoding.EncodeToString([]byte("not json")),
		base64.RawURLEncoding.EncodeToString([]byte(`{"k":"x"}`)),   // no id
		base64.RawURLEncoding.EncodeToString([]byte(`{"id":""}`)),   // empty id
		base64.RawURLEncoding.EncodeToString([]byte(`{"id":"a","k":5}`)),
	}
	for _, raw := range cases {
		_, err := Decode(raw)
		require.ErrorIs(t, err, ErrInvalidCursor, raw)
	}
}

func TestDecodeBoundsInputLength(t *testing.T) {
	long := make([]byte, maxCursorLength+1)
	for i := range long {
		long[i] = 'a'
	}

	_, err := Decode(string(long))
	require.ErrorIs(t, err, ErrInvalidCursor)
}

func TestCursorIsNotReversibleIntoAnotherPosition(t *testing.T) {
	first := Cursor{Key: "k1", ID: "id1"}
	second := Cursor{Key: "k2", ID: "id2"}

	require.NotEqual(t, first.Encode(), second.Encode())

	// A truncated cursor must not decode to a usable position.
	encoded := first.Encode()
	_, err := Decode(encoded[:len(encoded)-2])
	require.ErrorIs(t, err, ErrInvalidCursor)
}
