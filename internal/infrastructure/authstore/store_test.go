package authstore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/platform/config"
	"github.com/practacu/practacu-press/internal/site"

	"github.com/practacu/practacu-press/internal/ent/sitemember"
)

// harness wires the real Ent store, a real SQLite database and the real token
// issuer. Only the password hasher is cheapened so tests stay fast.
type harness struct {
	ctx     context.Context
	service *auth.Service
	db      *db.DB
	issuer  *auth.TokenIssuer
	siteID  string
}

func newHarness(t *testing.T) *harness {
	return newHarnessWith(t, nil)
}

// newHarnessWith lets a test change the service configuration before it is built.
func newHarnessWith(t *testing.T, tweak func(*auth.ServiceConfig)) *harness {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "auth.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })

	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	issuer, _, err := auth.NewTokenIssuer(config.Config{
		AppEnv:        config.EnvTest,
		AuthJWTIssuer: "test-issuer",
	})
	require.NoError(t, err)

	cfg := auth.ServiceConfig{
		Repository: authstore.New(handle.Client),
		Hasher: auth.NewArgon2idHasher(auth.Argon2Params{
			Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32,
		}),
		Tokens: issuer,
	}
	if tweak != nil {
		tweak(&cfg)
	}

	service, err := auth.NewService(cfg)
	require.NoError(t, err)

	return &harness{ctx: ctx, service: service, db: handle, issuer: issuer, siteID: siteRow.ID}
}

func (h *harness) register(t *testing.T, email string) auth.Session {
	t.Helper()
	session, err := h.service.RegisterEmail(h.ctx, h.siteID, auth.RegisterEmailInput{
		Email:       email,
		Password:    "correct horse battery",
		DisplayName: "Alice",
		ClientMeta:  auth.ClientMeta{UserAgent: "test-agent", IPAddress: "203.0.113.7"},
	})
	require.NoError(t, err)
	return session
}

func TestRegisterIssuesUsableSession(t *testing.T) {
	h := newHarness(t)

	session := h.register(t, "Alice@Example.com")

	require.NotEmpty(t, session.AccessToken)
	require.NotEmpty(t, session.RefreshToken)
	require.NotEmpty(t, session.CSRFToken)
	require.Equal(t, "Alice", session.User.DisplayName)

	principal, err := h.issuerVerify(session.AccessToken)
	require.NoError(t, err)
	require.Equal(t, session.User.ID, principal.UserID)
	require.Equal(t, h.siteID, principal.SiteID)
	require.Equal(t, site.RoleMember, principal.Role)
}

func TestBootstrapFirstAdminPromotesOnlyTheFirstAccount(t *testing.T) {
	h := newHarnessWith(t, func(cfg *auth.ServiceConfig) {
		cfg.BootstrapFirstAdmin = true
	})

	// The transport layer only sets AllowFirstAdmin for a loopback caller; the store
	// level test plays that role directly.
	owner, err := h.service.RegisterEmail(h.ctx, h.siteID, auth.RegisterEmailInput{
		Email:           "owner@example.com",
		Password:        "correct horse battery",
		DisplayName:     "Owner",
		AllowFirstAdmin: true,
	})
	require.NoError(t, err)
	member := h.register(t, "member@example.com")

	ownerPrincipal, err := h.issuerVerify(owner.AccessToken)
	require.NoError(t, err)
	require.Equal(t, site.RolePlatformAdmin, ownerPrincipal.Role,
		"the first account of a desktop install must be able to administer the site")

	memberPrincipal, err := h.issuerVerify(member.AccessToken)
	require.NoError(t, err)
	require.Equal(t, site.RoleMember, memberPrincipal.Role,
		"later accounts keep the plain member role")
}

// TestBootstrapFirstAdminRequiresLocalAccess is the V-16 regression: a fresh install
// that is reachable over the network must not hand the owner role to whoever registers
// first. The request must be refused before any account is created.
func TestBootstrapFirstAdminRequiresLocalAccess(t *testing.T) {
	h := newHarnessWith(t, func(cfg *auth.ServiceConfig) {
		cfg.BootstrapFirstAdmin = true
	})

	_, err := h.service.RegisterEmail(h.ctx, h.siteID, auth.RegisterEmailInput{
		Email:       "attacker@example.com",
		Password:    "correct horse battery",
		DisplayName: "Attacker",
	})
	require.ErrorIs(t, err, auth.ErrInstallRequiresLocalAccess)

	members, err := h.db.Client.SiteMember.Query().Count(h.ctx)
	require.NoError(t, err)
	require.Zero(t, members, "a refused bootstrap must not create an account")
}

func TestRegisterRejectsDuplicateEmailCaseInsensitively(t *testing.T) {
	h := newHarness(t)
	h.register(t, "alice@example.com")

	_, err := h.service.RegisterEmail(h.ctx, h.siteID, auth.RegisterEmailInput{
		Email:       "ALICE@example.com",
		Password:    "correct horse battery",
		DisplayName: "Other Alice",
	})
	require.ErrorIs(t, err, auth.ErrIdentityExists)
}

func TestRegisterRequiresExistingSite(t *testing.T) {
	h := newHarness(t)

	_, err := h.service.RegisterEmail(h.ctx, "no-such-site", auth.RegisterEmailInput{
		Email:       "bob@example.com",
		Password:    "correct horse battery",
		DisplayName: "Bob",
	})
	require.ErrorIs(t, err, auth.ErrSiteMissing)
}

func TestRegisterValidatesInput(t *testing.T) {
	h := newHarness(t)

	_, err := h.service.RegisterEmail(h.ctx, h.siteID, auth.RegisterEmailInput{
		Email: "not-an-email", Password: "long enough password", DisplayName: "X",
	})
	require.ErrorIs(t, err, auth.ErrInvalidInput)

	_, err = h.service.RegisterEmail(h.ctx, h.siteID, auth.RegisterEmailInput{
		Email: "ok@example.com", Password: "Aa1!Aa1!Aa1", DisplayName: "X", // 11 runes
	})
	require.ErrorIs(t, err, auth.ErrInvalidInput)
}

func TestLoginSucceedsAndIssuesNewFamily(t *testing.T) {
	h := newHarness(t)
	registered := h.register(t, "alice@example.com")

	loggedIn, err := h.service.LoginPassword(h.ctx, h.siteID, auth.LoginInput{
		Email:    "ALICE@example.com",
		Password: "correct horse battery",
	})
	require.NoError(t, err)
	require.Equal(t, registered.User.ID, loggedIn.User.ID)
	require.NotEqual(t, registered.RefreshToken, loggedIn.RefreshToken)
}

func TestLoginRejectsWrongPasswordAndUnknownAccountIdentically(t *testing.T) {
	h := newHarness(t)
	h.register(t, "alice@example.com")

	_, errWrong := h.service.LoginPassword(h.ctx, h.siteID, auth.LoginInput{
		Email: "alice@example.com", Password: "wrong password",
	})
	_, errUnknown := h.service.LoginPassword(h.ctx, h.siteID, auth.LoginInput{
		Email: "nobody@example.com", Password: "wrong password",
	})

	require.ErrorIs(t, errWrong, auth.ErrInvalidCredentials)
	require.ErrorIs(t, errUnknown, auth.ErrInvalidCredentials)
	require.Equal(t, errWrong.Error(), errUnknown.Error(),
		"responses must not reveal whether the account exists")
}

func TestRefreshRotatesToken(t *testing.T) {
	h := newHarness(t)
	first := h.register(t, "alice@example.com")

	second, err := h.service.Refresh(h.ctx, h.siteID, first.RefreshToken)
	require.NoError(t, err)
	require.NotEqual(t, first.RefreshToken, second.RefreshToken)

	// The rotated token is no longer usable.
	_, err = h.service.Refresh(h.ctx, h.siteID, first.RefreshToken)
	require.ErrorIs(t, err, auth.ErrRefreshReuse)
}

// TestRefreshReuseRevokesWholeFamily is the P0-1 regression: a replayed refresh
// token must invalidate every token descended from the same login, including the
// one the legitimate client just received.
func TestRefreshReuseRevokesWholeFamily(t *testing.T) {
	h := newHarness(t)
	first := h.register(t, "alice@example.com")

	second, err := h.service.Refresh(h.ctx, h.siteID, first.RefreshToken)
	require.NoError(t, err)

	// Attacker replays the stolen, already rotated token.
	_, err = h.service.Refresh(h.ctx, h.siteID, first.RefreshToken)
	require.ErrorIs(t, err, auth.ErrRefreshReuse)

	// The legitimate successor is now revoked too: the lineage is burned.
	_, err = h.service.Refresh(h.ctx, h.siteID, second.RefreshToken)
	require.ErrorIs(t, err, auth.ErrSessionRevoked)
}

func TestRefreshRejectsUnknownToken(t *testing.T) {
	h := newHarness(t)

	_, err := h.service.Refresh(h.ctx, h.siteID, "not-a-real-token")
	require.ErrorIs(t, err, auth.ErrSessionRevoked)
}

func TestRefreshRejectsSessionFromAnotherSite(t *testing.T) {
	h := newHarness(t)
	session := h.register(t, "alice@example.com")

	otherSite, err := h.db.Client.Site.Create().SetSlug("other").SetName("Other").Save(h.ctx)
	require.NoError(t, err)

	_, err = h.service.Refresh(h.ctx, otherSite.ID, session.RefreshToken)
	require.ErrorIs(t, err, auth.ErrSessionRevoked)
}

func TestLogoutRevokesSession(t *testing.T) {
	h := newHarness(t)
	session := h.register(t, "alice@example.com")

	require.NoError(t, h.service.Logout(h.ctx, session.RefreshToken))

	_, err := h.service.Refresh(h.ctx, h.siteID, session.RefreshToken)
	require.ErrorIs(t, err, auth.ErrSessionRevoked)

	// Logout is idempotent.
	require.NoError(t, h.service.Logout(h.ctx, session.RefreshToken))
	require.NoError(t, h.service.Logout(h.ctx, ""))
}

func TestRefreshUsesCurrentMembershipRole(t *testing.T) {
	h := newHarness(t)
	session := h.register(t, "alice@example.com")

	_, err := h.db.Client.SiteMember.Update().
		Where(sitemember.SiteIDEQ(h.siteID)).
		SetRole(string(site.RoleEditor)).
		Save(h.ctx)
	require.NoError(t, err)

	refreshed, err := h.service.Refresh(h.ctx, h.siteID, session.RefreshToken)
	require.NoError(t, err)

	principal, err := h.issuerVerify(refreshed.AccessToken)
	require.NoError(t, err)
	require.Equal(t, site.RoleEditor, principal.Role,
		"a role change must take effect at the next refresh")
}

func TestSuspendedMembershipBlocksSessionIssue(t *testing.T) {
	h := newHarness(t)
	h.register(t, "alice@example.com")

	_, err := h.db.Client.SiteMember.Update().
		Where(sitemember.SiteIDEQ(h.siteID)).
		SetStatus("suspended").
		Save(h.ctx)
	require.NoError(t, err)

	_, err = h.service.LoginPassword(h.ctx, h.siteID, auth.LoginInput{
		Email:    "alice@example.com",
		Password: "correct horse battery",
	})
	require.ErrorIs(t, err, auth.ErrPermissionToSite)
}

// TestFamilyCreatedAtIsStableAcrossRotation proves the query that backs the refresh
// lineage's absolute lifetime: the oldest row's created_at, unaffected by rotation.
func TestFamilyCreatedAtIsStableAcrossRotation(t *testing.T) {
	h := newHarness(t)
	registered := h.register(t, "alice@example.com")
	store := authstore.New(h.db.Client)

	root, err := store.FindSessionByHash(h.ctx, auth.HashOpaqueToken(registered.RefreshToken))
	require.NoError(t, err)

	createdAt, err := store.FamilyCreatedAt(h.ctx, root.FamilyID)
	require.NoError(t, err)
	require.WithinDuration(t, registered.RefreshExpiresAt.Add(-auth.RefreshTTL), createdAt,
		2*time.Second, "a fresh lineage is born when the session is created")

	rotated, err := h.service.Refresh(h.ctx, h.siteID, registered.RefreshToken)
	require.NoError(t, err)
	next, err := store.FindSessionByHash(h.ctx, auth.HashOpaqueToken(rotated.RefreshToken))
	require.NoError(t, err)
	require.Equal(t, root.FamilyID, next.FamilyID)

	afterRotation, err := store.FamilyCreatedAt(h.ctx, next.FamilyID)
	require.NoError(t, err)
	require.Equal(t, createdAt.UTC(), afterRotation.UTC(),
		"rotation must inherit the lineage birth time instead of resetting it")

	_, err = store.FamilyCreatedAt(h.ctx, "no-such-family")
	require.ErrorIs(t, err, auth.ErrSessionNotFound)
}

// issuerVerify re-verifies a token with the harness issuer.
func (h *harness) issuerVerify(token string) (auth.Principal, error) {
	return h.issuer.VerifyAccess(token)
}
