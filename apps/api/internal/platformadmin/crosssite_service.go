package platformadmin

import (
	"context"
	"fmt"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
)

// Overview returns the deployment wide operational snapshot.
//
// Only a platform administrator of the resolved site may ask: the answer aggregates
// every tenant, which no site role reaches on its own. The window bounds the activity
// counters and the recent rows; inventory counters (members, content, backlog) are
// totals as of now and are deliberately not windowed, because "how big is this site"
// does not depend on the last seven days.
func (s *Service) Overview(
	ctx context.Context,
	actorSiteID, actorUserID string,
	windowDays int,
) (Overview, error) {
	if _, err := s.platformMember(ctx, actorSiteID, actorUserID); err != nil {
		return Overview{}, err
	}
	window, err := normalizeOverviewWindow(windowDays)
	if err != nil {
		return Overview{}, err
	}

	now := s.now()
	since := now.AddDate(0, 0, -window)

	metrics, err := s.metrics.Metrics(ctx, since)
	if err != nil {
		return Overview{}, err
	}

	overview := overviewFrom(metrics, now, window)
	if err := s.attachRecentActivity(ctx, &overview, since); err != nil {
		return Overview{}, err
	}
	return overview, nil
}

// overviewFrom turns the storage counters into totals, signals and rows.
//
// The arithmetic lives here, not in storage: what counts as an anomaly is a product
// decision ("a running site that wrote nothing is worth a look"), and it must not be
// re-implemented per database driver.
func overviewFrom(metrics DeploymentMetrics, now time.Time, window int) Overview {
	overview := Overview{
		GeneratedAt: now,
		WindowDays:  window,
		WindowStart: now.AddDate(0, 0, -window),
		Sites:       make([]SiteMetrics, 0, len(metrics.Sites)),
	}

	for _, item := range metrics.Sites {
		overview.Totals.Sites++
		overview.Totals.Members += item.Members
		overview.Totals.ActiveMembers += item.ActiveMembers
		overview.Totals.Admins += item.Admins
		overview.Totals.Content += item.Content.Total
		overview.Totals.PublishedContent += item.Content.Published
		overview.Totals.PendingContent += item.Content.Pending
		overview.Totals.Comments += item.Comments.Total
		overview.Totals.PendingComments += item.Comments.Pending

		overview.Signals.OpenReports += item.OpenReports
		overview.Signals.FailedActions += item.RecentFailures

		if item.Site.Disabled {
			overview.Totals.DisabledSites++
			overview.Signals.DisabledSites++
		}
		if !item.Site.DomainVerified() {
			overview.Totals.UnverifiedSites++
			overview.Signals.UnverifiedSites++
		}
		if !item.Site.Disabled && item.RecentActivity == 0 {
			overview.Signals.QuietSites++
		}

		overview.Sites = append(overview.Sites, item)
	}

	overview.Totals.Accounts = metrics.Accounts.Total
	overview.Totals.VerifiedAccounts = metrics.Accounts.Verified
	overview.Totals.TwoFactorChosen = metrics.Accounts.TwoFactor
	// Pending comments are already summed per site; the signal is the same number,
	// repeated under the column an operator scans for "what needs me now".
	overview.Signals.PendingComments = overview.Totals.PendingComments
	overview.Signals.UnverifiedEmails = metrics.Accounts.Total - metrics.Accounts.Verified
	if overview.Signals.UnverifiedEmails < 0 {
		// Defensive: a verification column can only move forward, so this cannot
		// happen; a negative "unverified" count would still be a lie on screen.
		overview.Signals.UnverifiedEmails = 0
	}
	return overview
}

// attachRecentActivity fills the deployment-wide tail of the overview.
//
// Site names are resolved from the same metrics rows, so the overview costs one extra
// query instead of one per row. Rows without a site (an operator acting outside any
// tenant) simply carry an empty label.
func (s *Service) attachRecentActivity(ctx context.Context, overview *Overview, since time.Time) error {
	rows, _, err := s.trail.ListAll(ctx, audit.Filter{From: &since}, MaxRecentActivity, page.Cursor{})
	if err != nil {
		return err
	}

	names := make(map[string]string, len(overview.Sites))
	for _, item := range overview.Sites {
		names[item.Site.ID] = item.Site.Name
	}

	overview.Recent = make([]ActivityRow, 0, len(rows))
	for _, row := range rows {
		overview.Recent = append(overview.Recent, ActivityRow{
			Log:      row,
			SiteName: names[row.SiteID],
		})
	}
	return nil
}

// ListAuditLogs returns one page of the audit trail across sites.
//
// An empty SiteID means every site. The query itself is audited: handing out the
// deployment's privileged history is exactly the kind of access the trail exists to
// document, so a failure to write that row fails the read instead of leaving an
// unrecorded disclosure.
func (s *Service) ListAuditLogs(
	ctx context.Context,
	actorSiteID, actorUserID, requestID string,
	query AuditQuery,
	limit int,
	after page.Cursor,
) (audit.Page, error) {
	if _, err := s.platformMember(ctx, actorSiteID, actorUserID); err != nil {
		return audit.Page{}, err
	}

	filter, err := normalizeAuditQuery(query)
	if err != nil {
		return audit.Page{}, err
	}
	limit = normalizePageSize(limit, audit.DefaultLimit, audit.MaxLimit)
	if !after.IsZero() {
		if _, parseErr := time.Parse(time.RFC3339Nano, after.Key); parseErr != nil {
			return audit.Page{}, fmt.Errorf("%w: invalid cursor position", ErrInvalidInput)
		}
	}

	items, next, err := s.trail.ListAll(ctx, filter, limit, after)
	if err != nil {
		return audit.Page{}, err
	}
	if err := s.recordAuditQuery(ctx, actorSiteID, actorUserID, requestID, filter, len(items)); err != nil {
		return audit.Page{}, err
	}
	return audit.Page{Items: items, NextCursor: next}, nil
}

// recordAuditQuery appends the "someone read the deployment trail" row.
//
// It is written on the actor's own site so the row stays visible to that site's
// administrators too, and it targets the filtered site when there is one, which is what
// lets the existing name resolution render a readable target.
func (s *Service) recordAuditQuery(
	ctx context.Context,
	actorSiteID, actorUserID, requestID string,
	filter audit.Filter,
	returned int,
) error {
	targetID := filter.SiteID
	if targetID == "" {
		targetID = actorSiteID
	}
	detail := map[string]any{"returned": returned}
	if filter.SiteID != "" {
		detail["site_id"] = filter.SiteID
	}
	if filter.Action != "" {
		detail["action"] = filter.Action
	}
	if filter.ActorID != "" {
		detail["actor_id"] = filter.ActorID
	}
	if filter.TargetType != "" {
		detail["target_type"] = filter.TargetType
	}
	if filter.Outcome != "" {
		detail["outcome"] = filter.Outcome
	}
	if filter.From != nil {
		detail["from"] = filter.From.UTC().Format(time.RFC3339Nano)
	}
	if filter.To != nil {
		detail["to"] = filter.To.UTC().Format(time.RFC3339Nano)
	}

	return s.recorder.Record(ctx, audit.Entry{
		SiteID:     actorSiteID,
		ActorID:    actorUserID,
		Action:     "platform.audit.queried",
		TargetType: "site",
		TargetID:   targetID,
		RequestID:  requestID,
		Outcome:    "success",
		Detail:     detail,
		At:         s.now(),
	})
}

// ListAccounts returns one page of the deployment account directory.
//
// With a SiteID the page is that site's memberships; without one it is every account of
// the install. Both pages carry the same row shape so the frontend renders one table.
func (s *Service) ListAccounts(
	ctx context.Context,
	actorSiteID, actorUserID string,
	query AccountQuery,
	limit int,
	after page.Cursor,
) (AccountPage, error) {
	if _, err := s.platformMember(ctx, actorSiteID, actorUserID); err != nil {
		return AccountPage{}, err
	}

	normalized, err := normalizeAccountQuery(query)
	if err != nil {
		return AccountPage{}, err
	}
	limit = normalizePageSize(limit, DefaultAccountPageLimit, MaxAccountPageLimit)
	if !after.IsZero() {
		if _, parseErr := time.Parse(time.RFC3339Nano, after.Key); parseErr != nil {
			return AccountPage{}, fmt.Errorf("%w: invalid cursor position", ErrInvalidInput)
		}
	}

	items, next, err := s.directory.ListAccounts(ctx, normalized, limit, after)
	if err != nil {
		return AccountPage{}, err
	}
	return AccountPage{Items: items, NextCursor: next}, nil
}
