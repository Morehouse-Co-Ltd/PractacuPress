package content

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/safety"
	"github.com/practacu/practacu-press/internal/site"
)

// fakeContentGuard is the smallest ContentGuard: it reacts to the literal "bad".
type fakeContentGuard struct {
	mode safety.WordMode
}

func (g fakeContentGuard) CheckText(
	_ context.Context,
	_ string,
	text string,
) (safety.TextVerdict, error) {
	if !strings.Contains(strings.ToLower(text), "bad") {
		return safety.TextVerdict{Text: text}, nil
	}
	verdict := safety.TextVerdict{
		Text:    strings.ReplaceAll(text, "bad", "***"),
		Matched: []string{"bad"},
		Mode:    g.mode,
	}
	if g.mode == safety.ModeReject {
		return verdict, &safety.RejectedError{Matched: verdict.Matched}
	}
	return verdict, nil
}

func serviceWithGuard(t *testing.T, guard ContentGuard) (*Service, *fakeRepo) {
	t.Helper()
	repo := newFakeRepo()
	service, err := NewService(ServiceConfig{
		Repository:   repo,
		Sanitizer:    okSanitizer(),
		ContentGuard: guard,
		PublishMode: func(context.Context, string) (site.PublishMode, error) {
			return site.PublishModeOpen, nil
		},
		Now: func() time.Time { return time.Date(2026, 11, 7, 4, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)
	return service, repo
}

func TestCreateDraftReplacesSensitiveWordsAndAudits(t *testing.T) {
	service, repo := serviceWithGuard(t, fakeContentGuard{mode: safety.ModeReplace})
	ctx := context.Background()
	author := actor("author", site.RoleMember)

	item, err := service.CreateDraft(ctx, author, KindArticle, DraftInput{
		Title:        "a bad title",
		Summary:      "a bad summary",
		SourceFormat: FormatMarkdown,
		SourceBody:   "bad body",
	})
	require.NoError(t, err)
	require.Equal(t, "a *** title", item.Title)
	require.Equal(t, "a *** summary", item.Summary)
	require.Equal(t, "*** body", item.SourceBody)

	require.NotEmpty(t, repo.audits)
	detail, ok := repo.audits[0].Detail["content_safety"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, string(safety.ModeReplace), detail["action"])
}

func TestCreateDraftHoldsReviewMatchForModeration(t *testing.T) {
	service, _ := serviceWithGuard(t, fakeContentGuard{mode: safety.ModeReview})
	ctx := context.Background()
	author := actor("author", site.RoleMember)

	item, err := service.CreateDraft(ctx, author, KindArticle, DraftInput{
		Title:        "a bad title",
		SourceFormat: FormatMarkdown,
		SourceBody:   "clean body",
	})
	require.NoError(t, err)
	require.Equal(t, StatusPendingReview, item.Status)
}

func TestCreateDraftRefusesRejectMatch(t *testing.T) {
	service, repo := serviceWithGuard(t, fakeContentGuard{mode: safety.ModeReject})
	ctx := context.Background()
	author := actor("author", site.RoleMember)

	_, err := service.CreateDraft(ctx, author, KindArticle, DraftInput{
		Title:        "a bad title",
		SourceFormat: FormatMarkdown,
		SourceBody:   "clean body",
	})
	require.ErrorIs(t, err, safety.ErrRejected)
	require.Empty(t, repo.items, "a rejected submission is never stored")
}

func TestUpdateDraftDoesNotUnpublishLiveContentForReviewMatch(t *testing.T) {
	service, repo := serviceWithGuard(t, fakeContentGuard{mode: safety.ModeReplace})
	ctx := context.Background()
	editor := actor("editor", site.RoleEditor)
	author := actor("author", site.RoleMember)

	item, err := service.CreateDraft(ctx, author, KindArticle, DraftInput{
		Title:        "clean",
		SourceFormat: FormatMarkdown,
		SourceBody:   "clean body",
	})
	require.NoError(t, err)

	// Publish it, then switch the guard to review mode and save an edit.
	service.guard = fakeContentGuard{mode: safety.ModeReview}
	repo.items[item.ID] = Content{
		ID: item.ID, SiteID: item.SiteID, AuthorID: item.AuthorID, Kind: item.Kind,
		Status: StatusPublished, Title: "clean", SourceFormat: FormatMarkdown,
		SourceBody: "clean body", RenderedHTML: "<p>ok</p>", PolicyVersion: "v1",
		Revision: 1, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt,
	}

	updated, err := service.UpdateDraft(ctx, editor, item.ID, DraftInput{
		Title:        "a bad title",
		SourceFormat: FormatMarkdown,
		SourceBody:   "clean body",
	})
	require.NoError(t, err)
	require.Equal(t, StatusPublished, updated.Status, "a live article is never silently unpublished")
	require.Equal(t, "a *** title", updated.Title)
}
