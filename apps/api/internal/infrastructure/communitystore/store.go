// Package communitystore implements the community persistence port with Ent.
package communitystore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/community"
	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/site"

	"github.com/google/uuid"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/bookmark"
	"github.com/practacu/practacu-press/apps/api/ent/comment"
	"github.com/practacu/practacu-press/apps/api/ent/contentitem"
	"github.com/practacu/practacu-press/apps/api/ent/follow"
	"github.com/practacu/practacu-press/apps/api/ent/reaction"
	"github.com/practacu/practacu-press/apps/api/ent/user"
)

// Store is the Ent backed implementation of community.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ community.Repository = (*Store)(nil)

// FindComment loads a comment inside a site scope.
func (s *Store) FindComment(ctx context.Context, siteID, commentID string) (community.Comment, error) {
	row, err := s.client.Comment.Query().
		Where(comment.IDEQ(commentID), comment.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return community.Comment{}, community.ErrNotFound
		}
		return community.Comment{}, err
	}
	return toComment(row), nil
}

// ListComments returns comments newest first, joined with author display names.
func (s *Store) ListComments(ctx context.Context, filter community.CommentListFilter) ([]community.Comment, error) {
	query := s.client.Comment.Query().Where(comment.SiteIDEQ(filter.SiteID))
	if filter.TargetType != "" {
		query = query.Where(comment.TargetTypeEQ(string(filter.TargetType)))
	}
	if filter.TargetID != "" {
		query = query.Where(comment.TargetIDEQ(filter.TargetID))
	}
	if len(filter.Statuses) > 0 {
		query = query.Where(comment.StatusIn(filter.Statuses...))
	}
	if filter.Query != "" {
		// The search box matches the body and the author name. Names live on the user
		// row, so resolve matching authors first and OR the ids into the predicate.
		authorIDs, err := s.client.User.Query().
			Where(user.DisplayNameContainsFold(filter.Query)).
			IDs(ctx)
		if err != nil {
			return nil, err
		}
		body := comment.BodyContainsFold(filter.Query)
		if len(authorIDs) > 0 {
			query = query.Where(comment.Or(body, comment.AuthorIDIn(authorIDs...)))
		} else {
			query = query.Where(body)
		}
	}
	if !filter.After.IsZero() {
		at, err := time.Parse(time.RFC3339Nano, filter.After.Key)
		if err != nil {
			return nil, community.ErrInvalidInput
		}
		query = query.Where(comment.Or(
			comment.CreatedAtLT(at),
			comment.And(comment.CreatedAtEQ(at), comment.IDLT(filter.After.ID)),
		))
	}

	limit := filter.Limit
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := query.
		Order(entgen.Desc(comment.FieldCreatedAt), entgen.Desc(comment.FieldID)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []community.Comment{}, nil
	}

	ids := make([]string, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		if _, ok := seen[row.AuthorID]; ok {
			continue
		}
		seen[row.AuthorID] = struct{}{}
		ids = append(ids, row.AuthorID)
	}
	names := make(map[string]string, len(ids))
	if users, userErr := s.client.User.Query().Where(user.IDIn(ids...)).All(ctx); userErr == nil {
		for _, item := range users {
			names[item.ID] = item.DisplayName
		}
	}

	items := make([]community.Comment, 0, len(rows))
	for _, row := range rows {
		item := toComment(row)
		item.AuthorName = names[row.AuthorID]
		items = append(items, item)
	}
	return items, nil
}

// InsertComment stores a comment and records its audit entry in one transaction.
func (s *Store) InsertComment(
	ctx context.Context,
	item community.Comment,
	notifyUserID string,
	audit site.AuditEntry,
) (community.Comment, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return community.Comment{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	builder := tx.Comment.Create().
		SetSiteID(item.SiteID).
		SetAuthorID(item.AuthorID).
		SetTargetType(string(item.TargetType)).
		SetTargetID(item.TargetID).
		SetDepth(item.Depth).
		SetBody(item.Body).
		SetStatus(item.Status).
		SetCreatedAt(item.CreatedAt).
		SetUpdatedAt(item.UpdatedAt)
	if item.ParentID != "" {
		builder.SetParentID(item.ParentID)
	}

	created, err := builder.Save(ctx)
	if err != nil {
		return community.Comment{}, err
	}
	if err := insertAudit(ctx, tx.Client(), audit); err != nil {
		return community.Comment{}, err
	}
	if notifyUserID != "" {
		if _, err := tx.OutboxEvent.Create().
			SetEventID(uuid.Must(uuid.NewV7()).String()).
			SetSiteID(item.SiteID).
			SetEventType("comment.created").
			SetAggregateType("comment").
			SetAggregateID(created.ID).
			SetAudienceUserID(notifyUserID).
			SetOccurredAt(item.CreatedAt).
			SetPayload(map[string]any{
				"comment_id":  created.ID,
				"target_type": string(item.TargetType),
				"target_id":   item.TargetID,
				"author_id":   item.AuthorID,
				"occurred_at": item.CreatedAt.Format(time.RFC3339Nano),
			}).
			Save(ctx); err != nil {
			return community.Comment{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return community.Comment{}, err
	}
	committed = true

	return toComment(created), nil
}

// UpdateComment stores a body or status change with its audit entry.
func (s *Store) UpdateComment(ctx context.Context, item community.Comment, audit site.AuditEntry) (community.Comment, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return community.Comment{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	affected, err := tx.Comment.Update().
		Where(comment.IDEQ(item.ID), comment.SiteIDEQ(item.SiteID)).
		SetBody(item.Body).
		SetStatus(item.Status).
		SetUpdatedAt(item.UpdatedAt).
		Save(ctx)
	if err != nil {
		return community.Comment{}, err
	}
	if affected == 0 {
		return community.Comment{}, community.ErrNotFound
	}
	if err := insertAudit(ctx, tx.Client(), audit); err != nil {
		return community.Comment{}, err
	}
	if err := tx.Commit(); err != nil {
		return community.Comment{}, err
	}
	committed = true

	updated, err := s.client.Comment.Get(ctx, item.ID)
	if err != nil {
		return community.Comment{}, err
	}
	return toComment(updated), nil
}

// AuthorOf resolves the author of a comment, article or post.
func (s *Store) AuthorOf(ctx context.Context, siteID string, targetType community.TargetType, targetID string) (string, error) {
	switch targetType {
	case community.TargetComment:
		row, err := s.client.Comment.Query().
			Where(comment.IDEQ(targetID), comment.SiteIDEQ(siteID)).
			Only(ctx)
		if err != nil {
			if entgen.IsNotFound(err) {
				return "", community.ErrNotFound
			}
			return "", err
		}
		return row.AuthorID, nil
	case community.TargetArticle, community.TargetPost:
		row, err := s.client.ContentItem.Query().
			Where(contentitem.IDEQ(targetID), contentitem.SiteIDEQ(siteID)).
			Only(ctx)
		if err != nil {
			if entgen.IsNotFound(err) {
				return "", community.ErrNotFound
			}
			return "", err
		}
		return row.AuthorID, nil
	default:
		return "", community.ErrNotFound
	}
}

// HasReaction reports whether the user already reacted with this kind.
func (s *Store) HasReaction(ctx context.Context, userID, targetType, targetID, kind string) (bool, error) {
	return s.client.Reaction.Query().Where(
		reaction.UserIDEQ(userID),
		reaction.TargetTypeEQ(targetType),
		reaction.TargetIDEQ(targetID),
		reaction.KindEQ(kind),
	).Exist(ctx)
}

// SetReaction inserts or deletes a reaction row.
//
// Deleting a missing row is not an error: the caller already knows the desired state,
// so a retry must converge rather than fail.
func (s *Store) SetReaction(ctx context.Context, item community.Reaction, active bool, notifyUserID string) error {
	if !active {
		_, err := s.client.Reaction.Delete().Where(
			reaction.UserIDEQ(item.UserID),
			reaction.TargetTypeEQ(string(item.TargetType)),
			reaction.TargetIDEQ(item.TargetID),
			reaction.KindEQ(item.Kind),
		).Exec(ctx)
		return err
	}

	tx, err := s.client.Tx(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	if err := tx.Reaction.Create().
		SetSiteID(item.SiteID).
		SetUserID(item.UserID).
		SetTargetType(string(item.TargetType)).
		SetTargetID(item.TargetID).
		SetKind(item.Kind).
		OnConflict().
		Ignore().
		Exec(ctx); err != nil {
		return err
	}

	if notifyUserID != "" {
		now := time.Now().UTC()
		if _, err := tx.OutboxEvent.Create().
			SetEventID(uuid.Must(uuid.NewV7()).String()).
			SetSiteID(item.SiteID).
			SetEventType("reaction.created").
			SetAggregateType("reaction").
			SetAggregateID(item.TargetID).
			SetAudienceUserID(notifyUserID).
			SetOccurredAt(now).
			SetPayload(map[string]any{
				"target_type": string(item.TargetType),
				"target_id":   item.TargetID,
				"kind":        item.Kind,
				"user_id":     item.UserID,
				"occurred_at": now.Format(time.RFC3339Nano),
			}).
			Save(ctx); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// HasBookmark reports whether the user bookmarked the target.
func (s *Store) HasBookmark(ctx context.Context, userID, targetType, targetID string) (bool, error) {
	return s.client.Bookmark.Query().Where(
		bookmark.UserIDEQ(userID),
		bookmark.TargetTypeEQ(targetType),
		bookmark.TargetIDEQ(targetID),
	).Exist(ctx)
}

// SetBookmark inserts or deletes a bookmark row.
func (s *Store) SetBookmark(ctx context.Context, siteID, userID, targetType, targetID string, active bool) error {
	if !active {
		_, err := s.client.Bookmark.Delete().Where(
			bookmark.UserIDEQ(userID),
			bookmark.TargetTypeEQ(targetType),
			bookmark.TargetIDEQ(targetID),
		).Exec(ctx)
		return err
	}

	return s.client.Bookmark.Create().
		SetSiteID(siteID).
		SetUserID(userID).
		SetTargetType(targetType).
		SetTargetID(targetID).
		OnConflict().
		Ignore().
		Exec(ctx)
}

// HasFollow reports whether follower follows followee.
func (s *Store) HasFollow(ctx context.Context, siteID, followerID, followeeID string) (bool, error) {
	return s.client.Follow.Query().Where(
		follow.SiteIDEQ(siteID),
		follow.FollowerIDEQ(followerID),
		follow.FolloweeIDEQ(followeeID),
	).Exist(ctx)
}

// SetFollow inserts or deletes a follow row.
func (s *Store) SetFollow(ctx context.Context, siteID, followerID, followeeID string, active bool) error {
	if !active {
		_, err := s.client.Follow.Delete().Where(
			follow.SiteIDEQ(siteID),
			follow.FollowerIDEQ(followerID),
			follow.FolloweeIDEQ(followeeID),
		).Exec(ctx)
		return err
	}

	return s.client.Follow.Create().
		SetSiteID(siteID).
		SetFollowerID(followerID).
		SetFolloweeID(followeeID).
		OnConflict().
		Ignore().
		Exec(ctx)
}

func insertAudit(ctx context.Context, client *entgen.Client, entry site.AuditEntry) error {
	at := entry.At
	if at.IsZero() {
		at = time.Now().UTC()
	}

	builder := client.AuditLog.Create().
		SetAction(entry.Action).
		SetTargetType("comment").
		SetCreatedAt(at)

	if entry.Target != "" {
		builder.SetTargetID(entry.Target)
	}
	if entry.SiteID != "" {
		builder.SetSiteID(entry.SiteID)
	}
	if entry.ActorID != "" {
		builder.SetActorID(entry.ActorID)
	}
	if entry.Detail != nil {
		builder.SetDetail(entry.Detail)
	}

	_, err := builder.Save(ctx)
	return err
}

// TargetOf resolves an interaction target to its author and publication state.
//
// Only content targets can be resolved here; comment/page/user targets either resolve
// through their own table or do not have an author to compare against, and the
// community service treats a missing target as "not interactable". The site predicate
// is mandatory: a target id from another tenant is not visible here.
func (s *Store) TargetOf(
	ctx context.Context,
	siteID string,
	targetType community.TargetType,
	targetID string,
) (community.Target, error) {
	switch targetType {
	case community.TargetArticle, community.TargetPost:
		row, err := s.client.ContentItem.Query().
			Where(contentitem.IDEQ(targetID), contentitem.SiteIDEQ(siteID)).
			Only(ctx)
		if err != nil {
			if entgen.IsNotFound(err) {
				return community.Target{}, community.ErrTargetNotFound
			}
			return community.Target{}, err
		}
		return community.Target{
			AuthorID:  row.AuthorID,
			Published: row.Status == string(content.StatusPublished),
		}, nil
	default:
		return community.Target{}, community.ErrTargetNotFound
	}
}
func toComment(row *entgen.Comment) community.Comment {
	item := community.Comment{
		ID:         row.ID,
		SiteID:     row.SiteID,
		AuthorID:   row.AuthorID,
		TargetType: community.TargetType(row.TargetType),
		TargetID:   row.TargetID,
		Depth:      row.Depth,
		Body:       row.Body,
		Status:     row.Status,
		CreatedAt:  row.CreatedAt,
		UpdatedAt:  row.UpdatedAt,
	}
	if row.ParentID != nil {
		item.ParentID = *row.ParentID
	}
	return item
}
