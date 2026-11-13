package media

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// testPNG renders a real image. Derivative tests need bytes the standard decoders
// accept; a magic-number prefix alone would only prove that decoding failed.
func testPNG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x % 256), G: uint8(y % 256), B: 96, A: 255})
		}
	}
	var buffer bytes.Buffer
	require.NoError(t, png.Encode(&buffer, img))
	return buffer.Bytes()
}

func testJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x % 256), G: 64, B: uint8(y % 256), A: 255})
		}
	}
	var buffer bytes.Buffer
	require.NoError(t, jpeg.Encode(&buffer, img, &jpeg.Options{Quality: 90}))
	return buffer.Bytes()
}

// derivativeFixture seeds one clean asset and the storage object it points at.
type derivativeFixture struct {
	service *Service
	storage *LocalStorage
	repo    *fakeRepo
	asset   Asset
}

func newDerivativeFixture(
	t *testing.T,
	mime string,
	data []byte,
	status ScanStatus,
) derivativeFixture {
	t.Helper()

	storage, err := NewLocalStorage(t.TempDir())
	require.NoError(t, err)
	repo := newFakeRepo()
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Scanner:    &fakeScanner{result: ScanResult{Status: ScanClean}},
		Storage:    storage,
		Now:        func() time.Time { return time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)

	key := NewStorageKey("photo.png")
	require.NoError(t, storage.Put(context.Background(), key, bytes.NewReader(data), int64(len(data))))

	asset, err := repo.InsertAsset(context.Background(), Asset{
		SiteID:     "s1",
		OwnerID:    "u1",
		StorageKey: key,
		MIME:       mime,
		Size:       int64(len(data)),
		ScanStatus: status,
		Purpose:    PurposeContent,
		CreatedAt:  time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC),
	})
	require.NoError(t, err)

	return derivativeFixture{service: service, storage: storage, repo: repo, asset: asset}
}

func (f derivativeFixture) openVariant(t *testing.T, width int) (Asset, []byte) {
	t.Helper()
	asset, reader, err := f.service.OpenVariant(context.Background(), owner(), f.asset.ID, width)
	require.NoError(t, err)
	defer reader.Close()
	data, err := io.ReadAll(reader)
	require.NoError(t, err)
	return asset, data
}

func TestOpenVariantProducesRequestedWidth(t *testing.T) {
	f := newDerivativeFixture(t, "image/png", testPNG(t, 1600, 900), ScanClean)

	asset, data := f.openVariant(t, 768)

	require.Equal(t, "image/png", asset.MIME)
	require.EqualValues(t, len(data), asset.Size)
	decoded, err := png.Decode(bytes.NewReader(data))
	require.NoError(t, err)
	require.Equal(t, 768, decoded.Bounds().Dx())
	require.Equal(t, 432, decoded.Bounds().Dy(), "the aspect ratio is preserved")

	cached, err := f.storage.Open(context.Background(), DerivativeKey(f.asset.StorageKey, 768, "png"))
	require.NoError(t, err, "the derivative is cached in the storage backend")
	require.NoError(t, cached.Close())
}

func TestOpenVariantKeepsJPEGForJPEG(t *testing.T) {
	f := newDerivativeFixture(t, "image/jpeg", testJPEG(t, 1200, 800), ScanClean)

	asset, data := f.openVariant(t, 320)

	require.Equal(t, "image/jpeg", asset.MIME)
	require.True(t, bytes.HasPrefix(data, []byte{0xFF, 0xD8, 0xFF}), "a JPEG derivative starts with the JPEG marker")
	decoded, err := jpeg.Decode(bytes.NewReader(data))
	require.NoError(t, err)
	require.Equal(t, 320, decoded.Bounds().Dx())
	require.Equal(t, 213, decoded.Bounds().Dy())

	cached, err := f.storage.Open(context.Background(), DerivativeKey(f.asset.StorageKey, 320, "jpg"))
	require.NoError(t, err, "a JPEG source caches a JPEG derivative")
	require.NoError(t, cached.Close())
}

func TestOpenVariantServesCachedBytesWithoutOriginal(t *testing.T) {
	f := newDerivativeFixture(t, "image/png", testPNG(t, 900, 600), ScanClean)

	_, first := f.openVariant(t, 320)
	require.NoError(t, f.storage.Delete(context.Background(), f.asset.StorageKey))

	asset, second := f.openVariant(t, 320)
	require.Equal(t, first, second, "the cached derivative is enough to serve the request")
	require.Equal(t, "image/png", asset.MIME)
}

func TestOpenVariantRefusesNonImage(t *testing.T) {
	f := newDerivativeFixture(t, "application/pdf", []byte("%PDF-1.7"), ScanClean)

	_, _, err := f.service.OpenVariant(context.Background(), owner(), f.asset.ID, 320)
	require.ErrorIs(t, err, ErrDerivativeUnavailable)
}

func TestOpenVariantRefusesUncleanAsset(t *testing.T) {
	f := newDerivativeFixture(t, "image/png", testPNG(t, 800, 600), ScanRejected)

	_, _, err := f.service.OpenVariant(context.Background(), owner(), f.asset.ID, 320)
	require.ErrorIs(t, err, ErrNotFound, "a rejected object must not be reachable through a variant")
}

func TestOpenVariantRefusesUnknownWidth(t *testing.T) {
	f := newDerivativeFixture(t, "image/png", testPNG(t, 800, 600), ScanClean)

	_, _, err := f.service.OpenVariant(context.Background(), owner(), f.asset.ID, 500)
	require.ErrorIs(t, err, ErrDerivativeUnavailable)
}

func TestOpenVariantNeverUpscales(t *testing.T) {
	f := newDerivativeFixture(t, "image/png", testPNG(t, 200, 150), ScanClean)

	_, _, err := f.service.OpenVariant(context.Background(), owner(), f.asset.ID, 320)
	require.ErrorIs(t, err, ErrDerivativeUnavailable, "the original is already smaller")
}

func TestOpenVariantHandlesCorruptImage(t *testing.T) {
	f := newDerivativeFixture(t, "image/png", []byte("this is not an image"), ScanClean)

	_, _, err := f.service.OpenVariant(context.Background(), owner(), f.asset.ID, 320)
	require.ErrorIs(t, err, ErrDerivativeUnavailable)
}

func TestOpenVariantRejectsMismatchedFormat(t *testing.T) {
	// Stored MIME claims PNG but the bytes decode as JPEG: the scanner should have
	// caught it, and the derivative path refuses to launder the mismatch.
	f := newDerivativeFixture(t, "image/png", testJPEG(t, 800, 600), ScanClean)

	_, _, err := f.service.OpenVariant(context.Background(), owner(), f.asset.ID, 320)
	require.ErrorIs(t, err, ErrDerivativeUnavailable)
}

func TestDeleteAssetRemovesDerivatives(t *testing.T) {
	f := newDerivativeFixture(t, "image/png", testPNG(t, 1600, 900), ScanClean)
	ctx := context.Background()

	f.openVariant(t, 320)
	f.openVariant(t, 768)

	require.NoError(t, f.service.DeleteAsset(ctx, owner(), f.asset.ID))

	for _, key := range []string{
		f.asset.StorageKey,
		DerivativeKey(f.asset.StorageKey, 320, "png"),
		DerivativeKey(f.asset.StorageKey, 768, "png"),
	} {
		_, err := f.storage.Open(ctx, key)
		require.ErrorIs(t, err, ErrStorageObjectMissing, key)
	}
	_, err := f.repo.FindAsset(ctx, "s1", f.asset.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

func TestDerivativeKeyShape(t *testing.T) {
	key := DerivativeKey("ab/uuid.png", 768, "jpg")
	require.Equal(t, "ab/uuid.png.w768.jpg", key)

	base, ok := DerivativeBaseKey(key)
	require.True(t, ok)
	require.Equal(t, "ab/uuid.png", base)

	for _, notAVariant := range []string{
		"ab/uuid.png",
		"ab/uuid.png.w768",
		"ab/uuid.png.wide.jpg",
		"ab/uuid.png.w768.bmp",
	} {
		_, ok := DerivativeBaseKey(notAVariant)
		require.False(t, ok, notAVariant)
	}
}

// --- HTTP surface -----------------------------------------------------------

// newVariantEngine mounts the real handler over a fixture storage.
func newVariantEngine(t *testing.T, fixture derivativeFixture) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	handler := NewHandler(fixture.service, HandlerConfig{
		Principal: func(*gin.Context) (Actor, bool) { return owner(), true },
	})
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			problem := apperr.FromError(c.Errors.Last().Err)
			c.Header("Content-Type", apperr.ContentType)
			c.JSON(problem.Status, problem)
		}
	})
	handler.Routes(r, func(c *gin.Context) { c.Next() }, func(c *gin.Context) { c.Next() })
	return r
}

func TestDownloadVariantSetsHeadersAndETag(t *testing.T) {
	f := newDerivativeFixture(t, "image/png", testPNG(t, 1600, 900), ScanClean)
	r := newVariantEngine(t, f)

	request := httptest.NewRequest(http.MethodGet, "/media/"+f.asset.ID+"?w=768", nil)
	response := httptest.NewRecorder()
	r.ServeHTTP(response, request)

	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, "image/png", response.Header().Get("Content-Type"))
	require.Equal(t, `"`+f.asset.ID+"-w768\"", response.Header().Get("ETag"))
	require.Equal(t, "private, max-age=300", response.Header().Get("Cache-Control"))
	require.Equal(t, "nosniff", response.Header().Get("X-Content-Type-Options"))

	decoded, err := png.Decode(bytes.NewReader(response.Body.Bytes()))
	require.NoError(t, err)
	require.Equal(t, 768, decoded.Bounds().Dx())

	// The same representation revalidates without shipping the bytes again.
	conditional := httptest.NewRequest(http.MethodGet, "/media/"+f.asset.ID+"?w=768", nil)
	conditional.Header.Set("If-None-Match", response.Header().Get("ETag"))
	notModified := httptest.NewRecorder()
	r.ServeHTTP(notModified, conditional)
	require.Equal(t, http.StatusNotModified, notModified.Code)
	require.Empty(t, notModified.Body.Bytes())
}

func TestDownloadVariantAcceptsAliases(t *testing.T) {
	f := newDerivativeFixture(t, "image/png", testPNG(t, 1600, 900), ScanClean)
	r := newVariantEngine(t, f)

	for _, query := range []string{"variant=thumb", "variant=w320", "w=320"} {
		response := httptest.NewRecorder()
		r.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/media/"+f.asset.ID+"?"+query, nil))
		require.Equal(t, http.StatusOK, response.Code, query)

		decoded, err := png.Decode(bytes.NewReader(response.Body.Bytes()))
		require.NoError(t, err, query)
		require.Equal(t, 320, decoded.Bounds().Dx(), query)
	}
}

func TestDownloadVariantRejectsUnknownSelector(t *testing.T) {
	f := newDerivativeFixture(t, "image/png", testPNG(t, 1600, 900), ScanClean)
	r := newVariantEngine(t, f)

	for _, query := range []string{"w=999", "w=abc", "variant=bogus"} {
		response := httptest.NewRecorder()
		r.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/media/"+f.asset.ID+"?"+query, nil))
		require.Equal(t, http.StatusBadRequest, response.Code, query)
	}
}

func TestDownloadVariantFallsBackToOriginal(t *testing.T) {
	// A corrupt "image" is still a clean asset: a derivative is best effort, so the
	// bytes must be served as-is instead of turning into an error.
	original := []byte("this is not an image")
	f := newDerivativeFixture(t, "image/png", original, ScanClean)
	r := newVariantEngine(t, f)

	response := httptest.NewRecorder()
	r.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/media/"+f.asset.ID+"?w=320", nil))

	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, original, response.Body.Bytes())
	require.Equal(t, `"`+f.asset.ID+`"`, response.Header().Get("ETag"),
		"the ETag must describe the original that was actually sent")
}

func TestDownloadVariantRefusesRejectedAsset(t *testing.T) {
	f := newDerivativeFixture(t, "image/png", testPNG(t, 800, 600), ScanRejected)
	r := newVariantEngine(t, f)

	response := httptest.NewRecorder()
	r.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/media/"+f.asset.ID+"?w=320", nil))

	require.Equal(t, http.StatusNotFound, response.Code)
}

func TestDownloadOriginalKeepsNoVariantETag(t *testing.T) {
	f := newDerivativeFixture(t, "image/png", testPNG(t, 800, 600), ScanClean)
	r := newVariantEngine(t, f)

	response := httptest.NewRecorder()
	r.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/media/"+f.asset.ID+"?variant=original", nil))

	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, `"`+f.asset.ID+`"`, response.Header().Get("ETag"))
	require.Equal(t, f.asset.Size, int64(response.Body.Len()))
}
