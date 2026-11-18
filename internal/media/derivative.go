package media

// derivative.go owns the resized representations of a clean image asset.
//
// A derivative is addressed by its width, never by a client supplied path: the object
// key is derived from the immutable storage key of the original, so a variant can only
// ever point at the asset it belongs to. The width set is closed, which keeps the cache
// bounded and lets a delete remove every variant without a database table.
//
// Derivatives are an optimisation, never a gate. A caller that cannot get one must fall
// back to the original bytes; only an asset that is not clean is refused, and that is
// enforced before a derivative is even considered.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"math"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/image/draw"

	// PNG, JPEG and GIF come from the standard library; WebP is decode only, which is
	// why a WebP original produces a PNG derivative instead of a WebP one.
	_ "golang.org/x/image/webp"

	"github.com/practacu/practacu-press/internal/site"
)

// Derivative widths. 320 is the thumbnail used by listings, 768 covers a tablet or a
// single column article body, and 1280 covers a wide desktop column.
const (
	// VariantThumbWidth is the width served by ?variant=thumb.
	VariantThumbWidth = 320
	// DefaultVariantWidth is the width used by ?variant=medium.
	DefaultVariantWidth = 768
)

// VariantWidths is the closed set of widths a caller may ask for, narrowest first.
var VariantWidths = []int{320, 768, 1280}

// Decoding bounds. An image is decoded in process memory, so a crafted file must not be
// able to turn a 10 MiB upload into an unbounded allocation. The dimension ceiling also
// rejects absurd panoramas that would make a 320px thumbnail cost gigabytes.
const (
	// MaxDerivativePixels bounds the decoded pixel count of a source image.
	MaxDerivativePixels int64 = 40_000_000
	// MaxDerivativeDimension bounds either decoded side.
	MaxDerivativeDimension = 12_000
	// MaxDerivativeSourceBytes bounds how much of the original is read into memory.
	MaxDerivativeSourceBytes = MaxImageBytes + (1 << 20)

	// derivativeConcurrency bounds simultaneous decodes. Two images and their scaled
	// copies fit comfortably in the desktop process; more would multiply the peak by
	// the bitmap size without making the average request faster.
	derivativeConcurrency = 2
)

// ErrDerivativeUnavailable reports that no resized representation could be produced for
// this asset. It is a soft failure: the caller should serve the original instead. An
// asset that is not clean never reaches this path at all, because it is refused earlier.
var ErrDerivativeUnavailable = errors.New("media: no derivative available")

// derivativeFormat maps a source MIME type to the format a derivative is encoded in.
//
// JPEG stays JPEG because re-encoding a photo as PNG multiplies its size. Everything
// else becomes PNG: it preserves transparency and is the only WebP-free lossless encoder
// in the standard library. The bool is false for a non-image asset.
func derivativeFormat(mime string) (format, contentType string, ok bool) {
	switch strings.ToLower(strings.TrimSpace(mime)) {
	case "image/jpeg":
		return "jpg", "image/jpeg", true
	case "image/png", "image/gif", "image/webp":
		return "png", "image/png", true
	default:
		return "", "", false
	}
}

// ValidVariantWidth reports whether width is one of the widths this build produces.
func ValidVariantWidth(width int) bool {
	for _, candidate := range VariantWidths {
		if candidate == width {
			return true
		}
	}
	return false
}

// DerivativeKey returns the object key of one variant.
//
// The suffix is appended to the original key, so an implementation only has to list one
// prefix to find every object of an asset, and a delete can enumerate the variants
// without a row per variant.
func DerivativeKey(storageKey string, width int, format string) string {
	return storageKey + ".w" + strconv.Itoa(width) + "." + format
}

// DerivativeKeys returns every key a variant of storageKey could occupy.
//
// The orphan collector and a defensive delete use it because they cannot always know
// which encoder produced a leftover object (a deployment may have changed the rule, or
// an old build may have used another format). Calling Delete on a key that was never
// written is a no-op on both drivers.
func DerivativeKeys(storageKey string) []string {
	formats := []string{"jpg", "png", "webp"}
	keys := make([]string, 0, len(VariantWidths)*len(formats))
	for _, width := range VariantWidths {
		for _, format := range formats {
			keys = append(keys, DerivativeKey(storageKey, width, format))
		}
	}
	return keys
}

// DerivativeBaseKey strips the variant suffix from a storage key.
//
// Orphan collection uses it to keep a derivative whose original still exists; a number
// in the suffix is what distinguishes a generated variant from an ordinary object.
func DerivativeBaseKey(key string) (string, bool) {
	index := strings.LastIndex(key, ".w")
	if index <= 0 {
		return "", false
	}
	rest := key[index+2:]
	dot := strings.IndexByte(rest, '.')
	if dot <= 0 {
		return "", false
	}
	width := rest[:dot]
	if _, err := strconv.Atoi(width); err != nil {
		return "", false
	}
	format := rest[dot+1:]
	if format != "jpg" && format != "png" && format != "webp" {
		return "", false
	}
	return key[:index], true
}

// OpenVariant returns a resized representation of a clean asset.
//
// Authorization is exactly the one of OpenAsset: a variant must never become a side door
// around the site scope, the scan verdict or the published-reference rule.
func (s *Service) OpenVariant(
	ctx context.Context,
	actor Actor,
	assetID string,
	width int,
) (Asset, io.ReadCloser, error) {
	return s.openVariant(ctx, actor.SiteID, assetID, width, func(asset Asset) error {
		if actor.Role.AtLeast(site.RoleEditor) || asset.OwnerID == actor.UserID {
			return nil
		}
		return s.authorizeSharedAsset(ctx, asset)
	})
}

// OpenVariantInSite is the anonymous-read variant, scoped by the resolved site.
func (s *Service) OpenVariantInSite(
	ctx context.Context,
	siteID string,
	assetID string,
	width int,
) (Asset, io.ReadCloser, error) {
	return s.openVariant(ctx, siteID, assetID, width, func(asset Asset) error {
		return s.authorizeSharedAsset(ctx, asset)
	})
}

// openVariant loads and authorizes an asset, then returns (and possibly creates) one
// resized representation.
func (s *Service) openVariant(
	ctx context.Context,
	siteID string,
	assetID string,
	width int,
	authorize func(Asset) error,
) (Asset, io.ReadCloser, error) {
	if siteID == "" || assetID == "" {
		return Asset{}, nil, ErrNotFound
	}
	if !ValidVariantWidth(width) {
		return Asset{}, nil, ErrDerivativeUnavailable
	}

	asset, err := s.repo.FindAsset(ctx, siteID, assetID)
	if err != nil {
		return Asset{}, nil, err
	}
	if !asset.Referenceable() {
		// A rejected or pending object must never be served, not even through a
		// derivative: the derivative is built from exactly those bytes.
		return Asset{}, nil, ErrNotFound
	}
	if err := authorize(asset); err != nil {
		return Asset{}, nil, err
	}

	storage := s.storageFor(asset.Purpose)
	if storage == nil {
		return Asset{}, nil, ErrStorageMissing
	}

	format, contentType, ok := derivativeFormat(asset.MIME)
	if !ok {
		return Asset{}, nil, ErrDerivativeUnavailable
	}
	key := DerivativeKey(asset.StorageKey, width, format)

	// One generation per key at a time. Without this two concurrent first requests
	// would both decode and write the same object, and on the local driver the second
	// O_TRUNC write could be observed half finished.
	unlock := s.lockDerivative(key)
	defer unlock()

	cached, cacheErr := readStoredObject(ctx, storage, key, MaxDerivativeSourceBytes)
	if cacheErr == nil && len(cached) > 0 {
		return variantAsset(asset, contentType, cached), bytesReader(cached), nil
	}
	if cacheErr != nil && !errors.Is(cacheErr, ErrStorageObjectMissing) {
		// A broken cache is not a broken request: fall back to the original.
		return Asset{}, nil, fmt.Errorf("%w: read cached variant: %v", ErrDerivativeUnavailable, cacheErr)
	}

	rendered, renderErr := s.renderWithinSlot(ctx, storage, asset, width, format)
	if renderErr != nil {
		return Asset{}, nil, renderErr
	}

	if putErr := storage.Put(ctx, key, bytes.NewReader(rendered), int64(len(rendered))); putErr != nil {
		// Serving the freshly rendered bytes is still correct; only the cache write
		// failed, and the next request can try again.
		return variantAsset(asset, contentType, rendered), bytesReader(rendered), nil
	}
	return variantAsset(asset, contentType, rendered), bytesReader(rendered), nil
}

// variantAsset returns a copy of asset that describes the derivative on the wire.
func variantAsset(asset Asset, contentType string, data []byte) Asset {
	asset.MIME = contentType
	asset.Size = int64(len(data))
	return asset
}

// bytesReader returns an owned reader; the slice is never mutated after this point.
func bytesReader(data []byte) io.ReadCloser {
	return io.NopCloser(bytes.NewReader(data))
}

// readStoredObject reads one object with a hard byte ceiling.
func readStoredObject(
	ctx context.Context,
	storage Storage,
	key string,
	limit int64,
) ([]byte, error) {
	reader, err := storage.Open(ctx, key)
	if err != nil {
		return nil, err
	}
	defer reader.Close()

	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("media: object exceeds derivative source limit")
	}
	return data, nil
}

// renderWithinSlot decodes with the global concurrency ceiling applied.
func (s *Service) renderWithinSlot(
	ctx context.Context,
	storage Storage,
	asset Asset,
	width int,
	format string,
) ([]byte, error) {
	if s.derivativeSlots == nil {
		return renderVariant(ctx, storage, asset, width, format)
	}
	select {
	case s.derivativeSlots <- struct{}{}:
		defer func() { <-s.derivativeSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return renderVariant(ctx, storage, asset, width, format)
}

// renderVariant decodes the original, scales it and encodes the derivative.
//
// Every failure is ErrDerivativeUnavailable so the transport can fall back to the
// original; a missing original is reported as ErrNotFound because the fallback would
// fail the same way.
func renderVariant(
	ctx context.Context,
	storage Storage,
	asset Asset,
	width int,
	format string,
) ([]byte, error) {
	source, err := readStoredObject(ctx, storage, asset.StorageKey, MaxDerivativeSourceBytes)
	if err != nil {
		if errors.Is(err, ErrStorageObjectMissing) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("%w: read source: %v", ErrDerivativeUnavailable, err)
	}

	config, decodedFormat, err := image.DecodeConfig(bytes.NewReader(source))
	if err != nil {
		return nil, fmt.Errorf("%w: undecodable image: %v", ErrDerivativeUnavailable, err)
	}
	if config.Width <= 0 || config.Height <= 0 {
		return nil, ErrDerivativeUnavailable
	}
	if config.Width > MaxDerivativeDimension || config.Height > MaxDerivativeDimension {
		return nil, ErrDerivativeUnavailable
	}
	if int64(config.Width)*int64(config.Height) > MaxDerivativePixels {
		return nil, ErrDerivativeUnavailable
	}
	// Never upscale. Asking for a width the original does not have means the original
	// already is the smallest useful representation.
	if config.Width <= width {
		return nil, ErrDerivativeUnavailable
	}
	if !decodedFormatMatches(decodedFormat, asset.MIME) {
		// The declared type and the actual bytes disagree. The scanner should have
		// caught this; refusing to process it is the safe second answer.
		return nil, ErrDerivativeUnavailable
	}

	decoded, _, err := image.Decode(bytes.NewReader(source))
	if err != nil {
		return nil, fmt.Errorf("%w: decode image: %v", ErrDerivativeUnavailable, err)
	}

	height := int(math.Round(float64(config.Height) * float64(width) / float64(config.Width)))
	if height < 1 {
		height = 1
	}

	scaled := image.NewNRGBA(image.Rect(0, 0, width, height))
	draw.CatmullRom.Scale(scaled, scaled.Bounds(), decoded, decoded.Bounds(), draw.Src, nil)

	var buffer bytes.Buffer
	switch format {
	case "jpg":
		// 82 keeps a photo visually indistinguishable at thumbnail size while staying
		// far below the original.
		if err := jpeg.Encode(&buffer, scaled, &jpeg.Options{Quality: 82}); err != nil {
			return nil, fmt.Errorf("%w: encode jpeg: %v", ErrDerivativeUnavailable, err)
		}
	default:
		if err := png.Encode(&buffer, scaled); err != nil {
			return nil, fmt.Errorf("%w: encode png: %v", ErrDerivativeUnavailable, err)
		}
	}
	return buffer.Bytes(), nil
}

// decodedFormatMatches compares an image.Decode format name with the stored MIME type.
//
// It is a deliberate equality, not a family check: a PNG that claims to be a JPEG is
// exactly the mismatch the scanner exists to reject.
func decodedFormatMatches(decodedFormat, mime string) bool {
	mime = strings.ToLower(strings.TrimSpace(mime))
	switch decodedFormat {
	case "jpeg":
		return mime == "image/jpeg"
	case "png":
		return mime == "image/png"
	case "gif":
		return mime == "image/gif"
	case "webp":
		return mime == "image/webp"
	default:
		return false
	}
}

// derivativeLock is one reference counted mutex in the per-key lock map.
type derivativeLock struct {
	mu    sync.Mutex
	users int
}

// lockDerivative acquires the mutex guarding one derivative key and returns the
// release function.
//
// The entry is reference counted and deleted when the last user releases it, so a
// long-lived process does not keep one mutex per asset it ever generated.
func (s *Service) lockDerivative(key string) func() {
	s.derivativeLocksMu.Lock()
	lock := s.derivativeLocks[key]
	if lock == nil {
		lock = &derivativeLock{}
		s.derivativeLocks[key] = lock
	}
	lock.users++
	s.derivativeLocksMu.Unlock()

	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		s.derivativeLocksMu.Lock()
		lock.users--
		if lock.users == 0 {
			delete(s.derivativeLocks, key)
		}
		s.derivativeLocksMu.Unlock()
	}
}

// deleteDerivatives removes the variants an asset could own.
//
// The format comes from the stored MIME, exactly as generation did, so only the three
// width keys of that format are touched. Non-image assets never had a derivative and
// need no delete. It runs before the original, so a rerun after a partial failure still
// has the row and can finish the job; deleting a missing object is a no-op on both
// drivers.
func (s *Service) deleteDerivatives(ctx context.Context, storage Storage, asset Asset) error {
	format, _, ok := derivativeFormat(asset.MIME)
	if !ok {
		return nil
	}
	var errs []error
	for _, width := range VariantWidths {
		if err := storage.Delete(ctx, DerivativeKey(asset.StorageKey, width, format)); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
