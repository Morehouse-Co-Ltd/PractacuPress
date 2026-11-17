// Package platformstore implements the cross-site operational reads of the platform
// console: the deployment overview counters and the account directory.
//
// The queries span several modules (sites, memberships, content, comments, reports,
// accounts and the audit trail), which is why they live in infrastructure rather than
// in any one of them: the console declares narrow ports and this adapter answers them
// against one consistent snapshot of the database.
package platformstore

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/auditlog"
	"github.com/practacu/practacu-press/apps/api/ent/comment"
	"github.com/practacu/practacu-press/apps/api/ent/contentitem"
	"github.com/practacu/practacu-press/apps/api/ent/moderationreport"
	entsite "github.com/practacu/practacu-press/apps/api/ent/site"
	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
	"github.com/practacu/practacu-press/apps/api/ent/twofactor"
	"github.com/practacu/practacu-press/apps/api/ent/user"
	"github.com/practacu/practacu-press/apps/api/ent/useridentity"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/sitestore"
	"github.com/practacu/practacu-press/apps/api/internal/platform/fieldcrypto"
	"github.com/practacu/practacu-press/apps/api/internal/platform/identitycrypto"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/platformadmin"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// The status vocabulary below mirrors the ent schema constants (which the schema
// package owns). They are repeated as literals instead of importing every domain
// package, exactly like the audit store repeats its target types: this adapter reads
// columns, it does not make product decisions.
const (
	contentStatusPublished = "published"
	contentStatusPending   = "pending_review"
	contentStatusSecurity  = "pending_security_check"
	contentStatusDraft     = "draft"

	commentStatusPending = "pending_review"

	reportStatusOpen     = "open"
	reportStatusAssigned = "assigned"

	roleSiteAdmin     = "site_admin"
	rolePlatformAdmin = "platform_admin"

	memberStatusActive = "active"

	auditOutcomeFailure = "failure"

	// providerEmail is the identity provider that carries the account's address.
	providerEmail = "email"
)

// maxSearchCandidates bounds the id list a free text search may contribute to a query.
//
// It only applies to a search: without one the directory pages through its own rows, so
// a large install never materialises an unbounded id list. With one, 500 matches is far
// more than a human narrows down to, and the search field tells the user to be more
// specific by simply not finding the rest.
const maxSearchCandidates = 500

// Store is the Ent backed implementation of the console's cross-site ports.
type Store struct {
	client *entgen.Client
	// identity opens the sealed login addresses shown in the account directory.
	identity *identitycrypto.Codec
}

// Option customises a Store.
type Option func(*Store)

// WithFieldCipher opens sealed identity address columns.
func WithFieldCipher(cipher *fieldcrypto.Cipher) Option {
	return func(s *Store) { s.identity = identitycrypto.New(cipher) }
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client, opts ...Option) *Store {
	store := &Store{client: client}
	for _, option := range opts {
		if option != nil {
			option(store)
		}
	}
	return store
}

var _ platformadmin.MetricsRepository = (*Store)(nil)
var _ platformadmin.DirectoryRepository = (*Store)(nil)

// counter is the shape every ent query exposes, which lets siteMetrics describe its
// counters as data instead of repeating eleven identical error checks.
type counter interface {
	Count(ctx context.Context) (int, error)
}

// Metrics returns the deployment snapshot the overview is built from.
//
// One fixed number of small, indexed counts per site: the console shows at most
// platformadmin.MaxListedSites sites, so the cost is bounded by that limit rather than
// by the number of content rows. A deployment that outgrows the console needs paging,
// not a heavier single screen.
func (s *Store) Metrics(ctx context.Context, since time.Time) (platformadmin.DeploymentMetrics, error) {
	sites, err := sitestore.New(s.client).ListSites(ctx, platformadmin.MaxListedSites)
	if err != nil {
		return platformadmin.DeploymentMetrics{}, err
	}

	metrics := platformadmin.DeploymentMetrics{Sites: make([]platformadmin.SiteMetrics, 0, len(sites))}
	for _, found := range sites {
		item, itemErr := s.siteMetrics(ctx, found, since)
		if itemErr != nil {
			return platformadmin.DeploymentMetrics{}, itemErr
		}
		metrics.Sites = append(metrics.Sites, item)
	}

	accounts, err := s.accountCounts(ctx)
	if err != nil {
		return platformadmin.DeploymentMetrics{}, err
	}
	metrics.Accounts = accounts
	return metrics, nil
}

// siteMetrics reads one site's counters.
func (s *Store) siteMetrics(
	ctx context.Context,
	found site.Site,
	since time.Time,
) (platformadmin.SiteMetrics, error) {
	item := platformadmin.SiteMetrics{Site: found}

	counters := []struct {
		name  string
		value *int
		query counter
	}{
		{"members", &item.Members, s.client.SiteMember.Query().
			Where(sitemember.SiteIDEQ(found.ID))},
		{"active members", &item.ActiveMembers, s.client.SiteMember.Query().
			Where(sitemember.SiteIDEQ(found.ID), sitemember.StatusEQ(memberStatusActive))},
		{"admins", &item.Admins, s.client.SiteMember.Query().
			Where(
				sitemember.SiteIDEQ(found.ID),
				sitemember.StatusEQ(memberStatusActive),
				sitemember.RoleIn(roleSiteAdmin, rolePlatformAdmin),
			)},
		// The recycle bin is excluded from every content counter: an operator reading
		// the cross site dashboard is asking how much live content a site has, and a
		// trashed row is not that. It is still counted nowhere else, so the number the
		// site owner sees in the content library matches this one.
		{"content", &item.Content.Total, s.client.ContentItem.Query().
			Where(contentitem.SiteIDEQ(found.ID), contentitem.DeletedAtIsNil())},
		{"published content", &item.Content.Published, s.client.ContentItem.Query().
			Where(
				contentitem.SiteIDEQ(found.ID),
				contentitem.StatusEQ(contentStatusPublished),
				contentitem.DeletedAtIsNil(),
			)},
		{"pending content", &item.Content.Pending, s.client.ContentItem.Query().
			Where(
				contentitem.SiteIDEQ(found.ID),
				contentitem.StatusIn(contentStatusPending, contentStatusSecurity),
				contentitem.DeletedAtIsNil(),
			)},
		{"draft content", &item.Content.Draft, s.client.ContentItem.Query().
			Where(
				contentitem.SiteIDEQ(found.ID),
				contentitem.StatusEQ(contentStatusDraft),
				contentitem.DeletedAtIsNil(),
			)},
		{"comments", &item.Comments.Total, s.client.Comment.Query().
			Where(comment.SiteIDEQ(found.ID))},
		{"pending comments", &item.Comments.Pending, s.client.Comment.Query().
			Where(comment.SiteIDEQ(found.ID), comment.StatusEQ(commentStatusPending))},
		{"open reports", &item.OpenReports, s.client.ModerationReport.Query().
			Where(
				moderationreport.SiteIDEQ(found.ID),
				moderationreport.StatusIn(reportStatusOpen, reportStatusAssigned),
			)},
		{"recent activity", &item.RecentActivity, s.client.AuditLog.Query().
			Where(auditlog.SiteIDEQ(found.ID), auditlog.CreatedAtGTE(since))},
		{"recent failures", &item.RecentFailures, s.client.AuditLog.Query().
			Where(
				auditlog.SiteIDEQ(found.ID),
				auditlog.CreatedAtGTE(since),
				auditlog.OutcomeEQ(auditOutcomeFailure),
			)},
	}

	for _, counted := range counters {
		value, err := counted.query.Count(ctx)
		if err != nil {
			return platformadmin.SiteMetrics{}, fmt.Errorf(
				"count %s of site %s: %w", counted.name, found.ID, err)
		}
		*counted.value = value
	}
	return item, nil
}

// accountCounts reads the deployment wide account inventory.
func (s *Store) accountCounts(ctx context.Context) (platformadmin.AccountCounts, error) {
	total, err := s.client.User.Query().Count(ctx)
	if err != nil {
		return platformadmin.AccountCounts{}, err
	}
	verified, err := s.client.User.Query().Where(user.EmailVerifiedAtNotNil()).Count(ctx)
	if err != nil {
		return platformadmin.AccountCounts{}, err
	}
	// Only the enrolment flag is counted. The sealed TOTP secret is never read here,
	// which is why the query filters on enabled instead of loading the rows.
	enrolled, err := s.client.TwoFactor.Query().Where(twofactor.EnabledEQ(true)).Count(ctx)
	if err != nil {
		return platformadmin.AccountCounts{}, err
	}
	return platformadmin.AccountCounts{Total: total, Verified: verified, TwoFactor: enrolled}, nil
}

// ListAccounts returns one page of the account directory.
//
// Two orderings, one row shape: without a site filter the page is accounts newest
// first, with one it is that site's memberships newest first. Both are paginated by the
// row they sort on, so neither has to materialise an id list from the other table.
func (s *Store) ListAccounts(
	ctx context.Context,
	query platformadmin.AccountQuery,
	limit int,
	after page.Cursor,
) ([]platformadmin.AccountSummary, string, error) {
	if query.SiteID != "" {
		return s.listSiteMembers(ctx, query, limit, after)
	}
	return s.listAccounts(ctx, query, limit, after)
}

// listAccounts pages the global account list.
func (s *Store) listAccounts(
	ctx context.Context,
	query platformadmin.AccountQuery,
	limit int,
	after page.Cursor,
) ([]platformadmin.AccountSummary, string, error) {
	rows := s.client.User.Query()
	if query.Search != "" {
		matching, err := s.searchAccountIDs(ctx, query.Search)
		if err != nil {
			return nil, "", err
		}
		// No match is an empty page, not an unfiltered one.
		if len(matching) == 0 {
			return nil, "", nil
		}
		rows.Where(user.IDIn(matching...))
	}
	if !after.IsZero() {
		key, err := time.Parse(time.RFC3339Nano, after.Key)
		if err != nil {
			return nil, "", err
		}
		// (created_at DESC, id DESC): both halves keep rows that share a timestamp
		// from being skipped at a page boundary.
		rows.Where(user.Or(
			user.CreatedAtLT(key),
			user.And(user.CreatedAtEQ(key), user.IDLT(after.ID)),
		))
	}

	pageRows, err := rows.
		Order(entgen.Desc(user.FieldCreatedAt), entgen.Desc(user.FieldID)).
		Limit(limit + 1).
		All(ctx)
	if err != nil {
		return nil, "", err
	}

	next := ""
	if len(pageRows) > limit {
		pageRows = pageRows[:limit]
		last := pageRows[len(pageRows)-1]
		next = page.Cursor{
			Key: last.CreatedAt.UTC().Format(time.RFC3339Nano),
			ID:  last.ID,
		}.Encode()
	}

	ids := make([]string, 0, len(pageRows))
	for _, row := range pageRows {
		ids = append(ids, row.ID)
	}
	byID, err := s.accountDetails(ctx, ids)
	if err != nil {
		return nil, "", err
	}
	return ordered(ids, byID), next, nil
}

// listSiteMembers pages one site's memberships.
func (s *Store) listSiteMembers(
	ctx context.Context,
	query platformadmin.AccountQuery,
	limit int,
	after page.Cursor,
) ([]platformadmin.AccountSummary, string, error) {
	matching, err := s.searchAccountIDs(ctx, query.Search)
	if err != nil {
		return nil, "", err
	}
	if query.Search != "" && len(matching) == 0 {
		return nil, "", nil
	}

	rows := s.client.SiteMember.Query().Where(sitemember.SiteIDEQ(query.SiteID))
	if query.Search != "" {
		rows.Where(sitemember.UserIDIn(matching...))
	}
	if !after.IsZero() {
		key, err := time.Parse(time.RFC3339Nano, after.Key)
		if err != nil {
			return nil, "", err
		}
		rows.Where(sitemember.Or(
			sitemember.CreatedAtLT(key),
			sitemember.And(sitemember.CreatedAtEQ(key), sitemember.IDLT(after.ID)),
		))
	}

	pageRows, err := rows.
		Order(entgen.Desc(sitemember.FieldCreatedAt), entgen.Desc(sitemember.FieldID)).
		Limit(limit + 1).
		All(ctx)
	if err != nil {
		return nil, "", err
	}

	next := ""
	if len(pageRows) > limit {
		pageRows = pageRows[:limit]
		last := pageRows[len(pageRows)-1]
		next = page.Cursor{
			Key: last.CreatedAt.UTC().Format(time.RFC3339Nano),
			ID:  last.ID,
		}.Encode()
	}

	ids := make([]string, 0, len(pageRows))
	seen := make(map[string]struct{}, len(pageRows))
	for _, row := range pageRows {
		if _, ok := seen[row.UserID]; ok {
			continue
		}
		seen[row.UserID] = struct{}{}
		ids = append(ids, row.UserID)
	}
	byID, err := s.accountDetails(ctx, ids)
	if err != nil {
		return nil, "", err
	}
	return ordered(ids, byID), next, nil
}

// searchAccountIDs resolves the accounts whose display name or email address matches
// term, case insensitively.
//
// The address lives on the identity row, not on the account, so the free text search
// has to cross the two tables somewhere. Resolving the matches first keeps the account
// query a single table scan with an IN list bounded by maxSearchCandidates; the display
// name lives on the account itself, and unioning both makes the search behave the same
// on the global page and on one site's member page.
func (s *Store) searchAccountIDs(ctx context.Context, term string) ([]string, error) {
	if term == "" {
		return nil, nil
	}
	ids := make([]string, 0, 16)
	accounts, err := s.client.User.Query().
		Select(user.FieldID).
		Where(user.DisplayNameContainsFold(term)).
		Limit(maxSearchCandidates).
		All(ctx)
	if err != nil {
		return nil, err
	}
	for _, account := range accounts {
		ids = append(ids, account.ID)
	}
	matches, err := s.searchIdentityUserIDs(ctx, term)
	if err != nil {
		return nil, err
	}
	ids = append(ids, matches...)
	return unique(ids), nil
}

// searchIdentityUserIDs resolves the accounts whose login address matches term.
//
// The address is sealed, so the case-insensitive SQL contains() the old code used
// can no longer run on the column. An exact address takes the sealed equality path
// (deterministic envelopes keep that working); anything else decrypts a bounded page
// and filters in memory. maxSearchCandidates keeps that page small enough that the
// scan stays a directory convenience rather than a table dump.
func (s *Store) searchIdentityUserIDs(ctx context.Context, term string) ([]string, error) {
	term = strings.TrimSpace(term)
	if term == "" {
		return nil, nil
	}
	lower := strings.ToLower(term)

	if strings.Contains(lower, "@") {
		sealed, err := s.identity.SealEmail(lower)
		if err != nil {
			return nil, err
		}
		rows, err := s.client.UserIdentity.Query().
			Select(useridentity.FieldUserID).
			Where(useridentity.EmailEQ(sealed)).
			Limit(maxSearchCandidates).
			All(ctx)
		if err != nil {
			return nil, err
		}
		if len(rows) > 0 {
			ids := make([]string, 0, len(rows))
			for _, row := range rows {
				ids = append(ids, row.UserID)
			}
			return ids, nil
		}
	}

	rows, err := s.client.UserIdentity.Query().
		Select(useridentity.FieldUserID, useridentity.FieldEmail).
		Where(useridentity.EmailNotNil()).
		Order(entgen.Desc(useridentity.FieldCreatedAt)).
		Limit(maxSearchCandidates).
		All(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	for _, row := range rows {
		if row.Email == nil {
			continue
		}
		address, err := s.identity.OpenEmail(*row.Email)
		if err != nil {
			return nil, err
		}
		if strings.Contains(strings.ToLower(address), lower) {
			ids = append(ids, row.UserID)
		}
	}
	return ids, nil
}

// accountDetails attaches the display, verification, two factor and membership facts
// of a page of accounts.
//
// Every field selected here is public to an administrator. The identity password hash
// and the sealed authenticator secret are not selected at all: a read model that never
// loads a secret cannot leak one through a later field addition.
func (s *Store) accountDetails(
	ctx context.Context,
	ids []string,
) (map[string]platformadmin.AccountSummary, error) {
	summaries := make(map[string]platformadmin.AccountSummary, len(ids))
	if len(ids) == 0 {
		return summaries, nil
	}

	accounts, err := s.client.User.Query().Where(user.IDIn(ids...)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, account := range accounts {
		summaries[account.ID] = platformadmin.AccountSummary{
			UserID:        account.ID,
			DisplayName:   account.DisplayName,
			EmailVerified: account.EmailVerifiedAt != nil,
			Status:        account.Status,
			CreatedAt:     account.CreatedAt,
		}
	}

	identities, err := s.client.UserIdentity.Query().
		Select(useridentity.FieldUserID, useridentity.FieldEmail).
		Where(useridentity.UserIDIn(ids...), useridentity.ProviderEQ(providerEmail)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	for _, identity := range identities {
		if identity.Email == nil {
			continue
		}
		summary, ok := summaries[identity.UserID]
		if !ok || summary.Email != "" {
			continue
		}
		address, err := s.identity.OpenEmail(*identity.Email)
		if err != nil {
			return nil, err
		}
		summary.Email = address
		summaries[identity.UserID] = summary
	}

	enrolled, err := s.client.TwoFactor.Query().
		Select(twofactor.FieldUserID).
		Where(twofactor.UserIDIn(ids...), twofactor.EnabledEQ(true)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	for _, row := range enrolled {
		summary, ok := summaries[row.UserID]
		if !ok {
			continue
		}
		summary.TwoFactorEnabled = true
		summaries[row.UserID] = summary
	}

	memberships, err := s.client.SiteMember.Query().
		Where(sitemember.UserIDIn(ids...)).
		Order(entgen.Asc(sitemember.FieldCreatedAt)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	siteIDs := make([]string, 0, len(memberships))
	for _, membership := range memberships {
		siteIDs = append(siteIDs, membership.SiteID)
	}
	labels, err := s.siteLabels(ctx, unique(siteIDs))
	if err != nil {
		return nil, err
	}
	for _, membership := range memberships {
		summary, ok := summaries[membership.UserID]
		if !ok {
			continue
		}
		label := labels[membership.SiteID]
		summary.Memberships = append(summary.Memberships, platformadmin.AccountMembership{
			SiteID:   membership.SiteID,
			SiteName: label.name,
			SiteSlug: label.slug,
			Role:     site.Role(membership.Role),
			Status:   membership.Status,
		})
		summaries[membership.UserID] = summary
	}
	for id, summary := range summaries {
		sort.Slice(summary.Memberships, func(left, right int) bool {
			return summary.Memberships[left].SiteName < summary.Memberships[right].SiteName
		})
		summaries[id] = summary
	}
	return summaries, nil
}

type siteLabel struct {
	name string
	slug string
}

// siteLabels resolves the site names the directory shows.
func (s *Store) siteLabels(ctx context.Context, ids []string) (map[string]siteLabel, error) {
	labels := make(map[string]siteLabel, len(ids))
	if len(ids) == 0 {
		return labels, nil
	}
	rows, err := s.client.Site.Query().
		Select(entsite.FieldID, entsite.FieldSlug, entsite.FieldName).
		Where(entsite.IDIn(ids...)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		labels[row.ID] = siteLabel{name: row.Name, slug: row.Slug}
	}
	return labels, nil
}

// ordered returns the summaries in the order their ids were collected, dropping the
// ones that vanished between the page query and the detail query.
func ordered(
	ids []string,
	byID map[string]platformadmin.AccountSummary,
) []platformadmin.AccountSummary {
	items := make([]platformadmin.AccountSummary, 0, len(ids))
	for _, id := range ids {
		summary, ok := byID[id]
		if !ok {
			continue
		}
		if summary.Memberships == nil {
			summary.Memberships = []platformadmin.AccountMembership{}
		}
		items = append(items, summary)
	}
	return items
}

func unique(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
