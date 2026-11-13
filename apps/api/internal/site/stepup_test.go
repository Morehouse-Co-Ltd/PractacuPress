package site

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeStepUpHasher stores a reversible encoding so a test can prove a hash (not the
// plaintext) reached the repository.
type fakeStepUpHasher struct {
	hashed []string
}

// Hash implements StepUpPasswordHasher.
func (h *fakeStepUpHasher) Hash(_ context.Context, plain string) (string, error) {
	h.hashed = append(h.hashed, plain)
	return "hashed$" + plain, nil
}

// Verify implements StepUpPasswordHasher.
func (h *fakeStepUpHasher) Verify(_ context.Context, plain, encoded string) (bool, error) {
	return encoded == "hashed$"+plain, nil
}

// fakeStepUpTokens accepts only the grants it was told about, bound to one account
// and one site exactly like the real signer.
type fakeStepUpTokens struct {
	grants map[string]string
}

// Verify implements StepUpTokenVerifier.
func (f *fakeStepUpTokens) Verify(raw, userID, siteID string) bool {
	if f.grants == nil {
		return false
	}
	return f.grants[raw] == userID+"/"+siteID
}

func (f *fakeStepUpTokens) mint(userID, siteID string) string {
	if f.grants == nil {
		f.grants = map[string]string{}
	}
	raw := "grant:" + userID + ":" + siteID
	f.grants[raw] = userID + "/" + siteID
	return raw
}

func newStepUpService(t *testing.T, repo Repository, hasher StepUpPasswordHasher, tokens StepUpTokenVerifier) *Service {
	t.Helper()
	return newServiceWithOptions(t, repo, WithStepUpPasswordHasher(hasher), WithStepUpTokens(tokens))
}

// storedStepUp reads the masked service view and the raw stored document.
func storedStepUp(t *testing.T, repo *fakeRepo, siteID string) (StepUpSettings, SiteConfig) {
	t.Helper()
	saved, ok := repo.siteConfig[siteID]
	require.True(t, ok, "the step-up write must have stored a configuration")
	settings, err := stepUpSettingsOf(saved.Document)
	require.NoError(t, err)
	return settings, saved
}

func TestStepUpStatusDefaultsToOff(t *testing.T) {
	repo := newFakeRepo()
	service := newStepUpService(t, repo, &fakeStepUpHasher{}, &fakeStepUpTokens{})
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	status, err := service.StepUpStatus(context.Background(), admin, "s1")
	require.NoError(t, err)
	require.False(t, status.Enabled)
	require.False(t, status.PasswordSet)
	require.Equal(t, int(StepUpTokenTTL/time.Second), status.WindowSeconds)
	require.Equal(t, 300, status.WindowSeconds)
}

func TestStepUpFirstSaveNeedsNoGrant(t *testing.T) {
	repo := newFakeRepo()
	hasher := &fakeStepUpHasher{}
	tokens := &fakeStepUpTokens{}
	service := newStepUpService(t, repo, hasher, tokens)
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	enabled := true
	password := "site security password"
	status, err := service.UpdateStepUpSettings(context.Background(), admin, "s1", StepUpSettingsInput{
		Enabled:  &enabled,
		Password: &password,
	}, "", "req-1")
	require.NoError(t, err, "enabling protection for the first time cannot require a grant it could not mint yet")
	require.True(t, status.Enabled)
	require.True(t, status.PasswordSet)

	settings, _ := storedStepUp(t, repo, "s1")
	require.True(t, settings.Enabled)
	require.Equal(t, "hashed$"+password, settings.PasswordHash,
		"the plaintext must be hashed before it is stored")
	require.False(t, settings.UpdatedAt.IsZero())

	// The audit entry names the switch but never the password or its hash.
	audit := repo.audits[len(repo.audits)-1]
	require.Equal(t, "site.stepup.updated", audit.Action)
	rendered := strings.TrimSpace(strings.Join([]string{
		audit.Target, audit.RequestID, marshalAuditDetail(t, audit.Detail),
	}, " "))
	require.NotContains(t, rendered, password)
	require.NotContains(t, rendered, settings.PasswordHash)
}

// marshalAuditDetail renders an audit detail map for substring assertions.
func marshalAuditDetail(t *testing.T, detail map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(detail)
	require.NoError(t, err)
	return string(raw)
}

func TestStepUpChangeRequiresGrantOnceEnabled(t *testing.T) {
	repo := newFakeRepo()
	tokens := &fakeStepUpTokens{}
	service := newStepUpService(t, repo, &fakeStepUpHasher{}, tokens)
	admin := activeMember("s1", "u1", RoleSiteAdmin)
	ctx := context.Background()

	enabled := true
	_, err := service.UpdateStepUpSettings(ctx, admin, "s1", StepUpSettingsInput{Enabled: &enabled}, "", "req")
	require.NoError(t, err)

	disabled := false
	_, err = service.UpdateStepUpSettings(ctx, admin, "s1", StepUpSettingsInput{Enabled: &disabled}, "", "req")
	require.ErrorIs(t, err, ErrStepUpRequired,
		"disabling protection without a grant would let a stolen session weaken the site")

	settings, _ := storedStepUp(t, repo, "s1")
	require.True(t, settings.Enabled, "the refused change must not have been applied")

	status, err := service.UpdateStepUpSettings(ctx, admin, "s1", StepUpSettingsInput{
		Enabled: &disabled,
	}, tokens.mint("u1", "s1"), "req")
	require.NoError(t, err)
	require.False(t, status.Enabled)
}

func TestStepUpChangeRequiresGrantWhenOnlyPasswordWasSet(t *testing.T) {
	repo := newFakeRepo()
	service := newStepUpService(t, repo, &fakeStepUpHasher{}, &fakeStepUpTokens{})
	admin := activeMember("s1", "u1", RoleSiteAdmin)
	ctx := context.Background()

	password := "dedicated"
	_, err := service.UpdateStepUpSettings(ctx, admin, "s1", StepUpSettingsInput{
		Password: &password,
	}, "", "req")
	require.NoError(t, err, "the first save of a fresh site is allowed without a grant")

	enabled := true
	_, err = service.UpdateStepUpSettings(ctx, admin, "s1", StepUpSettingsInput{
		Enabled: &enabled,
	}, "", "req")
	require.ErrorIs(t, err, ErrStepUpRequired,
		"a site with a dedicated password must not be changed without re-authenticating")
}

func TestStepUpRejectsGrantsForAnotherUserOrSite(t *testing.T) {
	repo := newFakeRepo()
	tokens := &fakeStepUpTokens{}
	service := newStepUpService(t, repo, &fakeStepUpHasher{}, tokens)
	admin := activeMember("s1", "u1", RoleSiteAdmin)
	ctx := context.Background()

	enabled := true
	_, err := service.UpdateStepUpSettings(ctx, admin, "s1", StepUpSettingsInput{Enabled: &enabled}, "", "req")
	require.NoError(t, err)

	disabled := false
	_, err = service.UpdateStepUpSettings(ctx, admin, "s1",
		StepUpSettingsInput{Enabled: &disabled}, tokens.mint("u2", "s1"), "req")
	require.ErrorIs(t, err, ErrStepUpRequired, "a grant minted for another account must not authorize this caller")

	_, err = service.UpdateStepUpSettings(ctx, admin, "s1",
		StepUpSettingsInput{Enabled: &disabled}, tokens.mint("u1", "s2"), "req")
	require.ErrorIs(t, err, ErrStepUpRequired, "a grant minted on another site must not authorize this site")

	_, err = service.UpdateStepUpSettings(ctx, admin, "s1",
		StepUpSettingsInput{Enabled: &disabled}, "expired-or-forged", "req")
	require.ErrorIs(t, err, ErrStepUpRequired, "an unknown grant must not authorize anything")
}

func TestStepUpUpdateKeepsOtherConfigKeys(t *testing.T) {
	repo := newFakeRepo()
	repo.siteConfig["s1"] = SiteConfig{
		Document:  []byte(`{"admin_path":"/manage","note":"keep me"}`),
		Revision:  3,
		UpdatedAt: time.Now().UTC(),
	}
	service := newStepUpService(t, repo, &fakeStepUpHasher{}, &fakeStepUpTokens{})
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	enabled := true
	_, err := service.UpdateStepUpSettings(context.Background(), admin, "s1",
		StepUpSettingsInput{Enabled: &enabled}, "", "req")
	require.NoError(t, err)

	saved := repo.siteConfig["s1"]
	require.Equal(t, 4, saved.Revision, "the write must build on the stored revision")
	var document map[string]any
	require.NoError(t, json.Unmarshal(saved.Document, &document))
	require.Equal(t, "/manage", document["admin_path"])
	require.Equal(t, "keep me", document["note"])
	require.Contains(t, document, stepUpDocumentKey)
}

func TestStepUpPasswordHashIsReadableButNeverProjected(t *testing.T) {
	repo := newFakeRepo()
	service := newStepUpService(t, repo, &fakeStepUpHasher{}, &fakeStepUpTokens{})
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	password := "dedicated"
	_, err := service.UpdateStepUpSettings(context.Background(), admin, "s1",
		StepUpSettingsInput{Password: &password}, "", "req")
	require.NoError(t, err)

	hash, err := service.StepUpPasswordHash(context.Background(), "s1")
	require.NoError(t, err)
	require.Equal(t, "hashed$"+password, hash)

	settings, stored := storedStepUp(t, repo, "s1")

	// The administrator projection masks the section; the public projection drops it.
	adminView, err := SanitizeSiteConfigForAdmin(stored.Document)
	require.NoError(t, err)
	require.NotContains(t, string(adminView), "password_hash")
	require.NotContains(t, string(adminView), hash)
	var adminDocument map[string]any
	require.NoError(t, json.Unmarshal(adminView, &adminDocument))
	stepUp, ok := adminDocument[stepUpDocumentKey].(map[string]any)
	require.True(t, ok)
	require.Equal(t, false, stepUp["enabled"])
	require.Equal(t, true, stepUp["password_set"])
	require.NotContains(t, stepUp, "password_hash")

	publicView, err := PublicSiteConfig(stored.Document)
	require.NoError(t, err)
	require.NotContains(t, string(publicView), stepUpDocumentKey)
	require.NotContains(t, string(publicView), hash)
	require.False(t, settings.Enabled)
}

func TestStepUpClientSaveCannotWriteTheSection(t *testing.T) {
	repo := newFakeRepo()
	service := newStepUpService(t, repo, &fakeStepUpHasher{}, &fakeStepUpTokens{})
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	// A client round-trips a masked projection (or tries to switch protection off by
	// writing the section directly): the service strips it before storage.
	document := []byte(`{"admin_path":"/ops","step_up":{"enabled":false,"password_set":false}}`)
	_, err := service.SaveSiteConfig(context.Background(), admin, "s1", document, 0, "req")
	require.NoError(t, err)

	stored := repo.siteConfig["s1"]
	require.NotContains(t, string(stored.Document), stepUpDocumentKey,
		"only the step-up service may write the step_up section")
	require.Contains(t, string(stored.Document), "/ops")
}

func TestUpdateStepUpRejectsPasswordAndClearTogether(t *testing.T) {
	repo := newFakeRepo()
	service := newStepUpService(t, repo, &fakeStepUpHasher{}, &fakeStepUpTokens{})
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	password := "x"
	_, err := service.UpdateStepUpSettings(context.Background(), admin, "s1", StepUpSettingsInput{
		Password:      &password,
		ClearPassword: true,
	}, "", "req")
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestUpdateStepUpRejectsEmptyOrOversizedPasswords(t *testing.T) {
	repo := newFakeRepo()
	service := newStepUpService(t, repo, &fakeStepUpHasher{}, &fakeStepUpTokens{})
	admin := activeMember("s1", "u1", RoleSiteAdmin)
	ctx := context.Background()

	empty := ""
	_, err := service.UpdateStepUpSettings(ctx, admin, "s1",
		StepUpSettingsInput{Password: &empty}, "", "req")
	require.ErrorIs(t, err, ErrInvalidInput)

	huge := strings.Repeat("x", maxStepUpPasswordBytes+1)
	_, err = service.UpdateStepUpSettings(ctx, admin, "s1",
		StepUpSettingsInput{Password: &huge}, "", "req")
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestUpdateStepUpFailsClosedWithoutHasher(t *testing.T) {
	repo := newFakeRepo()
	service := newServiceWithOptions(t, repo, WithStepUpTokens(&fakeStepUpTokens{}))
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	password := "dedicated"
	_, err := service.UpdateStepUpSettings(context.Background(), admin, "s1",
		StepUpSettingsInput{Password: &password}, "", "req")
	require.ErrorIs(t, err, ErrStepUpUnavailable)
}

func TestStepUpRequiresManageSite(t *testing.T) {
	repo := newFakeRepo()
	service := newStepUpService(t, repo, &fakeStepUpHasher{}, &fakeStepUpTokens{})
	editor := activeMember("s1", "u2", RoleEditor)
	ctx := context.Background()

	_, err := service.StepUpStatus(ctx, editor, "s1")
	require.ErrorIs(t, err, ErrPermissionDenied)

	enabled := true
	_, err = service.UpdateStepUpSettings(ctx, editor, "s1",
		StepUpSettingsInput{Enabled: &enabled}, "", "req")
	require.ErrorIs(t, err, ErrPermissionDenied)
	require.Empty(t, repo.siteConfig, "a denied write must not store anything")
}

func TestStepUpEnabledReadsTheStoredSwitch(t *testing.T) {
	repo := newFakeRepo()
	service := newStepUpService(t, repo, &fakeStepUpHasher{}, &fakeStepUpTokens{})
	ctx := context.Background()

	enabled, err := service.StepUpEnabled(ctx, "s1")
	require.NoError(t, err)
	require.False(t, enabled)

	repo.siteConfig["s1"] = SiteConfig{
		Document: []byte(`{"step_up":{"enabled":true,"password_hash":"hashed$x","updated_at":"2026-01-01T00:00:00Z"}}`),
		Revision: 2,
	}
	enabled, err = service.StepUpEnabled(ctx, "s1")
	require.NoError(t, err)
	require.True(t, enabled)

	// A corrupt section must fail closed with an error, never read as "off".
	repo.siteConfig["s1"] = SiteConfig{Document: []byte(`{"step_up":"not-an-object"}`), Revision: 3}
	_, err = service.StepUpEnabled(ctx, "s1")
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestVerifyStepUpTokenDelegatesToTheSigner(t *testing.T) {
	repo := newFakeRepo()
	tokens := &fakeStepUpTokens{}
	service := newStepUpService(t, repo, &fakeStepUpHasher{}, tokens)

	grant := tokens.mint("u1", "s1")
	require.True(t, service.VerifyStepUpToken(grant, "u1", "s1"))
	require.False(t, service.VerifyStepUpToken(grant, "u2", "s1"))

	unwired := newService(t, repo)
	require.False(t, unwired.VerifyStepUpToken(grant, "u1", "s1"))
}
