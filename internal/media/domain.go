// Package media owns uploads: what may be uploaded, how the two phase flow works,
// and when a file becomes referenceable.
//
// A file is only usable after the in-process upload inspection has cleared it. Until then it is
// pending and must not be linked from content, because a scan bypass is exactly how a
// malware distribution channel gets built (design §7.6).
package media

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/practacu/practacu-press/internal/site"
)

// ScanStatus is the state of a stored object.
type ScanStatus string

// Scan states. Only clean objects may be referenced.
const (
	ScanPending           ScanStatus = "pending"
	ScanClean             ScanStatus = "clean"
	ScanRejected          ScanStatus = "rejected"
	ScanNeedsManualReview ScanStatus = "needs_manual_review"
)

// Valid reports whether the scan status is defined.
func (s ScanStatus) Valid() bool {
	return s == ScanPending || s == ScanClean || s == ScanRejected || s == ScanNeedsManualReview
}

// UploadStatus is the state of an upload session.
type UploadStatus string

// Upload session states.
const (
	UploadPending   UploadStatus = "pending"
	UploadUploaded  UploadStatus = "uploaded"
	UploadCompleted UploadStatus = "completed"
	UploadExpired   UploadStatus = "expired"
)

// Purpose is what the file will be used for.
type Purpose string

// Supported purposes.
const (
	PurposeContent    Purpose = "content"
	PurposeSite       Purpose = "site"
	PurposeAvatar     Purpose = "avatar"
	PurposeAttachment Purpose = "attachment"
)

// Valid reports whether the purpose is defined.
func (p Purpose) Valid() bool {
	return p == PurposeContent || p == PurposeSite || p == PurposeAvatar || p == PurposeAttachment
}

// IsImage reports whether the purpose only accepts image types. It keeps
// validation and the storage scope mapping from drifting apart. Article media is
// not image-only: it also accepts uploaded video.
func (p Purpose) IsImage() bool {
	return p == PurposeSite || p == PurposeAvatar
}

// Sentinel errors.
var (
	// ErrInvalidInput means a declared field failed validation.
	ErrInvalidInput = errors.New("media: invalid input")
	// ErrNotFound means the upload session or asset does not exist.
	ErrNotFound = errors.New("media: not found")
	// ErrPermissionDenied means the caller does not own the session.
	ErrPermissionDenied = errors.New("media: permission denied")
	// ErrScanRejected means the inspection rejected the file.
	ErrScanRejected = errors.New("media: file rejected by security scan")
	// ErrSecurityUnavailable means inspection could not run, so the file stays pending.
	ErrSecurityUnavailable = errors.New("media: security inspection unavailable")
	// ErrAlreadyCompleted means the session was completed before.
	ErrAlreadyCompleted = errors.New("media: upload already completed")
	// ErrStorageMissing means the deployment has no storage adapter, so bytes cannot
	// be accepted or inspected.
	ErrStorageMissing = errors.New("media: storage is not configured")
	// ErrStorageQuotaExceeded means every storage strategy assigned to the purpose is
	// full (or the allocation says stop at the first full entry). The bytes are not
	// written anywhere.
	ErrStorageQuotaExceeded = errors.New("media: storage quota exceeded")
	// ErrUploadTooLarge means the file is above the live per-member single-upload
	// limit configured in the storage settings.
	ErrUploadTooLarge = errors.New("media: upload exceeds the configured limit")
	// ErrAssetInUse means content still points at the asset, so removing it would break
	// a page silently: nothing reports a missing image, the author only notices later.
	ErrAssetInUse = errors.New("media: asset is still referenced by content")
)

// Bounds. They are enforced before a byte is stored.
const (
	// MaxImageBytes is the image size ceiling. Images are decoded for resize
	// variants, so they keep a hard memory bound independent of upload settings.
	MaxImageBytes int64 = 10 << 20
	// MaxUploadHardBytes is the safety ceiling for every non-image upload. The
	// dashboard's per-user upload limit can lower it, never raise it.
	MaxUploadHardBytes int64 = 1 << 30
	// UploadTTL is how long an upload session stays open.
	UploadTTL = 30 * time.Minute
	// MaxFileNameLength bounds the declared name.
	MaxFileNameLength = 200
)

// Pagination bounds for the asset library.
const (
	// DefaultListLimit is the page size used when the caller does not ask for one.
	DefaultListLimit = 20
	// MaxListLimit bounds one page so a caller cannot ask for the whole library.
	MaxListLimit = 100
)

// allowedImageTypes is the closed set of image MIME types.
var allowedImageTypes = map[string]struct{}{
	"image/png":  {},
	"image/jpeg": {},
	"image/webp": {},
	"image/gif":  {},
}

// allowedAttachmentTypes is the closed set of attachment MIME types.
var allowedAttachmentTypes = map[string]struct{}{
	"application/pdf": {},
	"text/plain":      {},
}

// allowedVideoTypes is the closed set of video MIME types. Only the two formats
// browsers play natively are accepted; anything else would be a download, not a
// video.
var allowedVideoTypes = map[string]struct{}{
	"video/mp4":  {},
	"video/webm": {},
}

// Actor is the caller performing an upload.
type Actor struct {
	UserID string
	SiteID string
	// Role is the caller's role in SiteID, taken from the live membership by the
	// transport. It decides whether the caller may see every asset of the site
	// (editor and above) or only their own (member).
	Role site.Role
	// Permissions is the expanded capability matrix of the caller's permission group.
	// Nil means "not loaded": the built-in defaults of Role apply, which is the rule
	// every caller had before permission groups existed. It mirrors site.Member, so a
	// capability switched off in the dashboard is off here too once the transport
	// passes the live matrix along.
	Permissions site.PermissionSet
}

// Allows reports whether the caller's capability matrix enables capability.
func (a Actor) Allows(capability site.Capability) bool {
	if a.Permissions == nil {
		return site.DefaultCapabilities(a.Role).Allows(capability)
	}
	return a.Permissions.Allows(capability)
}

// UploadRequest is the first phase: declare what will be uploaded.
type UploadRequest struct {
	FileName     string
	DeclaredMIME string
	Size         int64
	Purpose      Purpose
}

// ValidateRequest normalises and validates a declared upload.
//
// The declared name is only ever used for display. The storage key is generated, so a
// name like "../../etc/passwd" cannot influence where bytes land.
func ValidateRequest(in UploadRequest) (UploadRequest, error) {
	in.FileName = strings.TrimSpace(in.FileName)
	in.DeclaredMIME = strings.ToLower(strings.TrimSpace(in.DeclaredMIME))

	if !in.Purpose.Valid() {
		return UploadRequest{}, fmt.Errorf("%w: unknown purpose", ErrInvalidInput)
	}
	if in.FileName == "" {
		return UploadRequest{}, fmt.Errorf("%w: file name is required", ErrInvalidInput)
	}
	if len(in.FileName) > MaxFileNameLength {
		return UploadRequest{}, fmt.Errorf("%w: file name is too long", ErrInvalidInput)
	}
	if strings.ContainsAny(in.FileName, "\x00") {
		return UploadRequest{}, fmt.Errorf("%w: file name contains a null byte", ErrInvalidInput)
	}
	if in.Size <= 0 {
		return UploadRequest{}, fmt.Errorf("%w: size must be positive", ErrInvalidInput)
	}

	switch {
	case in.Purpose.IsImage():
		if _, ok := allowedImageTypes[in.DeclaredMIME]; !ok {
			return UploadRequest{}, fmt.Errorf("%w: unsupported image type", ErrInvalidInput)
		}
	case in.Purpose == PurposeContent:
		// Article media is images or videos. PDFs and text stay attachments so a
		// public article cannot accidentally publish a document.
		if _, image := allowedImageTypes[in.DeclaredMIME]; image {
			break
		}
		if _, video := allowedVideoTypes[in.DeclaredMIME]; !video {
			return UploadRequest{}, fmt.Errorf("%w: unsupported content media type", ErrInvalidInput)
		}
	case in.Purpose == PurposeAttachment:
		if _, ok := allowedAttachmentTypes[in.DeclaredMIME]; ok {
			break
		}
		if _, video := allowedVideoTypes[in.DeclaredMIME]; !video {
			return UploadRequest{}, fmt.Errorf("%w: unsupported attachment type", ErrInvalidInput)
		}
	}

	limit := int64(MaxUploadHardBytes)
	if _, image := allowedImageTypes[in.DeclaredMIME]; image {
		limit = MaxImageBytes
	}
	if in.Size > limit {
		return UploadRequest{}, fmt.Errorf("%w: file is too large", ErrInvalidInput)
	}

	return in, nil
}

// Upload is a pending upload session.
type Upload struct {
	ID           string
	SiteID       string
	OwnerID      string
	FileName     string
	DeclaredMIME string
	Size         int64
	Purpose      Purpose
	StorageKey   string
	Status       UploadStatus
	ExpiresAt    time.Time
	CreatedAt    time.Time
}

// Expired reports whether the session may no longer be completed.
func (u Upload) Expired(now time.Time) bool { return !now.Before(u.ExpiresAt) }

// NewStorageKey generates an opaque key.
//
// It is derived from a UUIDv7 and the display extension only, never from the caller's
// path, so traversal and collisions are impossible by construction.
func NewStorageKey(fileName string) string {
	ext := strings.ToLower(filepath.Ext(fileName))
	if len(ext) > 10 || strings.ContainsAny(ext, "/\\") {
		ext = ""
	}
	id := uuid.Must(uuid.NewV7()).String()
	return id[:2] + "/" + id + ext
}

// Asset is a stored, inspected object.
type Asset struct {
	ID      string
	SiteID  string
	OwnerID string
	// FileName is the display name the uploader declared. It is stored for the library
	// and for a copied reference, never for addressing bytes: the storage key below is
	// generated on its own, so renaming a file or naming it "../etc/passwd" cannot move
	// where the object lives.
	FileName   string
	StorageKey string
	MIME       string
	Size       int64
	ScanStatus ScanStatus
	// Purpose is persisted with the asset because storage may be configured per
	// purpose: a download or delete has to pick the same adapter the bytes were
	// written to, and only the record knows which one that was.
	Purpose Purpose
	// ReasonCode is the scanner's stable explanation for a non clean verdict.
	ReasonCode string
	CreatedAt  time.Time
}

// Referenceable reports whether content may link this asset.
func (a Asset) Referenceable() bool { return a.ScanStatus == ScanClean }

// AssetFilter narrows a library listing.
//
// An empty field means "do not narrow on this dimension". The values are closed sets:
// an unknown purpose or scan state is rejected rather than matching nothing, because a
// typo in a filter would otherwise be indistinguishable from an empty library.
type AssetFilter struct {
	Purpose    Purpose
	ScanStatus ScanStatus
	// OwnerID narrows the listing to one uploader. The service sets it from the
	// actor for callers below editor, so a member sees only their own library.
	OwnerID string
}

// Validate reports whether every declared filter value is one this build knows.
func (f AssetFilter) Validate() error {
	if f.Purpose != "" && !f.Purpose.Valid() {
		return fmt.Errorf("%w: unknown purpose filter", ErrInvalidInput)
	}
	if f.ScanStatus != "" && !f.ScanStatus.Valid() {
		return fmt.Errorf("%w: unknown scan status filter", ErrInvalidInput)
	}
	return nil
}

// ScanResult is the scanner verdict.
type ScanResult struct {
	Status     ScanStatus
	ReasonCode string
}
