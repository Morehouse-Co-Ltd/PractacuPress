package media

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// TestCacheControlForPurpose pins the cache policy split: site images and avatars are
// part of the public design and may live in a shared cache, while content and attachment
// assets must stay private because a published article can be withdrawn.
//
// The on-the-wire assertion (that the download handler actually sends this header) lives
// in handler_test.go next to the other download tests — it needs the shared fake service
// helpers, which are deliberately not duplicated here.
func TestCacheControlForPurpose(t *testing.T) {
	for _, tc := range []struct {
		purpose Purpose
		want    string
	}{
		{PurposeSite, "public, max-age=31536000, immutable"},
		{PurposeAvatar, "public, max-age=31536000, immutable"},
		{PurposeContent, "private, max-age=300"},
		{PurposeAttachment, "private, max-age=300"},
		{Purpose(""), "private, max-age=300"},
		{Purpose("something-new"), "private, max-age=300"},
	} {
		require.Equal(t, tc.want, cacheControlFor(tc.purpose), string(tc.purpose))
	}
}
