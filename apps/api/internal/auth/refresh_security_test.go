package auth_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	entsession "github.com/practacu/practacu-press/apps/api/ent/session"
	"github.com/practacu/practacu-press/apps/api/internal/auth"
)

const oneDay = 24 * time.Hour

// TestRefreshLineageHasAbsoluteLifetime is the V-23 regression: rotation extends the
// idle window but never the lineage's absolute lifetime, and past that lifetime the
// whole family is revoked.
func TestRefreshLineageHasAbsoluteLifetime(t *testing.T) {
	start := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	clock := newTestClock(start)
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: &fakeHasher{}, now: clock.Now})
	ctx := context.Background()

	registered, err := h.service.RegisterEmail(ctx, h.siteID, auth.RegisterEmailInput{
		Email: "alice@example.com", Password: "correct horse battery", DisplayName: "Alice",
	})
	require.NoError(t, err)
	current := registered

	// The schema stamps created_at with the real clock, not the service test clock, so
	// read the lineage birth time back instead of assuming it.
	rootRow, err := h.db.Client.Session.Query().Only(ctx)
	require.NoError(t, err)
	familyCreatedAt := rootRow.CreatedAt

	// Keep refreshing inside the idle window: each rotation succeeds, but the lineage
	// keeps its own birth time.
	for rotation := 1; rotation <= 4; rotation++ {
		clock.Advance(20 * oneDay)
		next, err := h.service.Refresh(ctx, h.siteID, current.RefreshToken)
		require.NoError(t, err, "rotation %d must work: the idle window is 30 days", rotation)
		current = next
	}

	wantAbsolute := familyCreatedAt.Add(auth.RefreshFamilyAbsoluteTTL)
	require.Equal(t, wantAbsolute.UTC(), current.RefreshExpiresAt.UTC(),
		"the expiry of a rotated session must be capped by the lineage's absolute deadline, not slid forward")

	// Simulate a row minted before this fix existed: its idle deadline is far beyond
	// the lineage ceiling, so only the absolute check can stop it.
	row, err := h.db.Client.Session.Query().
		Where(entsession.TokenHashEQ(auth.HashOpaqueToken(current.RefreshToken))).
		Only(ctx)
	require.NoError(t, err)
	_, err = h.db.Client.Session.Update().
		Where(entsession.IDEQ(row.ID)).
		SetExpiresAt(clock.Now().Add(200 * oneDay)).
		Save(ctx)
	require.NoError(t, err)

	// Day 95 is past the 90 day ceiling even though the token's own expiry is not.
	clock.Advance(15 * oneDay)
	_, err = h.service.Refresh(ctx, h.siteID, current.RefreshToken)
	require.ErrorIs(t, err, auth.ErrSessionRevoked,
		"a lineage older than the absolute lifetime must be refused")

	// The refusal burnt the whole family, with a reason an operator can audit.
	rows, err := h.db.Client.Session.Query().
		Where(entsession.FamilyIDEQ(row.FamilyID)).
		All(ctx)
	require.NoError(t, err)
	require.Len(t, rows, 5, "registration plus four rotations")
	for _, sessionRow := range rows {
		require.NotNil(t, sessionRow.RevokedAt, "every row of an expired lineage must be revoked")
		reason := ""
		if sessionRow.RevokedReason != nil {
			reason = *sessionRow.RevokedReason
		}
		require.Equal(t, "refresh_family_expired", reason)
	}
}

// TestConcurrentRefreshIsTreatedAsReuse is the V-25 regression: when two requests race
// to rotate the same token, the loser must revoke the family instead of leaving the
// winner's session alive.
func TestConcurrentRefreshIsTreatedAsReuse(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: &fakeHasher{}})
	ctx := context.Background()

	registered, err := h.service.RegisterEmail(ctx, h.siteID, auth.RegisterEmailInput{
		Email: "alice@example.com", Password: "correct horse battery", DisplayName: "Alice",
	})
	require.NoError(t, err)

	type outcome struct {
		session auth.Session
		err     error
	}
	results := make([]outcome, 2)
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i].session, results[i].err = h.service.Refresh(ctx, h.siteID, registered.RefreshToken)
		}(i)
	}
	wg.Wait()

	var winner *auth.Session
	reuseCount := 0
	for _, result := range results {
		switch {
		case result.err == nil:
			require.Nil(t, winner, "at most one concurrent rotation may succeed")
			session := result.session
			winner = &session
		case errors.Is(result.err, auth.ErrRefreshReuse):
			reuseCount++
		default:
			t.Fatalf("unexpected refresh error: %v", result.err)
		}
	}
	require.NotNil(t, winner, "exactly one concurrent rotation must succeed")
	require.Equal(t, 1, reuseCount, "the losing request must be reported as token reuse")

	// The loser burnt the lineage, so the winner's freshly minted token is dead too.
	_, err = h.service.Refresh(ctx, h.siteID, winner.RefreshToken)
	require.ErrorIs(t, err, auth.ErrSessionRevoked)

	rows, err := h.db.Client.Session.Query().All(ctx)
	require.NoError(t, err)
	require.NotEmpty(t, rows)
	for _, row := range rows {
		require.NotNil(t, row.RevokedAt,
			"concurrent reuse must revoke every live row of the family")
	}
}
