package authstore_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/site"

	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
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

	service, err := auth.NewService(auth.ServiceConfig{
		Repository: authstore.New(handle.Client),
		Hasher: auth.NewArgon2idHasher(auth.Argon2Params{
			Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32,
		}),
		Tokens: issuer,
	})
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
		Email: "ok@example.com", Password: "short", DisplayName: "X",
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

// issuerVerify re-verifies a token with the harness issuer.
func (h *harness) issuerVerify(token string) (auth.Principal, error) {
	return h.issuer.VerifyAccess(token)
}

