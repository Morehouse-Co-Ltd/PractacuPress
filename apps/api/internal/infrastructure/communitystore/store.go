// Package communitystore implements the community persistence port with Ent.
package communitystore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/community"
	"github.com/practacu/practacu-press/apps/api/internal/site"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/bookmark"
	"github.com/practacu/practacu-press/apps/api/ent/comment"
	"github.com/practacu/practacu-press/apps/api/ent/follow"
	"github.com/practacu/practacu-press/apps/api/ent/reaction"
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

// InsertComment stores a comment and records its audit entry in one transaction.
func (s *Store) InsertComment(ctx context.Context, item community.Comment, audit site.AuditEntry) (community.Comment, error) {
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
func (s *Store) SetReaction(ctx context.Context, item community.Reaction, active bool) error {
	if !active {
		_, err := s.client.Reaction.Delete().Where(
			reaction.UserIDEQ(item.UserID),
			reaction.TargetTypeEQ(string(item.TargetType)),
			reaction.TargetIDEQ(item.TargetID),
			reaction.KindEQ(item.Kind),
		).Exec(ctx)
		return err
	}

	return s.client.Reaction.Create().
		SetSiteID(item.SiteID).
		SetUserID(item.UserID).
		SetTargetType(string(item.TargetType)).
		SetTargetID(item.TargetID).
		SetKind(item.Kind).
		OnConflict().
		Ignore().
		Exec(ctx)
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
