package contentstore

import (
	"context"
	"strings"

	"github.com/practacu/practacu-press/internal/content"

	entgen "github.com/practacu/practacu-press/internal/ent"
	"github.com/practacu/practacu-press/internal/ent/contentitem"
	"github.com/practacu/practacu-press/internal/ent/contentrevision"
)

// The Beta 1.2 lookup capabilities (contract J1 and E) are optional ports of the
// content service, so the store advertises them explicitly instead of widening
// content.Repository for every implementation.

var (
	_ content.SlugLookupStore     = (*Store)(nil)
	_ content.RevisionLookupStore = (*Store)(nil)
)

// FindBySlug loads the live item of one kind carrying slug on a site.
//
// The slug column has no unique index: two authors can derive the same slug from their
// titles. The oldest row wins, which is the first page that ever claimed the address
// and therefore the one a shared link has always pointed at; picking newest instead
// would silently move an existing URL between items. A trashed row never answers, for
// the same reason no other read path exposes the recycle bin.
func (s *Store) FindBySlug(
	ctx context.Context,
	siteID string,
	kind content.Kind,
	slug string,
) (content.Content, error) {
	siteID = strings.TrimSpace(siteID)
	slug = strings.TrimSpace(slug)
	if siteID == "" || slug == "" {
		return content.Content{}, content.ErrNotFound
	}

	query := s.client.ContentItem.Query().Where(
		contentitem.SiteIDEQ(siteID),
		contentitem.SlugEQ(slug),
		contentitem.DeletedAtIsNil(),
	)
	if kind != "" {
		query = query.Where(contentitem.KindEQ(string(kind)))
	}

	row, err := query.
		Order(entgen.Asc(contentitem.FieldCreatedAt), entgen.Asc(contentitem.FieldID)).
		First(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return content.Content{}, content.ErrNotFound
		}
		return content.Content{}, err
	}
	return toContent(row), nil
}

// FindRevisionByVersion loads one history snapshot by version number.
//
// The (content_id, version) pair is what the diff endpoint addresses, so the lookup is
// scoped by site and content as well: a version number alone is never a resource.
func (s *Store) FindRevisionByVersion(
	ctx context.Context,
	siteID, contentID string,
	version int,
) (content.Revision, error) {
	row, err := s.client.ContentRevision.Query().
		Where(
			contentrevision.SiteIDEQ(siteID),
			contentrevision.ContentIDEQ(contentID),
			contentrevision.VersionEQ(version),
		).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return content.Revision{}, content.ErrNotFound
		}
		return content.Revision{}, err
	}

	revision := toRevision(row)
	names, err := s.editorNames(ctx, []string{revision.EditorID})
	if err != nil {
		return content.Revision{}, err
	}
	revision.EditorName = names[revision.EditorID]
	return revision, nil
}
