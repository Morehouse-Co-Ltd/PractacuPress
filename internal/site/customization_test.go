package site

import (
	"context"
	"encoding/json"
	"strconv"
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

// --- V-03: content validation of the executable fields ---

// saveDocumentWithJSON saves a hand written document, failing the test on unexpected
// errors; the caller only cares about the validation verdict.
func saveDocumentWithJSON(t *testing.T, document string) error {
	t.Helper()
	service := newService(t, newFakeRepo())
	admin := activeMember("s1", "u1", RoleSiteAdmin)
	_, err := service.SaveCustomization(context.Background(), admin, "s1", []byte(document), 0, "req")
	return err
}

// TestSaveCustomizationRejectsDangerousCustomCSS is the V-03 regression test: after H-1
// the design document is distributed to every visitor, so `custom_css` may not carry
// imports or script-bearing URLs even though it is otherwise just styling.
func TestSaveCustomizationRejectsDangerousCustomCSS(t *testing.T) {
	payloads := map[string]string{
		"plain import":         `@import url("https://evil.example/x.css");`,
		"escaped import":       `\40 import url("https://evil.example/x.css");`,
		"import split comment": `@im/* hidden */port url("https://evil.example/x.css");`,
		"expression":           `body{width:expression(alert(1))}`,
		"ie behavior":          `a{behavior:url(evil.htc)}`,
		"moz binding":          `a{-moz-binding:url(evil.xml#x)}`,
		"javascript url":       `a{background:url("javascript:alert(1)")}`,
		"quoted javascript":    `a{background:url('javascript:alert(1)')}`,
		"data text url":        `a{background:url(data:text/html;base64,PHNjcmlwdD4=)}`,
		"uppercase":            `A{BACKGROUND:URL(JAVASCRIPT:ALERT(1))}`,
	}
	for name, css := range payloads {
		err := saveDocumentWithJSON(t, `{"custom_css":`+strconv.Quote(css)+`}`)
		require.ErrorIs(t, err, ErrInvalidInput, name)
		require.Contains(t, err.Error(), "custom_css", name)
	}
}

// TestSaveCustomizationRejectsDangerousThemeStrings covers the theme subtree: token
// values flow into the global stylesheet, so a marker there is never legitimate.
func TestSaveCustomizationRejectsDangerousThemeStrings(t *testing.T) {
	err := saveDocumentWithJSON(t,
		`{"theme":{"preset":"paper","custom":{"tokens":{"background":"x;}html{background:url(javascript:alert(1))"}}}}`)

	require.ErrorIs(t, err, ErrInvalidInput)
	require.Contains(t, err.Error(), "javascript")
}

// TestSaveCustomizationRejectsDangerousBlockStrings covers page block properties: text
// bodies render as HTML and `code` blocks run their html/css/js in a sandboxed frame, so
// neither may persist one of the rejected constructs.
func TestSaveCustomizationRejectsDangerousBlockStrings(t *testing.T) {
	documents := map[string]string{
		"text body": `{"home":{"blocks":[{"id":"a","type":"text","props":{"body":"<p>hi</p><style>@import url(x)</style>"}}]}}`,
		"code css":  `{"home":{"blocks":[{"id":"a","type":"code","props":{"css":"a{behavior:url(x.htc)}"}}]}}`,
		"nested":    `{"pages":[{"id":"p","title":"t","slug":"p","layout":{"blocks":[{"id":"a","type":"columns","props":{},"children":[{"id":"b","type":"code","props":{"html":"<a style=\"background:url(javascript:alert(1))\">x</a>"}}]}]}}]}`,
	}
	for name, document := range documents {
		err := saveDocumentWithJSON(t, document)
		require.ErrorIs(t, err, ErrInvalidInput, name)
	}
}

// TestSaveCustomizationAllowsOrdinaryCustomCSS is the other half of the contract: the
// features a design actually needs must keep working.
func TestSaveCustomizationAllowsOrdinaryCustomCSS(t *testing.T) {
	css := `:root{--pp-accent:#cc3322}` +
		`body{background:url("https://cdn.example.com/bg.png") no-repeat;font-family:Georgia,serif}` +
		`@media (min-width: 900px){.hero{position:fixed;inset:0 0 auto 0;display:grid}}` +
		`.card{box-shadow:0 8px 24px rgba(0,0,0,.08);transition:transform .2s ease}`
	document := `{"custom_css":` + strconv.Quote(css) +
		`,"theme":{"preset":"paper"},"home":{"blocks":[{"id":"a","type":"text","props":{"body":"## 关于\n\n正文"}}]}}`

	require.NoError(t, saveDocumentWithJSON(t, document))
}

// TestSaveCustomizationRejectsOversizedCustomCSS keeps a single field from being the new
// document-size bypass the browser cap already prevents.
func TestSaveCustomizationRejectsOversizedCustomCSS(t *testing.T) {
	document := `{"custom_css":` + strconv.Quote(strings.Repeat("a", maxCustomCSSCharacters+1)) + `}`

	err := saveDocumentWithJSON(t, document)
	require.ErrorIs(t, err, ErrInvalidInput)
	require.Contains(t, err.Error(), "exceeds")
}

func TestSaveCustomizationValidatesPermalinkTemplates(t *testing.T) {
	invalid := `{"seo":{"permalinks":{"article_structure":"custom","article_custom":"/stories/%unknown%","post_structure":"legacy"}}}`
	err := saveDocumentWithJSON(t, invalid)
	require.ErrorIs(t, err, ErrInvalidInput)

	valid := `{"seo":{"permalinks":{"article_structure":"custom","article_custom":"/stories/%year%/%postname%","posts_follow_articles":false,"post_structure":"post_name","post_custom":"/%postname%"}}}`
	require.NoError(t, saveDocumentWithJSON(t, valid))
}

// TestSaveCustomizationSkipsSandboxedExtensionPayloads documents the deliberate gap:
// extensions are an explicit "run custom code" feature, so their payloads are not
// marker-checked (the sandbox, not a string filter, is their boundary).
func TestSaveCustomizationSkipsSandboxedExtensionPayloads(t *testing.T) {
	document := `{"custom_extensions":[{"id":"ext_x","name":"x","html":"@import url(x)","css":"a{behavior:url(x.htc)}","js":"url(javascript:x)"}]}`

	require.NoError(t, saveDocumentWithJSON(t, document))
}
