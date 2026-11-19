// Package taxonomy owns the categories and tags of a site.
//
// Categories and tags share one aggregate because they carry the same fields and the
// same CRUD rules; kind is the only difference. Content references a category by id
// (content_item.category_id) and a tag by name (the JSON tags array), which is why the
// name and the slug are unique inside a site and kind.
package taxonomy

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
)

// invalidField builds a field error that stays matchable as ErrInvalidInput.
//
// Both sentinels are wrapped: errors.Is(err, ErrInvalidInput) keeps working for the
// transport, while errors.As(err, &FieldError) recovers the field and rule the client
// translates. FieldError itself lives in the error model package and cannot reference
// this package's sentinel without an import cycle, which is why the wrapping happens
// here rather than in an Unwrap method.
func invalidField(field, rule, reason string) error {
	return fmt.Errorf("%w: %w", ErrInvalidInput, &apperr.FieldError{
		Field:  field,
		Rule:   rule,
		Reason: reason,
	})
}

// Kind distinguishes the two taxonomy term types.
type Kind string

// Supported kinds. The wire values are singular so they match the request field and
// read naturally in a term payload.
const (
	KindCategory Kind = "category"
	KindTag      Kind = "tag"
)

// Valid reports whether the kind is defined.
func (k Kind) Valid() bool { return k == KindCategory || k == KindTag }

// Bounds on caller supplied terms.
const (
	// MaxNameLength bounds a display name.
	MaxNameLength = 80
	// MaxSlugLength bounds a slug.
	MaxSlugLength = 80
	// MaxDescriptionLength bounds a description.
	MaxDescriptionLength = 500
	// MaxColorLength bounds a colour token.
	MaxColorLength = 16
)

// Sentinel errors.
var (
	// ErrInvalidInput means a term field failed validation.
	ErrInvalidInput = errors.New("taxonomy: invalid input")
	// ErrNotFound means the term does not exist in this site.
	ErrNotFound = errors.New("taxonomy: not found")
	// ErrConflict means the name or slug is already used in this site.
	ErrConflict = errors.New("taxonomy: term already exists")
	// ErrPermissionDenied means the caller may not change this site's taxonomy.
	ErrPermissionDenied = errors.New("taxonomy: permission denied")
	// ErrCrossSite means the site in the path is not the caller's site.
	ErrCrossSite = errors.New("taxonomy: cross site access")
)

var (
	slugPattern  = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	colorPattern = regexp.MustCompile(`^#[0-9a-f]{6}$`)
)

// Actor is the caller changing the taxonomy.
type Actor struct {
	UserID string
	SiteID string
	Role   site.Role
}

// Term is one category or tag.
type Term struct {
	ID          string
	SiteID      string
	Kind        Kind
	Name        string
	Slug        string
	Description string
	Color       string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// Input is a create request.
type Input struct {
	Kind        Kind
	Name        string
	Slug        string
	Description string
	Color       string
}

// PatchInput is a partial update. Nil means "leave unchanged", which is what lets a
// caller clear a description or colour with an explicit empty string.
type PatchInput struct {
	Name        *string
	Slug        *string
	Description *string
	Color       *string
}

// Validate checks and normalizes a create request.
func Validate(in Input) (Input, error) {
	if !in.Kind.Valid() {
		return Input{}, fmt.Errorf("%w: unknown kind", ErrInvalidInput)
	}

	normalized, err := normalizeFields(in.Name, in.Slug, in.Description, in.Color)
	if err != nil {
		return Input{}, err
	}
	if normalized.slug == "" {
		return Input{}, invalidField("slug", "required", "slug is required")
	}

	in.Name = normalized.name
	in.Slug = normalized.slug
	in.Description = normalized.description
	in.Color = normalized.color
	return in, nil
}

// Apply returns the term with the patch applied.
//
// The current name and slug are the fallback when a patch only clears one of them, so
// an update can never produce a term without either.
func (p PatchInput) Apply(term Term) (Term, error) {
	name := term.Name
	slug := term.Slug
	description := term.Description
	color := term.Color

	if p.Name != nil {
		name = *p.Name
	}
	if p.Slug != nil {
		slug = *p.Slug
	}
	if p.Description != nil {
		description = *p.Description
	}
	if p.Color != nil {
		color = *p.Color
	}

	normalized, err := normalizeFields(name, slug, description, color)
	if err != nil {
		return Term{}, err
	}
	// A patch that only changes name may leave slug empty when the slug was derived;
	// derive it again from the (possibly new) name.
	if normalized.slug == "" {
		normalized.slug = SlugFromName(normalized.name)
	}
	if normalized.slug == "" {
		return Term{}, invalidField("slug", "required", "slug is required")
	}

	term.Name = normalized.name
	term.Slug = normalized.slug
	term.Description = normalized.description
	term.Color = normalized.color
	return term, nil
}

type fields struct {
	name        string
	slug        string
	description string
	color       string
}

func normalizeFields(name, slug, description, color string) (fields, error) {
	name = strings.TrimSpace(name)
	slug = strings.ToLower(strings.TrimSpace(slug))
	description = strings.TrimSpace(description)
	color = strings.ToLower(strings.TrimSpace(color))

	if name == "" {
		return fields{}, invalidField("name", "required", "name is required")
	}
	if len([]rune(name)) > MaxNameLength {
		return fields{}, invalidField("name", "too_long", "name is too long")
	}
	if slug == "" {
		slug = SlugFromName(name)
	}
	if slug != "" {
		if len(slug) > MaxSlugLength {
			return fields{}, invalidField("slug", "too_long", "slug is too long")
		}
		if !slugPattern.MatchString(slug) {
			return fields{}, invalidField("slug", "malformed",
				"slug must be lowercase letters, digits and hyphens")
		}
	}
	if len([]rune(description)) > MaxDescriptionLength {
		return fields{}, fmt.Errorf("%w: description is too long", ErrInvalidInput)
	}
	if color != "" {
		if len(color) > MaxColorLength {
			return fields{}, invalidField("color", "too_long", "color is too long")
		}
		if !colorPattern.MatchString(color) {
			return fields{}, invalidField("color", "malformed", "color must be a #rrggbb value")
		}
	}

	return fields{name: name, slug: slug, description: description, color: color}, nil
}

// SlugFromName derives a slug from a display name.
//
// Non ASCII names produce an empty slug on purpose: a transliteration would collide
// across languages, so the caller must supply an explicit ASCII slug instead.
func SlugFromName(name string) string {
	var builder strings.Builder
	lastHyphen := true

	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			builder.WriteRune(r)
			lastHyphen = false
		case !lastHyphen:
			builder.WriteRune('-')
			lastHyphen = true
		}
	}

	slug := strings.Trim(builder.String(), "-")
	if len(slug) > MaxSlugLength {
		slug = strings.Trim(slug[:MaxSlugLength], "-")
	}
	return slug
}

// Repository is the persistence contract for taxonomy terms.
type Repository interface {
	// List returns every term of a site ordered by kind and name.
	List(ctx context.Context, siteID string) ([]Term, error)
	// FindByID loads one term inside a site scope.
	FindByID(ctx context.Context, siteID, termID string) (Term, error)
	// Insert stores a new term.
	Insert(ctx context.Context, term Term) (Term, error)
	// Update persists the mutable fields of a term.
	Update(ctx context.Context, term Term) (Term, error)
	// Delete removes a term. Deleting a category also clears the category reference
	// of content on the same site; content rows themselves are never deleted.
	Delete(ctx context.Context, siteID, termID string) error
}
