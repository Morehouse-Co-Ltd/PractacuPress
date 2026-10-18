package moderation

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

type fakeRepo struct {
	reports map[string]Report
	seq     int
}

func newFakeRepo() *fakeRepo { return &fakeRepo{reports: map[string]Report{}} }

func (f *fakeRepo) InsertReport(_ context.Context, report Report) (Report, error) {
	f.seq++
	report.ID = fmt.Sprintf("r%d", f.seq)
	f.reports[report.ID] = report
	return report, nil
}

func (f *fakeRepo) FindReport(_ context.Context, siteID, reportID string) (Report, error) {
	report, ok := f.reports[reportID]
	if !ok || report.SiteID != siteID {
		return Report{}, ErrNotFound
	}
	return report, nil
}

func (f *fakeRepo) UpdateReport(_ context.Context, report Report) (Report, error) {
	if _, ok := f.reports[report.ID]; !ok {
		return Report{}, ErrNotFound
	}
	f.reports[report.ID] = report
	return report, nil
}

func (f *fakeRepo) ListOpen(_ context.Context, siteID string, limit int) ([]Report, error) {
	out := make([]Report, 0, len(f.reports))
	for _, report := range f.reports {
		if report.SiteID == siteID && !report.Status.Closed() {
			out = append(out, report)
		}
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func newService(t *testing.T, repo Repository) *Service {
	t.Helper()
	service, err := NewService(repo)
	require.NoError(t, err)
	service.now = func() time.Time { return time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) }
	return service
}

func reporter() Actor { return Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember} }
func moderator() Actor {
	return Actor{UserID: "mod1", SiteID: "s1", Role: site.RoleEditor}
}

func spamReport() NewReportInput {
	return NewReportInput{TargetType: "article", TargetID: "a1", Reason: ReasonSpam, Note: "bad"}
}

func TestNewServiceRequiresRepository(t *testing.T) {
	_, err := NewService(nil)
	require.Error(t, err)
}

func TestFileReport(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)

	report, err := service.File(context.Background(), reporter(), spamReport(), "author-1")
	require.NoError(t, err)
	require.Equal(t, StatusOpen, report.Status)
	require.Equal(t, ReasonSpam, report.Reason)
}

func TestFileReportRejectsSelfReport(t *testing.T) {
	service := newService(t, newFakeRepo())

	_, err := service.File(context.Background(), reporter(), spamReport(), "u1")
	require.ErrorIs(t, err, ErrSelfReport)
}

func TestFileReportRejectsBadInput(t *testing.T) {
	service := newService(t, newFakeRepo())

	in := spamReport()
	in.Reason = "vibes"
	_, err := service.File(context.Background(), reporter(), in, "author-1")
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestAssignRequiresModerator(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()

	report, err := service.File(ctx, reporter(), spamReport(), "author-1")
	require.NoError(t, err)

	_, err = service.Assign(ctx, reporter(), report.ID)
	require.ErrorIs(t, err, ErrPermissionDenied)

	assigned, err := service.Assign(ctx, moderator(), report.ID)
	require.NoError(t, err)
	require.Equal(t, StatusAssigned, assigned.Status)
	require.Equal(t, "mod1", assigned.AssigneeID)
}

func TestResolveRequiresAssignee(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()

	report, err := service.File(ctx, reporter(), spamReport(), "author-1")
	require.NoError(t, err)
	_, err = service.Assign(ctx, moderator(), report.ID)
	require.NoError(t, err)

	other := Actor{UserID: "mod2", SiteID: "s1", Role: site.RoleEditor}
	_, err = service.Resolve(ctx, other, report.ID, false, "")
	require.ErrorIs(t, err, ErrNotAssignee)

	resolved, err := service.Resolve(ctx, moderator(), report.ID, false, "removed")
	require.NoError(t, err)
	require.Equal(t, StatusResolved, resolved.Status)
	require.Equal(t, "removed", resolved.Note)
}

func TestResolveTwiceIsRefused(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()

	report, err := service.File(ctx, reporter(), spamReport(), "author-1")
	require.NoError(t, err)
	_, err = service.Assign(ctx, moderator(), report.ID)
	require.NoError(t, err)
	_, err = service.Resolve(ctx, moderator(), report.ID, false, "")
	require.NoError(t, err)

	_, err = service.Resolve(ctx, moderator(), report.ID, false, "")
	require.ErrorIs(t, err, ErrAlreadyClosed)
}

func TestQueueRequiresModerator(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()

	_, err := service.File(ctx, reporter(), spamReport(), "author-1")
	require.NoError(t, err)

	_, err = service.Queue(ctx, reporter(), 10)
	require.ErrorIs(t, err, ErrPermissionDenied)

	queue, err := service.Queue(ctx, moderator(), 10)
	require.NoError(t, err)
	require.Len(t, queue, 1)
}

func TestQueueIncludesAssignedButNotClosed(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()

	first, err := service.File(ctx, reporter(), spamReport(), "author-1")
	require.NoError(t, err)
	second, err := service.File(ctx, reporter(), NewReportInput{
		TargetType: "post", TargetID: "p1", Reason: ReasonAbuse,
	}, "author-2")
	require.NoError(t, err)

	_, err = service.Assign(ctx, moderator(), first.ID)
	require.NoError(t, err)
	_, err = service.Resolve(ctx, moderator(), second.ID, true, "")
	require.ErrorIs(t, err, ErrNotAssignee, "an unclaimed report must be claimed first")

	queue, err := service.Queue(ctx, moderator(), 10)
	require.NoError(t, err)
	require.Len(t, queue, 2)
}
