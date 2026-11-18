package redirect

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// hitIncrementTimeout bounds the detached counter update. The counter is a coarse
// popularity signal, so a slow database must never hold the resolve request open.
const hitIncrementTimeout = 5 * time.Second

// Service implements the redirect use cases.
type Service struct {
	repo    Repository
	locator ContentLocator
	now     func() time.Time
	// launch runs a best effort background task. The default starts a goroutine;
	// tests replace it with a synchronous call so a counter assertion is deterministic.
	launch func(func())
	// onRulesChanged is called after a write that can change a resolution. The HTTP
	// handler points it at its resolve cache; without it an automatic slug-change
	// rule would stay invisible for one cache TTL after the author renamed a slug.
	onRulesChanged func(siteID string)
}

// The content service receives the same instance through this port (J4).
var _ RedirectRecorder = (*Service)(nil)

// ServiceConfig configures a Service.
type ServiceConfig struct {
	// Repository is required.
	Repository Repository
	// Locator resolves content paths for the public resolve endpoint. Nil means only
	// the redirect table is consulted, which is the state of a deployment whose
	// content service is not wired (and of the contract router, which only mounts).
	Locator ContentLocator
	// Now overrides the clock in tests.
	Now func() time.Time
}

// NewService builds a Service.
func NewService(cfg ServiceConfig) (*Service, error) {
	if cfg.Repository == nil {
		return nil, fmt.Errorf("%w: repository is required", ErrInvalidInput)
	}
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &Service{
		repo:    cfg.Repository,
		locator: cfg.Locator,
		now:     now,
		launch:  func(task func()) { go task() },
	}, nil
}

// SetLocator attaches the content lookup after both services exist.
//
// The composition root builds this service before the content service because content
// receives the RedirectRecorder at construction; the resolve endpoint however needs the
// finished content service as its locator, so the port is attached in a second step.
// Tests that build both at once pass it through ServiceConfig instead.
func (s *Service) SetLocator(locator ContentLocator) {
	if s == nil {
		return
	}
	s.locator = locator
}

// SetOnRulesChanged installs the invalidation hook run after a rule write. Wired
// once at construction time; nil is safe and keeps tests independent of a cache.
func (s *Service) SetOnRulesChanged(changed func(siteID string)) {
	if s == nil {
		return
	}
	s.onRulesChanged = changed
}

// rulesChanged tells the cache that one site's resolutions are stale.
func (s *Service) rulesChanged(siteID string) {
	if s != nil && s.onRulesChanged != nil {
		s.onRulesChanged(siteID)
	}
}

// Resolve returns the rule that owns an exact normalised path.
//
// The second return value is false when no rule matches, which is the common case: a
// page whose permalink never moved takes the content path below. A hit increments the
// coarse counter in the background; failing to count a hit must not fail the request,
// so the error is dropped on purpose.
func (s *Service) Resolve(ctx context.Context, siteID, path string) (Redirect, bool, error) {
	if strings.TrimSpace(siteID) == "" {
		return Redirect{}, false, ErrInvalidInput
	}

	normalized, err := NormalizePath(path)
	if err != nil {
		return Redirect{}, false, err
	}

	rule, err := s.repo.FindByPath(ctx, siteID, normalized)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Redirect{}, false, nil
		}
		return Redirect{}, false, err
	}

	s.incrementHit(siteID, rule.ID)
	return rule, true, nil
}

// incrementHit counts one resolution in the background.
func (s *Service) incrementHit(siteID, redirectID string) {
	if s.repo == nil || siteID == "" || redirectID == "" {
		return
	}
	s.launch(func() {
		ctx, cancel := context.WithTimeout(context.Background(), hitIncrementTimeout)
		defer cancel()
		_ = s.repo.IncrementHitCount(ctx, siteID, redirectID)
	})
}

// ResolvePath answers the public resolve endpoint.
//
// The redirect table is consulted before the content locator: an operator's explicit
// rule outranks whatever the content address would otherwise say. An id style content
// path that still resolves is reported as a 301 towards its slug form, which is how a
// shared /a/{id} link keeps working while the canonical address stays one URL.
func (s *Service) ResolvePath(ctx context.Context, siteID, rawPath string) (Resolution, error) {
	if strings.TrimSpace(siteID) == "" {
		return Resolution{}, ErrInvalidInput
	}

	normalized, err := NormalizePath(rawPath)
	if err != nil {
		return Resolution{}, err
	}

	rule, found, err := s.Resolve(ctx, siteID, normalized)
	if err != nil {
		return Resolution{}, err
	}
	if found {
		return Resolution{
			Kind:          KindRedirect,
			CanonicalPath: rule.ToPath,
			Status:        rule.StatusCode,
		}, nil
	}

	kind, key, isContent := splitContentPath(normalized)
	if !isContent || s.locator == nil {
		return missingResolution(normalized), nil
	}

	contentID, slug, title, ok, err := s.locator.Locate(ctx, siteID, kind, key)
	if err != nil {
		return Resolution{}, err
	}
	if !ok || contentID == "" {
		return missingResolution(normalized), nil
	}

	// The address already carries the slug: it is the canonical URL, so the page is
	// served directly instead of bouncing through a redirect.
	canonical := normalized
	status := httpStatusOK
	if key != slug && key == contentID && slug != "" {
		canonical = contentKindPrefix(kind) + slug
		status = httpStatusMovedPermanently
	}

	return Resolution{
		Kind:          KindContent,
		CanonicalPath: canonical,
		Status:        status,
		ContentID:     contentID,
		Slug:          slug,
		Title:         title,
	}, nil
}

// HTTP statuses used in a Resolution. They are the page server's answer, not this
// endpoint's own status, so they are spelled out instead of reused from net/http.
const (
	httpStatusOK               = 200
	httpStatusMovedPermanently = 301
	httpStatusNotFound         = 404
)

// missingResolution is the answer for a path nothing owns.
func missingResolution(normalized string) Resolution {
	return Resolution{
		Kind:          KindMissing,
		CanonicalPath: normalized,
		Status:        httpStatusNotFound,
	}
}

// List returns one page of a site's redirect rules.
func (s *Service) List(
	ctx context.Context,
	actor site.Member,
	siteID, query string,
	limit int,
	after page.Cursor,
) (Page, error) {
	if err := authorizeWrite(actor, siteID); err != nil {
		return Page{}, err
	}

	normalizedQuery, err := NormalizeQuery(query)
	if err != nil {
		return Page{}, err
	}
	if limit <= 0 {
		limit = DefaultLimit
	}
	if limit > MaxLimit {
		limit = MaxLimit
	}

	items, next, err := s.repo.List(ctx, siteID, normalizedQuery, limit, after)
	if err != nil {
		return Page{}, err
	}
	if items == nil {
		items = []Redirect{}
	}
	return Page{Items: items, NextCursor: next, HasMore: next != ""}, nil
}

// Create adds an operator authored rule to a site.
func (s *Service) Create(ctx context.Context, actor site.Member, siteID string, in Input) (Redirect, error) {
	if err := authorizeWrite(actor, siteID); err != nil {
		return Redirect{}, err
	}

	validated, err := Validate(in)
	if err != nil {
		return Redirect{}, err
	}

	now := s.now().UTC()
	created, err := s.repo.Insert(ctx, Redirect{
		SiteID:     siteID,
		FromPath:   validated.FromPath,
		ToPath:     validated.ToPath,
		StatusCode: validated.StatusCode,
		Source:     SourceManual,
		HitCount:   0,
		CreatedAt:  now,
		UpdatedAt:  now,
	})
	if err != nil {
		return Redirect{}, err
	}
	s.rulesChanged(siteID)
	return created, nil
}

// Update applies a partial change to one rule.
//
// Source is immutable: a rule an operator edited stays manual, so the "manual wins over
// automatic" ordering in RecordSlugChange cannot be flipped by an update.
func (s *Service) Update(
	ctx context.Context,
	actor site.Member,
	siteID, redirectID string,
	patch PatchInput,
) (Redirect, error) {
	if err := authorizeWrite(actor, siteID); err != nil {
		return Redirect{}, err
	}

	current, err := s.repo.FindByID(ctx, siteID, redirectID)
	if err != nil {
		return Redirect{}, err
	}

	updated, err := patch.Apply(current)
	if err != nil {
		return Redirect{}, err
	}
	updated.UpdatedAt = s.now().UTC()
	saved, err := s.repo.Update(ctx, updated)
	if err != nil {
		return Redirect{}, err
	}
	s.rulesChanged(siteID)
	return saved, nil
}

// Delete removes one rule.
func (s *Service) Delete(ctx context.Context, actor site.Member, siteID, redirectID string) error {
	if err := authorizeWrite(actor, siteID); err != nil {
		return err
	}
	if err := s.repo.Delete(ctx, siteID, redirectID); err != nil {
		return err
	}
	s.rulesChanged(siteID)
	return nil
}

// RecordSlugChange inserts or replaces the automatic rule for a moved permalink.
//
// It is the J4 write side: the content service calls it when a published item's slug
// changes, so yesterday's shared link keeps working. Both arguments are site relative
// paths ("/a/old-slug", "/a/new-slug"); an empty or unchanged pair is a no-op because
// there is nothing to redirect.
//
// An existing manual rule for the old path wins: an operator who pinned a destination
// asked for exactly that, and an automatic rule must not silently retarget it. An
// existing slug_change rule is overwritten because it describes the same automatic
// decision and the latest move is the correct one.
func (s *Service) RecordSlugChange(ctx context.Context, siteID, fromPath, toPath string) (err error) {
	if strings.TrimSpace(siteID) == "" {
		return nil
	}
	// Any successful write can change a resolution, and this path bypasses the HTTP
	// handler that would otherwise purge the cache. The no-op branches purge too;
	// dropping a few cache entries is far cheaper than serving a stale 404 for a
	// link that has just been given a permanent redirect.
	defer func() {
		if err == nil {
			s.rulesChanged(siteID)
		}
	}()

	from, err := NormalizePath(fromPath)
	if err != nil {
		// Best effort: a malformed path is not worth failing a publish over.
		return nil
	}
	target := strings.TrimSpace(toPath)
	if target == "" {
		return nil
	}
	if normalizedTarget, normalizeErr := NormalizePath(toPath); normalizeErr == nil && normalizedTarget == from {
		return nil
	}
	if target == from {
		return nil
	}

	existing, err := s.repo.FindByPath(ctx, siteID, from)
	if err == nil {
		return s.replaceSlugChange(ctx, existing, target)
	}
	if !errors.Is(err, ErrNotFound) {
		return err
	}

	now := s.now().UTC()
	_, err = s.repo.Insert(ctx, Redirect{
		SiteID:     siteID,
		FromPath:   from,
		ToPath:     target,
		StatusCode: DefaultStatusCode,
		Source:     SourceSlugChange,
		HitCount:   0,
		CreatedAt:  now,
		UpdatedAt:  now,
	})
	if !errors.Is(err, ErrConflict) {
		return err
	}

	// A concurrent writer created the rule between the lookup and the insert. Re-read
	// once and apply the same rules instead of failing the publish.
	existing, err = s.repo.FindByPath(ctx, siteID, from)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}
	return s.replaceSlugChange(ctx, existing, target)
}

// replaceSlugChange retargets an existing automatic rule, leaving a manual one alone.
func (s *Service) replaceSlugChange(ctx context.Context, existing Redirect, target string) error {
	if existing.Source != SourceSlugChange {
		return nil
	}
	if existing.ToPath == target && existing.StatusCode == DefaultStatusCode {
		return nil
	}
	existing.ToPath = target
	existing.StatusCode = DefaultStatusCode
	existing.UpdatedAt = s.now().UTC()
	_, err := s.repo.Update(ctx, existing)
	return err
}

// authorizeWrite is the single write rule: the caller must be authenticated for the
// same site and hold manage_site. A revoked capability is honoured because site.Can
// reads the live membership matrix when the transport passes one along.
func authorizeWrite(actor site.Member, siteID string) error {
	if actor.UserID == "" || actor.SiteID == "" {
		return ErrPermissionDenied
	}
	if actor.SiteID != siteID {
		return ErrCrossSite
	}
	if !site.Can(actor, site.ActionManageSite) {
		return ErrPermissionDenied
	}
	return nil
}
