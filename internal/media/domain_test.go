package media

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func validImage() UploadRequest {
	return UploadRequest{
		FileName:     "photo.png",
		DeclaredMIME: "image/png",
		Size:         1024,
		Purpose:      PurposeContent,
	}
}

func TestValidateRequestAcceptsImages(t *testing.T) {
	got, err := ValidateRequest(validImage())
	require.NoError(t, err)
	require.Equal(t, "image/png", got.DeclaredMIME)
}

func TestValidateRequestRejectsMismatchedPurpose(t *testing.T) {
	req := validImage()
	req.Purpose = PurposeAttachment
	_, err := ValidateRequest(req)
	require.Error(t, err, "an image is not an attachment type")

	req = validImage()
	req.DeclaredMIME = "application/pdf"
	_, err = ValidateRequest(req)
	require.Error(t, err, "a pdf is not an image type")
}

func TestValidateRequestRejectsExecutables(t *testing.T) {
	for _, mime := range []string{
		"application/x-msdownload",
		"application/x-sh",
		"text/html",
		"image/svg+xml",
	} {
		req := validImage()
		req.DeclaredMIME = mime
		req.Purpose = PurposeAttachment
		_, err := ValidateRequest(req)
		require.Error(t, err, mime)
	}
}

func TestValidateRequestEnforcesSizeLimits(t *testing.T) {
	req := validImage()
	req.Size = MaxImageBytes + 1
	_, err := ValidateRequest(req)
	require.Error(t, err)

	req = validImage()
	req.Purpose = PurposeAttachment
	req.DeclaredMIME = "application/pdf"
	req.Size = MaxImageBytes + 1
	_, err = ValidateRequest(req)
	require.NoError(t, err, "attachments have a larger ceiling")

	req.Size = MaxUploadHardBytes + 1
	_, err = ValidateRequest(req)
	require.Error(t, err)

	req.Size = 0
	_, err = ValidateRequest(req)
	require.Error(t, err)
}

func TestValidateRequestAcceptsVideosForArticleMedia(t *testing.T) {
	for _, mime := range []string{"video/mp4", "video/webm"} {
		req := UploadRequest{
			FileName:     "clip.mp4",
			DeclaredMIME: mime,
			Size:         MaxImageBytes + 1,
			Purpose:      PurposeContent,
		}
		_, err := ValidateRequest(req)
		require.NoError(t, err, "article media accepts %s", mime)

		req.Purpose = PurposeSite
		_, err = ValidateRequest(req)
		require.Error(t, err, "site images must stay images")
	}

	req := UploadRequest{
		FileName:     "clip.mov",
		DeclaredMIME: "video/quicktime",
		Size:         1024,
		Purpose:      PurposeContent,
	}
	_, err := ValidateRequest(req)
	require.Error(t, err, "only browser-playable containers are accepted")
}

func TestValidateRequestRejectsNullByteInName(t *testing.T) {
	req := validImage()
	req.FileName = "photo\x00.png"
	_, err := ValidateRequest(req)
	require.Error(t, err)
}

func TestValidateRequestRequiresKnownPurpose(t *testing.T) {
	req := validImage()
	req.Purpose = "executable"
	_, err := ValidateRequest(req)
	require.Error(t, err)
}

// TestStorageKeyIgnoresUserPath is the traversal guard: the declared name never
// influences the key, so "../../etc/passwd" cannot escape the storage root.
func TestStorageKeyIgnoresUserPath(t *testing.T) {
	for _, name := range []string{"photo.png", "../../etc/passwd", "..\\windows\\system32\\cmd.exe"} {
		key := NewStorageKey(name)
		require.NotContains(t, key, "..")
		require.NotContains(t, key, "\\")
		require.NotContains(t, key, "etc")
		require.Len(t, key, len(key))
		require.Contains(t, key, "/", "keys are namespaced in a prefix directory")
	}
}

func TestStorageKeyIsUnique(t *testing.T) {
	seen := map[string]struct{}{}
	for i := 0; i < 200; i++ {
		key := NewStorageKey("photo.png")
		_, dup := seen[key]
		require.False(t, dup, "storage keys must not collide")
		seen[key] = struct{}{}
	}
}

func TestStorageKeyKeepsSafeExtension(t *testing.T) {
	require.Contains(t, NewStorageKey("a.PNG"), ".png")
	require.NotContains(t, NewStorageKey("a.verylongextension"), "verylongextension")
}

func TestAssetIsReferenceableOnlyWhenClean(t *testing.T) {
	require.True(t, Asset{ScanStatus: ScanClean}.Referenceable())
	require.False(t, Asset{ScanStatus: ScanPending}.Referenceable())
	require.False(t, Asset{ScanStatus: ScanRejected}.Referenceable())
	require.False(t, Asset{ScanStatus: ScanNeedsManualReview}.Referenceable())
	require.False(t, Asset{}.Referenceable(), "an unknown state must never be treated as clean")
}

func TestUploadExpiry(t *testing.T) {
	now := time.Now().UTC()
	upload := Upload{ExpiresAt: now.Add(time.Minute)}

	require.False(t, upload.Expired(now))
	require.True(t, upload.Expired(now.Add(2*time.Minute)))
}

// TestPurposeSiteIsAnImagePurpose pins the site purpose contract: site pictures are
// validated exactly like article and avatar images, never like attachments.
func TestPurposeSiteIsAnImagePurpose(t *testing.T) {
	require.True(t, PurposeSite.Valid())
	require.True(t, PurposeSite.IsImage())

	req := validImage()
	req.Purpose = PurposeSite
	_, err := ValidateRequest(req)
	require.NoError(t, err)

	// A site picture cannot smuggle in an attachment type.
	req.DeclaredMIME = "application/pdf"
	_, err = ValidateRequest(req)
	require.Error(t, err, "site pictures must be images")

	// The image ceiling applies even though attachments may be larger.
	req = validImage()
	req.Purpose = PurposeSite
	req.Size = MaxImageBytes + 1
	_, err = ValidateRequest(req)
	require.Error(t, err, "site pictures use the image size ceiling")

	req.Size = MaxImageBytes
	_, err = ValidateRequest(req)
	require.NoError(t, err)
}
