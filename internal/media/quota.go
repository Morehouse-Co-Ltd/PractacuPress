package media

import (
	"context"
	"errors"
)

// ErrQuotaExceeded means a reservation would exceed either the user's or site's
// configured media quota.
var ErrQuotaExceeded = errors.New("media: upload quota exceeded")

// ErrQuotaUnavailable means a quota is configured but the repository cannot
// reserve atomically. It is a deployment wiring error, not a client error.
var ErrQuotaUnavailable = errors.New("media: quota repository is not configured")

// QuotaDefaults are deployment level limits. A zero value disables that limit.
type QuotaDefaults struct {
	UserBytes int64
	SiteBytes int64
}

// QuotaOverrides are optional site and member specific limits. Nil means inherit
// the corresponding deployment default.
type QuotaOverrides struct {
	UserBytes *int64
	SiteBytes *int64
}

// QuotaOverrideReader returns current limits for one site membership.
type QuotaOverrideReader interface {
	MediaQuotaOverrides(ctx context.Context, siteID, userID string) (QuotaOverrides, error)
}

// QuotaReservationRepository checks stored usage and reserves an upload atomically.
type QuotaReservationRepository interface {
	InsertUploadWithinQuota(ctx context.Context, upload Upload, userLimitBytes, siteLimitBytes int64) (Upload, error)
}

// SettingsReader exposes the live limits from the storage settings document. The
// storage manager implements it, so a dashboard change applies to the next upload
// without a restart.
type SettingsReader interface {
	// MediaQuotaDefaults returns the current per-user and per-site budgets. Zero
	// means unlimited.
	MediaQuotaDefaults() (userBytes, siteBytes int64)
	// MediaUploadLimitBytes returns the current single-upload ceiling for a member.
	// Zero means the hard safety ceiling is the only bound.
	MediaUploadLimitBytes() int64
}
