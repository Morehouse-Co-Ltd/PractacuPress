package taxonomy

import (
	"context"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Service implements the taxonomy use cases.
type Service struct {
	repo Repository
	now  func() time.Time
}

// ServiceConfig configures a Service.
type ServiceConfig struct {
	// Repository is required.
	Repository Repository
	// Now overrides the clock in tests.
	Now func() time.Time
}

// NewService builds a Service.
func NewService(cfg ServiceConfig) (*Service, error) {
	if cfg.Repository == nil {
		return nil, ErrInvalidInput
	}
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{repo: cfg.Repository, now: now}, nil
}

// List returns every term of a site.
//
// Reading is deliberately public: the reader facing site renders category lists and
// tag chips for anonymous visitors. The handler is still responsible for proving that
// the requested site is the one the request host resolved to, so this method cannot be
// used to read another tenant's taxonomy by guessing an id.
func (s *Service) List(ctx context.Context, siteID string) ([]Term, error) {
	if strings.TrimSpace(siteID) == "" {
		return nil, ErrInvalidInput
	}
	terms, err := s.repo.List(ctx, siteID)
	if err != nil {
		return nil, err
	}
	if terms == nil {
		terms = []Term{}
	}
	return terms, nil
}

// Create adds a category or tag to a site.
func (s *Service) Create(ctx context.Context, actor Actor, siteID string, in Input) (Term, error) {
	if err := authorizeWrite(actor, siteID); err != nil {
		return Term{}, err
	}

	validated, err := Validate(in)
	if err != nil {
		return Term{}, err
	}

	now := s.now().UTC()
	return s.repo.Insert(ctx, Term{
		SiteID:      siteID,
		Kind:        validated.Kind,
		Name:        validated.Name,
		Slug:        validated.Slug,
		Description: validated.Description,
		Color:       validated.Color,
		CreatedAt:   now,
		UpdatedAt:   now,
	})
}

// Update applies a partial change to one term.
//
// Kind is immutable: turning a category into a tag would orphan every reference, so a
// patch cannot change it.
func (s *Service) Update(
	ctx context.Context,
	actor Actor,
	siteID, termID string,
	patch PatchInput,
) (Term, error) {
	if err := authorizeWrite(actor, siteID); err != nil {
		return Term{}, err
	}

	term, err := s.repo.FindByID(ctx, siteID, termID)
	if err != nil {
		return Term{}, err
	}

	updated, err := patch.Apply(term)
	if err != nil {
		return Term{}, err
	}
	updated.UpdatedAt = s.now().UTC()

	return s.repo.Update(ctx, updated)
}

// Delete removes one term.
func (s *Service) Delete(ctx context.Context, actor Actor, siteID, termID string) error {
	if err := authorizeWrite(actor, siteID); err != nil {
		return err
	}
	return s.repo.Delete(ctx, siteID, termID)
}

// authorizeWrite is the single write permission rule: the caller must be
// authenticated, act on its own site, and hold at least site administrator authority.
// A platform administrator outranks site administrator and therefore passes.
func authorizeWrite(actor Actor, siteID string) error {
	if actor.UserID == "" || actor.SiteID == "" {
		return ErrPermissionDenied
	}
	if actor.SiteID != siteID {
		return ErrCrossSite
	}
	if !actor.Role.AtLeast(site.RoleSiteAdmin) {
		return ErrPermissionDenied
	}
	return nil
}
