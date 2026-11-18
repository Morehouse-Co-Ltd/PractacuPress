package sitestore_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/ent/auditlog"
	"github.com/practacu/practacu-press/internal/site"
)

func configAuditFor(siteID string) site.AuditEntry {
	return site.AuditEntry{
		SiteID:    siteID,
		ActorID:   "u1",
		Action:    "site.config.updated",
		Target:    siteID,
		RequestID: "req-1",
		Detail:    map[string]any{"bytes": 2},
		At:        auditFor(siteID).At,
	}
}

func TestSaveSiteConfigCreatesThenUpdates(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	first, err := store.SaveSiteConfig(ctx, siteRow.ID, site.SiteConfigInput{
		Document: []byte(`{"admin_path":"/manage"}`),
	}, configAuditFor(siteRow.ID))
	require.NoError(t, err)
	require.Equal(t, 1, first.Revision)
	require.JSONEq(t, `{"admin_path":"/manage"}`, string(first.Document))

	second, err := store.SaveSiteConfig(ctx, siteRow.ID, site.SiteConfigInput{
		Document:         []byte(`{"admin_path":"/ops"}`),
		ExpectedRevision: 1,
	}, configAuditFor(siteRow.ID))
	require.NoError(t, err)
	require.Equal(t, 2, second.Revision)

	stored, err := store.SiteConfig(ctx, siteRow.ID)
	require.NoError(t, err)
	require.Equal(t, 2, stored.Revision)
	require.JSONEq(t, `{"admin_path":"/ops"}`, string(stored.Document))
}

// TestSaveSiteConfigRejectsStaleRevision is the store level guard for the two-device
// case: the access rules saved on a laptop must not be silently replaced by a phone that
// still holds the previous revision.
func TestSaveSiteConfigRejectsStaleRevision(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	_, err = store.SaveSiteConfig(ctx, siteRow.ID, site.SiteConfigInput{
		Document: []byte(`{"v":1}`),
	}, configAuditFor(siteRow.ID))
	require.NoError(t, err)

	_, err = store.SaveSiteConfig(ctx, siteRow.ID, site.SiteConfigInput{
		Document:         []byte(`{"v":2,"device":"phone"}`),
		ExpectedRevision: 1,
	}, configAuditFor(siteRow.ID))
	require.NoError(t, err)

	_, err = store.SaveSiteConfig(ctx, siteRow.ID, site.SiteConfigInput{
		Document:         []byte(`{"v":2,"device":"laptop"}`),
		ExpectedRevision: 1,
	}, configAuditFor(siteRow.ID))
	require.ErrorIs(t, err, site.ErrSiteConfigConflict)

	stored, err := store.SiteConfig(ctx, siteRow.ID)
	require.NoError(t, err)
	require.JSONEq(t, `{"v":2,"device":"phone"}`, string(stored.Document),
		"the refused write must not have changed the document")
}

func TestSiteConfigReadIsNotFoundForFreshSite(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	_, err = store.SiteConfig(ctx, siteRow.ID)
	require.ErrorIs(t, err, site.ErrSiteConfigNotFound)
}

// TestSaveSiteConfigWritesTheAuditEntry keeps the operator trail in the same transaction
// as the configuration.
func TestSaveSiteConfigWritesTheAuditEntry(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	_, err = store.SaveSiteConfig(ctx, siteRow.ID, site.SiteConfigInput{
		Document: []byte(`{"v":1}`),
	}, configAuditFor(siteRow.ID))
	require.NoError(t, err)

	rows, err := handle.Client.AuditLog.Query().
		Where(auditlog.ActionEQ("site.config.updated")).
		All(ctx)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.NotNil(t, rows[0].ActorID)
	require.Equal(t, "u1", *rows[0].ActorID)
}
