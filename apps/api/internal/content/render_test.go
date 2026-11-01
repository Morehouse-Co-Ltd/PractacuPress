package content

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

func TestRenderMarkdownProducesRealTags(t *testing.T) {
	source := "# 标题\n\n正文 **粗体**。\n\n| 列 | 值 |\n| --- | --- |\n| 甲 | 1 |\n\n![图](https://example.com/a.png)\n\n~~旧~~"
	out, err := renderMarkdown(source)
	require.NoError(t, err)

	require.Contains(t, out, "<h1")
	require.Contains(t, out, "<strong>粗体</strong>")
	require.Contains(t, out, "<table>")
	require.Contains(t, out, "<th>列</th>")
	require.Contains(t, out, `<img src="https://example.com/a.png"`)
	require.Contains(t, out, "<del>旧</del>")
}

// TestMarkdownIsConvertedBeforeSanitization pins the contract between the two
// stages: the sanitizer cleans HTML, so markdown has to become HTML first.
func TestMarkdownIsConvertedBeforeSanitization(t *testing.T) {
	sanitizer := okSanitizer()
	service := newService(t, newFakeRepo(), sanitizer, site.PublishModeOpen)

	item := Content{
		ID:           "c1",
		SiteID:       "s1",
		Title:        "T",
		SourceFormat: FormatMarkdown,
		SourceBody:   "# 标题",
	}
	require.NoError(t, service.applySanitization(context.Background(), &item))
	require.Equal(t, FormatHTML, sanitizer.lastFormat,
		"markdown must reach the sanitizer already rendered as HTML")
	require.Contains(t, sanitizer.lastSource, "<h1")
}

func TestHTMLAndPlainArePassedThrough(t *testing.T) {
	sanitizer := okSanitizer()
	service := newService(t, newFakeRepo(), sanitizer, site.PublishModeOpen)

	html := Content{ID: "c1", SourceFormat: FormatHTML, SourceBody: "<p>x</p>"}
	require.NoError(t, service.applySanitization(context.Background(), &html))
	require.Equal(t, FormatHTML, sanitizer.lastFormat)
	require.Equal(t, "<p>x</p>", sanitizer.lastSource)

	plain := Content{ID: "c2", SourceFormat: FormatPlain, SourceBody: "x"}
	require.NoError(t, service.applySanitization(context.Background(), &plain))
	require.Equal(t, FormatPlain, sanitizer.lastFormat)
	require.Equal(t, "x", sanitizer.lastSource)
}
