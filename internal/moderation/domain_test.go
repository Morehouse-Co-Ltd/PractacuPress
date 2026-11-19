package moderation

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/site"
)

func editor(id string) Actor {
	return Actor{UserID: id, SiteID: "s1", Role: site.RoleEditor}
}

func member(id string) Actor {
	return Actor{UserID: id, SiteID: "s1", Role: site.RoleMember}
}

func openReport() Report {
	return Report{
		ID: "r1", SiteID: "s1", ReporterID: "u1", TargetType: "article",
		TargetID: "a1", Reason: ReasonSpam, Status: StatusOpen,
	}
}

func TestValidateReport(t *testing.T) {
	in := NewReportInput{TargetType: "article", TargetID: "a1", Reason: ReasonSpam, Note: "  spam  "}
	got, err := ValidateReport(in, "u1", "u2")
	require.NoError(t, err)
	require.Equal(t, "spam", got.Note)

	_, err = ValidateReport(NewReportInput{TargetType: "", TargetID: "a1", Reason: ReasonSpam}, "u1", "u2")
	require.ErrorIs(t, err, ErrInvalidInput)

	_, err = ValidateReport(NewReportInput{TargetType: "article", TargetID: "a1", Reason: "vibes"}, "u1", "u2")
	require.ErrorIs(t, err, ErrInvalidInput)

	_, err = ValidateReport(in, "u1", "u1")
	require.ErrorIs(t, err, ErrSelfReport, "reporting your own content is refused")
}

func TestOnlyModeratorsAssign(t *testing.T) {
	report := openReport()

	_, err := report.Assign(member("u1"), time.Now())
	require.ErrorIs(t, err, ErrPermissionDenied)

	assigned, err := report.Assign(editor("mod"), time.Now())
	require.NoError(t, err)
	require.Equal(t, StatusAssigned, assigned.Status)
	require.Equal(t, "mod", assigned.AssigneeID)
}

func TestCrossSiteAssignmentIsRefused(t *testing.T) {
	report := openReport()
	outsider := Actor{UserID: "mod", SiteID: "s2", Role: site.RoleSiteAdmin}

	_, err := report.Assign(outsider, time.Now())
	require.ErrorIs(t, err, ErrPermissionDenied)
}

// TestOnlyAssigneeResolves is what stops two moderators from contradicting each other.
func TestOnlyAssigneeResolves(t *testing.T) {
	assigned, err := openReport().Assign(editor("mod1"), time.Now())
	require.NoError(t, err)

	_, err = assigned.Resolve(editor("mod2"), false, "", time.Now())
	require.ErrorIs(t, err, ErrNotAssignee)

	resolved, err := assigned.Resolve(editor("mod1"), false, "handled", time.Now())
	require.NoError(t, err)
	require.Equal(t, StatusResolved, resolved.Status)
	require.Equal(t, "handled", resolved.Note)

	_, err = resolved.Resolve(editor("mod1"), false, "", time.Now())
	require.ErrorIs(t, err, ErrAlreadyClosed)
}

func TestDismissSetsDismissedStatus(t *testing.T) {
	assigned, err := openReport().Assign(editor("mod"), time.Now())
	require.NoError(t, err)

	dismissed, err := assigned.Resolve(editor("mod"), true, "", time.Now())
	require.NoError(t, err)
	require.Equal(t, StatusDismissed, dismissed.Status)
	require.True(t, dismissed.Status.Closed())
}

func TestPlatformAdminMayCloseUnassignedReport(t *testing.T) {
	admin := Actor{UserID: "root", SiteID: "s1", Role: site.RolePlatformAdmin}

	resolved, err := openReport().Resolve(admin, false, "", time.Now())
	require.NoError(t, err)
	require.Equal(t, StatusResolved, resolved.Status)
}

func TestEditorCannotCloseUnassignedReport(t *testing.T) {
	_, err := openReport().Resolve(editor("mod"), false, "", time.Now())
	require.ErrorIs(t, err, ErrNotAssignee, "an unclaimed report must be claimed first")
}
