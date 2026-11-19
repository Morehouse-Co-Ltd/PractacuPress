package site

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/practacu/practacu-press/internal/permalink"
)

// MaxCustomizationBytes bounds one design document.
//
// A site with a few dozen pages of block JSON stays well under a megabyte; the cap
// exists so one authenticated write cannot fill the database, and so a runaway client
// fails loudly instead of slowly.
const MaxCustomizationBytes = 1 << 20

// Per-field bounds that the browser also enforces. The document cap above is the real
// bound for anything else: a single field can never exceed it.
const (
	// maxCustomCSSCharacters matches the frontend cap for the free-form style sheet.
	maxCustomCSSCharacters = 20_000
	// maxThemeStringCharacters: theme tokens are colors, fonts and lengths, never prose.
	maxThemeStringCharacters = 4_096
	// maxCustomizationDepth bounds the recursive walk. The frontend block tree is
	// shallow; a deeply nested payload should fail explicitly, not overflow the stack.
	maxCustomizationDepth = 64
)

// highRiskCSSPatterns are the constructs that turn stored styling into an execution or
// network surface beyond the site: imports and URL schemes that can run script or load
// HTML text, plus the legacy IE/Gecko binding features.
//
// The list is deliberately narrow. Custom CSS legitimately needs `url(https://...)`,
// `@media`, `position: fixed` and friends, so only constructs that cannot be justified
// in a design document are rejected. Matching runs on a normalised form (comments
// stripped, CSS escapes decoded, whitespace removed, lowercased), because that is what
// the CSS parser sees before deciding what a token is.
var highRiskCSSPatterns = []struct {
	marker string
	re     *regexp.Regexp
}{
	{marker: "@import", re: regexp.MustCompile(`@import`)},
	{marker: "expression(", re: regexp.MustCompile(`expression\(`)},
	{marker: "behavior:", re: regexp.MustCompile(`behavior:`)},
	{marker: "-moz-binding", re: regexp.MustCompile(`-moz-binding`)},
	{marker: "url(javascript:", re: regexp.MustCompile(`url\(["']?javascript:`)},
	{marker: "url(data:text/", re: regexp.MustCompile(`url\(["']?data:text/`)},
}

var (
	cssCommentPattern = regexp.MustCompile(`(?s)/\*.*?\*/`)
	cssEscapePattern  = regexp.MustCompile(`\\([0-9a-fA-F]{1,6}\s?|.)`)
)

// Customization returns the saved design document of a site.
//
// No actor is involved on purpose: who may read a design is a transport concern, and the
// handler answers it from the site's visibility mode. The same split is used by the
// public author profile.
func (s *Service) Customization(ctx context.Context, siteID string) (Customization, error) {
	if siteID == "" {
		return Customization{}, ErrNotFound
	}
	return s.repo.Customization(ctx, siteID)
}

// SaveCustomization validates and stores a site's design document.
//
// The document is still stored byte for byte: the server does not interpret block
// properties or re-encode the JSON. But H-1 made one browser's design the copy every
// visitor receives, so a document that is valid JSON is no longer enough: the few fields
// that end up in an executable sink (`custom_css`, theme tokens, page block strings) get
// a content check first.
func (s *Service) SaveCustomization(
	ctx context.Context,
	actor Member,
	siteID string,
	document []byte,
	expectedRevision int,
	requestID string,
) (Customization, error) {
	if err := authorize(actor, siteID, ActionManageSite); err != nil {
		return Customization{}, err
	}
	if err := validateCustomizationDocument(document); err != nil {
		return Customization{}, err
	}
	if expectedRevision < 0 {
		return Customization{}, fmt.Errorf("%w: revision must not be negative", ErrInvalidInput)
	}

	saved, err := s.repo.SaveCustomization(
		ctx,
		siteID,
		CustomizationInput{Document: document, ExpectedRevision: expectedRevision},
		AuditEntry{
			SiteID:    siteID,
			ActorID:   actor.UserID,
			Action:    "site.customization.updated",
			Target:    siteID,
			RequestID: requestID,
			// The audit trail records what changed shape-wise, never the document: a
			// page tree belongs in the design table, not in the operator log.
			Detail: map[string]any{
				"bytes":    len(document),
				"revision": expectedRevision + 1,
			},
			At: s.now(),
		},
	)
	if err != nil {
		return Customization{}, err
	}
	return saved, nil
}

// validateCustomizationDocument rejects anything that is not a JSON object within the
// size cap, or whose executable fields contain known-dangerous constructs.
//
// The object requirement matters: an array or a scalar would still be valid JSON, but the
// frontend normaliser expects an object and would silently fall back to defaults, which
// looks like data loss to the operator who just saved.
func validateCustomizationDocument(document []byte) error {
	if len(document) == 0 {
		return fmt.Errorf("%w: document is empty", ErrInvalidInput)
	}
	if len(document) > MaxCustomizationBytes {
		return fmt.Errorf("%w: document exceeds %d bytes", ErrCustomizationTooLarge, MaxCustomizationBytes)
	}

	trimmed := bytes.TrimSpace(document)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return fmt.Errorf("%w: document must be a JSON object", ErrInvalidInput)
	}
	if !json.Valid(trimmed) {
		return fmt.Errorf("%w: document is not valid JSON", ErrInvalidInput)
	}

	var root map[string]any
	if err := json.Unmarshal(trimmed, &root); err != nil {
		return fmt.Errorf("%w: document must be a JSON object", ErrInvalidInput)
	}
	if err := permalink.ValidateCustomization(trimmed); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	return validateCustomizationContent(root)
}

// validateCustomizationContent walks the decoded document and checks the fields that
// reach a browser sink. Arbitrary block properties are allowed; what they contain is not.
func validateCustomizationContent(root map[string]any) error {
	scan := customizationScan{}
	return scan.walk(root, "", 0)
}

// customizationScan is the recursive field walk. It keeps only one piece of context: a
// theme subtree gets the theme string cap.
type customizationScan struct {
	inTheme bool
}

// subtrees that are skipped on purpose:
//   - custom_extensions: the feature is explicitly "run sandboxed HTML/CSS/JS" and its
//     payloads are arbitrary code by design; marker checks there would break real
//     extensions without preventing anything the sandbox does not already contain.
//   - covers: article covers may be percent-encoded SVG data URLs whose text can contain
//     any sequence, so scanning them would reject legitimate images.
func (s customizationScan) walk(value any, path string, depth int) error {
	if depth > maxCustomizationDepth {
		return fmt.Errorf("%w: document nesting exceeds %d levels", ErrInvalidInput, maxCustomizationDepth)
	}

	switch node := value.(type) {
	case map[string]any:
		for key, child := range node {
			if isSkippedCustomizationKey(key) {
				continue
			}
			childPath := key
			if path != "" {
				childPath = path + "." + key
			}
			if strings.EqualFold(key, "custom_css") {
				if err := validateCustomCSSValue(childPath, child); err != nil {
					return err
				}
				continue
			}
			next := customizationScan{inTheme: s.inTheme || strings.EqualFold(key, "theme")}
			if err := next.walk(child, childPath, depth+1); err != nil {
				return err
			}
		}
		return nil
	case []any:
		for index, child := range node {
			if err := s.walk(child, fmt.Sprintf("%s[%d]", path, index), depth+1); err != nil {
				return err
			}
		}
		return nil
	case string:
		return s.validateString(path, node)
	default:
		return nil
	}
}

func (s customizationScan) validateString(path, value string) error {
	if value == "" {
		return nil
	}
	if s.inTheme && len([]rune(value)) > maxThemeStringCharacters {
		return fmt.Errorf("%w: %s exceeds %d characters", ErrInvalidInput, path, maxThemeStringCharacters)
	}
	if marker := highRiskCSSMarker(value); marker != "" {
		return fmt.Errorf("%w: %s contains forbidden construct %q", ErrInvalidInput, path, marker)
	}
	return nil
}

func validateCustomCSSValue(path string, value any) error {
	if value == nil {
		return nil
	}
	text, ok := value.(string)
	if !ok {
		return fmt.Errorf("%w: %s must be a string", ErrInvalidInput, path)
	}
	if len([]rune(text)) > maxCustomCSSCharacters {
		return fmt.Errorf("%w: %s exceeds %d characters", ErrInvalidInput, path, maxCustomCSSCharacters)
	}
	if marker := highRiskCSSMarker(text); marker != "" {
		return fmt.Errorf("%w: %s contains forbidden construct %q", ErrInvalidInput, path, marker)
	}
	return nil
}

// isSkippedCustomizationKey reports whether a subtree is outside the content check.
func isSkippedCustomizationKey(key string) bool {
	switch strings.ToLower(key) {
	case "custom_extensions", "covers":
		return true
	default:
		return false
	}
}

// highRiskCSSMarker returns the first rejected construct found in value, or "".
func highRiskCSSMarker(value string) string {
	if value == "" {
		return ""
	}
	normalized := normalizeCSSForScan(value)
	for _, candidate := range highRiskCSSPatterns {
		if candidate.re.MatchString(normalized) {
			return candidate.marker
		}
	}
	return ""
}

// normalizeCSSForScan lowers the text and removes comments, CSS escapes and whitespace.
//
// The CSS parser drops comments and resolves escapes before it decides what a token is,
// so `@im/*x*/port` and `\75 rl(javascript:...)` are the same construct as their plain
// spellings. Detection must see that same normal form or it is trivial to bypass.
func normalizeCSSForScan(value string) string {
	value = cssCommentPattern.ReplaceAllString(value, "")
	value = decodeCSSEscapes(value)

	var builder strings.Builder
	builder.Grow(len(value))
	for _, r := range value {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			continue
		}
		builder.WriteRune(unicode.ToLower(r))
	}
	return builder.String()
}

// decodeCSSEscapes resolves CSS escape sequences: `\2f` style hex escapes and `\x`
// single-character escapes.
func decodeCSSEscapes(value string) string {
	return cssEscapePattern.ReplaceAllStringFunc(value, func(match string) string {
		body := match[1:]
		trimmed := strings.TrimSpace(body)
		if trimmed == "" {
			return body
		}
		if hex, err := strconv.ParseInt(trimmed, 16, 32); err == nil {
			return string(rune(hex))
		}
		return body
	})
}
