// Package securityclient is the contract to the Rust security service.
//
// The service owns password hashing, content sanitization and upload inspection.
// It never owns users, articles or permissions: those stay in the Go application.
package securityclient

import (
	"context"
	"errors"
)

// ErrUnavailable means the security service could not be reached.
//
// Callers must treat it as fail closed: an upload stays unscanned and content stays
// unpublishable. Continuing as if the check had passed converts an outage into a
// security incident.
var ErrUnavailable = errors.New("security: service unavailable")

// ContentFormat is the source format of submitted content.
type ContentFormat string

// Supported source formats.
const (
	FormatMarkdown ContentFormat = "markdown"
	FormatHTML     ContentFormat = "html"
	FormatPlain    ContentFormat = "plain"
)

// ContentInput is a sanitization request.
type ContentInput struct {
	Format ContentFormat
	Source string
}

// Sanitized is the outcome of sanitization.
type Sanitized struct {
	// HTML is the only representation allowed to reach a client as rendered content.
	HTML string
	// PolicyVersion identifies the policy that produced HTML, so a later policy
	// change can invalidate previously published content.
	PolicyVersion string
	// Violations lists removed constructs for the audit trail.
	Violations []string
}

// ScanStatus is the outcome of upload inspection.
type ScanStatus string

// Scan outcomes.
const (
	ScanClean             ScanStatus = "clean"
	ScanRejected          ScanStatus = "rejected"
	ScanNeedsManualReview ScanStatus = "needs_manual_review"
)

// UploadInput is an inspection request.
type UploadInput struct {
	FileName     string
	DeclaredMIME string
	Size         int64
	// StorageKey identifies the stored object; the service never dereferences it.
	StorageKey string
	// Content is the leading bytes of the object, used for magic number checks.
	Content []byte
}

// ScanResult is the outcome of inspection.
type ScanResult struct {
	Status        ScanStatus
	ReasonCode    string
	PolicyVersion string
}

// Client is the security service contract.
type Client interface {
	HashPassword(ctx context.Context, plain string) (string, error)
	VerifyPassword(ctx context.Context, plain, encoded string) (bool, error)
	SanitizeContent(ctx context.Context, input ContentInput) (Sanitized, error)
	InspectUpload(ctx context.Context, input UploadInput) (ScanResult, error)
	Ping(ctx context.Context) error
}
