package securityclient

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUnavailableFailsClosed(t *testing.T) {
	client := Unavailable{}
	ctx := context.Background()

	_, err := client.HashPassword(ctx, "hunter2")
	require.ErrorIs(t, err, ErrUnavailable)

	verified, err := client.VerifyPassword(ctx, "hunter2", "$argon2id$v=19$m=65536")
	require.ErrorIs(t, err, ErrUnavailable)
	require.False(t, verified, "an unavailable verifier must never report success")

	_, err = client.SanitizeContent(ctx, ContentInput{Format: FormatMarkdown, Source: "# hi"})
	require.ErrorIs(t, err, ErrUnavailable)

	_, err = client.InspectUpload(ctx, UploadInput{FileName: "a.png", DeclaredMIME: "image/png"})
	require.ErrorIs(t, err, ErrUnavailable)

	require.ErrorIs(t, client.Ping(ctx), ErrUnavailable)
}

func TestUnavailableNeverReportsCleanScan(t *testing.T) {
	result, err := Unavailable{}.InspectUpload(context.Background(), UploadInput{})
	require.Error(t, err)
	require.Empty(t, string(result.Status))
	require.NotEqual(t, ScanClean, result.Status)
}

func TestUnavailableNeverReturnsSanitizedHTML(t *testing.T) {
	out, err := Unavailable{}.SanitizeContent(context.Background(), ContentInput{Source: "<script>x</script>"})
	require.Error(t, err)
	require.Empty(t, out.HTML, "an unavailable sanitizer must not hand back renderable HTML")
	require.Empty(t, out.PolicyVersion)
}
