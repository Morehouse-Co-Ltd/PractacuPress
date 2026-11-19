// Package redirect owns the URL redirect rules of a site and the public path
// resolution that keeps old permalinks working after a slug changes.
//
// The redirect table is read in front of every public page view, so what is stored is
// a normalised path: a lookup is one exact match on (site_id, from_path) instead of a
// prefix scan, and the unique index on that pair is what makes resolution order
// independent of insertion order.
//
// The package deliberately does not import the content aggregate. The public resolve
// endpoint receives a ContentLocator from the composition root, and the content
// service receives a RedirectRecorder, so the dependency points one way and the
// redirect domain stays testable without a content service.
package redirect

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/permalink"
	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/platform/page"
)

// Bounds on caller supplied values. They mirror the database columns, so a rule that
// validates here cannot be rejected later by the store.
const (
	// DefaultLimit is the page size a listing uses when the caller sends none.
	DefaultLimit = 20
	// MaxLimit is the largest page a listing serves.
	MaxLimit = 100
	// MaxPathLength bounds from_path and to_path.
	MaxPathLength = 512
	// MaxQueryLength bounds the fuzzy search term of the listing.
	MaxQueryLength = 100
	// DefaultStatusCode is the redirect status used when the caller omits one.
	DefaultStatusCode = 301
)

// Locator kinds handed to ContentLocator.
//
// They are the content package's wire values ("article" / "post") duplicated here on
// purpose: the public resolve endpoint only needs to name the kind, and importing the
// content aggregate for two constants would couple the redirect domain to it.
const (
	LocateKindArticle = "article"
	LocateKindPost    = "post"
)

// Sentinel errors.
var (
	// ErrInvalidInput means a redirect field failed validation.
	ErrInvalidInput = errors.New("redirect: invalid input")
	// ErrNotFound means the rule does not exist in this site.
	ErrNotFound = errors.New("redirect: not found")
	// ErrConflict means another rule already owns the same from_path.
	ErrConflict = errors.New("redirect: from path already exists")
	// ErrPermissionDenied means the caller may not manage this site's redirects.
	ErrPermissionDenied = errors.New("redirect: permission denied")
	// ErrCrossSite means the site in the path is not the caller's site.
	ErrCrossSite = errors.New("redirect: cross site access")
)

// invalidField builds a field error that stays matchable as ErrInvalidInput.
//
// Both sentinels are wrapped: errors.Is(err, ErrInvalidInput) keeps working for the
// transport, while errors.As(err, &FieldError) recovers the field and rule the client
// translates. FieldError lives in the error model package and cannot reference this
// package's sentinel without an import cycle, which is why the wrapping happens here.
func invalidField(field, rule, reason string) error {
	return fmt.Errorf("%w: %w", ErrInvalidInput, &apperr.FieldError{
		Field:  field,
		Rule:   rule,
		Reason: reason,
	})
}

// Source records who wrote a rule.
//
// A manual rule is administered by an operator; a slug_change rule is written by the
// content service when a published item's permalink moves; import marks rules that
// arrived with a migration package.
type Source string

// Supported sources.
const (
	SourceManual     Source = "manual"
	SourceSlugChange Source = "slug_change"
	SourceImport     Source = "import"
)

// Valid reports whether the source is defined.
func (s Source) Valid() bool {
	return s == SourceManual || s == SourceSlugChange || s == SourceImport
}

// Redirect is one permanent or temporary URL rule scoped to a site.
type Redirect struct {
	ID         string
	SiteID     string
	FromPath   string
	ToPath     string
	StatusCode int
	Source     Source
	HitCount   int
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// ResolveKind is the outcome of a public path resolution.
type ResolveKind string

// The three outcomes the resolve endpoint can report.
const (
	// KindContent means the path addresses existing content.
	KindContent ResolveKind = "content"
	// KindRedirect means the redirect table owns the path.
	KindRedirect ResolveKind = "redirect"
	// KindMissing means nothing matches the path.
	KindMissing ResolveKind = "missing"
)

// Valid reports whether the kind is defined.
func (k ResolveKind) Valid() bool {
	return k == KindContent || k == KindRedirect || k == KindMissing
}

// Resolution is the answer of the public resolve endpoint.
//
// Status is the HTTP status the page server should answer with (200 for a canonical
// path, 301/302/308 for a move, 404 for a missing path). It is part of the body
// because the endpoint itself always answers 200: it is a lookup service, not the
// page it describes.
type Resolution struct {
	Kind          ResolveKind
	CanonicalPath string
	Status        int
	ContentID     string
	Slug          string
	Title         string
}

// Input is a create or full replace request.
type Input struct {
	FromPath   string
	ToPath     string
	StatusCode int
}

// PatchInput is a partial update. Nil means "leave unchanged", so a caller can move a
// rule without restating the status code the list already showed.
type PatchInput struct {
	FromPath   *string
	ToPath     *string
	StatusCode *int
}

// Validate checks and normalises a rule input.
func Validate(in Input) (Input, error) {
	from, err := normalizePath(in.FromPath, "from_path")
	if err != nil {
		return Input{}, err
	}
	target, err := normalizeTarget(in.ToPath)
	if err != nil {
		return Input{}, err
	}
	status, err := normalizeStatus(in.StatusCode)
	if err != nil {
		return Input{}, err
	}

	in.FromPath = from
	in.ToPath = target
	in.StatusCode = status
	return in, nil
}

// Apply returns the rule with the patch applied and revalidated.
func (p PatchInput) Apply(current Redirect) (Redirect, error) {
	in := Input{
		FromPath:   current.FromPath,
		ToPath:     current.ToPath,
		StatusCode: current.StatusCode,
	}
	if p.FromPath != nil {
		in.FromPath = *p.FromPath
	}
	if p.ToPath != nil {
		in.ToPath = *p.ToPath
	}
	if p.StatusCode != nil {
		in.StatusCode = *p.StatusCode
	}

	validated, err := Validate(in)
	if err != nil {
		return Redirect{}, err
	}
	current.FromPath = validated.FromPath
	current.ToPath = validated.ToPath
	current.StatusCode = validated.StatusCode
	return current, nil
}

// NormalizePath canonicalises an incoming public path.
//
// The stored form has a leading slash, no query string and no fragment, keeps "/" as
// the root and trims every other trailing slash. Two spellings of the same address
// therefore resolve to the same rule, and the unique (site_id, from_path) index is
// enough to detect a duplicate.
func NormalizePath(raw string) (string, error) { return normalizePath(raw, "path") }

func normalizePath(raw, field string) (string, error) {
	path := strings.TrimSpace(raw)
	if index := strings.IndexAny(path, "?#"); index >= 0 {
		path = path[:index]
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return "", invalidField(field, "required", "path is required")
	}
	if strings.ContainsRune(path, '\x00') {
		return "", invalidField(field, "malformed", "path contains a null byte")
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if len(path) > MaxPathLength {
		return "", invalidField(field, "too_long", "path is too long")
	}
	if path != "/" {
		path = strings.TrimRight(path, "/")
		if path == "" {
			path = "/"
		}
	}
	return path, nil
}

// normalizeTarget validates a redirect destination.
//
// It is not path-normalised like from_path: a target may legitimately be an absolute
// URL or carry a query string, and rewriting it would change where a visitor lands.
func normalizeTarget(raw string) (string, error) {
	target := strings.TrimSpace(raw)
	if target == "" {
		return "", invalidField("to_path", "required", "to path is required")
	}
	if strings.ContainsRune(target, '\x00') {
		return "", invalidField("to_path", "malformed", "to path contains a null byte")
	}
	if len(target) > MaxPathLength {
		return "", invalidField("to_path", "too_long", "to path is too long")
	}
	return target, nil
}

// normalizeStatus validates the redirect status code.
func normalizeStatus(code int) (int, error) {
	switch code {
	case 0:
		return DefaultStatusCode, nil
	case 301, 302, 308:
		return code, nil
	}
	return 0, invalidField("status_code", "malformed", "status code must be 301, 302 or 308")
}

// NormalizeQuery trims and bounds the fuzzy search term of a listing.
func NormalizeQuery(raw string) (string, error) {
	query := strings.TrimSpace(raw)
	if len([]rune(query)) > MaxQueryLength {
		return "", invalidField("q", "too_long", "query is too long")
	}
	return query, nil
}

// splitContentPath maps the legacy /a/{key} and /p/{key} paths to their kind and key.
// Configured permalink structures are parsed by the permalink package.
func splitContentPath(path string) (kind, key string, ok bool) {
	prefixes := []struct {
		prefix string
		kind   string
	}{
		{prefix: "/a/", kind: LocateKindArticle},
		{prefix: "/p/", kind: LocateKindPost},
	}
	for _, candidate := range prefixes {
		if !strings.HasPrefix(path, candidate.prefix) {
			continue
		}
		key = strings.TrimPrefix(path, candidate.prefix)
		// A key is one path segment (an id or a slug); anything deeper cannot be a
		// content address and asking the locator would only cost a query.
		if key == "" || strings.Contains(key, "/") {
			return "", "", false
		}
		return candidate.kind, key, true
	}
	return "", "", false
}

// contentKindPrefix returns the public prefix of a locator kind.
func contentKindPrefix(kind string) string {
	switch kind {
	case LocateKindArticle:
		return "/a/"
	case LocateKindPost:
		return "/p/"
	default:
		return ""
	}
}

// Repository is the persistence contract for redirect rules.
type Repository interface {
	// List returns one page of rules ordered newest first. The cursor position is
	// (created_at, id), which is stable when several rows share a timestamp.
	List(
		ctx context.Context,
		siteID, query string,
		limit int,
		after page.Cursor,
	) ([]Redirect, string, error)
	// FindByPath loads the rule that owns an exact normalised from_path.
	FindByPath(ctx context.Context, siteID, fromPath string) (Redirect, error)
	// FindByID loads one rule inside a site scope.
	FindByID(ctx context.Context, siteID, redirectID string) (Redirect, error)
	// Insert stores a new rule. A duplicate from_path is reported as ErrConflict.
	Insert(ctx context.Context, rule Redirect) (Redirect, error)
	// Update persists the mutable fields of a rule. Moving onto a from_path another
	// rule owns is reported as ErrConflict.
	Update(ctx context.Context, rule Redirect) (Redirect, error)
	// Delete removes a rule.
	Delete(ctx context.Context, siteID, redirectID string) error
	// IncrementHitCount adds one to the coarse popularity counter.
	IncrementHitCount(ctx context.Context, siteID, redirectID string) error
}

// Page is one cursor page of rules.
type Page struct {
	Items      []Redirect
	NextCursor string
	HasMore    bool
}

// ContentLocator resolves a public content path to the item behind it.
//
// It is implemented by the content service and injected by the composition root. The
// resolve endpoint sits in front of every page view, so this package takes a narrow
// read port instead of importing the content aggregate and its repository.
type ContentLocator interface {
	Locate(ctx context.Context, siteID, kind, key string) (contentID, slug, title string, ok bool, err error)
}

type DetailedContentLocator interface {
	LocateAddress(ctx context.Context, siteID, kind, key string) (
		contentID, slug, title string,
		publishedAt, createdAt time.Time,
		ok bool,
		err error,
	)
}

type PermalinkSettingsFunc func(context.Context, string) (permalink.Settings, error)

// RedirectRecorder is the write side the content service calls when a published
// item's slug changes.
//
// *Service implements it; the composition root injects that same instance into the
// content service. Publishing must not fail because a redirect could not be written,
// so the contract returns an error the caller may log and ignore.
type RedirectRecorder interface {
	RecordSlugChange(ctx context.Context, siteID, fromPath, toPath string) error
}
