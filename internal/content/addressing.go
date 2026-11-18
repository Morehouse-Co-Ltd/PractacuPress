package content

import (
	"context"
	"errors"
	"strings"
)

// Stable content addressing (Beta 1.2 contract J) and the two structured lookups the
// redirect and newsletter modules consume.
//
// A content id is the storage address; a slug is the public address. The read and
// action endpoints accept either (contract J1), which means one place has to decide
// what "look it up" means: id first, then slug inside the route's kind. Keeping that
// rule here keeps the handler from reimplementing it per endpoint and keeps the slug
// query scoped to the kind of the route, so /articles/x can never serve a post.

// KindPathPrefix returns the site relative URL prefix of a content kind.
func KindPathPrefix(kind Kind) string {
	if kind == KindPost {
		return "/p/"
	}
	return "/a/"
}

// PathFor renders the public path of one item: the slug when it has one, the id as the
// documented fallback otherwise (contract J5).
func PathFor(kind Kind, slug, id string) string {
	key := strings.TrimSpace(slug)
	if key == "" {
		key = id
	}
	return KindPathPrefix(kind) + key
}

// ContentPath is PathFor applied to a loaded item.
func ContentPath(item Content) string {
	return PathFor(item.Kind, item.Slug, item.ID)
}

// lookupByKey loads the item a URL key addresses.
//
// The contract order is explicit - id first, then slug - so a key that happens to be
// both (an id shaped slug) still resolves to the row, never to a different one. The
// slug query is scoped to the route's kind, which is the only disambiguation a URL
// offers when two kinds share a slug.
//
// includeTrashed is for the lifecycle actions (undelete, purge): they are the only
// callers whose key legitimately addresses a row in the recycle bin. The slug lookup
// stays live-only, so restoring a trashed item by id works and by slug it does not -
// the bin is an authoring surface reached from the id carrying listing.
func (s *Service) lookupByKey(
	ctx context.Context,
	siteID string,
	kind Kind,
	key string,
	includeTrashed bool,
) (Content, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return Content{}, ErrNotFound
	}

	find := s.repo.FindByID
	if includeTrashed {
		find = s.repo.FindByIDIncludingTrashed
	}
	item, err := find(ctx, siteID, key)
	if err == nil {
		if item.SiteID != siteID {
			return Content{}, ErrCrossSite
		}
		return item, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Content{}, err
	}

	// A repository without the slug capability keeps the pre Beta 1.2 behaviour: the
	// key was not an id, so it is not a resource.
	if s.slugs == nil || !kind.Valid() {
		return Content{}, ErrNotFound
	}
	item, err = s.slugs.FindBySlug(ctx, siteID, kind, key)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Content{}, ErrNotFound
		}
		return Content{}, err
	}
	if item.SiteID != siteID {
		return Content{}, ErrCrossSite
	}
	return item, nil
}

// ResolveContentID maps a route key to the stored id of a live item.
//
// The mutating endpoints (PATCH, revisions, diff, preview) share the ordinary service
// methods, which take an id. The handler resolves the key through this method once and
// then behaves exactly as it did before slug addressing existed.
func (s *Service) ResolveContentID(
	ctx context.Context,
	siteID string,
	kind Kind,
	key string,
) (string, error) {
	item, err := s.lookupByKey(ctx, siteID, kind, key, false)
	if err != nil {
		return "", err
	}
	return item.ID, nil
}

// ResolveActionContentID maps a route key to the stored id, including the recycle bin.
//
// It backs the workflow action route and the DELETE endpoint: trashing is idempotent
// and undelete/purge address an item that is, by definition, trashed, so those keys
// must resolve through the bin lookup rather than the ordinary read.
func (s *Service) ResolveActionContentID(
	ctx context.Context,
	siteID string,
	kind Kind,
	key string,
) (string, error) {
	item, err := s.lookupByKey(ctx, siteID, kind, key, true)
	if err != nil {
		return "", err
	}
	return item.ID, nil
}

// Locate resolves a public content path key for the redirect module (contract J2).
//
// It answers only for a live published item: the public path resolver exists to tell a
// static server where a page lives, and a draft or archived row has no public address.
// Reporting it as missing is also the non disclosure rule - guessing a draft's slug
// must produce the same answer as guessing an unused one.
//
// The signature matches redirect.ContentLocator; this package does not import it.
func (s *Service) Locate(
	ctx context.Context,
	siteID, kind, key string,
) (contentID, slug, title string, ok bool, err error) {
	siteID = strings.TrimSpace(siteID)
	contentKind := Kind(strings.TrimSpace(kind))
	if siteID == "" || strings.TrimSpace(key) == "" || !contentKind.Valid() {
		return "", "", "", false, nil
	}

	item, err := s.lookupByKey(ctx, siteID, contentKind, key, false)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return "", "", "", false, nil
		}
		return "", "", "", false, err
	}
	if item.Kind != contentKind || item.Status != StatusPublished {
		return "", "", "", false, nil
	}
	return item.ID, item.Slug, item.Title, true, nil
}

// Digest renders the three fields a newsletter needs (contract N6).
//
// The signature matches newsletter.ContentDigest. A trashed item is reported as
// missing; any other state is returned because choosing what to send is the
// administrator's decision and hiding a draft from them would only move the failure to
// a later step. The caller links to the public path, where an unpublished item answers
// 404 like any other missing page.
func (s *Service) Digest(
	ctx context.Context,
	siteID, contentID string,
) (title, summary, url string, ok bool, err error) {
	siteID = strings.TrimSpace(siteID)
	contentID = strings.TrimSpace(contentID)
	if siteID == "" || contentID == "" {
		return "", "", "", false, nil
	}

	item, err := s.repo.FindByID(ctx, siteID, contentID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return "", "", "", false, nil
		}
		return "", "", "", false, err
	}
	return item.Title, item.Summary, ContentPath(item), true, nil
}

// SetRedirectRecorder wires the slug change recorder after construction.
//
// The redirect module needs the content locator, so the composition root usually builds
// it after the content service and attaches it here. Called once at startup.
func (s *Service) SetRedirectRecorder(recorder RedirectRecorder) { s.redirects = recorder }

// recordSlugChange forwards a published item's old and new public path to the optional
// redirect recorder (contract J4).
//
// It is best effort by design: the save is already committed, and a redirect module
// that is down must not turn a successful edit into an API error. An unchanged or
// empty slug records nothing, because there is no old address to keep alive.
func (s *Service) recordSlugChange(ctx context.Context, siteID string, kind Kind, previous, next string) {
	if s.redirects == nil {
		return
	}
	previous = strings.TrimSpace(previous)
	next = strings.TrimSpace(next)
	if previous == "" || next == "" || previous == next {
		return
	}
	_ = s.redirects.RecordSlugChange(
		ctx,
		siteID,
		KindPathPrefix(kind)+previous,
		KindPathPrefix(kind)+next,
	)
}
