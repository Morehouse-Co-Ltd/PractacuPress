package media

import (
	"context"
	"errors"
)

// ErrQuotaExceeded means a reservation would exceed either the user's or site's
// configured media quota.
var ErrQuotaExceeded = errors.New("media: upload quota exceeded")

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
