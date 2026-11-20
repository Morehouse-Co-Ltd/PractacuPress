package securitygo

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRemovesScriptTags(t *testing.T) {
	out, err := Sanitize("html", "<p>hi</p><script>alert(1)</script>")
	require.NoError(t, err)
	require.NotContains(t, out.HTML, "<script")
	require.Contains(t, out.HTML, "<p>hi</p>")
	require.Contains(t, out.Violations, "script")
}

func TestRemovesEventHandlers(t *testing.T) {
	out, err := Sanitize("html", `<img src="x.png" onerror="alert(1)">`)
	require.NoError(t, err)
	require.NotContains(t, out.HTML, "onerror")
	require.Equal(t, `<img src="x.png">`, out.HTML)
}

func TestRemovesJavascriptURLs(t *testing.T) {
	out, err := Sanitize("html", `<a href="javascript:alert(1)">x</a>`)
	require.NoError(t, err)
	require.NotContains(t, out.HTML, "javascript:")
	require.Equal(t, `<a rel="noopener noreferrer">x</a>`, out.HTML)
	require.Contains(t, out.Violations, "javascript_url")
}

func TestRemovesObfuscatedJavascriptURLs(t *testing.T) {
	for _, source := range []string{
		`<a href="JaVaScRiPt:alert(1)">x</a>`,
		`<a href="java&#115;cript:alert(1)">x</a>`,
		"<a href=\"java\tscript:alert(1)\">x</a>",
		`<a href="data:text/html,<script>alert(1)</script>">x</a>`,
	} {
		out, err := Sanitize("html", source)
		require.NoError(t, err)
		require.NotContains(t, strings.ToLower(out.HTML), "script:", "source %q => %q", source, out.HTML)
		require.NotContains(t, out.HTML, "href=", "source %q => %q", source, out.HTML)
	}
}

func TestKeepsSafeFormatting(t *testing.T) {
	out, err := Sanitize("html", "<p><strong>bold</strong> and <em>italic</em></p>")
	require.NoError(t, err)
	require.Contains(t, out.HTML, "<strong>")
	require.Contains(t, out.HTML, "<em>")
	require.Equal(t, "<p><strong>bold</strong> and <em>italic</em></p>", out.HTML)
}

func TestKeepsCollapsibleDetails(t *testing.T) {
	// Collapsible text is authored as <details class="pp-collapse"> in the editor;
	// dropping either tag would silently turn it into a flat list of paragraphs.
	source := `<details class="pp-collapse" open><summary>更多说明</summary><p>正文</p><script>alert(1)</script></details>`
	out, err := Sanitize("html", source)
	require.NoError(t, err)
	require.Contains(t, out.HTML, `<details`)
	require.Contains(t, out.HTML, `class="pp-collapse"`)
	require.Contains(t, out.HTML, `open`)
	require.Contains(t, out.HTML, `<summary>更多说明</summary>`)
	require.Contains(t, out.HTML, `<p>正文</p>`)
	require.NotContains(t, out.HTML, "script")
}

func TestKeepsDiagramFenceForClientSideRendering(t *testing.T) {
	// Article diagrams are stored as a ```pp-diagram fenced block: goldmark turns
	// it into pre > code with a language class, the client hydrates it into SVG.
	// If the sanitizer drops pre/code/class the feature silently breaks.
	source := `<pre><code class="language-pp-diagram">{"type":"chart","kind":"bar"}</code></pre>`
	out, err := Sanitize("html", source)
	require.NoError(t, err)
	require.Contains(t, out.HTML, "<pre>")
	require.Contains(t, out.HTML, "language-pp-diagram")
	require.Contains(t, out.HTML, "chart")
}

func TestStillRemovesInlineSVGForDiagrams(t *testing.T) {
	out, err := Sanitize("html", `<svg onload="alert(1)"><script>alert(2)</script></svg>`)
	require.NoError(t, err)
	require.NotContains(t, out.HTML, "<svg")
	require.NotContains(t, out.HTML, "<script")
	require.Equal(t, "", out.HTML)
}

func TestHTTPSLinksSurviveAndGetRel(t *testing.T) {
	out, err := Sanitize("html", `<a href="https://example.com">x</a>`)
	require.NoError(t, err)
	require.Contains(t, out.HTML, "https://example.com")
	require.Contains(t, out.HTML, `rel="noopener noreferrer"`)
}

func TestRelativeURLsPassThrough(t *testing.T) {
	for _, href := range []string{"/posts/1", "#anchor", "posts/1", "//example.com/x"} {
		out, err := Sanitize("html", `<a href="`+href+`">x</a>`)
		require.NoError(t, err)
		require.Contains(t, out.HTML, `href="`+href+`"`, "href %q", href)
	}
}

func TestPlainTextIsEscaped(t *testing.T) {
	out, err := Sanitize("plain", "<script>alert(1)</script>")
	require.NoError(t, err)
	require.NotContains(t, out.HTML, "<script>")
	require.Contains(t, out.HTML, "&lt;script&gt;")
	// Violations are recorded against the escaped input the sanitizer sees, so
	// escaped markup is not reported (same as the reference implementation).
	require.Empty(t, out.Violations)
}

func TestPlainFormatWrapsInParagraph(t *testing.T) {
	out, err := Sanitize("plain", `a & b < c > d " quoted`)
	require.NoError(t, err)
	require.Equal(t, `<p>a &amp; b &lt; c &gt; d " quoted</p>`, out.HTML)
}

func TestMarkdownIsTreatedAsHTML(t *testing.T) {
	// The API renders Markdown before sanitization, so "markdown" is already HTML.
	out, err := Sanitize("markdown", "<h1>Title</h1>")
	require.NoError(t, err)
	require.Equal(t, "<h1>Title</h1>", out.HTML)
}

func TestUnknownFormatIsRefused(t *testing.T) {
	_, err := Sanitize("excel", "x")
	require.ErrorIs(t, err, ErrUnknownFormat)
}

func TestOversizedInputIsRefused(t *testing.T) {
	_, err := Sanitize("plain", strings.Repeat("a", MaxSourceChars+1))
	require.ErrorIs(t, err, ErrContentTooLarge)
}

func TestOutputIsDeterministicAndCarriesPolicyVersion(t *testing.T) {
	a, err := Sanitize("html", "<p>x</p>")
	require.NoError(t, err)
	b, err := Sanitize("html", "<p>x</p>")
	require.NoError(t, err)
	require.Equal(t, a, b)
	require.Equal(t, PolicyVersion, a.PolicyVersion)
}

func TestKeepsAllowListedClassTokens(t *testing.T) {
	// Block snippets the editor stores as HTML.
	out, err := Sanitize("html", `<table class="pp-columns"><tbody><tr><td>x</td></tr></tbody></table>`)
	require.NoError(t, err)
	require.Contains(t, out.HTML, `class="pp-columns"`)

	// Fenced code language class produced by goldmark.
	out, err = Sanitize("html", `<pre><code class="language-go">fmt.Println(1)</code></pre>`)
	require.NoError(t, err)
	require.Contains(t, out.HTML, `class="language-go"`)

	// Multiple tokens: keep the allowed ones, drop the rest.
	out, err = Sanitize("html", `<p class="pp-note pp-note-warn btn btn-danger">x</p>`)
	require.NoError(t, err)
	require.Contains(t, out.HTML, `class="pp-note pp-note-warn"`)
	require.NotContains(t, out.HTML, "btn")
	require.NotContains(t, out.HTML, "danger")

	// Arbitrary whitespace between tokens is normalised to single spaces.
	out, err = Sanitize("html", "<p class=\"pp-table\n\tbtn\">x</p>")
	require.NoError(t, err)
	require.Contains(t, out.HTML, `class="pp-table"`)
}

func TestDropsClassesThatCouldImitateSiteUI(t *testing.T) {
	// SEC-11: stored content must not borrow the site's button/badge/chip styling.
	out, err := Sanitize("html", `<p class="btn btn-danger">x</p>`)
	require.NoError(t, err)
	require.Equal(t, "<p>x</p>", out.HTML)

	// When every token is filtered the attribute is removed entirely.
	out, err = Sanitize("html", `<a class="chip" href="https://example.com">x</a>`)
	require.NoError(t, err)
	require.NotContains(t, out.HTML, "class=")
	require.Contains(t, out.HTML, "https://example.com")

	// Prefix must be followed by a name: "language-" alone is not a class.
	out, err = Sanitize("html", `<p class="language- pp-">x</p>`)
	require.NoError(t, err)
	require.Equal(t, "<p>x</p>", out.HTML)

	// Class names are case-sensitive in CSS, so "PP-COLUMNS" is not "pp-columns".
	out, err = Sanitize("html", `<p class="PP-COLUMNS">x</p>`)
	require.NoError(t, err)
	require.Equal(t, "<p>x</p>", out.HTML)
}

func TestKeepsMarkdownEcosystemClasses(t *testing.T) {
	cases := []struct {
		source   string
		expected string
	}{
		{`<pre class="hljs"><code class="language-go">func main() {}</code></pre>`, "hljs"},
		{`<p class="footnotes">notes</p>`, "footnotes"},
		{`<ol class="footnotes"><li class="footnote-ref">x</li></ol>`, "footnote-ref"},
		{`<ul class="task-list contains-task-list"><li class="task-list-item">x</li></ul>`, "contains-task-list"},
	}
	for _, tc := range cases {
		out, err := Sanitize("html", tc.source)
		require.NoError(t, err)
		require.Contains(t, out.HTML, tc.expected, "%s => %s", tc.source, out.HTML)
	}
}

func TestAllowedAttributes(t *testing.T) {
	out, err := Sanitize("html", `<a href="https://example.com" target="_blank" title="t">x</a>`)
	require.NoError(t, err)
	require.Equal(t, `<a href="https://example.com" title="t" rel="noopener noreferrer">x</a>`, out.HTML)

	out, err = Sanitize("html", `<p lang="zh" title="tip" class="pp-note" id="drop">x</p>`)
	require.NoError(t, err)
	require.Equal(t, `<p lang="zh" title="tip" class="pp-note">x</p>`, out.HTML)

	out, err = Sanitize("html", `<img src="https://example.com/a.png" alt="a" width="10" height="20" loading="lazy">`)
	require.NoError(t, err)
	require.Equal(t, `<img src="https://example.com/a.png" alt="a" width="10" height="20">`, out.HTML)
}

func TestDisallowedTagsKeepTheirText(t *testing.T) {
	out, err := Sanitize("html", `<div><span>keep me</span></div>`)
	require.NoError(t, err)
	require.Equal(t, "keep me", out.HTML)
}

func TestCommentsAndDoctypesAreStripped(t *testing.T) {
	out, err := Sanitize("html", "<!-- comment --><!DOCTYPE html><p>x</p>")
	require.NoError(t, err)
	require.Equal(t, "<p>x</p>", out.HTML)
}

func TestTextAndAttributeEscapingMatchesHTML5Serializer(t *testing.T) {
	// Quotes are not escaped in text, but are in attribute values; non-breaking
	// spaces become &nbsp; in both.
	out, err := Sanitize("html", "<p title=\"a &amp; &quot;b&quot; &lt;c&gt;\">a &amp; b &lt; c &gt; \u00a0</p>")
	require.NoError(t, err)
	require.Equal(t, `<p title="a &amp; &quot;b&quot; &lt;c&gt;">a &amp; b &lt; c &gt; &nbsp;</p>`, out.HTML)
}

func TestVoidElementsAreSerializedWithoutSlash(t *testing.T) {
	out, err := Sanitize("html", "<p>a<br>b</p><hr><img src=\"/x.png\" alt=\"x\">")
	require.NoError(t, err)
	require.Equal(t, `<p>a<br>b</p><hr><img src="/x.png" alt="x">`, out.HTML)
}

func TestViolationsAreSortedAndLabelled(t *testing.T) {
	out, err := Sanitize("html", `<script>1</script><iframe></iframe><object></object><embed onclick="javascript:void(0)" onerror= onload=`)
	require.NoError(t, err)
	require.Equal(t, []string{
		"embed", "iframe", "javascript_url", "object", "onerror", "onload", "script",
	}, out.Violations)
}

func TestSanitizeDoesNotProduceEmptyViolationListForCleanContent(t *testing.T) {
	out, err := Sanitize("html", "<p>clean</p>")
	require.NoError(t, err)
	require.Empty(t, out.Violations)
}

func TestURLPolicy(t *testing.T) {
	allowed := []string{
		"https://example.com",
		"http://example.com/x?y=1",
		"mailto:hi@example.com",
		"HTTPS://EXAMPLE.COM",
		"/relative",
		"relative/path",
		"#frag",
		"//example.com/x",
	}
	for _, value := range allowed {
		require.True(t, urlAllowed(value), value)
	}

	denied := []string{
		"javascript:alert(1)",
		"JAVASCRIPT:alert(1)",
		"data:text/html,x",
		"vbscript:msgbox",
		"file:///etc/passwd",
		"java\x00script:alert(1)",
		"http://",
		"https://exa mple.com",
	}
	for _, value := range denied {
		require.False(t, urlAllowed(value), value)
	}
}
