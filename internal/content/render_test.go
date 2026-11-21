package content

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	securitygo "github.com/practacu/practacu-press/internal/security"
	"github.com/practacu/practacu-press/internal/site"
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

func TestMaximumLengthMarkdownCanBeSanitizedAfterRendering(t *testing.T) {
	source := strings.Repeat("长", MaxSourceLength)
	rendered, err := renderMarkdown(source)
	require.NoError(t, err)

	_, err = securitygo.Sanitize("html", rendered)
	require.NoError(t, err)
}

type localPolicySanitizer struct{}

func (localPolicySanitizer) Sanitize(
	_ context.Context,
	format SourceFormat,
	source string,
) (Sanitized, error) {
	result, err := securitygo.Sanitize(string(format), source)
	if err != nil {
		return Sanitized{}, err
	}
	return Sanitized{
		HTML:          result.HTML,
		PolicyVersion: result.PolicyVersion,
		Violations:    result.Violations,
	}, nil
}

func TestMaximumLengthMarkdownCanBePublished(t *testing.T) {
	service := newService(t, newFakeRepo(), localPolicySanitizer{}, site.PublishModeOpen)
	author := actor("author", site.RoleMember)
	item, err := service.CreateDraft(context.Background(), author, KindArticle, DraftInput{
		Title:        "Maximum length",
		SourceFormat: FormatMarkdown,
		SourceBody:   strings.Repeat("长", MaxSourceLength),
	})
	require.NoError(t, err)
	require.Equal(t, StatusDraft, item.Status)

	published, err := service.Apply(context.Background(), author, item.ID, ActionPublish, "")
	require.NoError(t, err)
	require.Equal(t, StatusPublished, published.Status)
}

// TestDiagramFenceSurvivesMarkdownRendering pins the article-diagram storage contract:
// charts are drawn on the client from the JSON spec, so the server only has to preserve
// a <pre><code class="language-pp-diagram"> fence — all three parts are in the
// sanitizer allow-list, which is why article diagrams need no backend changes.
func TestDiagramFenceSurvivesMarkdownRendering(t *testing.T) {
	source := "```pp-diagram\n{\"type\":\"chart\",\"kind\":\"bar\",\"items\":[{\"label\":\"一\",\"value\":1}]}\n```\n"
	out, err := renderMarkdown(source)
	require.NoError(t, err)
	require.Contains(t, out, `<pre><code class="language-pp-diagram">`)
	require.Contains(t, out, "&quot;type&quot;")
	require.Contains(t, out, "</code></pre>")
}

func TestRawCollapsibleSurvivesMarkdownRendering(t *testing.T) {
	// The editor writes collapsible blocks as raw HTML inside Markdown. goldmark
	// must pass them through (WithUnsafe) so the sanitizer can decide what stays.
	source := "<details class=\"pp-collapse\" open><summary>更多说明</summary><p>正文</p></details>\n"
	out, err := renderMarkdown(source)
	require.NoError(t, err)
	require.Contains(t, out, "<details")
	require.Contains(t, out, "<summary>更多说明</summary>")
	require.Contains(t, out, "open")
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
