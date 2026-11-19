package audit_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
)

type fakeRepo struct {
	items      []audit.Log
	next       string
	gotFilter  audit.Filter
	gotLimit   int
	gotCursor  page.Cursor
	calledWith bool
	err        error
}

func (f *fakeRepo) List(
	_ context.Context,
	filter audit.Filter,
	limit int,
	after page.Cursor,
) ([]audit.Log, string, error) {
	f.calledWith = true
	f.gotFilter = filter
	f.gotLimit = limit
	f.gotCursor = after
	return f.items, f.next, f.err
}

func admin() site.Member {
	return site.Member{
		UserID: "u1",
		SiteID: "s1",
		Role:   site.RoleSiteAdmin,
		Status: site.MemberStatusActive,
	}
}

func TestListRejectsNonAdministrators(t *testing.T) {
	for _, role := range []site.Role{site.RoleMember, site.RoleEditor} {
		repo := &fakeRepo{}
		service, err := audit.NewService(repo)
		require.NoError(t, err)

		_, err = service.List(context.Background(), site.Member{
			UserID: "u1", SiteID: "s1", Role: role, Status: site.MemberStatusActive,
		}, "s1", audit.Filter{}, 20, page.Cursor{})
		require.ErrorIs(t, err, audit.ErrPermissionDenied)
		require.False(t, repo.calledWith)
	}
}

func TestListRejectsAnotherSite(t *testing.T) {
	repo := &fakeRepo{}
	service, _ := audit.NewService(repo)

	_, err := service.List(context.Background(), admin(), "s2", audit.Filter{}, 20, page.Cursor{})
	require.ErrorIs(t, err, audit.ErrPermissionDenied)
}

func TestListNormalizesFilterAndLimit(t *testing.T) {
	repo := &fakeRepo{next: "next"}
	service, _ := audit.NewService(repo)
	from := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	to := from.Add(24 * time.Hour)

	result, err := service.List(context.Background(), admin(), "s1", audit.Filter{
		ActorID:    "  u1  ",
		Action:     "  content.published  ",
		TargetType: "article",
		TargetID:   "c1",
		Outcome:    "success",
		From:       &from,
		To:         &to,
	}, 0, page.Cursor{})
	require.NoError(t, err)
	require.Equal(t, "next", result.NextCursor)
	require.Equal(t, "s1", repo.gotFilter.SiteID)
	require.Equal(t, "u1", repo.gotFilter.ActorID)
	require.Equal(t, "content.published", repo.gotFilter.Action)
	require.Equal(t, audit.DefaultLimit, repo.gotLimit)
}

func TestListRejectsInvertedRangeAndOversizedFilters(t *testing.T) {
	repo := &fakeRepo{}
	service, _ := audit.NewService(repo)
	from := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	to := from.Add(-time.Hour)

	_, err := service.List(context.Background(), admin(), "s1", audit.Filter{
		From: &from,
		To:   &to,
	}, 20, page.Cursor{})
	require.ErrorIs(t, err, audit.ErrInvalidFilter)

	longAction := make([]rune, audit.MaxActionLength+1)
	for i := range longAction {
		longAction[i] = 'a'
	}
	_, err = service.List(context.Background(), admin(), "s1", audit.Filter{
		Action: string(longAction),
	}, 20, page.Cursor{})
	require.ErrorIs(t, err, audit.ErrInvalidFilter)
}

func TestListRejectsMalformedCursorBeforeHittingTheRepository(t *testing.T) {
	repo := &fakeRepo{}
	service, _ := audit.NewService(repo)

	_, err := service.List(context.Background(), admin(), "s1", audit.Filter{}, 20, page.Cursor{
		Key: "not a timestamp",
		ID:  "x",
	})
	require.ErrorIs(t, err, audit.ErrInvalidFilter)
	require.False(t, repo.calledWith)
}

func TestListForwardsAValidCursor(t *testing.T) {
	repo := &fakeRepo{}
	service, _ := audit.NewService(repo)
	cursor := page.Cursor{Key: "2026-11-01T10:00:00.123Z", ID: "a1"}

	_, err := service.List(context.Background(), admin(), "s1", audit.Filter{}, 25, cursor)
	require.NoError(t, err)
	require.Equal(t, cursor, repo.gotCursor)
	require.Equal(t, 25, repo.gotLimit)
}
