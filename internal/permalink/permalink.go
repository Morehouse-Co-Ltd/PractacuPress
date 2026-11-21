package permalink

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type Structure string

const (
	StructureLegacy    Structure = "legacy"
	StructureDateName  Structure = "date_name"
	StructureMonthName Structure = "month_name"
	StructureNumeric   Structure = "numeric"
	StructurePostName  Structure = "post_name"
	StructureCustom    Structure = "custom"
)

type Settings struct {
	ArticleStructure Structure `json:"article_structure"`
	ArticleCustom    string    `json:"article_custom"`
	ArticleAliases   []Pattern `json:"article_aliases,omitempty"`
	PostsFollow      bool      `json:"posts_follow_articles"`
	PostStructure    Structure `json:"post_structure"`
	PostCustom       string    `json:"post_custom"`
	PostAliases      []Pattern `json:"post_aliases,omitempty"`
}

type Pattern struct {
	Structure Structure `json:"structure"`
	Custom    string    `json:"custom,omitempty"`
}

type Item struct {
	Kind string
	ID   string
	Slug string
	Date time.Time
}

type Candidate struct {
	Kind string
	Key  string
}

var (
	ErrInvalidSettings = errors.New("permalink: invalid settings")
	placeholderPattern = regexp.MustCompile(`%(year|monthnum|day|postname|post_id)%`)
)

// Defaults is the address structure for a site that has not saved an explicit
// choice: both articles and posts live directly under their own name ("/%postname%",
// the "文章名" option). A saved legacy or custom structure is never rewritten.
func Defaults() Settings {
	return Settings{
		ArticleStructure: StructurePostName,
		PostStructure:    StructurePostName,
	}
}

func ParseCustomization(document []byte) Settings {
	settings := Defaults()
	if len(bytes.TrimSpace(document)) == 0 {
		return settings
	}
	var decoded struct {
		SEO *struct {
			Permalinks *Settings `json:"permalinks"`
		} `json:"seo"`
	}
	if json.Unmarshal(document, &decoded) != nil || decoded.SEO == nil || decoded.SEO.Permalinks == nil {
		return settings
	}
	candidate := *decoded.SEO.Permalinks
	if !ValidStructure(candidate.ArticleStructure) || !ValidStructure(candidate.PostStructure) {
		return settings
	}
	if candidate.ArticleStructure == StructureCustom && ValidateCustom(candidate.ArticleCustom) != nil {
		return settings
	}
	if candidate.PostStructure == StructureCustom && ValidateCustom(candidate.PostCustom) != nil {
		return settings
	}
	candidate.ArticleAliases = validAliases(candidate.ArticleAliases)
	candidate.PostAliases = validAliases(candidate.PostAliases)
	return candidate
}

func ValidateCustomization(document []byte) error {
	var decoded struct {
		SEO *struct {
			Permalinks *Settings `json:"permalinks"`
		} `json:"seo"`
	}
	if json.Unmarshal(document, &decoded) != nil || decoded.SEO == nil || decoded.SEO.Permalinks == nil {
		return nil
	}
	settings := decoded.SEO.Permalinks
	if !ValidStructure(settings.ArticleStructure) {
		return fmt.Errorf("%w: article structure", ErrInvalidSettings)
	}
	if settings.ArticleStructure == StructureCustom {
		if err := ValidateCustom(settings.ArticleCustom); err != nil {
			return fmt.Errorf("%w: article custom structure: %v", ErrInvalidSettings, err)
		}
	}
	if !ValidStructure(settings.PostStructure) {
		return fmt.Errorf("%w: post structure", ErrInvalidSettings)
	}
	if settings.PostStructure == StructureCustom {
		if err := ValidateCustom(settings.PostCustom); err != nil {
			return fmt.Errorf("%w: post custom structure: %v", ErrInvalidSettings, err)
		}
	}
	for _, alias := range append(append([]Pattern(nil), settings.ArticleAliases...), settings.PostAliases...) {
		if !ValidStructure(alias.Structure) || (alias.Structure == StructureCustom && ValidateCustom(alias.Custom) != nil) {
			return fmt.Errorf("%w: invalid previous permalink structure", ErrInvalidSettings)
		}
	}
	return nil
}

func ValidStructure(value Structure) bool {
	switch value {
	case StructureLegacy, StructureDateName, StructureMonthName, StructureNumeric, StructurePostName, StructureCustom:
		return true
	default:
		return false
	}
}

func ValidateCustom(template string) error {
	template = strings.TrimSpace(template)
	if template == "" || len(template) > 200 || !strings.HasPrefix(template, "/") ||
		strings.ContainsAny(template, "?#\\") || strings.Contains(template, "//") {
		return ErrInvalidSettings
	}
	withoutPlaceholders := placeholderPattern.ReplaceAllString(template, "x")
	if strings.Contains(withoutPlaceholders, "%") || strings.ContainsAny(withoutPlaceholders, " <>\t\r\n") {
		return ErrInvalidSettings
	}
	if !strings.Contains(template, "%postname%") && !strings.Contains(template, "%post_id%") {
		return ErrInvalidSettings
	}
	for _, segment := range strings.Split(strings.Trim(template, "/"), "/") {
		if segment == ".." || segment == "." {
			return ErrInvalidSettings
		}
	}
	return nil
}

func StructureFor(settings Settings, kind string) (Structure, string) {
	if kind == "post" {
		if settings.PostsFollow {
			return settings.ArticleStructure, settings.ArticleCustom
		}
		return settings.PostStructure, settings.PostCustom
	}
	return settings.ArticleStructure, settings.ArticleCustom
}

func Path(settings Settings, item Item) string {
	structure, custom := StructureFor(settings, item.Kind)
	slug := strings.TrimSpace(item.Slug)
	if slug == "" {
		slug = item.ID
	}
	if slug == "" || item.ID == "" {
		return ""
	}
	date := item.Date
	if date.IsZero() {
		date = time.Unix(0, 0).UTC()
	}
	values := map[string]string{
		"%year%":     date.UTC().Format("2006"),
		"%monthnum%": date.UTC().Format("01"),
		"%day%":      date.UTC().Format("02"),
		"%postname%": slug,
		"%post_id%":  item.ID,
	}
	switch structure {
	case StructureLegacy:
		prefix := "/a/"
		if item.Kind == "post" {
			prefix = "/p/"
		}
		return prefix + url.PathEscape(slug)
	case StructureDateName:
		return "/" + values["%year%"] + "/" + values["%monthnum%"] + "/" + values["%day%"] + "/" + url.PathEscape(slug)
	case StructureMonthName:
		return "/" + values["%year%"] + "/" + values["%monthnum%"] + "/" + url.PathEscape(slug)
	case StructureNumeric:
		return "/archives/" + url.PathEscape(item.ID)
	case StructurePostName:
		return "/" + url.PathEscape(slug)
	case StructureCustom:
		return replace(templateOrDefault(custom), values)
	default:
		return ""
	}
}

func Match(path string, settings Settings) []Candidate {
	path = cleanPath(path)
	candidates := make([]Candidate, 0, 2)
	for _, kind := range []string{"article", "post"} {
		for _, pattern := range patternsFor(settings, kind) {
			if key, ok := matchStructure(path, pattern.Structure, pattern.Custom); ok {
				candidate := Candidate{Kind: kind, Key: key}
				if !containsCandidate(candidates, candidate) {
					candidates = append(candidates, candidate)
				}
			}
		}
	}
	if len(candidates) == 0 {
		if kind, key, ok := legacyMatch(path); ok {
			return []Candidate{{Kind: kind, Key: key}}
		}
	}
	return candidates
}

func patternsFor(settings Settings, kind string) []Pattern {
	structure, custom := StructureFor(settings, kind)
	patterns := []Pattern{{Structure: structure, Custom: custom}}
	aliases := settings.ArticleAliases
	if kind == "post" {
		aliases = settings.PostAliases
		if settings.PostsFollow {
			aliases = append(append([]Pattern(nil), settings.ArticleAliases...), settings.PostAliases...)
		}
	}
	for _, alias := range aliases {
		patterns = append(patterns, alias)
	}
	return patterns
}

func validAliases(aliases []Pattern) []Pattern {
	valid := make([]Pattern, 0, len(aliases))
	for _, alias := range aliases {
		if ValidStructure(alias.Structure) && (alias.Structure != StructureCustom || ValidateCustom(alias.Custom) == nil) {
			valid = append(valid, alias)
		}
	}
	if len(valid) > 12 {
		valid = valid[len(valid)-12:]
	}
	return valid
}

func containsCandidate(candidates []Candidate, candidate Candidate) bool {
	for _, existing := range candidates {
		if existing == candidate {
			return true
		}
	}
	return false
}

func matchStructure(path string, structure Structure, custom string) (string, bool) {
	template := templateFor(structure, custom)
	if template == "" {
		return "", false
	}
	parts := placeholderPattern.FindAllStringIndex(template, -1)
	var pattern strings.Builder
	pattern.WriteByte('^')
	last := 0
	for _, part := range parts {
		pattern.WriteString(regexp.QuoteMeta(template[last:part[0]]))
		name := template[part[0]+1 : part[1]-1]
		pattern.WriteString("(?P<" + name + ">[^/]+)")
		last = part[1]
	}
	pattern.WriteString(regexp.QuoteMeta(template[last:]))
	pattern.WriteByte('$')
	compiled, err := regexp.Compile(pattern.String())
	if err != nil {
		return "", false
	}
	matches := compiled.FindStringSubmatch(path)
	if matches == nil {
		return "", false
	}
	for index, name := range compiled.SubexpNames() {
		if (name == "postname" || name == "post_id") && index < len(matches) {
			key, err := url.PathUnescape(matches[index])
			return key, err == nil && key != ""
		}
	}
	return "", false
}

func templateFor(structure Structure, custom string) string {
	switch structure {
	case StructureLegacy:
		return ""
	case StructureDateName:
		return "/%year%/%monthnum%/%day%/%postname%"
	case StructureMonthName:
		return "/%year%/%monthnum%/%postname%"
	case StructureNumeric:
		return "/archives/%post_id%"
	case StructurePostName:
		return "/%postname%"
	case StructureCustom:
		return templateOrDefault(custom)
	default:
		return ""
	}
}

func templateOrDefault(custom string) string {
	if ValidateCustom(custom) != nil {
		return "/%postname%"
	}
	return strings.TrimRight(strings.TrimSpace(custom), "/")
}

func replace(template string, values map[string]string) string {
	return placeholderPattern.ReplaceAllStringFunc(template, func(token string) string {
		return url.PathEscape(values[token])
	})
}

func legacyMatch(path string) (string, string, bool) {
	for _, prefix := range []struct{ path, kind string }{{"/a/", "article"}, {"/p/", "post"}} {
		if !strings.HasPrefix(path, prefix.path) {
			continue
		}
		key := strings.TrimPrefix(path, prefix.path)
		if key == "" || strings.Contains(key, "/") {
			return "", "", false
		}
		decoded, err := url.PathUnescape(key)
		return prefix.kind, decoded, err == nil
	}
	return "", "", false
}

func cleanPath(path string) string {
	path = strings.TrimSpace(path)
	path = strings.TrimRight(path, "/")
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		return "/" + path
	}
	return path
}
