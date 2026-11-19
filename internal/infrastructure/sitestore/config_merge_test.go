package sitestore_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/site"
)

// TestSaveSiteConfigKeepsServerOwnedSections is the regression for the step-up
// feature: `site_configs` is one JSON document, and a client that saves only the
// documented settings must not erase the `step_up` section the server wrote. Without
// the merge in SaveSiteConfig, an ordinary settings save would silently switch the
// high threat protection off (and drop the dedicated password hash).
func TestSaveSiteConfigKeepsServerOwnedSections(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	const stepUpSection = `{"enabled":true,"password_hash":"$argon2id$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA","updated_at":"2026-01-01T00:00:00Z"}`
	first, err := store.SaveSiteConfig(ctx, siteRow.ID, site.SiteConfigInput{
		Document: []byte(`{"admin_path":"/manage","step_up":` + stepUpSection + `,"future_section":{"a":1}}`),
	}, configAuditFor(siteRow.ID))
	require.NoError(t, err)
	require.Equal(t, 1, first.Revision)

	// The browser saves the settings it knows: no step_up, no unknown future section.
	second, err := store.SaveSiteConfig(ctx, siteRow.ID, site.SiteConfigInput{
		Document:         []byte(`{"admin_path":"/ops"}`),
		ExpectedRevision: 1,
	}, configAuditFor(siteRow.ID))
	require.NoError(t, err)
	require.Equal(t, 2, second.Revision)
	require.JSONEq(t,
		`{"admin_path":"/ops","step_up":`+stepUpSection+`,"future_section":{"a":1}}`,
		string(second.Document),
		"the store must merge back every top level key the caller did not send")

	// A later ordinary save keeps working the same way.
	third, err := store.SaveSiteConfig(ctx, siteRow.ID, site.SiteConfigInput{
		Document:         []byte(`{"admin_path":"/console","loading":{"enabled":true}}`),
		ExpectedRevision: 2,
	}, configAuditFor(siteRow.ID))
	require.NoError(t, err)
	require.Equal(t, 3, third.Revision)
	require.Contains(t, string(third.Document), `"step_up"`)
	require.Contains(t, string(third.Document), `"future_section"`)
	require.Contains(t, string(third.Document), `"loading"`)
}

// TestSaveSiteConfigStoresAnOrdinaryDocumentVerbatim keeps the byte-for-byte guarantee
// for a normal save: the merge only rewrites the document when it actually has
// something to add.
func TestSaveSiteConfigStoresAnOrdinaryDocumentVerbatim(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	first, err := store.SaveSiteConfig(ctx, siteRow.ID, site.SiteConfigInput{
		Document: []byte(`{"admin_path":"/manage"}`),
	}, configAuditFor(siteRow.ID))
	require.NoError(t, err)
	require.Equal(t, 1, first.Revision)

	stored, err := store.SaveSiteConfig(ctx, siteRow.ID, site.SiteConfigInput{
		Document:         []byte(`{"admin_path":"/ops"}`),
		ExpectedRevision: 1,
	}, configAuditFor(siteRow.ID))
	require.NoError(t, err)
	require.Equal(t, `{"admin_path":"/ops"}`, string(stored.Document))
}
