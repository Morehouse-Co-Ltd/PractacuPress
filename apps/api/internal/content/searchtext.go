package content

import (
	"html"
	"strings"
	"unicode"
	"unicode/utf8"
)

// SearchTokenize splits text into the tokens the full text indexes store.
//
// The three supported engines disagree about word boundaries, and CJK text has
// no spaces at all. Normalizing here gives every dialect the same vocabulary:
// Latin/digit runs become one lower case token, while each CJK rune becomes its
// own token. A phrase search then re-joins those runes in order, which is what
// makes "排版" match "排版" and not "排版设计" as one inseparable blob.
//
// The output contains only letters, digits and combining marks, so it can be
// embedded in an FTS5 or tsquery expression without escaping.
func SearchTokenize(text string) []string {
	tokens := make([]string, 0, 16)
	var word strings.Builder

	flush := func() {
		if word.Len() == 0 {
			return
		}
		tokens = append(tokens, word.String())
		word.Reset()
	}

	for _, r := range text {
		switch {
		case IsCJK(r):
			flush()
			tokens = append(tokens, string(unicode.ToLower(r)))
		case unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r):
			word.WriteRune(unicode.ToLower(r))
		default:
			flush()
		}
	}
	flush()
	return tokens
}

// SearchTokenizedText renders the normalized token stream the indexes store.
func SearchTokenizedText(text string) string {
	return strings.Join(SearchTokenize(text), " ")
}

// SearchPhrases groups a query into phrases the engines can evaluate.
//
// A run of CJK runes is one phrase (the runes must appear in order, adjacent),
// and every Latin/digit word is a one token phrase. The phrases are combined
// with AND by the dialect query builders, so "排版 hello" means "the phrase
// 排版 AND the word hello".
func SearchPhrases(term string) [][]string {
	phrases := make([][]string, 0, 4)
	var phrase []string
	var word strings.Builder
	inCJK := false

	flush := func() {
		if word.Len() > 0 {
			phrases = append(phrases, []string{word.String()})
			word.Reset()
		}
		if len(phrase) > 0 {
			phrases = append(phrases, phrase)
			phrase = nil
		}
	}

	for _, r := range term {
		if IsCJK(r) {
			if !inCJK {
				flush()
				inCJK = true
			}
			phrase = append(phrase, string(unicode.ToLower(r)))
			continue
		}

		if inCJK {
			flush()
			inCJK = false
		}
		if unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r) {
			word.WriteRune(unicode.ToLower(r))
			continue
		}
		flush()
	}
	flush()
	return phrases
}

// SearchHasTokens reports whether a term contains anything the indexes can
// match. A term made only of punctuation or wildcard characters is valid input
// but has no searchable token, so the caller answers an empty page instead of
// turning an empty prefix query into "match everything".
func SearchHasTokens(term string) bool {
	return len(SearchTokenize(term)) > 0
}

// IsCJK reports whether a rune belongs to a script written without word spaces.
//
// Those scripts are the reason the index stores one token per rune; treating a
// whole sentence as one token would make every short query miss.
func IsCJK(r rune) bool {
	return unicode.Is(unicode.Han, r) ||
		unicode.Is(unicode.Hiragana, r) ||
		unicode.Is(unicode.Katakana, r) ||
		unicode.Is(unicode.Hangul, r)
}

// PlainText returns the readable text of an item for indexing and snippets.
//
// Rendered HTML is preferred because it is the sanitized representation a
// reader actually sees. Source text is only used while an item has no rendered
// output yet (drafts).
func PlainText(renderedHTML, source string, format SourceFormat) string {
	switch {
	case strings.TrimSpace(renderedHTML) != "":
		return collapseWhitespace(stripHTML(renderedHTML))
	case format == FormatHTML:
		return collapseWhitespace(stripHTML(source))
	default:
		return collapseWhitespace(source)
	}
}

// SearchSnippet returns a plain text excerpt around the first occurrence of the
// query. It never emits HTML: the client owns escaping and highlighting.
//
// A result that matched only the title or summary still gets the opening of the
// body, so the result list never renders an empty description.
func SearchSnippet(body, term string, maxRunes int) string {
	text := collapseWhitespace(body)
	if text == "" {
		return ""
	}
	if maxRunes <= 0 {
		maxRunes = 160
	}

	needle := ""
	if phrases := SearchPhrases(term); len(phrases) > 0 {
		needle = strings.Join(phrases[0], "")
	}
	if needle == "" {
		needle = strings.TrimSpace(term)
	}

	idx := -1
	if needle != "" {
		if byteIdx := strings.Index(strings.ToLower(text), strings.ToLower(needle)); byteIdx >= 0 {
			idx = utf8.RuneCountInString(text[:byteIdx])
		}
	}

	runes := []rune(text)
	start := 0
	if idx >= 0 {
		start = idx - maxRunes/3
		if start < 0 {
			start = 0
		}
	}
	end := start + maxRunes
	if end > len(runes) {
		end = len(runes)
		if end > maxRunes {
			start = end - maxRunes
		} else {
			start = 0
		}
	}

	out := strings.TrimSpace(string(runes[start:end]))
	if out == "" {
		return ""
	}
	if start > 0 {
		out = "…" + out
	}
	if end < len(runes) {
		out += "…"
	}
	return out
}

// collapseWhitespace flattens a body to single spaces so a snippet is one line.
func collapseWhitespace(text string) string {
	var builder strings.Builder
	builder.Grow(len(text))
	space := false
	for _, r := range text {
		if unicode.IsSpace(r) {
			if !space && builder.Len() > 0 {
				builder.WriteByte(' ')
			}
			space = true
			continue
		}
		builder.WriteRune(r)
		space = false
	}
	return strings.TrimSpace(builder.String())
}

// stripHTML removes tags and decodes entities from sanitized HTML.
//
// It is deliberately not a parser: the input has already passed the security
// policy, and the only job here is producing index text. Script and style
// bodies are skipped as a defence in depth, in case older stored HTML predates
// the current sanitizer.
func stripHTML(raw string) string {
	var builder strings.Builder
	builder.Grow(len(raw))
	for i := 0; i < len(raw); {
		switch raw[i] {
		case '<':
			if strings.HasPrefix(raw[i:], "<!--") {
				end := strings.Index(raw[i+4:], "-->")
				if end < 0 {
					i = len(raw)
					continue
				}
				i += 4 + end + 3
				continue
			}
			end := strings.IndexByte(raw[i:], '>')
			if end < 0 {
				i = len(raw)
				continue
			}
			tag := raw[i+1 : i+end]
			i += end + 1
			name := strings.ToLower(strings.TrimLeft(tag, "/"))
			if cut := strings.IndexAny(name, " \t\r\n"); cut >= 0 {
				name = name[:cut]
			}
			if !strings.HasPrefix(tag, "/") && (name == "script" || name == "style") {
				closeTag := "</" + name
				lower := strings.ToLower(raw[i:])
				if closeIdx := strings.Index(lower, closeTag); closeIdx >= 0 {
					rest := raw[i+closeIdx:]
					if closeEnd := strings.IndexByte(rest, '>'); closeEnd >= 0 {
						i += closeIdx + closeEnd + 1
					} else {
						i = len(raw)
					}
				}
			}
			builder.WriteByte(' ')
		case '&':
			end := strings.IndexByte(raw[i:], ';')
			if end > 1 && end <= 12 {
				builder.WriteString(html.UnescapeString(raw[i : i+end+1]))
				i += end + 1
				continue
			}
			builder.WriteByte(raw[i])
			i++
		default:
			builder.WriteByte(raw[i])
			i++
		}
	}
	return builder.String()
}
