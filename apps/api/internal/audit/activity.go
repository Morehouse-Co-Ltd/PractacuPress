package audit

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// The dashboard's "recent operations" projection (Beta 1.2 contract C).
//
// It is the same audit ledger the audit page reads, with a deliberately smaller
// vocabulary: one page, no cursor, no filters, and the detail map rendered as a
// single display string. Keeping the query here (rather than adding a second
// read model) is what guarantees the panel and the audit page can never disagree
// about what happened.
const (
	// ActivityDefaultLimit is the dashboard feed size when the caller asks for none.
	ActivityDefaultLimit = 20
	// ActivityMaxLimit matches the documented limit ceiling of the endpoint.
	ActivityMaxLimit = 100
)

// Activity returns the newest audit rows of one site.
//
// Authorisation is the `view_log` capability, not site administration: the panel
// is meant for moderators and administrators alike, and the matrix decides. The
// membership must still belong to the site in the path, so the path cannot widen
// the tenant boundary.
func (s *Service) Activity(
	ctx context.Context,
	actor site.Member,
	siteID string,
	limit int,
) ([]Log, error) {
	if actor.SiteID != siteID || !site.Can(actor, site.ActionViewLog) {
		return nil, ErrPermissionDenied
	}
	if limit <= 0 || limit > ActivityMaxLimit {
		limit = ActivityDefaultLimit
	}
	// Actor and target display names are resolved by the repository (it joins the
	// local user table), so the projection carries actor_name without a second
	// query here.
	items, _, err := s.repo.List(ctx, Filter{SiteID: siteID}, limit, page.Cursor{})
	if err != nil {
		return nil, err
	}
	return items, nil
}

// activityDetail renders one audit detail map as the single string the contract
// declares for SiteActivityItem.detail.
//
// A module that already wrote a human summary wins; otherwise the map is encoded
// as compact JSON so no information is silently dropped. The result is bounded:
// the dashboard renders it as one line and a huge detail JSON would push the row
// height around.
func activityDetail(detail map[string]any) string {
	if len(detail) == 0 {
		return ""
	}
	for _, key := range []string{"summary", "message", "title"} {
		if value, ok := detail[key].(string); ok && strings.TrimSpace(value) != "" {
			return truncateRunes(value, 500)
		}
	}
	raw, err := json.Marshal(detail)
	if err != nil {
		return ""
	}
	return truncateRunes(string(raw), 500)
}

// truncateRunes cuts at a rune boundary so the JSON response stays valid UTF-8.
func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return value
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}
