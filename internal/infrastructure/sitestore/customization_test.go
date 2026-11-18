package sitestore_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/ent/auditlog"
	"github.com/practacu/practacu-press/internal/site"
)

func auditFor(siteID string) site.AuditEntry {
	return site.AuditEntry{
		SiteID:    siteID,
		ActorID:   "u1",
		Action:    "site.customization.updated",
		Target:    siteID,
		RequestID: "req-1",
		Detail:    map[string]any{"bytes": 3},
		At:        time.Now().UTC(),
	}
}

func TestSaveCustomizationCreatesThenUpdates(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	first, err := store.SaveCustomization(ctx, siteRow.ID, site.CustomizationInput{
		Document: []byte(`{"theme":{"preset":"paper"}}`),
	}, auditFor(siteRow.ID))
	require.NoError(t, err)
	require.Equal(t, 1, first.Revision)
	require.JSONEq(t, `{"theme":{"preset":"paper"}}`, string(first.Document))

	second, err := store.SaveCustomization(ctx, siteRow.ID, site.CustomizationInput{
		Document:         []byte(`{"theme":{"preset":"night"}}`),
		ExpectedRevision: 1,
	}, auditFor(siteRow.ID))
	require.NoError(t, err)
	require.Equal(t, 2, second.Revision)

	stored, err := store.Customization(ctx, siteRow.ID)
	require.NoError(t, err)
	require.Equal(t, 2, stored.Revision)
	require.JSONEq(t, `{"theme":{"preset":"night"}}`, string(stored.Document))
}

// TestSaveCustomizationRejectsStaleRevision is the store level guard: two tabs that both
// read revision 1 must not both succeed, otherwise one edit silently disappears.
func TestSaveCustomizationRejectsStaleRevision(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	_, err = store.SaveCustomization(ctx, siteRow.ID, site.CustomizationInput{
		Document: []byte(`{"v":1}`),
	}, auditFor(siteRow.ID))
	require.NoError(t, err)

	// First writer in: wins.
	_, err = store.SaveCustomization(ctx, siteRow.ID, site.CustomizationInput{
		Document:         []byte(`{"v":2,"tab":"a"}`),
		ExpectedRevision: 1,
	}, auditFor(siteRow.ID))
	require.NoError(t, err)

	// Second writer with the same precondition is refused.
	_, err = store.SaveCustomization(ctx, siteRow.ID, site.CustomizationInput{
		Document:         []byte(`{"v":2,"tab":"b"}`),
		ExpectedRevision: 1,
	}, auditFor(siteRow.ID))
	require.ErrorIs(t, err, site.ErrCustomizationConflict)

	stored, err := store.Customization(ctx, siteRow.ID)
	require.NoError(t, err)
	require.JSONEq(t, `{"v":2,"tab":"a"}`, string(stored.Document),
		"the refused write must not have changed the document")
}

// TestSaveCustomizationRefusesToResurrectADeletedDocument covers the other half of the
// conditional write: a client that expects revision 2 must not recreate a document that
// someone removed, because it would come back as revision 1 in the middle of nowhere.
func TestSaveCustomizationRefusesToResurrectADeletedDocument(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	_, err = store.SaveCustomization(ctx, siteRow.ID, site.CustomizationInput{
		Document: []byte(`{"v":1}`),
	}, auditFor(siteRow.ID))
	require.NoError(t, err)

	// The operator discarded the design; a stale client must not bring it back.
	rows, err := handle.Client.SiteCustomization.Query().All(ctx)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.NoError(t, handle.Client.SiteCustomization.DeleteOneID(rows[0].ID).Exec(ctx))

	_, err = store.SaveCustomization(ctx, siteRow.ID, site.CustomizationInput{
		Document:         []byte(`{"v":9}`),
		ExpectedRevision: 1,
	}, auditFor(siteRow.ID))
	require.ErrorIs(t, err, site.ErrCustomizationConflict)
}

func TestCustomizationReadIsNotFoundForFreshSite(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	_, err = store.Customization(ctx, siteRow.ID)
	require.ErrorIs(t, err, site.ErrCustomizationNotFound)
}

// TestSaveCustomizationWritesTheAuditEntry keeps the operator trail in the same
// transaction as the document.
func TestSaveCustomizationWritesTheAuditEntry(t *testing.T) {
	store, handle := newStore(t)
	ctx := context.Background()

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	_, err = store.SaveCustomization(ctx, siteRow.ID, site.CustomizationInput{
		Document: []byte(`{"v":1}`),
	}, auditFor(siteRow.ID))
	require.NoError(t, err)

	rows, err := handle.Client.AuditLog.Query().
		Where(auditlog.ActionEQ("site.customization.updated")).
		All(ctx)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.NotNil(t, rows[0].ActorID)
	require.Equal(t, "u1", *rows[0].ActorID)
	require.NotNil(t, rows[0].RequestID)
	require.Equal(t, "req-1", *rows[0].RequestID)
}
