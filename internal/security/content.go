package securitygo

import (
	"errors"
	"net/url"
	"sort"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// Errors returned when the source cannot be processed at all.
var (
	// ErrContentTooLarge means the source exceeded MaxSourceChars.
	ErrContentTooLarge = errors.New("content exceeds the maximum allowed size")
	// ErrUnknownFormat means the format is not one of markdown, html or plain.
	ErrUnknownFormat = errors.New("unknown source format")
)

// Sanitized is the outcome of sanitization.
type Sanitized struct {
	// HTML is the only representation a client may render.
	HTML string
	// PolicyVersion identifies the rule set that produced HTML.
	PolicyVersion string
	// Violations lists removed constructs, for the audit trail.
	Violations []string
}

// allowedTags is the allow-list used by the content policy.
//
// Anything else is dropped, keeping its text content.
var allowedTags = map[string]struct{}{
	"a": {}, "b": {}, "blockquote": {}, "br": {}, "code": {}, "del": {},
	"em": {}, "h1": {}, "h2": {}, "h3": {}, "h4": {}, "h5": {}, "h6": {},
	"hr": {}, "i": {}, "img": {}, "li": {}, "ol": {}, "p": {}, "pre": {},
	"s": {}, "strong": {}, "table": {}, "tbody": {}, "td": {}, "th": {},
	"thead": {}, "tr": {}, "ul": {},
}

// cleanContentTags have both their tag and their contents removed.
//
// This mirrors ammonia's default clean_content_tags, which the
// inherits because it never overrides the set.
var cleanContentTags = map[string]struct{}{
	"script": {},
	"style":  {},
}

// voidTags are serialized without an end tag, the same way html5ever does.
var voidTags = map[string]struct{}{
	"br":  {},
	"hr":  {},
	"img": {},
}

// allowedClassPrefixes are class-name prefixes that survive sanitization.
//
// The list is derived from what the content pipeline actually emits:
//
//   - language-*: goldmark renders fenced code as
//     <pre><code class="language-…"></pre> (internal/content/render.go,
//     pinned by TestRenderMarkdownProducesRealTags and
//     TestDiagramFenceSurvivesMarkdownRendering; article diagrams ride on
//     language-pp-diagram).
//   - pp-*: the rich-text block snippets stored as HTML by the editor
//     (web/src/lib/richBlocks.ts and web/src/lib/markdown.ts).
//
// Everything else is dropped, which is the SEC-11 fix: a stored
// <p class="btn btn-danger"> can no longer borrow the site's own button styling
// to imitate UI.
var allowedClassPrefixes = []string{"pp-", "language-"}

// allowedClassTokens are exact class tokens that survive sanitization.
//
// These are conventional Markdown ecosystem class names (syntax highlighting,
// footnotes, GFM task lists) used by imported/pasted HTML and by renderers the
// project may adopt later. The site stylesheet defines none of them, so they
// cannot be used to imitate site UI.
var allowedClassTokens = map[string]struct{}{
	"hljs":               {},
	"footnotes":          {},
	"footnote-ref":       {},
	"footnote-backref":   {},
	"task-list":          {},
	"task-list-item":     {},
	"contains-task-list": {},
}

// allowedSchemes are the URL schemes allowed in links and image sources.
//
// javascript: and data: are refused, which is what makes stored XSS through
// links and images impossible.
var allowedSchemes = map[string]struct{}{
	"http":   {},
	"https":  {},
	"mailto": {},
}

// Sanitize sanitizes source content into safe HTML.
//
// The result is deterministic for the same input and policy, so it can be
// stored and compared across revisions.
//
// format is one of "markdown", "html" or "plain". Markdown does not mean the
// service parses a Markdown dialect: the Go API renders Markdown to HTML before
// it calls the security package (internal/content/render.go), so
// "markdown" and "html" are sanitized identically, exactly like the reference
// service.
func Sanitize(format, source string) (Sanitized, error) {
	if utf8.RuneCountInString(source) > MaxSourceChars {
		return Sanitized{}, ErrContentTooLarge
	}

	var input string
	switch format {
	case "markdown", "html":
		input = source
	case "plain":
		input = "<p>" + escapeHTML(source) + "</p>"
	default:
		return Sanitized{}, ErrUnknownFormat
	}

	cleaned, err := sanitizeHTML(input)
	if err != nil {
		return Sanitized{}, err
	}

	// Record violations against the string the sanitizer actually sees: for "plain"
	// that is the escaped <p> wrapper, so escaped
	// markup is not reported as a violation.
	violations := recordViolations(input)
	return Sanitized{
		HTML:          cleaned,
		PolicyVersion: PolicyVersion,
		Violations:    violations,
	}, nil
}

// sanitizeHTML parses an HTML fragment and re-serializes only the allow-listed
// parts of it.
//
// Parsing uses a <div> context node, matching ammonia's fragment parsing.
func sanitizeHTML(source string) (string, error) {
	contextNode := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := html.ParseFragment(strings.NewReader(source), contextNode)
	if err != nil {
		return "", err
	}

	var builder strings.Builder
	for _, node := range nodes {
		writeSanitizedNode(&builder, node)
	}
	return builder.String(), nil
}

// writeSanitizedNode writes one parsed node, dropping disallowed tags but
// keeping their text content and dropping the contents of script/style.
func writeSanitizedNode(builder *strings.Builder, node *html.Node) {
	switch node.Type {
	case html.TextNode:
		writeEscapedText(builder, node.Data)
	case html.ElementNode:
		if _, clean := cleanContentTags[node.Data]; clean {
			return
		}
		if _, allowed := allowedTags[node.Data]; !allowed {
			for child := node.FirstChild; child != nil; child = child.NextSibling {
				writeSanitizedNode(builder, child)
			}
			return
		}
		writeSanitizedElement(builder, node)
	case html.DocumentNode:
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			writeSanitizedNode(builder, child)
		}
	default:
		// Comments, doctypes and processing instructions are stripped,
		// matching ammonia's strip_comments default.
	}
}

// writeSanitizedElement writes an allowed element with its filtered attributes
// and sanitized children.
func writeSanitizedElement(builder *strings.Builder, node *html.Node) {
	builder.WriteString("<")
	builder.WriteString(node.Data)
	for _, attr := range node.Attr {
		name := strings.ToLower(attr.Key)
		if !isAllowedAttribute(node.Data, name) {
			continue
		}

		value := attr.Val
		switch name {
		case "class":
			filtered, ok := filterClass(value)
			if !ok {
				continue
			}
			value = filtered
		case "href", "src":
			if !urlAllowed(value) {
				continue
			}
		}

		builder.WriteString(" ")
		builder.WriteString(name)
		builder.WriteString(`="`)
		writeEscapedAttribute(builder, value)
		builder.WriteString(`"`)
	}
	if node.Data == "a" {
		// ammonia appends the rel attribute after the surviving attributes.
		builder.WriteString(` rel="noopener noreferrer"`)
	}
	builder.WriteString(">")

	if _, void := voidTags[node.Data]; void {
		return
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		writeSanitizedNode(builder, child)
	}
	builder.WriteString("</")
	builder.WriteString(node.Data)
	builder.WriteString(">")
}

// isAllowedAttribute mirrors the reference allow-list.
//
// class, lang and title are generic attributes in ammonia's defaults (lang and
// title are not overridden by the reference builder); href is allowed on links and
// src/alt/width/height on images.
func isAllowedAttribute(tag, attribute string) bool {
	switch attribute {
	case "class", "lang", "title":
		return true
	case "href":
		return tag == "a"
	case "src", "alt", "width", "height":
		return tag == "img"
	default:
		return false
	}
}

// filterClass filters one class value down to the allow-list.
//
// The second result is false when the attribute carries no allowed token and
// must be removed entirely.
func filterClass(value string) (string, bool) {
	tokens := strings.Fields(value)
	kept := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if isAllowedClass(token) {
			kept = append(kept, token)
		}
	}
	if len(kept) == 0 {
		return "", false
	}
	return strings.Join(kept, " "), true
}

// isAllowedClass reports whether one class token is allowed. Class names are
// case-sensitive in CSS, so the match is exact.
func isAllowedClass(token string) bool {
	if _, ok := allowedClassTokens[token]; ok {
		return true
	}
	for _, prefix := range allowedClassPrefixes {
		if len(token) > len(prefix) && strings.HasPrefix(token, prefix) {
			return true
		}
	}
	return false
}

// urlAllowed applies the sanitizer URL policy to one href/src value.
//
// An absolute URL survives only when its scheme is allow-listed; a relative URL
// passes through unchanged because ammonia's url_relative policy is
// PassThrough. Malformed values are dropped, which matches ammonia dropping
// anything that is neither a valid absolute URL nor a relative one.
func urlAllowed(raw string) bool {
	candidate, ok := normalizeURL(raw)
	if !ok {
		return false
	}

	scheme, hasScheme := urlScheme(candidate)
	if !hasScheme {
		// Relative URLs, including protocol-relative ones, are passed through.
		return true
	}
	if _, allowed := allowedSchemes[scheme]; !allowed {
		return false
	}

	// A value with an allowed scheme but no parseable authority (for example
	// "http://") is dropped instead of stored.
	parsed, err := url.Parse(candidate)
	if err != nil || strings.ToLower(parsed.Scheme) != scheme {
		return false
	}
	if (scheme == "http" || scheme == "https") && parsed.Host == "" {
		return false
	}
	return true
}

// normalizeURL applies the WHATWG URL parser's input cleanup: ASCII tab, line
// feed and carriage return are removed everywhere and leading/trailing C0
// controls and spaces are trimmed.
//
// The second result is false for a value containing another C0 control or DEL.
// Those are refused rather than interpreted, because browsers and the WHATWG
// parser disagree about how to recover from them and a mismatch there could let
// "java\x00script:" survive as a link.
func normalizeURL(raw string) (string, bool) {
	var builder strings.Builder
	builder.Grow(len(raw))
	for i := 0; i < len(raw); i++ {
		switch raw[i] {
		case '\t', '\n', '\r':
			continue
		case 0x7f:
			return "", false
		default:
			if raw[i] < 0x20 {
				return "", false
			}
			builder.WriteByte(raw[i])
		}
	}
	return strings.Trim(builder.String(), " "), true
}

// urlScheme extracts a URL scheme: an ASCII letter followed by letters, digits,
// '+', '-' or '.', terminated by ':'. This is the RFC 3986 scheme grammar, which
// the WHATWG URL parser also accepts.
func urlScheme(raw string) (string, bool) {
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z':
			if i > 0 {
				continue
			}
		case c >= '0' && c <= '9', c == '+', c == '-', c == '.':
			if i == 0 {
				return "", false
			}
		case c == ':':
			if i == 0 {
				return "", false
			}
			return strings.ToLower(raw[:i]), true
		default:
			return "", false
		}
	}
	return "", false
}

// writeEscapedText writes text the way the HTML fragment serializer does:
// &, <, > and non-breaking space are escaped; quotes are not.
func writeEscapedText(builder *strings.Builder, text string) {
	for _, r := range text {
		switch r {
		case '&':
			builder.WriteString("&amp;")
		case '<':
			builder.WriteString("&lt;")
		case '>':
			builder.WriteString("&gt;")
		case '\u00a0':
			builder.WriteString("&nbsp;")
		default:
			builder.WriteRune(r)
		}
	}
}

// writeEscapedAttribute writes an attribute value the way html5ever does:
// &, <, >, " and non-breaking space are escaped.
func writeEscapedAttribute(builder *strings.Builder, value string) {
	for _, r := range value {
		switch r {
		case '&':
			builder.WriteString("&amp;")
		case '<':
			builder.WriteString("&lt;")
		case '>':
			builder.WriteString("&gt;")
		case '"':
			builder.WriteString("&quot;")
		case '\u00a0':
			builder.WriteString("&nbsp;")
		default:
			builder.WriteRune(r)
		}
	}
}

// recordViolations records which dangerous constructs were present in the
// source, so the audit trail can show why content was modified rather than just
// that it was.
//
// The markers and the lexicographically sorted output mirror the reference
// implementation's BTreeSet.
func recordViolations(source string) []string {
	lowered := strings.ToLower(source)
	markers := []struct {
		marker string
		label  string
	}{
		{"<script", "script"},
		{"<iframe", "iframe"},
		{"<object", "object"},
		{"<embed", "embed"},
		{"onerror=", "onerror"},
		{"onload=", "onload"},
		{"javascript:", "javascript_url"},
	}

	found := make([]string, 0, len(markers))
	for _, marker := range markers {
		if strings.Contains(lowered, marker.marker) {
			found = append(found, marker.label)
		}
	}
	sort.Strings(found)
	return found
}

// escapeHTML escapes the five characters the reference plain-format wrapper escapes
// before the source is treated as HTML. Note that apostrophes are not escaped,
// exactly like the reference implementation.
func escapeHTML(source string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
	)
	return replacer.Replace(source)
}
