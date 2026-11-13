package platformadmin

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/audit"
	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

// The cross-site read endpoints of the console: the deployment overview, the account
// directory and the audit trail of every site at once.
//
// They sit inside the authenticated /platform group, so the transport only has to add
// their routes; authorization itself is the service's platformMember check, which is
// the same seat that guards site creation.

// mountCrossSite registers the deployment wide reads on the console group.
func (h *Handler) mountCrossSite(group *gin.RouterGroup) {
	group.GET("/overview", h.Overview)
	group.GET("/audit-logs", h.ListAuditLogs)
	group.GET("/users", h.ListAccounts)
}

type overviewTotalsResponse struct {
	Sites            int `json:"sites"`
	DisabledSites    int `json:"disabled_sites"`
	UnverifiedSites  int `json:"unverified_sites"`
	Members          int `json:"members"`
	ActiveMembers    int `json:"active_members"`
	Admins           int `json:"admins"`
	Content          int `json:"content"`
	PublishedContent int `json:"published_content"`
	PendingContent   int `json:"pending_content"`
	Comments         int `json:"comments"`
	PendingComments  int `json:"pending_comments"`
	Accounts         int `json:"accounts"`
	VerifiedAccounts int `json:"verified_accounts"`
	TwoFactorChosen  int `json:"two_factor_accounts"`
}

type overviewSignalsResponse struct {
	OpenReports      int `json:"open_reports"`
	PendingComments  int `json:"pending_comments"`
	FailedActions    int `json:"failed_actions"`
	DisabledSites    int `json:"disabled_sites"`
	UnverifiedSites  int `json:"unverified_sites"`
	UnverifiedEmails int `json:"unverified_emails"`
	QuietSites       int `json:"quiet_sites"`
}

// overviewSiteResponse is one row of the cross-site table.
//
// It is a superset of PlatformSite with the counters an operator scans for. The member
// counts keep their PlatformSite meaning (memberships, suspended included) so the two
// screens never disagree about the same site.
type overviewSiteResponse struct {
	ID                 string    `json:"id"`
	Slug               string    `json:"slug"`
	Name               string    `json:"name"`
	Domain             string    `json:"domain"`
	DomainVerified     bool      `json:"domain_verified"`
	VisibilityMode     string    `json:"visibility_mode"`
	PublishMode        string    `json:"publish_mode"`
	Disabled           bool      `json:"disabled"`
	MemberCount        int       `json:"member_count"`
	ActiveMemberCount  int       `json:"active_member_count"`
	AdminCount         int       `json:"admin_count"`
	ContentCount       int       `json:"content_count"`
	PublishedCount     int       `json:"published_content_count"`
	PendingContent     int       `json:"pending_content_count"`
	DraftCount         int       `json:"draft_count"`
	CommentCount       int       `json:"comment_count"`
	PendingComment     int       `json:"pending_comment_count"`
	OpenReportCount    int       `json:"open_report_count"`
	RecentActivity     int       `json:"recent_activity_count"`
	RecentFailureCount int       `json:"recent_failure_count"`
	CreatedAt          time.Time `json:"created_at"`
}

type auditRowResponse struct {
	ID         string         `json:"id"`
	SiteID     string         `json:"site_id,omitempty"`
	SiteName   string         `json:"site_name,omitempty"`
	ActorID    string         `json:"actor_id,omitempty"`
	ActorName  string         `json:"actor_name,omitempty"`
	Action     string         `json:"action"`
	TargetType string         `json:"target_type,omitempty"`
	TargetID   string         `json:"target_id,omitempty"`
	TargetName string         `json:"target_name,omitempty"`
	RequestID  string         `json:"request_id,omitempty"`
	Outcome    string         `json:"outcome"`
	Detail     map[string]any `json:"detail,omitempty"`
	CreatedAt  time.Time      `json:"created_at"`
}

func toAuditRowResponse(entry audit.Log) auditRowResponse {
	return auditRowResponse{
		ID:         entry.ID,
		SiteID:     entry.SiteID,
		ActorID:    entry.ActorID,
		ActorName:  entry.ActorName,
		Action:     entry.Action,
		TargetType: entry.TargetType,
		TargetID:   entry.TargetID,
		TargetName: entry.TargetName,
		RequestID:  entry.RequestID,
		Outcome:    entry.Outcome,
		Detail:     entry.Detail,
		CreatedAt:  entry.CreatedAt.UTC(),
	}
}

type overviewResponse struct {
	GeneratedAt    time.Time               `json:"generated_at"`
	WindowDays     int                     `json:"window_days"`
	WindowStart    time.Time               `json:"window_start"`
	Totals         overviewTotalsResponse  `json:"totals"`
	Signals        overviewSignalsResponse `json:"signals"`
	Sites          []overviewSiteResponse  `json:"sites"`
	RecentActivity []auditRowResponse      `json:"recent_activity"`
}

type auditListResponse struct {
	Items      []auditRowResponse `json:"items"`
	NextCursor string             `json:"next_cursor,omitempty"`
}

type accountMembershipResponse struct {
	SiteID   string `json:"site_id"`
	SiteName string `json:"site_name"`
	SiteSlug string `json:"site_slug"`
	Role     string `json:"role"`
	Status   string `json:"status"`
}

// accountResponse is one account of the directory.
//
// There is deliberately no password hash, secret, token or session field here: the
// directory is a read model, and two factor collapses to a boolean so an operator can
// see who is protected without ever receiving the material that protects them.
type accountResponse struct {
	UserID           string                      `json:"user_id"`
	DisplayName      string                      `json:"display_name"`
	Email            string                      `json:"email"`
	EmailVerified    bool                        `json:"email_verified"`
	TwoFactorEnabled bool                        `json:"two_factor_enabled"`
	Status           string                      `json:"status"`
	CreatedAt        time.Time                   `json:"created_at"`
	Memberships      []accountMembershipResponse `json:"memberships"`
}

type accountListResponse struct {
	Items      []accountResponse `json:"items"`
	NextCursor string            `json:"next_cursor,omitempty"`
}

// Overview returns the deployment wide snapshot to a platform administrator.
func (h *Handler) Overview(c *gin.Context) {
	userID, siteID, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	windowDays := 0
	if raw := c.Query("window_days"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			_ = c.Error(apperr.Validation("window_days must be a positive integer").
				WithDetail("field", "window_days"))
			return
		}
		windowDays = parsed
	}

	overview, err := h.service.Overview(c.Request.Context(), siteID, userID, windowDays)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	response := overviewResponse{
		GeneratedAt: overview.GeneratedAt.UTC(),
		WindowDays:  overview.WindowDays,
		WindowStart: overview.WindowStart.UTC(),
		Totals: overviewTotalsResponse{
			Sites:            overview.Totals.Sites,
			DisabledSites:    overview.Totals.DisabledSites,
			UnverifiedSites:  overview.Totals.UnverifiedSites,
			Members:          overview.Totals.Members,
			ActiveMembers:    overview.Totals.ActiveMembers,
			Admins:           overview.Totals.Admins,
			Content:          overview.Totals.Content,
			PublishedContent: overview.Totals.PublishedContent,
			PendingContent:   overview.Totals.PendingContent,
			Comments:         overview.Totals.Comments,
			PendingComments:  overview.Totals.PendingComments,
			Accounts:         overview.Totals.Accounts,
			VerifiedAccounts: overview.Totals.VerifiedAccounts,
			TwoFactorChosen:  overview.Totals.TwoFactorChosen,
		},
		Signals: overviewSignalsResponse{
			OpenReports:      overview.Signals.OpenReports,
			PendingComments:  overview.Signals.PendingComments,
			FailedActions:    overview.Signals.FailedActions,
			DisabledSites:    overview.Signals.DisabledSites,
			UnverifiedSites:  overview.Signals.UnverifiedSites,
			UnverifiedEmails: overview.Signals.UnverifiedEmails,
			QuietSites:       overview.Signals.QuietSites,
		},
		Sites:          make([]overviewSiteResponse, 0, len(overview.Sites)),
		RecentActivity: make([]auditRowResponse, 0, len(overview.Recent)),
	}

	for _, item := range overview.Sites {
		response.Sites = append(response.Sites, overviewSiteResponse{
			ID:                 item.Site.ID,
			Slug:               item.Site.Slug,
			Name:               item.Site.Name,
			Domain:             item.Site.Domain,
			DomainVerified:     item.Site.DomainVerified(),
			VisibilityMode:     string(item.Site.VisibilityMode),
			PublishMode:        string(item.Site.PublishMode),
			Disabled:           item.Site.Disabled,
			MemberCount:        item.Members,
			ActiveMemberCount:  item.ActiveMembers,
			AdminCount:         item.Admins,
			ContentCount:       item.Content.Total,
			PublishedCount:     item.Content.Published,
			PendingContent:     item.Content.Pending,
			DraftCount:         item.Content.Draft,
			CommentCount:       item.Comments.Total,
			PendingComment:     item.Comments.Pending,
			OpenReportCount:    item.OpenReports,
			RecentActivity:     item.RecentActivity,
			RecentFailureCount: item.RecentFailures,
			CreatedAt:          item.Site.CreatedAt.UTC(),
		})
	}

	for _, row := range overview.Recent {
		mapped := toAuditRowResponse(row.Log)
		mapped.SiteName = row.SiteName
		response.RecentActivity = append(response.RecentActivity, mapped)
	}

	c.JSON(http.StatusOK, response)
}

// ListAuditLogs returns one page of the audit trail across sites.
func (h *Handler) ListAuditLogs(c *gin.Context) {
	userID, siteID, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	query := AuditQuery{
		SiteID:     c.Query("site_id"),
		ActorID:    c.Query("actor_id"),
		Action:     c.Query("action"),
		TargetType: c.Query("target_type"),
		TargetID:   c.Query("target_id"),
		Outcome:    c.Query("outcome"),
	}

	from, problem := parseTimeQuery(c, "from")
	if problem != nil {
		_ = c.Error(problem)
		return
	}
	to, problem := parseTimeQuery(c, "to")
	if problem != nil {
		_ = c.Error(problem)
		return
	}
	query.From = from
	query.To = to

	limit, problem := parseLimitQuery(c)
	if problem != nil {
		_ = c.Error(problem)
		return
	}
	after, err := page.Decode(c.Query("cursor"))
	if err != nil {
		_ = c.Error(apperr.New(apperr.CodeInvalidCursor))
		return
	}

	result, err := h.service.ListAuditLogs(
		c.Request.Context(),
		siteID,
		userID,
		middleware.RequestIDFrom(c),
		query,
		limit,
		after,
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	items := make([]auditRowResponse, 0, len(result.Items))
	for _, entry := range result.Items {
		items = append(items, toAuditRowResponse(entry))
	}
	c.JSON(http.StatusOK, auditListResponse{Items: items, NextCursor: result.NextCursor})
}

// ListAccounts returns one page of the account directory.
func (h *Handler) ListAccounts(c *gin.Context) {
	userID, siteID, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}

	limit, problem := parseLimitQuery(c)
	if problem != nil {
		_ = c.Error(problem)
		return
	}
	after, err := page.Decode(c.Query("cursor"))
	if err != nil {
		_ = c.Error(apperr.New(apperr.CodeInvalidCursor))
		return
	}

	result, err := h.service.ListAccounts(
		c.Request.Context(),
		siteID,
		userID,
		AccountQuery{SiteID: c.Query("site_id"), Search: c.Query("q")},
		limit,
		after,
	)
	if err != nil {
		_ = c.Error(mapError(err))
		return
	}

	items := make([]accountResponse, 0, len(result.Items))
	for _, account := range result.Items {
		mapped := accountResponse{
			UserID:           account.UserID,
			DisplayName:      account.DisplayName,
			Email:            account.Email,
			EmailVerified:    account.EmailVerified,
			TwoFactorEnabled: account.TwoFactorEnabled,
			Status:           account.Status,
			CreatedAt:        account.CreatedAt.UTC(),
			Memberships:      make([]accountMembershipResponse, 0, len(account.Memberships)),
		}
		for _, membership := range account.Memberships {
			mapped.Memberships = append(mapped.Memberships, accountMembershipResponse{
				SiteID:   membership.SiteID,
				SiteName: membership.SiteName,
				SiteSlug: membership.SiteSlug,
				Role:     string(membership.Role),
				Status:   membership.Status,
			})
		}
		items = append(items, mapped)
	}
	c.JSON(http.StatusOK, accountListResponse{Items: items, NextCursor: result.NextCursor})
}

// parseTimeQuery reads one RFC 3339 query timestamp.
func parseTimeQuery(c *gin.Context, name string) (*time.Time, *apperr.Problem) {
	raw := c.Query(name)
	if raw == "" {
		return nil, nil
	}
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return nil, apperr.Validation(name + " must be an RFC 3339 timestamp").
			WithDetail("field", name)
	}
	return &parsed, nil
}

// parseLimitQuery reads the page size, bounded like every other paged endpoint.
func parseLimitQuery(c *gin.Context) (int, *apperr.Problem) {
	raw := c.Query("limit")
	if raw == "" {
		return 0, nil
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 || parsed > MaxAccountPageLimit {
		return 0, apperr.Validation("limit must be between 1 and 100").
			WithDetail("field", "limit")
	}
	return parsed, nil
}
