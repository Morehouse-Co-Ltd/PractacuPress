package auth

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fixedClock is a deterministic time source for the signer tests.
type fixedClock struct{ at time.Time }

// Now implements a time source.
func (c *fixedClock) Now() time.Time { return c.at }

// newStepUpTestIssuer builds the minimal issuer the signer derivation needs. Only
// the signing seed and the clock are actually read.
func newStepUpTestIssuer(t *testing.T, now func() time.Time) *TokenIssuer {
	t.Helper()
	key, err := GenerateSigningKey()
	require.NoError(t, err)
	return &TokenIssuer{key: key, keyID: "test", issuer: "test", accessTTL: AccessTTL, now: now}
}

func TestStepUpSignerIssuesTokensBoundToUserAndSite(t *testing.T) {
	clock := &fixedClock{at: time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)}
	signer := NewStepUpSigner(newStepUpTestIssuer(t, clock.Now), 300*time.Second)
	require.Equal(t, 300*time.Second, signer.TTL())

	token, expiresIn, err := signer.Issue("u1", "s1")
	require.NoError(t, err)
	require.Equal(t, 300, expiresIn)
	require.NotEmpty(t, token)

	require.True(t, signer.Verify(token, "u1", "s1"))
	// The grant is bound to one account and one site: a leaked token is useless for
	// another caller or another tenant.
	require.False(t, signer.Verify(token, "u2", "s1"))
	require.False(t, signer.Verify(token, "u1", "s2"))
	// Any mutation of the signed material must be rejected.
	require.False(t, signer.Verify(token+"x", "u1", "s1"))
	require.False(t, signer.Verify("v1."+token, "u1", "s1"))
	require.False(t, signer.Verify("garbage", "u1", "s1"))
	require.False(t, signer.Verify("", "u1", "s1"))
}

func TestStepUpSignerRejectsExpiredGrants(t *testing.T) {
	base := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	clock := &fixedClock{at: base}
	signer := NewStepUpSigner(newStepUpTestIssuer(t, clock.Now), 300*time.Second)

	token, _, err := signer.Issue("u1", "s1")
	require.NoError(t, err)

	clock.at = base.Add(299 * time.Second)
	require.True(t, signer.Verify(token, "u1", "s1"))

	// The expiry instant itself is no longer valid (strictly before).
	clock.at = base.Add(300 * time.Second)
	require.False(t, signer.Verify(token, "u1", "s1"))
}

func TestStepUpSignersDerivedFromDifferentSeedsRejectEachOther(t *testing.T) {
	clock := &fixedClock{at: time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)}
	first := NewStepUpSigner(newStepUpTestIssuer(t, clock.Now), 300*time.Second)
	second := NewStepUpSigner(newStepUpTestIssuer(t, clock.Now), 300*time.Second)

	token, _, err := first.Issue("u1", "s1")
	require.NoError(t, err)
	require.True(t, first.Verify(token, "u1", "s1"))
	require.False(t, second.Verify(token, "u1", "s1"),
		"a grant must not verify under another deployment's key")
}

func TestNewStepUpSignerWithoutIssuerIsNil(t *testing.T) {
	require.Nil(t, NewStepUpSigner(nil, 0))
}

func TestStepUpVerifyPasswordRejectsEmptyInputBeforeAnyWork(t *testing.T) {
	clock := &fixedClock{at: time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)}
	signer := NewStepUpSigner(newStepUpTestIssuer(t, clock.Now), 300*time.Second)
	// No repository and no hasher: an empty submission must be refused before either
	// would be needed, which also proves the endpoint cannot be used as a free oracle.
	service := &Service{stepUpSigner: signer}

	_, _, err := service.VerifyStepUpPassword(t.Context(), "u1", "s1", "")
	require.ErrorIs(t, err, ErrStepUpPasswordRejected)
}
