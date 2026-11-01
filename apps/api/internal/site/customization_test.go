package site

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// design returns a minimal design document of the shape the frontend saves.
func design() []byte {
	return []byte(`{"version":1,"theme":{"preset":"paper"},"pages":[]}`)
}

func TestSaveCustomizationStoresTheDocumentByteForByte(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	saved, err := service.SaveCustomization(context.Background(), admin, "s1", design(), 0, "req")
	require.NoError(t, err)
	require.Equal(t, 1, saved.Revision)
	require.Equal(t, design(), saved.Document, "the document must be stored verbatim")

	// Raw JSON is opaque: the service must not have re-encoded it.
	require.True(t, json.Valid(saved.Document))
}

func TestSaveCustomizationRequiresManageSite(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	member := activeMember("s1", "u2", RoleMember)

	_, err := service.SaveCustomization(context.Background(), member, "s1", design(), 0, "req")
	require.ErrorIs(t, err, ErrPermissionDenied)
	require.Empty(t, repo.customization, "a denied write must not reach the repository")
}

// TestSaveCustomizationPreservesRawBytes is the reason the store takes bytes: the
// frontend round-trips its own export format, so key order and formatting that the
// server re-encoded would show up as spurious diffs in the operator's file.
func TestSaveCustomizationPreservesRawBytes(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	raw := []byte("{\n  \"zeta\": 1,\n  \"alpha\": [2, 3]\n}")
	_, err := service.SaveCustomization(context.Background(), admin, "s1", raw, 0, "req")
	require.NoError(t, err)
	require.Equal(t, raw, repo.customization["s1"].Document)
}

func TestSaveCustomizationRejectsNonObjectDocuments(t *testing.T) {
	service := newService(t, newFakeRepo())
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	for name, document := range map[string][]byte{
		"empty":        {},
		"blank":        []byte("   "),
		"array":        []byte(`[1,2,3]`),
		"scalar":       []byte(`"design"`),
		"invalid json": []byte(`{"broken":`),
	} {
		_, err := service.SaveCustomization(context.Background(), admin, "s1", document, 0, "req")
		require.ErrorIs(t, err, ErrInvalidInput, name)
	}
}

func TestSaveCustomizationRejectsOversizedDocuments(t *testing.T) {
	service := newService(t, newFakeRepo())
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	// A valid object that is simply too big.
	huge := []byte(`{"padding":"` + strings.Repeat("x", MaxCustomizationBytes) + `"}`)
	_, err := service.SaveCustomization(context.Background(), admin, "s1", huge, 0, "req")
	require.ErrorIs(t, err, ErrCustomizationTooLarge)
}

func TestSaveCustomizationUsesOptimisticConcurrency(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	admin := activeMember("s1", "u1", RoleSiteAdmin)
	ctx := context.Background()

	first, err := service.SaveCustomization(ctx, admin, "s1", design(), 0, "req")
	require.NoError(t, err)
	require.Equal(t, 1, first.Revision)

	// A writer that saw revision 1 may advance it.
	second, err := service.SaveCustomization(ctx, admin, "s1", []byte(`{"theme":{"preset":"night"}}`), 1, "req")
	require.NoError(t, err)
	require.Equal(t, 2, second.Revision)

	// A writer that still believes revision 1 is at it is refused, not silently applied.
	_, err = service.SaveCustomization(ctx, admin, "s1", design(), 1, "req")
	require.ErrorIs(t, err, ErrCustomizationConflict)
	require.Equal(t, 1, repo.saveConflicts)

	// Unconditional writes stay possible for callers that omit the revision.
	unconditional, err := service.SaveCustomization(ctx, admin, "s1", design(), 0, "req")
	require.NoError(t, err)
	require.Equal(t, 3, unconditional.Revision)
}

func TestCustomizationReadReturnsNotFoundWhenNeverSaved(t *testing.T) {
	service := newService(t, newFakeRepo())

	_, err := service.Customization(context.Background(), "s1")
	require.ErrorIs(t, err, ErrCustomizationNotFound)
}

func TestCustomizationReadRequiresSiteID(t *testing.T) {
	service := newService(t, newFakeRepo())

	_, err := service.Customization(context.Background(), "")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestSaveCustomizationAuditsWithoutTheDocument(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	admin := activeMember("s1", "u1", RoleSiteAdmin)

	_, err := service.SaveCustomization(context.Background(), admin, "s1", design(), 0, "req-1")
	require.NoError(t, err)

	require.Len(t, repo.audits, 1)
	audit := repo.audits[0]
	require.Equal(t, "site.customization.updated", audit.Action)
	require.Equal(t, "u1", audit.ActorID)
	require.Equal(t, "req-1", audit.RequestID)
	require.Equal(t, len(design()), audit.Detail["bytes"])
	// The page tree stays in the design table, not in the operator log.
	require.NotContains(t, audit.Detail, "document")
}
