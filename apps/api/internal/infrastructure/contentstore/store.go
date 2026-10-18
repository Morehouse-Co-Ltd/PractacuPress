// Package contentstore implements the content persistence port with Ent.
package contentstore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/site"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/contentitem"
)

// Store is the Ent backed implementation of content.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ content.Repository = (*Store)(nil)

// Insert stores a new item and its audit entry in one transaction.
func (s *Store) Insert(ctx context.Context, item content.Content, audit site.AuditEntry) (content.Content, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return content.Content{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	builder := tx.ContentItem.Create().
		SetSiteID(item.SiteID).
		SetAuthorID(item.AuthorID).
		SetKind(string(item.Kind)).
		SetStatus(string(item.Status)).
		SetTitle(item.Title).
		SetSlug(item.Slug).
		SetSummary(item.Summary).
		SetSourceFormat(string(item.SourceFormat)).
		SetSourceBody(item.SourceBody).
		SetRenderedHTML(item.RenderedHTML).
		SetPolicyVersion(item.PolicyVersion).
		SetCreatedAt(item.CreatedAt).
		SetUpdatedAt(item.UpdatedAt)
	if item.CategoryID != "" {
		builder.SetCategoryID(item.CategoryID)
	}
	if item.PublishedAt != nil {
		builder.SetPublishedAt(*item.PublishedAt)
	}
	if item.ArchivedAt != nil {
		builder.SetArchivedAt(*item.ArchivedAt)
	}

	created, err := builder.Save(ctx)
	if err != nil {
		return content.Content{}, err
	}
	if err := insertAudit(ctx, tx.Client(), audit, item.Kind, created.ID); err != nil {
		return content.Content{}, err
	}
	if err := tx.Commit(); err != nil {
		return content.Content{}, err
	}
	committed = true

	return toContent(created), nil
}

// SaveDraft updates an editable item and its audit entry in one transaction.
func (s *Store) SaveDraft(ctx context.Context, item content.Content, audit site.AuditEntry) (content.Content, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return content.Content{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	update := tx.ContentItem.Update().
		Where(contentitem.IDEQ(item.ID), contentitem.SiteIDEQ(item.SiteID)).
		SetTitle(item.Title).
		SetSlug(item.Slug).
		SetSummary(item.Summary).
		SetSourceFormat(string(item.SourceFormat)).
		SetSourceBody(item.SourceBody).
		SetRenderedHTML(item.RenderedHTML).
		SetPolicyVersion(item.PolicyVersion).
		SetStatus(string(item.Status)).
		SetUpdatedAt(item.UpdatedAt)
	if item.CategoryID != "" {
		update.SetCategoryID(item.CategoryID)
	}

	affected, err := update.Save(ctx)
	if err != nil {
		return content.Content{}, err
	}
	if affected == 0 {
		return content.Content{}, content.ErrNotFound
	}

	if err := insertAudit(ctx, tx.Client(), audit, item.Kind, item.ID); err != nil {
		return content.Content{}, err
	}
	if err := tx.Commit(); err != nil {
		return content.Content{}, err
	}
	committed = true

	updated, err := s.client.ContentItem.Get(ctx, item.ID)
	if err != nil {
		return content.Content{}, err
	}
	return toContent(updated), nil
}

// FindByID loads an item inside a site scope.
func (s *Store) FindByID(ctx context.Context, siteID, contentID string) (content.Content, error) {
	row, err := s.client.ContentItem.Query().
		Where(contentitem.IDEQ(contentID), contentitem.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return content.Content{}, content.ErrNotFound
		}
		return content.Content{}, err
	}
	return toContent(row), nil
}

// Transition applies a status change only when the stored status still matches from.
//
// The conditional update is the concurrency guard: two moderators acting on stale
// reads cannot both win, and the loser sees ErrInvalidTransition rather than silently
// overwriting the other decision.
func (s *Store) Transition(
	ctx context.Context,
	item content.Content,
	from content.Status,
	audit site.AuditEntry,
) (content.Content, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return content.Content{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	update := tx.ContentItem.Update().
		Where(
			contentitem.IDEQ(item.ID),
			contentitem.SiteIDEQ(item.SiteID),
			contentitem.StatusEQ(string(from)),
		).
		SetStatus(string(item.Status)).
		SetUpdatedAt(item.UpdatedAt)

	if item.PublishedAt != nil {
		update.SetPublishedAt(*item.PublishedAt)
	} else {
		update.ClearPublishedAt()
	}
	if item.ArchivedAt != nil {
		update.SetArchivedAt(*item.ArchivedAt)
	} else {
		update.ClearArchivedAt()
	}

	affected, err := update.Save(ctx)
	if err != nil {
		return content.Content{}, err
	}
	if affected == 0 {
		return content.Content{}, content.ErrInvalidTransition
	}

	if err := insertAudit(ctx, tx.Client(), audit, item.Kind, item.ID); err != nil {
		return content.Content{}, err
	}
	if err := tx.Commit(); err != nil {
		return content.Content{}, err
	}
	committed = true

	updated, err := s.client.ContentItem.Get(ctx, item.ID)
	if err != nil {
		return content.Content{}, err
	}
	return toContent(updated), nil
}

func insertAudit(ctx context.Context, client *entgen.Client, entry site.AuditEntry, kind content.Kind, contentID string) error {
	at := entry.At
	if at.IsZero() {
		at = time.Now().UTC()
	}

	builder := client.AuditLog.Create().
		SetAction(entry.Action).
		SetTargetType(string(kind)).
		SetTargetID(contentID).
		SetCreatedAt(at)

	if entry.SiteID != "" {
		builder.SetSiteID(entry.SiteID)
	}
	if entry.ActorID != "" {
		builder.SetActorID(entry.ActorID)
	}
	if entry.RequestID != "" {
		builder.SetRequestID(entry.RequestID)
	}
	if entry.Detail != nil {
		builder.SetDetail(entry.Detail)
	}

	_, err := builder.Save(ctx)
	return err
}

func toContent(row *entgen.ContentItem) content.Content {
	item := content.Content{
		ID:            row.ID,
		SiteID:        row.SiteID,
		AuthorID:      row.AuthorID,
		Kind:          content.Kind(row.Kind),
		Status:        content.Status(row.Status),
		Title:         row.Title,
		Slug:          row.Slug,
		Summary:       row.Summary,
		SourceFormat:  content.SourceFormat(row.SourceFormat),
		SourceBody:    row.SourceBody,
		RenderedHTML:  row.RenderedHTML,
		PolicyVersion: row.PolicyVersion,
		PublishedAt:   row.PublishedAt,
		ArchivedAt:    row.ArchivedAt,
		CreatedAt:     row.CreatedAt,
		UpdatedAt:     row.UpdatedAt,
	}
	if row.CategoryID != nil {
		item.CategoryID = *row.CategoryID
	}
	return item
}
