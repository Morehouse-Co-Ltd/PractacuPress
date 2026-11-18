package platformadmin

import (
	"fmt"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/site"
)

// The cross-site operations of the platform console.
//
// The console used to be a site lifecycle screen: list, create, enter. That left a
// deployment operator with no answer to "what is happening across my sites" and no way
// to read the audit trail of more than one tenant at a time. The views below close that
// gap, and two rules run through all of them:
//
//   - The caller must hold an active platform administrator seat on the site its token
//     was issued for. A site administrator, even one that administers every site, is
//     refused: aggregating tenants is deployment authority, not site administration.
//   - Nothing that leaves this package carries a secret. Counters, statuses and
//     booleans only: no password hash, no sealed TOTP seed, no session or handoff token.

// Bounds of the cross-site views.
const (
	// DefaultOverviewWindowDays is the activity window when the caller asks for none.
	DefaultOverviewWindowDays = 7
	// MinOverviewWindowDays and MaxOverviewWindowDays bound the asked window: a
	// negative window would count the future, and an unbounded one would turn the
	// overview into a full audit scan.
	MinOverviewWindowDays = 1
	MaxOverviewWindowDays = 30
	// MaxRecentActivity is how many deployment-wide audit rows the overview carries.
	// It is a glance, not a log reader: the full trail is GET /platform/audit-logs.
	MaxRecentActivity = 12
	// DefaultAccountPageLimit and MaxAccountPageLimit mirror the audit page sizes.
	DefaultAccountPageLimit = 50
	MaxAccountPageLimit     = 100
	// MaxDirectorySearchLength bounds the free text account search.
	MaxDirectorySearchLength = 120
)

// ContentCounts is the content inventory of one site, split by review state.
type ContentCounts struct {
	Total     int
	Published int
	// Pending counts the items waiting for a human: pending review and pending
	// security check. Both are invisible to visitors, which is why they are one number
	// here and the moderation queue page is the place to work them off.
	Pending int
	Draft   int
}

// CommentCounts is the comment inventory of one site.
type CommentCounts struct {
	Total int
	// Pending is the size of the moderation queue: comments held back by
	// comments_require_review or by a sensitive word.
	Pending int
}

// SiteMetrics is one site's operational snapshot.
//
// It answers the questions an operator asks when scanning the deployment: is it alive
// (activity in the window), is moderation keeping up (pending comments, open reports),
// how big is it (members, content), and is something wrong (failures in the window).
type SiteMetrics struct {
	Site site.Site

	Members       int
	ActiveMembers int
	Admins        int

	Content  ContentCounts
	Comments CommentCounts

	// OpenReports counts reports still waiting for a decision (open or assigned).
	OpenReports int
	// RecentActivity counts audit rows written for this site inside the window.
	RecentActivity int
	// RecentFailures counts audit rows that recorded a refusal inside the window.
	// Today that is the human verification guard (auth.captcha.failed); a module that
	// starts recording another failure outcome shows up here automatically.
	RecentFailures int
}

// AccountCounts is the deployment-wide account inventory.
type AccountCounts struct {
	Total int
	// Verified counts accounts whose email identity has been proven.
	Verified int
	// TwoFactor counts accounts with a confirmed authenticator. It is a count, never
	// the enrollment row: the sealed secret does not belong in an overview.
	TwoFactor int
}

// DeploymentMetrics is the whole-install counter snapshot one overview request needs.
//
// It is a single port method on purpose: the console asks its storage one question and
// the service turns the answer into totals, signals and rows, which keeps every rule
// (what counts as an anomaly, how the totals add up) in the package that owns them.
type DeploymentMetrics struct {
	Sites    []SiteMetrics
	Accounts AccountCounts
}

// OverviewTotals is the deployment column of the overview.
type OverviewTotals struct {
	Sites            int
	DisabledSites    int
	UnverifiedSites  int
	Members          int
	ActiveMembers    int
	Admins           int
	Content          int
	PublishedContent int
	PendingContent   int
	Comments         int
	PendingComments  int
	Accounts         int
	VerifiedAccounts int
	TwoFactorChosen  int
}

// OverviewSignals is the "look here first" column of the overview.
//
// Every number is something the operator can act on today with an existing screen;
// a signal nobody can fix would be noise.
type OverviewSignals struct {
	OpenReports      int
	PendingComments  int
	FailedActions    int
	DisabledSites    int
	UnverifiedSites  int
	UnverifiedEmails int
	// QuietSites counts running sites that wrote no audit row inside the window.
	QuietSites int
}

// ActivityRow is one deployment-wide audit row plus the site label it belongs to.
//
// The audit row stores a site id; the overview shows names, so the service joins the
// label from the same metrics query instead of asking the client to resolve it.
type ActivityRow struct {
	Log      audit.Log
	SiteName string
}

// Overview is the whole-install snapshot: totals, signals, per-site rows and the most
// recent audit rows across every tenant.
type Overview struct {
	GeneratedAt time.Time
	WindowDays  int
	WindowStart time.Time
	Totals      OverviewTotals
	Signals     OverviewSignals
	Sites       []SiteMetrics
	Recent      []ActivityRow
}

// AccountMembership is one membership of an account, as the directory lists it.
type AccountMembership struct {
	SiteID   string
	SiteName string
	SiteSlug string
	Role     site.Role
	Status   string
}

// AccountSummary is one account in the platform directory.
//
// The account row is global (one account, many memberships), so the directory lists
// accounts and nests the sites they belong to. Email verification and two factor are
// booleans: the directory answers "can this account recover its password / is it
// protected", never "what is its secret".
type AccountSummary struct {
	UserID      string
	DisplayName string
	// Email is the address of the account's email identity; empty for an account that
	// only signs in through a third party provider.
	Email string
	// EmailVerified mirrors the account level email_verified_at column.
	EmailVerified bool
	// TwoFactorEnabled reports a confirmed authenticator.
	TwoFactorEnabled bool
	Status           string
	CreatedAt        time.Time
	Memberships      []AccountMembership
}

// AccountQuery filters the directory. Empty fields are not applied.
type AccountQuery struct {
	// SiteID narrows the list to the memberships of one site; the rows are then
	// ordered by membership creation instead of by account creation.
	SiteID string
	// Search matches the display name or the email address, case insensitively.
	Search string
}

// AccountPage is one page of the directory plus the cursor for the next page.
type AccountPage struct {
	Items      []AccountSummary
	NextCursor string
}

// AuditQuery is the cross-site filter vocabulary.
//
// It mirrors audit.Filter with one difference that matters: SiteID empty means every
// site, because this endpoint is exactly the one that crosses the tenant boundary.
type AuditQuery struct {
	SiteID     string
	From       *time.Time
	To         *time.Time
	ActorID    string
	Action     string
	TargetType string
	TargetID   string
	Outcome    string
}

// normalizeOverviewWindow turns the requested window into a bounded number of days.
//
// Zero means "not asked for" and takes the default. Anything else is validated instead
// of clamped: a client that asks for 90 days gets a 400, not a silently different page.
func normalizeOverviewWindow(days int) (int, error) {
	if days == 0 {
		return DefaultOverviewWindowDays, nil
	}
	if days < MinOverviewWindowDays || days > MaxOverviewWindowDays {
		return 0, fmt.Errorf(
			"%w: window_days must be between %d and %d",
			ErrInvalidInput, MinOverviewWindowDays, MaxOverviewWindowDays)
	}
	return days, nil
}

// normalizeAuditQuery validates the cross-site audit filter and lowers it onto the
// shared audit vocabulary.
//
// Lengths and the from/to order are checked here rather than in storage so a malformed
// filter is a 400 on every database; the audit package owns the same bounds for its own
// per-site endpoint.
func normalizeAuditQuery(query AuditQuery) (audit.Filter, error) {
	filter := audit.Filter{
		SiteID:     strings.TrimSpace(query.SiteID),
		From:       query.From,
		To:         query.To,
		ActorID:    strings.TrimSpace(query.ActorID),
		Action:     strings.TrimSpace(query.Action),
		TargetType: strings.TrimSpace(query.TargetType),
		TargetID:   strings.TrimSpace(query.TargetID),
		Outcome:    strings.TrimSpace(query.Outcome),
	}
	if len(filter.SiteID) > audit.MaxIDLength ||
		len(filter.ActorID) > audit.MaxIDLength ||
		len(filter.TargetID) > audit.MaxIDLength ||
		len(filter.Action) > audit.MaxActionLength ||
		len(filter.TargetType) > audit.MaxTargetTypeLength ||
		len(filter.Outcome) > audit.MaxOutcomeLength {
		return audit.Filter{}, fmt.Errorf("%w: filter value is too long", ErrInvalidInput)
	}
	if filter.From != nil && filter.To != nil && filter.From.After(*filter.To) {
		return audit.Filter{}, fmt.Errorf("%w: from must not be after to", ErrInvalidInput)
	}
	return filter, nil
}

// normalizeAccountQuery validates the directory filter.
func normalizeAccountQuery(query AccountQuery) (AccountQuery, error) {
	normalized := AccountQuery{
		SiteID: strings.TrimSpace(query.SiteID),
		Search: strings.TrimSpace(query.Search),
	}
	if len(normalized.SiteID) > audit.MaxIDLength {
		return AccountQuery{}, fmt.Errorf("%w: site_id is too long", ErrInvalidInput)
	}
	if len([]rune(normalized.Search)) > MaxDirectorySearchLength {
		return AccountQuery{}, fmt.Errorf(
			"%w: search must be at most %d characters", ErrInvalidInput, MaxDirectorySearchLength)
	}
	return normalized, nil
}

// normalizePageSize clamps a page size onto the published bound.
func normalizePageSize(limit, fallback, max int) int {
	if limit <= 0 {
		return fallback
	}
	if limit > max {
		return max
	}
	return limit
}
