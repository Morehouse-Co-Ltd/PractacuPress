package media

import "context"

// UnavailableScanner is the Scanner used until the Rust security service is deployed.
//
// It always fails, so every completion stays pending and no asset becomes referenceable.
// Wiring this in development keeps the fail closed branches exercised continuously
// instead of being discovered during an incident.
type UnavailableScanner struct{}

var _ Scanner = UnavailableScanner{}

// Inspect always reports that inspection could not run.
func (UnavailableScanner) Inspect(context.Context, ScanInput) (ScanResult, error) {
	return ScanResult{}, ErrSecurityUnavailable
}
