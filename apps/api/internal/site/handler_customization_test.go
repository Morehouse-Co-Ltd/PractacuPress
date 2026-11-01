package site_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

)

// put sends one JSON body to the harness router with an optional bearer token.
func (h *harness) put(t *testing.T, path, token string, body any) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(body)
	require.NoError(t, err)

	req := httptest.NewRequest(http.MethodPut, path, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)
	return w
}

// promote makes the registered member an administrator of the harness site.
func (h *harness) promote(t *testing.T, role string) {
	t.Helper()
	member := h.memberOf(t)
	_, err := h.db.Client.SiteMember.UpdateOneID(member.ID).SetRole(role).Save(context.Background())
	require.NoError(t, err)
}

func customizationPath(siteID string) string {
	return "/api/v1/sites/" + siteID + "/customization"
}

func designDocument() map[string]any {
	return map[string]any{
		"customization": map[string]any{
			"version": 1,
			"theme":   map[string]any{"preset": "paper"},
			"pages":   []any{},
		},
	}
}

// TestCustomizationRoundTrip is the contract the browser depends on: save a design as an
// administrator, then read it back anonymously (every visitor needs it before paint).
func TestCustomizationRoundTrip(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promote(t, "site_admin")
	path := customizationPath(h.siteID)

	// Nothing saved yet: the browser falls back to its own defaults.
	require.Equal(t, http.StatusNotFound, h.get(t, path, "").Code)

	saved := h.put(t, path, token, designDocument())
	require.Equal(t, http.StatusOK, saved.Code, saved.Body.String())

	var saveBody struct {
		Revision  int    `json:"revision"`
		UpdatedAt string `json:"updated_at"`
	}
	require.NoError(t, json.Unmarshal(saved.Body.Bytes(), &saveBody))
	require.Equal(t, 1, saveBody.Revision)
	require.NotEmpty(t, saveBody.UpdatedAt)

	// Anonymous read, no token at all.
	read := h.get(t, path, "")
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())

	var readBody struct {
		SiteID        string         `json:"site_id"`
		Revision      int            `json:"revision"`
		Customization map[string]any `json:"customization"`
	}
	require.NoError(t, json.Unmarshal(read.Body.Bytes(), &readBody))
	require.Equal(t, h.siteID, readBody.SiteID)
	require.Equal(t, 1, readBody.Revision)
	require.Equal(t, float64(1), readBody.Customization["version"])
}

// TestCustomizationWriteRequiresManageSite keeps a plain member out of the site design.
func TestCustomizationWriteRequiresManageSite(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "reader@example.com")

	w := h.put(t, customizationPath(h.siteID), token, designDocument())

	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, http.StatusNotFound, h.get(t, customizationPath(h.siteID), "").Code,
		"a denied write must not have stored anything")
}

// TestCustomizationWriteIsRefusedWithoutAToken keeps the write endpoint guarded.
func TestCustomizationWriteIsRefusedWithoutAToken(t *testing.T) {
	h := newHarness(t)

	w := h.put(t, customizationPath(h.siteID), "", designDocument())

	require.Equal(t, http.StatusUnauthorized, w.Code, w.Body.String())
}

// TestCustomizationStaleRevisionConflicts is the two-tabs case at the HTTP level.
func TestCustomizationStaleRevisionConflicts(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promote(t, "site_admin")
	path := customizationPath(h.siteID)

	require.Equal(t, http.StatusOK, h.put(t, path, token, designDocument()).Code)

	body := designDocument()
	body["revision"] = 1
	require.Equal(t, http.StatusOK, h.put(t, path, token, body).Code, "revision 1 is current")

	// A second writer that still believes revision 1 is at it is refused.
	stale := designDocument()
	stale["revision"] = 1
	conflict := h.put(t, path, token, stale)
	require.Equal(t, http.StatusConflict, conflict.Code, conflict.Body.String())
	require.Contains(t, conflict.Body.String(), "revision_conflict")
}

// TestCustomizationRejectsNonObjectDocument keeps a document the frontend could not
// interpret out of the database, instead of storing it and rendering defaults.
func TestCustomizationRejectsNonObjectDocument(t *testing.T) {
	h := newHarness(t)
	token := h.register(t, "owner@example.com")
	h.promote(t, "site_admin")

	for name, customization := range map[string]any{
		"array":  []any{1, 2, 3},
		"scalar": "design",
		"null":   nil,
	} {
		w := h.put(t, customizationPath(h.siteID), token, map[string]any{"customization": customization})
		require.Equal(t, http.StatusBadRequest, w.Code, "%s: %s", name, w.Body.String())
	}
}

// TestCustomizationOnMembersOnlySiteIsHiddenFromOutsiders covers the visibility rule: the
// document names the private pages of a closed site, so a non-member gets the same 404 a
// site with no design returns - and, importantly, no 401 that a browser would read as an
// expired session during boot.
func TestCustomizationOnMembersOnlySiteIsHiddenFromOutsiders(t *testing.T) {
	h := newHarnessWithVisibility(t, "members_only")
	token := h.register(t, "owner@example.com")
	h.promote(t, "site_admin")
	path := customizationPath(h.siteID)

	require.Equal(t, http.StatusOK, h.put(t, path, token, designDocument()).Code)
	require.Equal(t, http.StatusOK, h.get(t, path, token).Code, "a member reads the design")

	anonymous := h.get(t, path, "")
	require.Equal(t, http.StatusNotFound, anonymous.Code, anonymous.Body.String())
	require.NotContains(t, anonymous.Body.String(), "unauthenticated")
}

// TestCustomizationRejectsForeignSitePath keeps the path from selecting another tenant.
func TestCustomizationRejectsForeignSitePath(t *testing.T) {
	h := newHarness(t)
	_ = h.register(t, "owner@example.com")

	w := h.get(t, customizationPath("some_other_site"), "")
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "cross_site")
}
