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
	"github.com/practacu/practacu-press/apps/api/ent/readinghistory"
	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
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
		// The risk assessment is computed by the domain when the comment is written;
		// storing it here is what lets the review queue rank by risk and stay
		// auditable instead of recomputing a score per browser.
		SetRiskScore(item.RiskScore).
		SetRiskFlags(community.EncodeRiskFlags(item.RiskFlags)).
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
		// The body change carries a new assessment with it (an edited body is a new
		// submission), so the queue never ranks a comment by the score of the text it
		// used to have.
		SetRiskScore(item.RiskScore).
		SetRiskFlags(community.EncodeRiskFlags(item.RiskFlags)).
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

// HasReactionsFor reports which of the targets the user liked.
func (s *Store) HasReactionsFor(
	ctx context.Context,
	siteID, userID string,
	targetType community.TargetType,
	targetIDs []string,
	kind string,
) (map[string]bool, error) {
	result := make(map[string]bool, len(targetIDs))
	if len(targetIDs) == 0 {
		return result, nil
	}
	ids, err := s.client.Reaction.Query().
		Where(
			reaction.SiteIDEQ(siteID),
			reaction.UserIDEQ(userID),
			reaction.TargetTypeEQ(string(targetType)),
			reaction.TargetIDIn(targetIDs...),
			reaction.KindEQ(kind),
		).
		Select(reaction.FieldTargetID).
		Strings(ctx)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		result[id] = true
	}
	return result, nil
}

// HasBookmarksFor reports which of the targets the user saved.
func (s *Store) HasBookmarksFor(
	ctx context.Context,
	siteID, userID string,
	targetType community.TargetType,
	targetIDs []string,
) (map[string]bool, error) {
	result := make(map[string]bool, len(targetIDs))
	if len(targetIDs) == 0 {
		return result, nil
	}
	ids, err := s.client.Bookmark.Query().
		Where(
			bookmark.SiteIDEQ(siteID),
			bookmark.UserIDEQ(userID),
			bookmark.TargetTypeEQ(string(targetType)),
			bookmark.TargetIDIn(targetIDs...),
		).
		Select(bookmark.FieldTargetID).
		Strings(ctx)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		result[id] = true
	}
	return result, nil
}

// HasFollowsFor reports which of the users the caller follows.
func (s *Store) HasFollowsFor(
	ctx context.Context,
	siteID, followerID string,
	followeeIDs []string,
) (map[string]bool, error) {
	result := make(map[string]bool, len(followeeIDs))
	if len(followeeIDs) == 0 {
		return result, nil
	}
	ids, err := s.client.Follow.Query().
		Where(
			follow.SiteIDEQ(siteID),
			follow.FollowerIDEQ(followerID),
			follow.FolloweeIDIn(followeeIDs...),
		).
		Select(follow.FieldFolloweeID).
		Strings(ctx)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		result[id] = true
	}
	return result, nil
}

// ListBookmarks returns the caller's saved content newest first.
func (s *Store) ListBookmarks(
	ctx context.Context,
	filter community.InteractionListFilter,
) ([]community.InteractionEntry, error) {
	query := s.client.Bookmark.Query().
		Where(bookmark.SiteIDEQ(filter.SiteID), bookmark.UserIDEQ(filter.UserID))
	if filter.TargetType != "" {
		query = query.Where(bookmark.TargetTypeEQ(string(filter.TargetType)))
	}
	if !filter.After.IsZero() {
		at, err := time.Parse(time.RFC3339Nano, filter.After.Key)
		if err != nil {
			return nil, community.ErrInvalidInput
		}
		query = query.Where(bookmark.Or(
			bookmark.CreatedAtLT(at),
			bookmark.And(bookmark.CreatedAtEQ(at), bookmark.TargetIDLT(filter.After.ID)),
		))
	}

	rows, err := query.
		Order(entgen.Desc(bookmark.FieldCreatedAt), entgen.Desc(bookmark.FieldTargetID)).
		Limit(filter.Limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	entries := make([]community.InteractionEntry, 0, len(rows))
	for _, row := range rows {
		entries = append(entries, community.InteractionEntry{
			TargetType: community.TargetType(row.TargetType),
			TargetID:   row.TargetID,
			CreatedAt:  row.CreatedAt,
		})
	}
	return s.enrichInteractionEntries(ctx, filter.SiteID, entries)
}

// ListReactions returns the content the caller reacted to newest first.
func (s *Store) ListReactions(
	ctx context.Context,
	filter community.InteractionListFilter,
) ([]community.InteractionEntry, error) {
	query := s.client.Reaction.Query().
		Where(reaction.SiteIDEQ(filter.SiteID), reaction.UserIDEQ(filter.UserID))
	if filter.TargetType != "" {
		query = query.Where(reaction.TargetTypeEQ(string(filter.TargetType)))
	}
	if filter.Kind != "" {
		query = query.Where(reaction.KindEQ(filter.Kind))
	}
	if !filter.After.IsZero() {
		at, err := time.Parse(time.RFC3339Nano, filter.After.Key)
		if err != nil {
			return nil, community.ErrInvalidInput
		}
		query = query.Where(reaction.Or(
			reaction.CreatedAtLT(at),
			reaction.And(reaction.CreatedAtEQ(at), reaction.TargetIDLT(filter.After.ID)),
		))
	}

	rows, err := query.
		Order(entgen.Desc(reaction.FieldCreatedAt), entgen.Desc(reaction.FieldTargetID)).
		Limit(filter.Limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	entries := make([]community.InteractionEntry, 0, len(rows))
	for _, row := range rows {
		entries = append(entries, community.InteractionEntry{
			TargetType: community.TargetType(row.TargetType),
			TargetID:   row.TargetID,
			CreatedAt:  row.CreatedAt,
		})
	}
	return s.enrichInteractionEntries(ctx, filter.SiteID, entries)
}

// ListFollowing returns the members the caller follows, newest first.
func (s *Store) ListFollowing(
	ctx context.Context,
	filter community.FollowListFilter,
) ([]community.FollowEntry, error) {
	query := s.client.Follow.Query().
		Where(follow.SiteIDEQ(filter.SiteID), follow.FollowerIDEQ(filter.UserID))
	if !filter.After.IsZero() {
		at, err := time.Parse(time.RFC3339Nano, filter.After.Key)
		if err != nil {
			return nil, community.ErrInvalidInput
		}
		query = query.Where(follow.Or(
			follow.CreatedAtLT(at),
			follow.And(follow.CreatedAtEQ(at), follow.FolloweeIDLT(filter.After.ID)),
		))
	}

	rows, err := query.
		Order(entgen.Desc(follow.FieldCreatedAt), entgen.Desc(follow.FieldFolloweeID)).
		Limit(filter.Limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	return s.followEntries(ctx, filter.SiteID, rows, false)
}

// ListFollowers returns the members who follow the caller, newest first.
func (s *Store) ListFollowers(
	ctx context.Context,
	filter community.FollowListFilter,
) ([]community.FollowEntry, error) {
	query := s.client.Follow.Query().
		Where(follow.SiteIDEQ(filter.SiteID), follow.FolloweeIDEQ(filter.UserID))
	if !filter.After.IsZero() {
		at, err := time.Parse(time.RFC3339Nano, filter.After.Key)
		if err != nil {
			return nil, community.ErrInvalidInput
		}
		query = query.Where(follow.Or(
			follow.CreatedAtLT(at),
			follow.And(follow.CreatedAtEQ(at), follow.FollowerIDLT(filter.After.ID)),
		))
	}

	rows, err := query.
		Order(entgen.Desc(follow.FieldCreatedAt), entgen.Desc(follow.FieldFollowerID)).
		Limit(filter.Limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	return s.followEntries(ctx, filter.SiteID, rows, true)
}

// followEntries joins display names onto a page of follow rows.
//
// The bool says whether the row user is the follower (followers list) or the
// followee (following list); both use the same FollowEntry shape.
func (s *Store) followEntries(
	ctx context.Context,
	siteID string,
	rows []*entgen.Follow,
	followers bool,
) ([]community.FollowEntry, error) {
	userIDs := make([]string, 0, len(rows))
	for _, row := range rows {
		if followers {
			userIDs = append(userIDs, row.FollowerID)
		} else {
			userIDs = append(userIDs, row.FolloweeID)
		}
	}

	accounts := make([]*entgen.User, 0, len(userIDs))
	if len(userIDs) > 0 {
		found, err := s.client.User.Query().Where(user.IDIn(userIDs...)).All(ctx)
		if err != nil {
			return nil, err
		}
		accounts = found
	}
	byID := make(map[string]*entgen.User, len(accounts))
	for _, account := range accounts {
		byID[account.ID] = account
	}

	// A follow row whose account or membership disappeared would render as a dead
	// link, so only active members of this site are listed.
	active := map[string]bool{}
	if len(userIDs) > 0 {
		members, err := s.client.SiteMember.Query().
			Where(
				sitemember.SiteIDEQ(siteID),
				sitemember.UserIDIn(userIDs...),
				sitemember.StatusEQ(site.MemberStatusActive),
			).
			All(ctx)
		if err != nil {
			return nil, err
		}
		for _, member := range members {
			active[member.UserID] = true
		}
	}

	entries := make([]community.FollowEntry, 0, len(rows))
	for _, row := range rows {
		userID := row.FolloweeID
		if followers {
			userID = row.FollowerID
		}
		if !active[userID] {
			continue
		}
		entry := community.FollowEntry{UserID: userID, Since: row.CreatedAt}
		if account := byID[userID]; account != nil {
			entry.DisplayName = account.DisplayName
			if account.Bio != nil {
				entry.Bio = *account.Bio
			}
			if account.AvatarMediaID != nil {
				entry.AvatarMediaID = *account.AvatarMediaID
			}
		}
		entries = append(entries, entry)
	}
	return entries, nil
}

// RecordReading upserts the caller's last visit to one content item.
func (s *Store) RecordReading(ctx context.Context, entry community.ReadingEntry) error {
	return s.client.ReadingHistory.Create().
		SetSiteID(entry.SiteID).
		SetUserID(entry.UserID).
		SetTargetType(string(entry.TargetType)).
		SetTargetID(entry.TargetID).
		SetLastViewedAt(entry.At).
		SetViewCount(1).
		SetCreatedAt(entry.At).
		OnConflictColumns(
			readinghistory.FieldUserID,
			readinghistory.FieldTargetType,
			readinghistory.FieldTargetID,
		).
		Update(func(upsert *entgen.ReadingHistoryUpsert) {
			upsert.SetLastViewedAt(entry.At)
			upsert.AddViewCount(1)
		}).
		Exec(ctx)
}

// ListReadingHistory returns the caller's recently read content newest first.
func (s *Store) ListReadingHistory(
	ctx context.Context,
	filter community.InteractionListFilter,
) ([]community.ReadingEntryView, error) {
	query := s.client.ReadingHistory.Query().
		Where(readinghistory.SiteIDEQ(filter.SiteID), readinghistory.UserIDEQ(filter.UserID))
	if filter.TargetType != "" {
		query = query.Where(readinghistory.TargetTypeEQ(string(filter.TargetType)))
	}
	if !filter.After.IsZero() {
		at, err := time.Parse(time.RFC3339Nano, filter.After.Key)
		if err != nil {
			return nil, community.ErrInvalidInput
		}
		query = query.Where(readinghistory.Or(
			readinghistory.LastViewedAtLT(at),
			readinghistory.And(readinghistory.LastViewedAtEQ(at), readinghistory.TargetIDLT(filter.After.ID)),
		))
	}

	rows, err := query.
		Order(entgen.Desc(readinghistory.FieldLastViewedAt), entgen.Desc(readinghistory.FieldTargetID)).
		Limit(filter.Limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	entries := make([]community.InteractionEntry, 0, len(rows))
	views := make([]community.ReadingEntryView, 0, len(rows))
	for _, row := range rows {
		views = append(views, community.ReadingEntryView{
			TargetType:   community.TargetType(row.TargetType),
			TargetID:     row.TargetID,
			LastViewedAt: row.LastViewedAt,
			ViewCount:    row.ViewCount,
		})
		entries = append(entries, community.InteractionEntry{
			TargetType: community.TargetType(row.TargetType),
			TargetID:   row.TargetID,
			CreatedAt:  row.LastViewedAt,
		})
	}

	// The content join runs on the interaction entry shape, then the fields are
	// copied back so the caller keeps the reading specific timestamps.
	enriched, err := s.enrichInteractionEntries(ctx, filter.SiteID, entries)
	if err != nil {
		return nil, err
	}
	for index := range enriched {
		views[index].Title = enriched[index].Title
		views[index].Summary = enriched[index].Summary
		views[index].Kind = enriched[index].Kind
		views[index].AuthorID = enriched[index].AuthorID
		views[index].AuthorName = enriched[index].AuthorName
		views[index].PublishedAt = enriched[index].PublishedAt
		views[index].Available = enriched[index].Available
	}
	return views, nil
}

// enrichInteractionEntries joins content titles and author names onto one page.
//
// Only content targets have a row to join. A non content target, or a target that
// was deleted, simply stays unavailable; the personal list then renders it as a
// tombstone instead of a broken link.
func (s *Store) enrichInteractionEntries(
	ctx context.Context,
	siteID string,
	entries []community.InteractionEntry,
) ([]community.InteractionEntry, error) {
	if len(entries) == 0 {
		return []community.InteractionEntry{}, nil
	}

	ids := make([]string, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if entry.TargetType != community.TargetArticle && entry.TargetType != community.TargetPost {
			continue
		}
		if _, ok := seen[entry.TargetID]; ok {
			continue
		}
		seen[entry.TargetID] = struct{}{}
		ids = append(ids, entry.TargetID)
	}
	if len(ids) == 0 {
		return entries, nil
	}

	rows, err := s.client.ContentItem.Query().
		Where(contentitem.SiteIDEQ(siteID), contentitem.IDIn(ids...)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	contentByID := make(map[string]*entgen.ContentItem, len(rows))
	authorIDs := make([]string, 0, len(rows))
	seenAuthors := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		contentByID[row.ID] = row
		if _, ok := seenAuthors[row.AuthorID]; ok {
			continue
		}
		seenAuthors[row.AuthorID] = struct{}{}
		authorIDs = append(authorIDs, row.AuthorID)
	}
	names := make(map[string]string, len(authorIDs))
	if len(authorIDs) > 0 {
		authors, authorErr := s.client.User.Query().Where(user.IDIn(authorIDs...)).All(ctx)
		if authorErr != nil {
			return nil, authorErr
		}
		for _, author := range authors {
			names[author.ID] = author.DisplayName
		}
	}

	for index := range entries {
		row := contentByID[entries[index].TargetID]
		if row == nil {
			continue
		}
		entries[index].Title = row.Title
		entries[index].Summary = row.Summary
		entries[index].Kind = row.Kind
		entries[index].AuthorID = row.AuthorID
		entries[index].AuthorName = names[row.AuthorID]
		entries[index].PublishedAt = row.PublishedAt
		// Only published content can be opened again; an archived item stays in the
		// list with its title but is reported unavailable.
		entries[index].Available = row.Status == string(content.StatusPublished)
	}
	return entries, nil
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
			// The notification renderer needs a label and the route kind; both come
			// from the row we already loaded.
			Title: row.Title,
			Kind:  row.Kind,
			// The item level comment policy overrides the site switches (C-19).
			CommentPolicy: community.ContentCommentPolicy(row.CommentPolicy),
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
		RiskScore:  row.RiskScore,
		// The column holds JSON text; an unreadable value decodes to no flags rather
		// than failing the read, because the column is derived data.
		RiskFlags: community.DecodeRiskFlags(row.RiskFlags),
		CreatedAt: row.CreatedAt,
		UpdatedAt: row.UpdatedAt,
	}
	if row.ParentID != nil {
		item.ParentID = *row.ParentID
	}
	return item
}
