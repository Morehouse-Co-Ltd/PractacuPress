package content

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

func article(status Status, authorID string) Content {
	return Content{
		ID:       "c1",
		SiteID:   "s1",
		AuthorID: authorID,
		Kind:     KindArticle,
		Status:   status,
	}
}

func actor(userID string, role site.Role) Actor {
	return Actor{UserID: userID, SiteID: "s1", Role: role}
}

func TestOpenModeMemberPublishesDraftDirectly(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeOpen}
	item := article(StatusDraft, "author")
	member := actor("author", site.RoleMember)

	next, err := policy.Next(item, ActionPublish, member)
	require.NoError(t, err)
	require.Equal(t, StatusPublished, next)
}

func TestReviewModeMemberMustSubmitFirst(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeReview}
	item := article(StatusDraft, "author")
	member := actor("author", site.RoleMember)

	_, err := policy.Next(item, ActionPublish, member)
	require.ErrorIs(t, err, ErrReviewRequired)

	next, err := policy.Next(item, ActionSubmit, member)
	require.NoError(t, err)
	require.Equal(t, StatusPendingReview, next)
}

func TestReviewModeEditorPublishesDirectly(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeReview}
	item := article(StatusDraft, "editor")
	editor := actor("editor", site.RoleEditor)

	next, err := policy.Next(item, ActionPublish, editor)
	require.NoError(t, err)
	require.Equal(t, StatusPublished, next)
}

func TestRoleBasedModeBehavesLikeReviewForMembers(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeRoleBased}
	item := article(StatusDraft, "author")

	_, err := policy.Next(item, ActionPublish, actor("author", site.RoleMember))
	require.ErrorIs(t, err, ErrReviewRequired)

	next, err := policy.Next(item, ActionPublish, actor("editor", site.RoleEditor))
	require.NoError(t, err)
	require.Equal(t, StatusPublished, next)
}

func TestApprovingPendingReviewRequiresEditor(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeReview}
	item := article(StatusPendingReview, "author")

	_, err := policy.Next(item, ActionPublish, actor("author", site.RoleMember))
	require.ErrorIs(t, err, ErrPermissionDenied, "an author must not approve their own content")

	next, err := policy.Next(item, ActionPublish, actor("mod", site.RoleEditor))
	require.NoError(t, err)
	require.Equal(t, StatusPublished, next)
}

func TestRejectAndRestoreRequireEditor(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeReview}

	_, err := policy.Next(article(StatusPendingReview, "author"), ActionReject, actor("author", site.RoleMember))
	require.ErrorIs(t, err, ErrPermissionDenied)

	next, err := policy.Next(article(StatusPendingReview, "author"), ActionReject, actor("mod", site.RoleEditor))
	require.NoError(t, err)
	require.Equal(t, StatusRejected, next)

	_, err = policy.Next(article(StatusArchived, "author"), ActionRestore, actor("author", site.RoleMember))
	require.ErrorIs(t, err, ErrPermissionDenied)

	restored, err := policy.Next(article(StatusArchived, "author"), ActionRestore, actor("mod", site.RoleEditor))
	require.NoError(t, err)
	require.Equal(t, StatusDraft, restored)
}

func TestAuthorArchivesOwnPublishedContent(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeReview}

	next, err := policy.Next(article(StatusPublished, "author"), ActionArchive, actor("author", site.RoleMember))
	require.NoError(t, err)
	require.Equal(t, StatusArchived, next)

	_, err = policy.Next(article(StatusPublished, "other"), ActionArchive, actor("author", site.RoleMember))
	require.ErrorIs(t, err, ErrPermissionDenied)
}

func TestRejectedItemResubmitsForReview(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeReview}

	next, err := policy.Next(article(StatusRejected, "author"), ActionSubmit, actor("author", site.RoleMember))
	require.NoError(t, err)
	require.Equal(t, StatusPendingReview, next)
}

func TestSecurityHoldCanResubmit(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeReview}

	next, err := policy.Next(article(StatusPendingSecurityCheck, "author"), ActionSubmit, actor("author", site.RoleMember))
	require.NoError(t, err)
	require.Equal(t, StatusPendingReview, next)
}

func TestInvalidTransitionsAreRejected(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeOpen}

	cases := []struct {
		item   Content
		action Action
	}{
		{article(StatusDraft, "a"), ActionReject},
		{article(StatusDraft, "a"), ActionArchive},
		{article(StatusDraft, "a"), ActionRestore},
		{article(StatusPublished, "a"), ActionSubmit},
		{article(StatusPublished, "a"), ActionPublish},
		{article(StatusArchived, "a"), ActionPublish},
		{article(StatusPendingReview, "a"), ActionArchive},
	}
	for _, tc := range cases {
		_, err := policy.Next(tc.item, tc.action, actor("a", site.RolePlatformAdmin))
		require.ErrorIs(t, err, ErrInvalidTransition, "%s from %s", tc.action, tc.item.Status)
	}
}

// TestCrossSiteIsRejectedBeforeAnythingElse proves site isolation is checked before
// permission, so a platform admin of one site cannot act on another site's content.
func TestCrossSiteIsRejectedBeforeAnythingElse(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeOpen}
	item := article(StatusDraft, "author")
	other := Actor{UserID: "author", SiteID: "s2", Role: site.RolePlatformAdmin}

	_, err := policy.Next(item, ActionPublish, other)
	require.ErrorIs(t, err, ErrCrossSite)
}

func TestPlatformAdminOutranksSiteRules(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeReview}
	item := article(StatusPendingReview, "author")

	next, err := policy.Next(item, ActionPublish, actor("root", site.RolePlatformAdmin))
	require.NoError(t, err)
	require.Equal(t, StatusPublished, next)
}

func TestAvailableActionsMatchesNext(t *testing.T) {
	policy := Policy{PublishMode: site.PublishModeReview}

	draftByMember := policy.AvailableActions(article(StatusDraft, "author"), actor("author", site.RoleMember))
	require.Equal(t, []Action{ActionSubmit}, draftByMember)

	draftByEditor := policy.AvailableActions(article(StatusDraft, "editor"), actor("editor", site.RoleEditor))
	require.ElementsMatch(t, []Action{ActionSubmit, ActionPublish}, draftByEditor)

	reviewByEditor := policy.AvailableActions(article(StatusPendingReview, "author"), actor("mod", site.RoleEditor))
	require.ElementsMatch(t, []Action{ActionPublish, ActionReject}, reviewByEditor)

	publishedByAuthor := policy.AvailableActions(article(StatusPublished, "author"), actor("author", site.RoleMember))
	// Beta 1.2 contract I: withdrawing a live item is an author action, so unpublish
	// is offered next to archive.
	require.ElementsMatch(t, []Action{ActionUnpublish, ActionArchive}, publishedByAuthor)
}

func TestValidateDraft(t *testing.T) {
	valid := DraftInput{
		Title:        "  Hello World  ",
		Slug:         "Hello-World",
		SourceFormat: FormatMarkdown,
		SourceBody:   "# body",
	}

	got, err := ValidateDraft(valid)
	require.NoError(t, err)
	require.Equal(t, "Hello World", got.Title)
	require.Equal(t, "hello-world", got.Slug)

	_, err = ValidateDraft(DraftInput{SourceBody: "x"})
	require.Error(t, err, "title is required")

	_, err = ValidateDraft(DraftInput{Title: "x", SourceBody: "x", SourceFormat: "excel"})
	require.Error(t, err, "unknown format")

	_, err = ValidateDraft(DraftInput{Title: "x", SourceFormat: FormatMarkdown})
	require.Error(t, err, "body is required")

	_, err = ValidateDraft(DraftInput{Title: "x", Slug: "Bad Slug!", SourceBody: "x"})
	require.Error(t, err, "slug must be url safe")

	longTitle := make([]rune, MaxTitleLength+1)
	for i := range longTitle {
		longTitle[i] = 'a'
	}
	_, err = ValidateDraft(DraftInput{Title: string(longTitle), SourceBody: "x"})
	require.Error(t, err, "title length is bounded")
}

func TestSlugFromTitle(t *testing.T) {
	require.Equal(t, "hello-world", SlugFromTitle("Hello, World!"))
	require.Equal(t, "a-b-c", SlugFromTitle("  A   B   C  "))
	require.Equal(t, "", SlugFromTitle("中文标题"), "non ASCII titles do not invent a slug")
	require.Equal(t, "go-1-26", SlugFromTitle("Go 1.26"))
}

func TestStatusHelpers(t *testing.T) {
	require.True(t, StatusPublished.IsPublic())
	require.False(t, StatusDraft.IsPublic())
	require.True(t, StatusPendingSecurityCheck.Valid())
	require.False(t, Status("deleted").Valid())
	require.True(t, KindArticle.Valid())
	require.False(t, Kind("comment").Valid())
}
