// Package messagingstore implements the messaging persistence port with Ent.
package messagingstore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/messaging"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/conversation"
	"github.com/practacu/practacu-press/apps/api/ent/conversationmember"
	"github.com/practacu/practacu-press/apps/api/ent/message"
)

// Store is the Ent backed messaging repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ messaging.Repository = (*Store)(nil)

// InsertConversation stores a conversation and its members in one transaction.
func (s *Store) InsertConversation(ctx context.Context, item messaging.Conversation) (messaging.Conversation, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return messaging.Conversation{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	created, err := tx.Conversation.Create().
		SetSiteID(item.SiteID).
		SetKind(string(item.Kind)).
		SetCreatedBy(item.CreatedBy).
		SetCreatedAt(item.CreatedAt).
		SetUpdatedAt(item.CreatedAt).
		Save(ctx)
	if err != nil {
		return messaging.Conversation{}, err
	}

	for _, member := range item.Members {
		if _, err := tx.ConversationMember.Create().
			SetSiteID(item.SiteID).
			SetConversationID(created.ID).
			SetUserID(member.UserID).
			Save(ctx); err != nil {
			return messaging.Conversation{}, err
		}
	}

	if err := tx.Commit(); err != nil {
		return messaging.Conversation{}, err
	}
	committed = true

	result := item
	result.ID = created.ID
	return result, nil
}

// FindConversation loads a conversation with its members.
func (s *Store) FindConversation(ctx context.Context, siteID, conversationID string) (messaging.Conversation, error) {
	row, err := s.client.Conversation.Query().
		Where(conversation.IDEQ(conversationID), conversation.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return messaging.Conversation{}, messaging.ErrNotFound
		}
		return messaging.Conversation{}, err
	}

	members, err := s.client.ConversationMember.Query().
		Where(conversationmember.ConversationIDEQ(conversationID)).
		All(ctx)
	if err != nil {
		return messaging.Conversation{}, err
	}

	result := messaging.Conversation{
		ID:        row.ID,
		SiteID:    row.SiteID,
		Kind:      messaging.ConversationKind(row.Kind),
		CreatedBy: row.CreatedBy,
		CreatedAt: row.CreatedAt,
		Members:   make([]messaging.Member, 0, len(members)),
	}
	for _, member := range members {
		entry := messaging.Member{UserID: member.UserID, JoinedAt: member.CreatedAt}
		if member.LastReadMessageID != nil {
			entry.LastReadMessageID = *member.LastReadMessageID
		}
		result.Members = append(result.Members, entry)
	}
	return result, nil
}

// ListForUser returns the conversations a user belongs to.
func (s *Store) ListForUser(ctx context.Context, siteID, userID string, limit int) ([]messaging.Conversation, error) {
	rows, err := s.client.ConversationMember.Query().
		Where(conversationmember.SiteIDEQ(siteID), conversationmember.UserIDEQ(userID)).
		Order(entgen.Desc(conversationmember.FieldCreatedAt)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	items := make([]messaging.Conversation, 0, len(rows))
	for _, row := range rows {
		found, err := s.FindConversation(ctx, siteID, row.ConversationID)
		if err != nil {
			continue
		}
		items = append(items, found)
	}
	return items, nil
}

// InsertMessage stores one message.
func (s *Store) InsertMessage(ctx context.Context, item messaging.Message) (messaging.Message, error) {
	created, err := s.client.Message.Create().
		SetSiteID(item.SiteID).
		SetConversationID(item.ConversationID).
		SetSenderID(item.SenderID).
		SetBody(item.Body).
		SetCreatedAt(item.CreatedAt).
		Save(ctx)
	if err != nil {
		return messaging.Message{}, err
	}

	result := item
	result.ID = created.ID
	return result, nil
}

// ListMessages returns messages in creation order.
func (s *Store) ListMessages(ctx context.Context, siteID, conversationID string, limit int) ([]messaging.Message, error) {
	rows, err := s.client.Message.Query().
		Where(message.SiteIDEQ(siteID), message.ConversationIDEQ(conversationID)).
		Order(entgen.Asc(message.FieldCreatedAt)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	items := make([]messaging.Message, 0, len(rows))
	for _, row := range rows {
		items = append(items, messaging.Message{
			ID:             row.ID,
			SiteID:         row.SiteID,
			ConversationID: row.ConversationID,
			SenderID:       row.SenderID,
			Body:           row.Body,
			CreatedAt:      row.CreatedAt,
		})
	}
	return items, nil
}

// AdvanceReadCursor moves a member's cursor forward.
func (s *Store) AdvanceReadCursor(ctx context.Context, siteID, conversationID, userID, messageID string) (bool, error) {
	affected, err := s.client.ConversationMember.Update().
		Where(
			conversationmember.SiteIDEQ(siteID),
			conversationmember.ConversationIDEQ(conversationID),
			conversationmember.UserIDEQ(userID),
		).
		SetLastReadMessageID(messageID).
		SetUpdatedAt(time.Now().UTC()).
		Save(ctx)
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}