package authstore_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/site"

	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
	"github.com/practacu/practacu-press/apps/api/ent/useridentity"
)

// oauthHarness wires the real Ent store and the real state store to a throwaway
// SQLite database.
//
// It follows store_test.go: the Ent schema is created the way a fresh install
// creates it, and oauth_states is added on top from the reviewed migration,
// because that table has no Ent entity and therefore nothing in the schema tool
// creates it.
type oauthHarness struct {
	ctx    context.Context
	db     *db.DB
	store  *authstore.Store
	state  *authstore.OAuthStateStore
	siteID string
}

func newOAuthHarness(t *testing.T) *oauthHarness {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "oauth.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })

	require.NoError(t, handle.Client.Schema.Create(ctx))
	applyOAuthStateMigration(t, handle.SQL())

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	return &oauthHarness{
		ctx:    ctx,
		db:     handle,
		store:  authstore.New(handle.Client),
		state:  authstore.NewOAuthStateStore(handle),
		siteID: siteRow.ID,
	}
}

// applyOAuthStateMigration runs the shipped SQLite change set that creates
// oauth_states.
//
// The real file is used rather than an inline copy so the store is tested against
// the schema production ships: a column renamed in the migration and forgotten in
// the store fails here instead of at the first login.
func applyOAuthStateMigration(t *testing.T, pool *sql.DB) {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	require.True(t, ok, "the test file path must be available")

	path := filepath.Join(
		filepath.Dir(file),
		"..", "..", "..", "..", "..",
		"migrations", "sqlite", "20261118000000_oauth_state.up.sql",
	)
	script, err := os.ReadFile(path)
	require.NoError(t, err, "the oauth_states migration must exist")

	// The comment prose contains semicolons, so whole comment lines are dropped
	// before the script is split into statements.
	var body strings.Builder
	for _, line := range strings.Split(string(script), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		body.WriteString(line)
		body.WriteString("\n")
	}

	for _, statement := range strings.Split(body.String(), ";") {
		statement = strings.TrimSpace(statement)
		if statement == "" {
			continue
		}
		_, err := pool.ExecContext(context.Background(), statement)
		require.NoError(t, err, "apply an oauth_states migration statement")
	}
}

// countOAuthStates reports how many rows the state table holds.
func countOAuthStates(t *testing.T, h *oauthHarness) int {
	t.Helper()
	var count int
	require.NoError(t, h.db.SQL().
		QueryRowContext(h.ctx, "SELECT COUNT(*) FROM oauth_states").
		Scan(&count))
	return count
}

func TestOAuthAccountCreateUserFillsRequiredFields(t *testing.T) {
	h := newOAuthHarness(t)

	// The address is passed but not stored: users has no email column, and the
	// address only reaches the database through the identity LinkIdentity writes.
	// It still names the account when the provider supplied no name.
	userID, err := h.store.CreateUser(h.ctx, h.siteID, "Ada@Example.com", "", "")
	require.NoError(t, err)
	require.NotEmpty(t, userID)

	row, err := h.db.Client.User.Get(h.ctx, userID)
	require.NoError(t, err)
	require.Equal(t, "Ada", row.DisplayName, "a nameless profile falls back to the address' local part")
	require.Equal(t, "active", row.Status, "a new account defaults to active")
	require.Equal(t, "zh-CN", row.Locale, "the schema default locale is kept")
	require.Nil(t, row.EmailVerifiedAt, "a provider sign-in is never a verification")
	require.Nil(t, row.AvatarMediaID, "a remote avatar URL is not a media asset id")

	// A provider name is kept as given; a name longer than the column is truncated
	// instead of failing the login on a validation error.
	named, err := h.store.CreateUser(h.ctx, h.siteID, "bob@example.com", "Bob Builder", "")
	require.NoError(t, err)
	namedRow, err := h.db.Client.User.Get(h.ctx, named)
	require.NoError(t, err)
	require.Equal(t, "Bob Builder", namedRow.DisplayName)

	longName := strings.Repeat("名", 200)
	long, err := h.store.CreateUser(h.ctx, h.siteID, "", longName, "")
	require.NoError(t, err)
	longRow, err := h.db.Client.User.Get(h.ctx, long)
	require.NoError(t, err)
	require.LessOrEqual(t, len(longRow.DisplayName), 120,
		"display_name is capped at the column limit, which Ent counts in bytes")
	require.True(t, strings.HasPrefix(longName, longRow.DisplayName), "the name is cut, not mangled")
	require.True(t, utf8.ValidString(longRow.DisplayName), "the cut must not split a rune")

	// A profile with neither a name nor an address still creates a usable account,
	// because display_name is required by the schema.
	anonymous, err := h.store.CreateUser(h.ctx, h.siteID, "", "   ", "")
	require.NoError(t, err)
	anonymousRow, err := h.db.Client.User.Get(h.ctx, anonymous)
	require.NoError(t, err)
	require.NotEmpty(t, anonymousRow.DisplayName)
}

func TestOAuthAccountFindUserByEmailFollowsTheLoginAddress(t *testing.T) {
	h := newOAuthHarness(t)

	// A password account owns its address through an email identity, which is the
	// row login resolves.
	account, err := h.store.CreateAccountWithEmail(h.ctx, auth.CreateAccountInput{
		SiteID:       h.siteID,
		Email:        "alice@example.com",
		DisplayName:  "Alice",
		PasswordHash: "phc-placeholder",
	})
	require.NoError(t, err)

	found, ok, err := h.store.FindUserByEmail(h.ctx, "ALICE@example.com")
	require.NoError(t, err)
	require.True(t, ok, "the address is compared case insensitively")
	require.Equal(t, account.ID, found)

	_, ok, err = h.store.FindUserByEmail(h.ctx, "  alice@example.com ")
	require.NoError(t, err)
	require.True(t, ok, "surrounding whitespace is not part of the address")

	_, ok, err = h.store.FindUserByEmail(h.ctx, "carol@example.com")
	require.NoError(t, err)
	require.False(t, ok, "an unknown address is not an error")

	_, ok, err = h.store.FindUserByEmail(h.ctx, "   ")
	require.NoError(t, err)
	require.False(t, ok, "an empty address cannot match an account")

	// A provider identity's email column is audit data, not ownership. If it were
	// matched, anyone able to type an address into a provider profile could park an
	// identity on it, and a later verified sign-in with the same address would be
	// linked into that stranger's account.
	oauthUser, err := h.store.CreateUser(h.ctx, h.siteID, "dave@example.com", "Dave", "")
	require.NoError(t, err)
	require.NoError(t, h.store.LinkIdentity(h.ctx, oauthUser, "google", "google-dave", "dave@example.com"))

	_, ok, err = h.store.FindUserByEmail(h.ctx, "dave@example.com")
	require.NoError(t, err)
	require.False(t, ok, "only an email identity proves ownership of an address")
}

func TestOAuthAccountLinkIdentityBindsOneSubjectOnce(t *testing.T) {
	h := newOAuthHarness(t)

	userID, err := h.store.CreateUser(h.ctx, h.siteID, "ada@example.com", "Ada", "")
	require.NoError(t, err)

	_, ok, err := h.store.FindIdentity(h.ctx, "github", "4242")
	require.NoError(t, err)
	require.False(t, ok, "an unbound subject is a first login, not an error")

	require.NoError(t, h.store.LinkIdentity(h.ctx, userID, "github", "4242", "ada@example.com"))

	found, ok, err := h.store.FindIdentity(h.ctx, "github", "4242")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, userID, found)

	// The address seen at the provider is kept on the row for audit.
	identity, err := h.db.Client.UserIdentity.Query().
		Where(useridentity.ProviderEQ("github"), useridentity.ProviderSubjectEQ("4242")).
		Only(h.ctx)
	require.NoError(t, err)
	require.NotNil(t, identity.Email)
	require.Equal(t, "ada@example.com", *identity.Email)
	require.Nil(t, identity.VerifiedAt, "an OAuth identity is not a verification")

	// Binding the same subject twice is the unique index rejecting the second
	// write, reported as a conflict the caller can recognise.
	err = h.store.LinkIdentity(h.ctx, userID, "github", "4242", "ada@example.com")
	require.ErrorIs(t, err, auth.ErrIdentityExists)
	require.Equal(t, 1, countIdentities(t, h))

	// The same subject under a different provider is a different identity, and an
	// absent provider address stays NULL rather than an empty string.
	require.NoError(t, h.store.LinkIdentity(h.ctx, userID, "google", "4242", ""))
	found, ok, err = h.store.FindIdentity(h.ctx, "google", "4242")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, userID, found)

	googleIdentity, err := h.db.Client.UserIdentity.Query().
		Where(useridentity.ProviderEQ("google"), useridentity.ProviderSubjectEQ("4242")).
		Only(h.ctx)
	require.NoError(t, err)
	require.Nil(t, googleIdentity.Email, "a missing address is stored as NULL")
}

// countIdentities reports how many oauth identities exist, so a rejected write can
// be shown to have left no row behind.
func countIdentities(t *testing.T, h *oauthHarness) int {
	t.Helper()
	count, err := h.db.Client.UserIdentity.Query().
		Where(useridentity.ProviderIn("github", "google")).
		Count(h.ctx)
	require.NoError(t, err)
	return count
}

func TestOAuthAccountLinkIdentityRejectsUnknownUser(t *testing.T) {
	h := newOAuthHarness(t)

	err := h.store.LinkIdentity(h.ctx, "no-such-user", "github", "1", "")
	require.ErrorIs(t, err, auth.ErrAccountNotFound,
		"an identity without an account would be a login nobody can complete")
	require.Zero(t, countIdentities(t, h))

	err = h.store.LinkIdentity(h.ctx, "  ", "github", "1", "")
	require.Error(t, err)
}

// TestOAuthAccountResolveAgainstRealStore drives the business rule end to end over
// the real persistence port: create, return, and link.
func TestOAuthAccountResolveAgainstRealStore(t *testing.T) {
	h := newOAuthHarness(t)

	created, outcome, err := auth.ResolveOAuthAccount(h.ctx, h.store, h.siteID, "google", auth.OAuthProfile{
		Subject:       "google-ada",
		Email:         "Ada@Example.com",
		EmailVerified: true,
		DisplayName:   "Ada",
		AvatarURL:     "https://cdn.example.com/ada.png",
	})
	require.NoError(t, err)
	require.Equal(t, auth.OutcomeCreatedUser, outcome)
	require.NotEmpty(t, created)

	// The identity decides the login afterwards, even when the provider reports a
	// different address, so a returning visitor always lands on the same account.
	again, outcome, err := auth.ResolveOAuthAccount(h.ctx, h.store, h.siteID, "google", auth.OAuthProfile{
		Subject:       "google-ada",
		Email:         "ada.changed@example.com",
		EmailVerified: true,
	})
	require.NoError(t, err)
	require.Equal(t, auth.OutcomeExistingIdentity, outcome)
	require.Equal(t, created, again)

	// A verified address that already has a password account links the identity to
	// that account instead of creating a second one.
	account, err := h.store.CreateAccountWithEmail(h.ctx, auth.CreateAccountInput{
		SiteID:       h.siteID,
		Email:        "bruno@example.com",
		DisplayName:  "Bruno",
		PasswordHash: "phc-placeholder",
	})
	require.NoError(t, err)

	linked, outcome, err := auth.ResolveOAuthAccount(h.ctx, h.store, h.siteID, "github", auth.OAuthProfile{
		Subject:       "github-bruno",
		Email:         "bruno@example.com",
		EmailVerified: true,
	})
	require.NoError(t, err)
	require.Equal(t, auth.OutcomeLinkedExistingUser, outcome)
	require.Equal(t, account.ID, linked)
}

// TestOAuthAccountFirstLoginCreatesTheSiteMembership is the regression test for
// the original 403: a brand new provider account used to be written without a
// site_members row, so the session build refused the login as not_a_member.
func TestOAuthAccountFirstLoginCreatesTheSiteMembership(t *testing.T) {
	h := newOAuthHarness(t)

	created, outcome, err := auth.ResolveOAuthAccount(h.ctx, h.store, h.siteID, "google", auth.OAuthProfile{
		Subject:       "google-fresh",
		Email:         "fresh@example.com",
		EmailVerified: true,
		DisplayName:   "Fresh",
	})
	require.NoError(t, err)
	require.Equal(t, auth.OutcomeCreatedUser, outcome)

	// The account exists, the identity is bound, and the membership is the row the
	// session build reads; all three are checked so a first login cannot succeed by
	// leaving one of them behind.
	require.Equal(t, 1, countOAuthUsers(t, h))
	found, ok, err := h.store.FindIdentity(h.ctx, "google", "google-fresh")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, created, found)

	member, err := h.db.Client.SiteMember.Query().
		Where(sitemember.SiteIDEQ(h.siteID), sitemember.UserIDEQ(created)).
		Only(h.ctx)
	require.NoError(t, err, "a first provider login must leave a membership row")
	require.Equal(t, "active", member.Status)
	require.Equal(t, string(site.RoleMember), member.Role)
	require.Equal(t, 1, countOAuthMembers(t, h))

	// FindMembershipRole is the exact read the session build performs. It succeeding
	// is what turns the old 403 not_a_member into a session for the new account.
	role, err := h.store.FindMembershipRole(h.ctx, h.siteID, created)
	require.NoError(t, err)
	require.Equal(t, site.RoleMember, role)
}

// TestOAuthAccountClosedRegistrationRefusesFirstLogin proves the registration
// switch also gates provider sign-ups: the account and its membership are refused
// before either row is written, so a closed site stays closed.
func TestOAuthAccountClosedRegistrationRefusesFirstLogin(t *testing.T) {
	h := newOAuthHarness(t)

	_, err := h.db.Client.Site.UpdateOneID(h.siteID).
		SetRegistrationOpen(false).
		Save(h.ctx)
	require.NoError(t, err)

	_, outcome, err := auth.ResolveOAuthAccount(h.ctx, h.store, h.siteID, "google", auth.OAuthProfile{
		Subject:       "google-refused",
		Email:         "refused@example.com",
		EmailVerified: true,
		DisplayName:   "Refused",
	})
	require.ErrorIs(t, err, auth.ErrRegistrationClosed)
	require.Empty(t, outcome)
	// The same rule holds for the store method the resolution builds on: a closed
	// site answers with the sentinel, not with a bare constraint error.
	_, err = h.store.CreateUser(h.ctx, h.siteID, "refused@example.com", "Refused", "")
	require.ErrorIs(t, err, auth.ErrRegistrationClosed)

	require.Zero(t, countOAuthUsers(t, h), "a refused registration must leave no user row")
	require.Zero(t, countOAuthMembers(t, h), "a refused registration must leave no member row")
	require.Zero(t, countIdentities(t, h), "a refused registration must leave no identity row")
}

// TestOAuthAccountCreateUserRejectsUnknownSite keeps the other refusal honest: an
// account is never orphaned on a site id that does not exist.
func TestOAuthAccountCreateUserRejectsUnknownSite(t *testing.T) {
	h := newOAuthHarness(t)

	_, err := h.store.CreateUser(h.ctx, "no-such-site", "orphan@example.com", "Orphan", "")
	require.ErrorIs(t, err, auth.ErrSiteMissing)
	require.Zero(t, countOAuthUsers(t, h))
	require.Zero(t, countOAuthMembers(t, h))
}

// TestOAuthAccountEnsureMembershipIsIdempotent covers the returning-login half of
// the same rule: a second callback must neither duplicate the row nor overwrite a
// decision the site has already made about the member.
func TestOAuthAccountEnsureMembershipIsIdempotent(t *testing.T) {
	h := newOAuthHarness(t)

	userID, err := h.store.CreateUser(h.ctx, h.siteID, "member@example.com", "Member", "")
	require.NoError(t, err)
	require.Equal(t, 1, countOAuthMembers(t, h))

	// A returning login reaches the same call every time; it must be a no-op.
	require.NoError(t, h.store.EnsureMembership(h.ctx, h.siteID, userID))
	require.Equal(t, 1, countOAuthMembers(t, h))

	// An existing row of any status is left exactly as it is: suspending a member
	// is the site's decision, not something a login may undo.
	_, err = h.db.Client.SiteMember.Update().
		Where(sitemember.SiteIDEQ(h.siteID), sitemember.UserIDEQ(userID)).
		SetStatus("suspended").
		SetRole(string(site.RoleEditor)).
		Save(h.ctx)
	require.NoError(t, err)

	require.NoError(t, h.store.EnsureMembership(h.ctx, h.siteID, userID))
	member, err := h.db.Client.SiteMember.Query().
		Where(sitemember.SiteIDEQ(h.siteID), sitemember.UserIDEQ(userID)).
		Only(h.ctx)
	require.NoError(t, err)
	require.Equal(t, "suspended", member.Status)
	require.Equal(t, string(site.RoleEditor), member.Role)
	require.Equal(t, 1, countOAuthMembers(t, h))

	// Closing registration later does not lock the existing member out: the switch
	// gates new rows, not the accounts already on the site.
	_, err = h.db.Client.Site.UpdateOneID(h.siteID).
		SetRegistrationOpen(false).
		Save(h.ctx)
	require.NoError(t, err)
	require.NoError(t, h.store.EnsureMembership(h.ctx, h.siteID, userID))

	// A stranger on the closed site, however, is refused like a first login.
	stranger, err := h.db.Client.User.Create().SetDisplayName("Stranger").Save(h.ctx)
	require.NoError(t, err)
	err = h.store.EnsureMembership(h.ctx, h.siteID, stranger.ID)
	require.ErrorIs(t, err, auth.ErrRegistrationClosed)
	require.Equal(t, 1, countOAuthMembers(t, h), "the refused row must not be written")
}

// countOAuthUsers reports how many accounts the harness holds.
func countOAuthUsers(t *testing.T, h *oauthHarness) int {
	t.Helper()
	count, err := h.db.Client.User.Query().Count(h.ctx)
	require.NoError(t, err)
	return count
}

// countOAuthMembers reports how many membership rows the harness holds.
func countOAuthMembers(t *testing.T, h *oauthHarness) int {
	t.Helper()
	count, err := h.db.Client.SiteMember.Query().Count(h.ctx)
	require.NoError(t, err)
	return count
}

func TestOAuthStateStoreCreateAndConsumeOnce(t *testing.T) {
	h := newOAuthHarness(t)

	state, err := auth.NewOAuthState("site-1", "google", "/admin/content", 10*time.Minute)
	require.NoError(t, err)

	require.NoError(t, h.state.Create(h.ctx, state))
	require.ErrorIs(t, h.state.Create(h.ctx, state), auth.ErrOAuthStateInvalid,
		"a live state must not be overwritten by a second flow")
	require.ErrorIs(t, h.state.Create(h.ctx, auth.OAuthState{}), auth.ErrOAuthStateInvalid,
		"an empty state is not a key")

	consumed, err := h.state.Consume(h.ctx, state.State)
	require.NoError(t, err)
	require.Equal(t, state.State, consumed.State)
	require.Equal(t, "site-1", consumed.SiteID)
	require.Equal(t, "google", consumed.Provider)
	require.Equal(t, "/admin/content", consumed.RedirectTarget)
	require.Equal(t, state.CodeVerifier, consumed.CodeVerifier, "the PKCE verifier must survive the round trip")
	require.NotNil(t, consumed.ConsumedAt, "consume must stamp the row")
	require.True(t, state.CreatedAt.Equal(consumed.CreatedAt))
	require.True(t, state.ExpiresAt.Equal(consumed.ExpiresAt))

	_, err = h.state.Consume(h.ctx, state.State)
	require.ErrorIs(t, err, auth.ErrOAuthStateInvalid, "a state is single use")

	_, err = h.state.Consume(h.ctx, "no-such-state")
	require.ErrorIs(t, err, auth.ErrOAuthStateInvalid, "an unknown state is the same opaque failure")

	// The row is kept after redemption: a replay must be recognisable instead of
	// looking unknown, and only the sweeper removes it.
	require.Equal(t, 1, countOAuthStates(t, h))
}

func TestOAuthStateStoreConsumeExpired(t *testing.T) {
	h := newOAuthHarness(t)
	now := time.Now().UTC()

	expired := auth.OAuthState{
		State:          "expired-state",
		SiteID:         "site-1",
		Provider:       "google",
		RedirectTarget: "/",
		CodeVerifier:   "verifier",
		CreatedAt:      now.Add(-2 * time.Hour),
		ExpiresAt:      now.Add(-time.Hour),
	}
	require.NoError(t, h.state.Create(h.ctx, expired))

	_, err := h.state.Consume(h.ctx, expired.State)
	require.ErrorIs(t, err, auth.ErrOAuthStateInvalid)

	// A rejected attempt is not a redemption: the row must not be stamped, or the
	// sweeper could not tell it apart from one that was really used.
	var consumed sql.NullTime
	require.NoError(t, h.db.SQL().
		QueryRowContext(h.ctx, "SELECT consumed_at FROM oauth_states WHERE state = ?", expired.State).
		Scan(&consumed))
	require.False(t, consumed.Valid)

	// The boundary belongs to the expired side: at the expiry instant the state is
	// already invalid, exactly like the in-memory store.
	due := auth.OAuthState{
		State:     "due-state",
		SiteID:    "site-1",
		Provider:  "google",
		CreatedAt: now.Add(-time.Minute),
		ExpiresAt: now,
	}
	require.NoError(t, h.state.Create(h.ctx, due))
	_, err = h.state.Consume(h.ctx, due.State)
	require.ErrorIs(t, err, auth.ErrOAuthStateInvalid)

	// Just inside the window it still works.
	live := auth.OAuthState{
		State:     "live-state",
		SiteID:    "site-1",
		Provider:  "google",
		CreatedAt: now,
		ExpiresAt: now.Add(time.Minute),
	}
	require.NoError(t, h.state.Create(h.ctx, live))
	_, err = h.state.Consume(h.ctx, live.State)
	require.NoError(t, err)
}

func TestOAuthStateStoreDeleteExpiredSweepsOnlyExpiredRows(t *testing.T) {
	h := newOAuthHarness(t)
	now := time.Now().UTC()

	live := auth.OAuthState{
		State:     "live-state",
		SiteID:    "site-1",
		Provider:  "google",
		CreatedAt: now,
		ExpiresAt: now.Add(time.Hour),
	}
	expired := auth.OAuthState{
		State:     "expired-state",
		SiteID:    "site-1",
		Provider:  "google",
		CreatedAt: now.Add(-2 * time.Hour),
		ExpiresAt: now.Add(-time.Hour),
	}
	require.NoError(t, h.state.Create(h.ctx, live))
	require.NoError(t, h.state.Create(h.ctx, expired))
	require.Equal(t, 2, countOAuthStates(t, h))

	require.NoError(t, h.state.DeleteExpired(h.ctx, now))
	require.Equal(t, 1, countOAuthStates(t, h))

	_, err := h.state.Consume(h.ctx, expired.State)
	require.ErrorIs(t, err, auth.ErrOAuthStateInvalid, "the swept row is gone")

	_, err = h.state.Consume(h.ctx, live.State)
	require.NoError(t, err, "a live row must survive the sweep")
}

func TestOAuthStateStoreConcurrentConsumeHasOneWinner(t *testing.T) {
	h := newOAuthHarness(t)

	state, err := auth.NewOAuthState("site-1", "google", "/", 10*time.Minute)
	require.NoError(t, err)
	require.NoError(t, h.state.Create(h.ctx, state))

	const attempts = 8
	var wait sync.WaitGroup
	errs := make([]error, attempts)
	for i := 0; i < attempts; i++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			_, errs[index] = h.state.Consume(context.Background(), state.State)
		}(i)
	}
	wait.Wait()

	winners := 0
	for _, err := range errs {
		switch {
		case err == nil:
			winners++
		case errors.Is(err, auth.ErrOAuthStateInvalid):
			// An expected loser: the conditional update matched no row.
		default:
			t.Fatalf("concurrent Consume error = %v, want nil or ErrOAuthStateInvalid", err)
		}
	}
	require.Equal(t, 1, winners, "exactly one callback may redeem a state")
}
