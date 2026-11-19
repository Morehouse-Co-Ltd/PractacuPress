package content

import (
	"bytes"
	"fmt"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer/html"
)

// markdownRenderer converts author markdown into HTML.
//
// The security service sanitizes HTML; it deliberately does not implement a markdown
// dialect (a sanitiser should have one job). Converting here means the published page
// gets real <h2>, <table> and <img> tags instead of literal asterisks and pipes, and
// the HTML that comes out still goes through the same allow-list afterwards.
//
// html.WithUnsafe is intentional: the sanitizer is the authority on what survives, and
// blocking raw HTML here would silently drop the block snippets the editor inserts
// (columns, quote cards, embeds) for authors who write in markdown.
var markdownRenderer = goldmark.New(
	goldmark.WithExtensions(
		extension.GFM, // tables, strikethrough, task lists, autolinks
	),
	goldmark.WithParserOptions(
		parser.WithAutoHeadingID(),
	),
	goldmark.WithRendererOptions(
		html.WithUnsafe(),
		html.WithXHTML(),
	),
)

// renderMarkdown turns markdown source into HTML.
func renderMarkdown(source string) (string, error) {
	var out bytes.Buffer
	if err := markdownRenderer.Convert([]byte(source), &out); err != nil {
		return "", fmt.Errorf("content: render markdown: %w", err)
	}
	return out.String(), nil
}
