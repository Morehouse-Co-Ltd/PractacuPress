package content

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Sanitized is the security service's verdict on a revision.
type Sanitized struct {
	HTML          string
	PolicyVersion string
	Violations    []string
}

// Sanitizer turns author supplied source into safe HTML.
//
// It is a narrow interface so this package does not depend on the security client or
// on gRPC, and so a test can control exactly when sanitization fails.
type Sanitizer interface {
	Sanitize(ctx context.Context, format SourceFormat, source string) (Sanitized, error)
}

// Repository is the persistence contract for content.
type Repository interface {
	// Insert stores a new item and its audit entry.
	Insert(ctx context.Context, item Content, audit site.AuditEntry) (Content, error)
	// SaveDraft updates an editable item and its audit entry.
	SaveDraft(ctx context.Context, item Content, audit site.AuditEntry) (Content, error)
	// FindByID loads an item inside a site scope.
	FindByID(ctx context.Context, siteID, contentID string) (Content, error)
	// List returns items of a site filtered by what the caller may see.
	List(ctx context.Context, filter ListFilter) ([]Content, error)
	// Search returns published items whose title or summary matches a term.
	Search(ctx context.Context, siteID, term string, kind Kind, limit int) ([]Content, error)
	// Transition applies a status change only when the stored status still equals
	// from, which makes concurrent moderator decisions safe.
	Transition(ctx context.Context, item Content, from Status, audit site.AuditEntry) (Content, error)
}

// PublishModeFunc resolves the publishing rule of a site.
type PublishModeFunc func(ctx context.Context, siteID string) (site.PublishMode, error)

// Service implements the content use cases.
type Service struct {
	repo        Repository
	sanitizer   Sanitizer
	publishMode PublishModeFunc
	now         func() time.Time
}

// ServiceConfig configures a Service.
type ServiceConfig struct {
	Repository  Repository
	Sanitizer   Sanitizer
	PublishMode PublishModeFunc
	Now         func() time.Time
}

// NewService builds a Service.
func NewService(cfg ServiceConfig) (*Service, error) {
	if cfg.Repository == nil {
		return nil, ErrInvalidInput
	}
	if cfg.Sanitizer == nil {
		return nil, ErrInvalidInput
	}

	service := &Service{
		repo:        cfg.Repository,
		sanitizer:   cfg.Sanitizer,
		publishMode: cfg.PublishMode,
		now:         cfg.Now,
	}
	if service.publishMode == nil {
		// The safe default is review: content never publishes without a human.
		service.publishMode = func(context.Context, string) (site.PublishMode, error) {
			return site.PublishModeReview, nil
		}
	}
	if service.now == nil {
		service.now = func() time.Time { return time.Now().UTC() }
	}
	return service, nil
}

// CreateDraft stores a new draft after sanitizing it.
//
// If the security service is unavailable the item is stored in
// pending_security_check and the error is returned: the content is preserved for the
// author, but it cannot be published until a real sanitization succeeds.
func (s *Service) CreateDraft(ctx context.Context, actor Actor, kind Kind, in DraftInput) (Content, error) {
	if !kind.Valid() {
		return Content{}, ErrInvalidInput
	}
	validated, err := ValidateDraft(in)
	if err != nil {
		return Content{}, err
	}

	now := s.now()
	item := Content{
		SiteID:       actor.SiteID,
		AuthorID:     actor.UserID,
		Kind:         kind,
		Status:       StatusDraft,
		Title:        validated.Title,
		Slug:         validated.Slug,
		Summary:      validated.Summary,
		SourceFormat: validated.SourceFormat,
		SourceBody:   validated.SourceBody,
		CategoryID:   validated.CategoryID,
		Tags:         validated.Tags,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if item.Slug == "" {
		item.Slug = SlugFromTitle(item.Title)
	}

	securityErr := s.applySanitization(ctx, &item)

	audit := site.AuditEntry{
		SiteID:  item.SiteID,
		ActorID: actor.UserID,
		Action:  "content.created",
		Detail:  map[string]any{"kind": string(kind)},
		At:      now,
	}
	saved, err := s.repo.Insert(ctx, item, audit)
	if err != nil {
		return Content{}, err
	}
	return saved, securityErr
}

// UpdateDraft edits an item that has not been published yet.
//
// Published content is immutable: a correction is a new revision that goes through
// review again, so an editor cannot silently rewrite something readers already saw.
func (s *Service) UpdateDraft(ctx context.Context, actor Actor, contentID string, in DraftInput) (Content, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return Content{}, err
	}
	if !editable(item.Status) {
		return Content{}, ErrInvalidTransition
	}
	if !item.IsAuthor(actor) && !actor.Role.AtLeast(site.RoleEditor) {
		return Content{}, ErrPermissionDenied
	}

	validated, err := ValidateDraft(in)
	if err != nil {
		return Content{}, err
	}

	item.Title = validated.Title
	item.Slug = validated.Slug
	if item.Slug == "" {
		item.Slug = SlugFromTitle(item.Title)
	}
	item.Summary = validated.Summary
	item.SourceFormat = validated.SourceFormat
	item.SourceBody = validated.SourceBody
	item.CategoryID = validated.CategoryID
	item.Tags = validated.Tags
	item.UpdatedAt = s.now()

	securityErr := s.applySanitization(ctx, &item)

	saved, err := s.repo.SaveDraft(ctx, item, site.AuditEntry{
		SiteID:  item.SiteID,
		ActorID: actor.UserID,
		Action:  "content.updated",
		At:      s.now(),
	})
	if err != nil {
		return Content{}, err
	}
	return saved, securityErr
}

// Apply performs a workflow action on an item.
func (s *Service) Apply(ctx context.Context, actor Actor, contentID string, action Action, reason string) (Content, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return Content{}, err
	}

	mode, err := s.publishMode(ctx, item.SiteID)
	if err != nil {
		return Content{}, err
	}

	next, err := Policy{PublishMode: mode}.Next(item, action, actor)
	if err != nil {
		return Content{}, err
	}

	// Publication requires a revision that passed sanitization under the current
	// policy. Without it, publishing would serve unaudited HTML.
	if next == StatusPublished && !item.IsSanitized() {
		return Content{}, ErrSecurityUnavailable
	}

	now := s.now()
	updated := item
	updated.Status = next
	updated.UpdatedAt = now
	switch next {
	case StatusPublished:
		updated.PublishedAt = &now
	case StatusArchived:
		updated.ArchivedAt = &now
	case StatusDraft:
		updated.PublishedAt = nil
		updated.ArchivedAt = nil
	}

	detail := map[string]any{
		"from": string(item.Status),
		"to":   string(next),
	}
	if reason != "" {
		detail["reason"] = reason
	}

	return s.repo.Transition(ctx, updated, item.Status, site.AuditEntry{
		SiteID:  item.SiteID,
		ActorID: actor.UserID,
		Action:  "content." + string(action),
		Target:  item.ID,
		Detail:  detail,
		At:      now,
	})
}

// RetrySecurityCheck re-runs sanitization on an item held for security review.
//
// On success the item returns to draft; on failure it stays held, so a retry loop
// cannot accidentally publish something that never passed the check.
func (s *Service) RetrySecurityCheck(ctx context.Context, actor Actor, contentID string) (Content, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return Content{}, err
	}
	if item.Status != StatusPendingSecurityCheck {
		return Content{}, ErrInvalidTransition
	}
	if !item.IsAuthor(actor) && !actor.Role.AtLeast(site.RoleEditor) {
		return Content{}, ErrPermissionDenied
	}

	return s.UpdateDraft(ctx, actor, contentID, DraftInput{
		Title:        item.Title,
		Slug:         item.Slug,
		Summary:      item.Summary,
		SourceFormat: item.SourceFormat,
		SourceBody:   item.SourceBody,
		CategoryID:   item.CategoryID,
		Tags:         item.Tags,
	})
}

// Actions reports what the actor may do to an item right now.
//
// The handler needs this to render affordances, and it must agree with Apply, so it
// runs the same policy with the site's real publish mode.
func (s *Service) Actions(ctx context.Context, actor Actor, item Content) ([]Action, error) {
	mode, err := s.publishMode(ctx, item.SiteID)
	if err != nil {
		return nil, err
	}
	return Policy{PublishMode: mode}.AvailableActions(item, actor), nil
}

// Listing orders accepted by the list endpoints.
const (
	// SortNewest is the default order: most recent first.
	SortNewest = "newest"
	// SortOldest reads the same listing backwards: oldest first.
	SortOldest = "oldest"
)

// MaxTagFilterLength bounds the tag name a listing request may ask for.
//
// It sits above MaxTagLength, the storage bound, because the contract advertises the
// filter bound and a client should not have to know the per item one. A longer value
// cannot be a name this site ever stored, so it is refused rather than truncated into
// a different tag.
const MaxTagFilterLength = 40

// maxCategoryIDLength mirrors the column bound on content_item.category_id.
const maxCategoryIDLength = 36

// ListFilter narrows a listing query.
//
// The service fills SiteID, Kind, Statuses, After and Limit itself; the remaining
// fields are the caller's narrowing. Keeping both in one value means the repository
// has a single argument to read.
type ListFilter struct {
	SiteID string
	Kind   Kind
	// Statuses restricts the result; empty means every status the caller may see.
	Statuses []Status
	// AuthorID restricts the result to one author.
	AuthorID string
	// CategoryID restricts the result to one category. Empty means any.
	CategoryID string
	// Tag restricts the result to items carrying this tag.
	Tag string
	// Since keeps items created at or after this instant. Zero means unbounded.
	Since time.Time
	// Sort picks the ordering: "newest" (default) or "oldest".
	Sort string
	// After is the page boundary; zero means the first page.
	After page.Cursor
	Limit int
}

// NormalizeTag turns a raw tag query value into the name the store may search for.
//
// The returned name never contains a double quote or a backslash. That is what makes
// the quoted token match in the repository safe: the value cannot break out of the
// JSON array text it is compared against. An empty result means the value is not a tag
// name at all — blank, too long, or carrying a character the JSON encoding would
// escape — and the caller must refuse it instead of dropping the filter, because a
// dropped filter would widen the page.
func NormalizeTag(raw string) string {
	name := strings.TrimSpace(raw)
	if name == "" || len([]rune(name)) > MaxTagFilterLength {
		return ""
	}
	if strings.ContainsAny(name, `"\`) {
		return ""
	}
	return name
}

// ValidateSort returns the ordering the repository understands.
//
// An empty value is the documented default rather than an error, so a client that
// sends no sort gets exactly the page it would get from "newest". Any other value is
// rejected: silently falling back would make a typo look like a working filter.
func ValidateSort(raw string) (string, error) {
	switch strings.TrimSpace(raw) {
	case "", SortNewest:
		return SortNewest, nil
	case SortOldest:
		return SortOldest, nil
	default:
		return "", fmt.Errorf("%w: unsupported sort", ErrInvalidInput)
	}
}

// listFilter merges the caller's narrowing with the fields the service owns.
//
// Site, kind, page size and page boundary describe the request, and visibility is
// decided here, so neither is taken from the caller: a filter that arrives with
// statuses set cannot widen what the actor may see.
func (s *Service) listFilter(
	actor Actor,
	kind Kind,
	limit int,
	after page.Cursor,
	narrow ListFilter,
) (ListFilter, error) {
	filter := ListFilter{
		SiteID:   actor.SiteID,
		Kind:     kind,
		AuthorID: strings.TrimSpace(narrow.AuthorID),
		After:    after,
		Limit:    limit,
	}

	if narrow.CategoryID != "" {
		categoryID := strings.TrimSpace(narrow.CategoryID)
		if len([]rune(categoryID)) > maxCategoryIDLength {
			return ListFilter{}, fmt.Errorf("%w: category id is malformed", ErrInvalidInput)
		}
		filter.CategoryID = categoryID
	}

	if narrow.Tag != "" {
		tag := NormalizeTag(narrow.Tag)
		if tag == "" {
			return ListFilter{}, fmt.Errorf("%w: tag is malformed", ErrInvalidInput)
		}
		filter.Tag = tag
	}

	filter.Since = narrow.Since

	sort, err := ValidateSort(narrow.Sort)
	if err != nil {
		return ListFilter{}, err
	}
	filter.Sort = sort

	// Visibility is recomputed, never inherited from the caller's filter.
	if !actor.Role.AtLeast(site.RoleEditor) {
		filter.Statuses = []Status{StatusPublished}
	}

	return filter, nil
}

// ListAfter returns one page of visible items plus the cursor for the next page.
//
// The cursor is only issued when a full page came back: a short page means the end,
// and handing out a cursor there would make the client ask for an empty page.
func (s *Service) ListAfter(
	ctx context.Context,
	actor Actor,
	kind Kind,
	limit int,
	after page.Cursor,
) ([]Content, string, error) {
	return s.ListAfterFilter(ctx, actor, kind, limit, after, ListFilter{})
}

// ListAfterFilter is ListAfter narrowed by the caller's query filters.
//
// It backs the public listing and the author archive (/u/{userID}): the visibility
// rules stay exactly those of ListAfter, so a reader only ever gets published items
// while a moderator may also see the author's queue. The narrowing values are plain
// filter values, not validated resources: an unknown author or category simply matches
// nothing, which is why a stale archive link yields an empty page instead of an error.
func (s *Service) ListAfterFilter(
	ctx context.Context,
	actor Actor,
	kind Kind,
	limit int,
	after page.Cursor,
	narrow ListFilter,
) ([]Content, string, error) {
	if kind != "" && !kind.Valid() {
		return nil, "", ErrInvalidInput
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}

	filter, err := s.listFilter(actor, kind, limit, after, narrow)
	if err != nil {
		return nil, "", err
	}

	items, err := s.repo.List(ctx, filter)
	if err != nil {
		return nil, "", err
	}

	next := ""
	if len(items) == limit && len(items) > 0 {
		last := items[len(items)-1]
		next = page.Cursor{Key: last.CreatedAt.UTC().Format(time.RFC3339Nano), ID: last.ID}.Encode()
	}
	return items, next, nil
}

// List returns the items of a site that the actor is allowed to see.
//
// Visibility is decided here, not by the caller: anonymous and ordinary readers only
// ever get published items, while an author additionally sees their own work and a
// moderator sees everything on the site. narrow carries the optional query filters;
// the fields the service owns are overwritten, so a filter can only narrow the page.
func (s *Service) List(
	ctx context.Context,
	actor Actor,
	kind Kind,
	limit int,
	narrow ListFilter,
) ([]Content, error) {
	if kind != "" && !kind.Valid() {
		return nil, ErrInvalidInput
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}

	filter, err := s.listFilter(actor, kind, limit, page.Cursor{}, narrow)
	if err != nil {
		return nil, err
	}

	return s.repo.List(ctx, filter)
}

// ListOwn returns the caller's own items in every state.
func (s *Service) ListOwn(ctx context.Context, actor Actor, kind Kind, limit int) ([]Content, error) {
	if kind != "" && !kind.Valid() {
		return nil, ErrInvalidInput
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	return s.repo.List(ctx, ListFilter{
		SiteID:   actor.SiteID,
		Kind:     kind,
		AuthorID: actor.UserID,
		Limit:    limit,
	})
}

// SearchQuery bounds a search term.
const (
	// MinSearchTerm is the shortest term worth a query.
	MinSearchTerm = 2
	// MaxSearchTerm bounds the term so a pathological input cannot be indexed.
	MaxSearchTerm = 100
	// DefaultSearchLimit is the page size for search.
	DefaultSearchLimit = 20
)

// Search finds published content by title or summary.
//
// Only published items are searched: a draft leaking through search would be the same
// disclosure the read endpoint exists to prevent. The term is trimmed and bounded here
// so the repository never receives an unbounded pattern.
func (s *Service) Search(
	ctx context.Context,
	actor Actor,
	term string,
	kind Kind,
	limit int,
) ([]Content, error) {
	if kind != "" && !kind.Valid() {
		return nil, ErrInvalidInput
	}

	term = strings.TrimSpace(term)
	if len([]rune(term)) < MinSearchTerm {
		return nil, ErrInvalidInput
	}
	if len([]rune(term)) > MaxSearchTerm {
		term = string([]rune(term)[:MaxSearchTerm])
	}
	if limit <= 0 || limit > 100 {
		limit = DefaultSearchLimit
	}

	return s.repo.Search(ctx, actor.SiteID, term, kind, limit)
}

// Get returns one item, restricted to what the actor may read.
func (s *Service) Get(ctx context.Context, actor Actor, contentID string) (Content, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return Content{}, err
	}
	// Unpublished content is visible to its author and to moderators only.
	if !item.Status.IsPublic() && !item.IsAuthor(actor) && !actor.Role.AtLeast(site.RoleEditor) {
		return Content{}, ErrNotFound
	}
	return item, nil
}

// applySanitization fills the rendered HTML or marks the item as held.
func (s *Service) applySanitization(ctx context.Context, item *Content) error {
	format := item.SourceFormat
	source := item.SourceBody

	// Markdown is expanded to HTML first: the sanitizer cleans markup, it does not
	// parse a markdown dialect. Plain and HTML already reach it in their final shape.
	if format == FormatMarkdown {
		rendered, err := renderMarkdown(source)
		if err != nil {
			return fmt.Errorf("render markdown: %w", err)
		}
		format, source = FormatHTML, rendered
	}

	result, err := s.sanitizer.Sanitize(ctx, format, source)
	if err != nil {
		// Fail closed: keep the item, drop any previously rendered HTML, and hold it.
		item.Status = StatusPendingSecurityCheck
		item.RenderedHTML = ""
		item.PolicyVersion = ""
		return ErrSecurityUnavailable
	}

	item.RenderedHTML = result.HTML
	item.PolicyVersion = result.PolicyVersion
	if item.Status == StatusPendingSecurityCheck {
		item.Status = StatusDraft
	}
	return nil
}

func (s *Service) load(ctx context.Context, actor Actor, contentID string) (Content, error) {
	item, err := s.repo.FindByID(ctx, actor.SiteID, contentID)
	if err != nil {
		return Content{}, err
	}
	if item.SiteID != actor.SiteID {
		// The repository already scopes by site; this is defence in depth.
		return Content{}, ErrCrossSite
	}
	return item, nil
}

// IsSanitized reports whether the item carries HTML produced by a security policy.
func (c Content) IsSanitized() bool {
	return c.RenderedHTML != "" && c.PolicyVersion != ""
}

func editable(status Status) bool {
	switch status {
	case StatusDraft, StatusRejected, StatusPendingSecurityCheck:
		return true
	default:
		return false
	}
}
