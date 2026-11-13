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
	audits  []site.AuditEntry
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

func (f *fakeRepo) UpdateReportWithAudit(_ context.Context, report Report, audit site.AuditEntry) (Report, error) {
	f.audits = append(f.audits, audit)
	return f.UpdateReport(context.Background(), report)
}

func (f *fakeRepo) FindByReporter(
	_ context.Context,
	siteID, reporterID string,
	targetType TargetType,
	targetID string,
) (Report, error) {
	for _, report := range f.reports {
		if report.SiteID == siteID && report.ReporterID == reporterID &&
			report.TargetType == targetType && report.TargetID == targetID {
			return report, nil
		}
	}
	return Report{}, ErrNotFound
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

type fakeTargets struct {
	author      string
	takedowns   []string
	bans        []string
	takedownErr error
}

func (f *fakeTargets) AuthorOf(context.Context, string, TargetType, string) (string, error) {
	if f.author == "" {
		return "", ErrTargetNotFound
	}
	return f.author, nil
}

type fakeModerator struct{ targets *fakeTargets }

func (f fakeModerator) Takedown(_ context.Context, _ Actor, targetType TargetType, targetID string) error {
	if f.targets.takedownErr != nil {
		return f.targets.takedownErr
	}
	f.targets.takedowns = append(f.targets.takedowns, string(targetType)+":"+targetID)
	return nil
}

func (f fakeModerator) Ban(_ context.Context, _ Actor, userID string) error {
	f.targets.bans = append(f.targets.bans, userID)
	return nil
}

type fakeNotifier struct{ messages []ModerationNotification }

func (f *fakeNotifier) NotifyModeration(_ context.Context, in ModerationNotification) error {
	f.messages = append(f.messages, in)
	return nil
}

func TestResolveActionTakedownWritesAuditAndNotifies(t *testing.T) {
	repo := newFakeRepo()
	targets := &fakeTargets{author: "author-1"}
	notifier := &fakeNotifier{}
	service, err := NewService(repo,
		WithTargetResolver(targets),
		WithTargetModerator(fakeModerator{targets: targets}),
		WithNotifier(notifier),
	)
	require.NoError(t, err)
	service.now = func() time.Time { return time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) }
	ctx := context.Background()

	report, err := service.File(ctx, reporter(), spamReport(), "")
	require.NoError(t, err)
	_, err = service.Assign(ctx, moderator(), report.ID)
	require.NoError(t, err)

	resolved, err := service.ResolveAction(ctx, moderator(), report.ID, ResolveInput{
		Action: ActionTakedown,
		Note:   "removed",
	})
	require.NoError(t, err)
	require.Equal(t, StatusResolved, resolved.Status)
	require.Len(t, targets.takedowns, 1)
	require.Len(t, repo.audits, 1)
	require.Equal(t, "moderation.report.takedown", repo.audits[0].Action)
	require.Len(t, notifier.messages, 2, "the reporter and the target author are told")
}

func TestResolveActionBanNeedsAdministrator(t *testing.T) {
	repo := newFakeRepo()
	targets := &fakeTargets{author: "author-1"}
	service, err := NewService(repo,
		WithTargetResolver(targets),
		WithTargetModerator(fakeModerator{targets: targets}),
	)
	require.NoError(t, err)
	ctx := context.Background()

	report, err := service.File(ctx, reporter(), spamReport(), "")
	require.NoError(t, err)
	_, err = service.Assign(ctx, moderator(), report.ID)
	require.NoError(t, err)

	_, err = service.ResolveAction(ctx, moderator(), report.ID, ResolveInput{Action: ActionBan})
	require.ErrorIs(t, err, ErrActionNotAllowed)

	admin := Actor{UserID: "admin1", SiteID: "s1", Role: site.RoleSiteAdmin}
	resolved, err := service.ResolveAction(ctx, admin, report.ID, ResolveInput{Action: ActionBan})
	require.NoError(t, err)
	require.Equal(t, StatusResolved, resolved.Status)
	require.Equal(t, []string{"author-1"}, targets.bans)
}

func TestResolveActionIgnoreDismisses(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(repo, WithTargetResolver(&fakeTargets{author: "author-1"}))
	require.NoError(t, err)
	ctx := context.Background()

	report, err := service.File(ctx, reporter(), spamReport(), "")
	require.NoError(t, err)
	_, err = service.Assign(ctx, moderator(), report.ID)
	require.NoError(t, err)

	resolved, err := service.ResolveAction(ctx, moderator(), report.ID, ResolveInput{Action: ActionIgnore})
	require.NoError(t, err)
	require.Equal(t, StatusDismissed, resolved.Status)
}

func TestFileRejectsDuplicateOpenReport(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(repo, WithRateLimit(0, 0))
	require.NoError(t, err)
	ctx := context.Background()

	_, err = service.File(ctx, reporter(), spamReport(), "author-1")
	require.NoError(t, err)
	_, err = service.File(ctx, reporter(), spamReport(), "author-1")
	require.ErrorIs(t, err, ErrDuplicateReport)
}

func TestFileRateLimit(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(repo, WithRateLimit(1, time.Hour))
	require.NoError(t, err)
	ctx := context.Background()

	_, err = service.File(ctx, reporter(), spamReport(), "author-1")
	require.NoError(t, err)
	_, err = service.File(ctx, reporter(), NewReportInput{
		TargetType: TargetPost, TargetID: "p1", Reason: ReasonAbuse,
	}, "author-2")
	require.ErrorIs(t, err, ErrRateLimited)
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
