package contentstore_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/ent/auditlog"
	"github.com/practacu/practacu-press/internal/community"
	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/feed"
	"github.com/practacu/practacu-press/internal/infrastructure/communitystore"
	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/sitefiles"
)

// createPublished stores a draft and publishes it as its author. The harness is
// built with PublishModeOpen for these tests, so a member may publish directly.
func (h *harness) createPublished(t *testing.T, in content.DraftInput) content.Content {
	t.Helper()
	ctx := context.Background()

	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, in)
	require.NoError(t, err)
	item, err = h.service.Apply(ctx, h.author(), item.ID, content.ActionPublish, "")
	require.NoError(t, err)
	require.Equal(t, content.StatusPublished, item.Status)
	return item
}

// TestScheduledPublicationPublishesDueDraft is the SQLite smoke test for C-17: a
// future draft is stored, a pass before the instant does nothing, and the pass after
// it publishes once with an audit entry.
func TestScheduledPublicationPublishesDueDraft(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	due := h.now.Add(30 * time.Minute).Add(42 * time.Second)
	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, content.DraftInput{
		Title:        "Scheduled",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# Scheduled",
		PublishAt:    &due,
	})
	require.NoError(t, err)
	require.NotNil(t, item.PublishAt)
	require.Equal(t, due.UTC().Truncate(time.Minute), *item.PublishAt,
		"the schedule is stored with minute precision")

	// The clock has not reached the instant yet.
	result, err := h.service.ProcessScheduledPublishing(ctx)
	require.NoError(t, err)
	require.Zero(t, result.Due)
	require.Zero(t, result.Published)

	// Move past the instant and run one pass.
	h.now = due.Add(time.Minute)
	result, err = h.service.ProcessScheduledPublishing(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, result.Due)
	require.Equal(t, 1, result.Published)

	stored, err := h.service.Get(ctx, h.author(), item.ID)
	require.NoError(t, err)
	require.Equal(t, content.StatusPublished, stored.Status)
	require.Nil(t, stored.PublishAt, "publishing consumes the schedule")
	require.NotNil(t, stored.PublishedAt)

	audits, err := h.db.Client.AuditLog.Query().
		Where(auditlog.ActionEQ("content.scheduled_publish")).
		Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, audits, "the scheduled publication is audited")

	// A second pass finds nothing: the conditional transition already consumed it.
	result, err = h.service.ProcessScheduledPublishing(ctx)
	require.NoError(t, err)
	require.Zero(t, result.Due)
}

// TestPasswordContentUnlockAndExclusion is the SQLite smoke test for C-18: a wrong
// password fails and then locks, the right password grants a session token, and the
// item never appears on a public listing, search, feed or sitemap surface.
func TestPasswordContentUnlockAndExclusion(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	item := h.createPublished(t, content.DraftInput{
		Title:          "Secret",
		Summary:        "hidden summary",
		SourceFormat:   content.FormatMarkdown,
		SourceBody:     "# Secret",
		AccessMode:     content.AccessPassword,
		AccessPassword: "s3cret",
	})

	anonymous := content.Actor{SiteID: h.siteID}

	// A direct read without a grant reports the lock, not the content.
	_, err := h.service.Read(ctx, anonymous, item.ID, false)
	require.ErrorIs(t, err, content.ErrPasswordRequired)

	// Wrong passwords fail and then lock the content/IP pair.
	const ip = "203.0.113.7"
	for attempt := 1; attempt <= 4; attempt++ {
		_, err = h.service.Unlock(ctx, anonymous, item.ID, "wrong", ip)
		require.ErrorIs(t, err, content.ErrInvalidPassword, "attempt %d", attempt)
	}
	_, err = h.service.Unlock(ctx, anonymous, item.ID, "wrong", ip)
	require.ErrorIs(t, err, content.ErrUnlockLocked, "the fifth failure locks the key")

	// Even the right password is refused while the lock is active.
	_, err = h.service.Unlock(ctx, anonymous, item.ID, "s3cret", ip)
	require.ErrorIs(t, err, content.ErrUnlockLocked)

	// After the lock window a correct password issues a grant.
	h.now = h.now.Add(16 * time.Minute)
	grant, err := h.service.Unlock(ctx, anonymous, item.ID, "s3cret", ip)
	require.NoError(t, err)
	require.True(t, h.service.VerifyUnlock(ctx, grant.Token, h.siteID, item.ID))
	require.False(t, h.service.VerifyUnlock(ctx, grant.Token, h.siteID, "another-item"))

	unlocked, err := h.service.Read(ctx, anonymous, item.ID, true)
	require.NoError(t, err)
	require.Equal(t, "hidden summary", unlocked.Summary)

	// The public surfaces exclude the item and its summary.
	items, _, err := h.service.ListAfterFilter(
		ctx, anonymous, "", 20, page.Cursor{}, content.ListFilter{},
	)
	require.NoError(t, err)
	require.Empty(t, items, "a password item is not in a public listing")

	// Search runs the real index (SQLite FTS5) over the real store, so an empty
	// result here proves the visibility gate, not a stubbed repository.
	found, err := h.service.Search(ctx, anonymous, content.SearchQuery{
		Term:      "hidden",
		Kind:      content.KindArticle,
		Limit:     20,
		Highlight: true,
	})
	require.NoError(t, err)
	require.Empty(t, found.Hits, "a password item is not searchable")
	require.Zero(t, found.Total, "the password item is not counted either")
	require.Empty(t, found.NextCursor)

	channel, err := feed.Build(ctx, feed.Source{Content: h.service}, feed.Request{
		SiteID:   h.siteID,
		SiteName: "Main",
		Origin:   "https://example.test",
		FeedURL:  "https://example.test/rss.xml",
		Settings: feed.Defaults(),
	})
	require.NoError(t, err)
	require.Empty(t, channel.Items, "a password item is not in a feed")

	sitemapItems, err := sitefiles.Published(ctx, h.service, h.siteID)
	require.NoError(t, err)
	require.Empty(t, sitemapItems, "a password item is not in the sitemap")

	// The author can still read it, which is what the editor preview relies on.
	_, err = h.service.Read(ctx, h.author(), item.ID, false)
	require.NoError(t, err)

	// Positive control: the same term does match a public item in this site, so the
	// empty page above is the access rule and not a blind index.
	public := h.createPublished(t, content.DraftInput{
		Title:        "Hidden history of typesetting",
		Summary:      "a public summary",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "the hidden part is public here",
	})
	visible, err := h.service.Search(ctx, anonymous, content.SearchQuery{
		Term: "hidden", Limit: 20, Highlight: true,
	})
	require.NoError(t, err)
	require.Equal(t, 1, visible.Total, "only the public item is searchable")
	require.Len(t, visible.Hits, 1)
	require.Equal(t, public.ID, visible.Hits[0].Content.ID)
	require.NotEmpty(t, visible.Hits[0].Snippet, "a matching body yields a plain text snippet")
}

// TestMembersOnlyContentIsDirectLinkOnly covers the second private mode: anonymous
// readers are refused, signed-in readers may read, and public surfaces exclude it.
func TestMembersOnlyContentIsDirectLinkOnly(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	item := h.createPublished(t, content.DraftInput{
		Title:        "Members",
		Summary:      "members summary",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# Members",
		AccessMode:   content.AccessMembers,
	})

	anonymous := content.Actor{SiteID: h.siteID}
	_, err := h.service.Read(ctx, anonymous, item.ID, false)
	require.ErrorIs(t, err, content.ErrMembersOnly)

	member := content.Actor{UserID: "reader_1", SiteID: h.siteID, Role: site.RoleMember}
	got, err := h.service.Read(ctx, member, item.ID, false)
	require.NoError(t, err)
	require.Equal(t, "Members", got.Title)

	items, _, err := h.service.ListAfterFilter(
		ctx, member, "", 20, page.Cursor{}, content.ListFilter{},
	)
	require.NoError(t, err)
	require.Empty(t, items, "a members-only item is direct-link only")
}

// siteCommentPolicy is a fixed site switch stand-in.
type siteCommentPolicy struct {
	enabled bool
	review  bool
}

func (p siteCommentPolicy) CommentPolicy(context.Context, string) (bool, bool, error) {
	return p.enabled, p.review, nil
}

// TestContentCommentPolicyOverridesSiteSwitches is the SQLite smoke test for C-19:
// a disabled item refuses the API write, a review item stores pending_review and an
// open item comments even when the site closed comments.
func TestContentCommentPolicyOverridesSiteSwitches(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	communityStore := communitystore.New(h.db.Client)
	service, err := community.NewService(
		communityStore,
		nil,
		community.WithTargetChecker(communityStore),
		community.WithCommentPolicy(siteCommentPolicy{enabled: false, review: false}),
	)
	require.NoError(t, err)

	actor := community.Actor{UserID: "reader_1", SiteID: h.siteID, Role: site.RoleMember}
	add := func(contentID, body string) (community.Comment, error) {
		return service.AddComment(ctx, actor, community.NewCommentInput{
			TargetType: community.TargetArticle,
			TargetID:   contentID,
			Body:       body,
		})
	}

	// Closed per item: refused even though the caller is a valid member.
	closed := h.createPublished(t, content.DraftInput{
		Title:         "Closed comments",
		SourceFormat:  content.FormatMarkdown,
		SourceBody:    "# Closed",
		CommentPolicy: content.CommentPolicyDisabled,
	})
	_, err = add(closed.ID, "should fail")
	require.ErrorIs(t, err, community.ErrCommentsClosed)

	// Review per item: accepted but pending.
	reviewed := h.createPublished(t, content.DraftInput{
		Title:         "Reviewed comments",
		SourceFormat:  content.FormatMarkdown,
		SourceBody:    "# Reviewed",
		CommentPolicy: content.CommentPolicyReview,
	})
	pending, err := add(reviewed.ID, "needs review")
	require.NoError(t, err)
	require.Equal(t, community.CommentStatusPending, pending.Status)

	// Open per item: wins over the site-wide closed switch.
	open := h.createPublished(t, content.DraftInput{
		Title:         "Open comments",
		SourceFormat:  content.FormatMarkdown,
		SourceBody:    "# Open",
		CommentPolicy: content.CommentPolicyOpen,
	})
	visible, err := add(open.ID, "hello")
	require.NoError(t, err)
	require.Equal(t, community.CommentStatusVisible, visible.Status)
}

// TestScheduledPublishRetryIsCancelled keeps the retry bound honest: an item that
// fails sanitization is retried and then has its schedule dropped.
func TestScheduledPublishRetryIsCancelled(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	due := h.now.Add(10 * time.Minute)
	item, err := h.service.CreateDraft(ctx, h.author(), content.KindArticle, content.DraftInput{
		Title:        "Unsanitized",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# Unsanitized",
		PublishAt:    &due,
	})
	require.NoError(t, err)

	// Force the stored row into a draft with no sanitized revision, which is the
	// state a security service outage leaves behind.
	_, err = h.db.Client.ContentItem.UpdateOneID(item.ID).
		SetRenderedHTML("").
		SetPolicyVersion("").
		Save(ctx)
	require.NoError(t, err)

	h.now = due.Add(time.Minute)
	for pass := 0; pass < content.MaxScheduledPublishAttempts; pass++ {
		_, err = h.service.ProcessScheduledPublishing(ctx)
		require.NoError(t, err)
	}

	stored, err := h.service.Get(ctx, h.author(), item.ID)
	require.NoError(t, err)
	require.Equal(t, content.StatusDraft, stored.Status)
	require.Nil(t, stored.PublishAt, "the retry bound cancels the schedule")
	require.Equal(t, content.MaxScheduledPublishAttempts, stored.PublishAttempts)

	// The failure is audited, including the cancellation.
	failures, err := h.db.Client.AuditLog.Query().
		Where(auditlog.ActionEQ("content.scheduled_publish_failed")).
		Count(ctx)
	require.NoError(t, err)
	require.Equal(t, content.MaxScheduledPublishAttempts, failures)
}

// TestUnlockRequiresPasswordMode keeps a non-password item from being unlocked.
func TestUnlockRequiresPasswordMode(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)
	ctx := context.Background()

	item := h.createPublished(t, content.DraftInput{
		Title:        "Public",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "# Public",
	})
	_, err := h.service.Unlock(
		ctx, content.Actor{SiteID: h.siteID}, item.ID, "anything", "203.0.113.9",
	)
	require.True(t, errors.Is(err, content.ErrPasswordNotSet))
}

// TestCommentAPIRejectsDisabledItemPolicy is the HTTP level C-19 check: the community
// endpoint answers 403 with the machine readable reason, so a direct API call cannot
// bypass the per item closed switch.
func TestCommentAPIRejectsDisabledItemPolicy(t *testing.T) {
	h := newHarness(t, site.PublishModeOpen)

	closed := h.createPublished(t, content.DraftInput{
		Title:         "Closed comments",
		SourceFormat:  content.FormatMarkdown,
		SourceBody:    "# Closed",
		CommentPolicy: content.CommentPolicyDisabled,
	})

	communityStore := communitystore.New(h.db.Client)
	service, err := community.NewService(
		communityStore,
		nil,
		community.WithTargetChecker(communityStore),
		community.WithCommentPolicy(siteCommentPolicy{enabled: true, review: false}),
	)
	require.NoError(t, err)

	actor := community.Actor{UserID: "reader_1", SiteID: h.siteID, Role: site.RoleMember}
	handler := community.NewHandler(service, community.HandlerConfig{
		Principal: func(*gin.Context) (community.Actor, bool) { return actor, true },
		Site:      func(*gin.Context) (site.Site, bool) { return site.Site{ID: h.siteID}, true },
	})

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			problem := apperr.FromError(c.Errors.Last().Err)
			c.Header("Content-Type", apperr.ContentType)
			c.JSON(problem.Status, problem)
		}
	})
	passthrough := func(c *gin.Context) { c.Next() }
	handler.Routes(r, passthrough, passthrough)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/comments", strings.NewReader(
		`{"target_type":"article","target_id":"`+closed.ID+`","body":"hello"}`,
	))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	var problem struct {
		Code    string         `json:"code"`
		Details map[string]any `json:"details"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &problem))
	require.Equal(t, "permission_denied", problem.Code)
	require.Equal(t, "comments_closed", problem.Details["reason"])
}
