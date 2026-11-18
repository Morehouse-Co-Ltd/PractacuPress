package securityclient

import "context"

// Unavailable is the Client used until the Rust service is deployed.
//
// Every method fails with ErrUnavailable on purpose. Wiring this in development and
// test means the fail closed branches are exercised continuously, instead of being
// discovered during the first production outage.
type Unavailable struct{}

// HashPassword always fails.
func (Unavailable) HashPassword(context.Context, string) (string, error) { return "", ErrUnavailable }

// VerifyPassword always fails.
func (Unavailable) VerifyPassword(context.Context, string, string) (bool, error) {
	return false, ErrUnavailable
}

// SanitizeContent always fails.
func (Unavailable) SanitizeContent(context.Context, ContentInput) (Sanitized, error) {
	return Sanitized{}, ErrUnavailable
}

// InspectUpload always fails.
func (Unavailable) InspectUpload(context.Context, UploadInput) (ScanResult, error) {
	return ScanResult{}, ErrUnavailable
}

// Ping always reports unavailable.
func (Unavailable) Ping(context.Context) error { return ErrUnavailable }

// Compile time check that the stub satisfies the contract.
var _ Client = Unavailable{}
