// Package messagingstore implements the messaging persistence port with Ent.
package messagingstore

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/practacu/practacu-press/internal/messaging"
	"github.com/practacu/practacu-press/internal/platform/fieldcrypto"

	entgen "github.com/practacu/practacu-press/internal/ent"
	"github.com/practacu/practacu-press/internal/ent/conversation"
	"github.com/practacu/practacu-press/internal/ent/conversationmember"
	"github.com/practacu/practacu-press/internal/ent/message"
)

// Store is the Ent backed messaging repository.
type Store struct {
	client *entgen.Client
	// cipher seals private message bodies at rest. Nil keeps the pre-encryption
	// plaintext behaviour, which is only acceptable for development and tests.
	cipher *fieldcrypto.Cipher
}

// Option customises a Store without breaking existing callers.
type Option func(*Store)

// WithFieldCipher installs the cipher used to seal message bodies at rest.
//
// Without it the store writes and reads plaintext, which is the historical
// behaviour. Deployments must pass this option: the body of a private message is
// exactly the kind of field a database dump must not expose.
func WithFieldCipher(c *fieldcrypto.Cipher) Option {
	return func(s *Store) { s.cipher = c }
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client, opts ...Option) *Store {
	store := &Store{client: client}
	for _, opt := range opts {
		if opt != nil {
			opt(store)
		}
	}
	return store
}

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

// InsertMessage stores one message and its delivery events in one transaction.
//
// The event rows are written here rather than in the service because this is the only
// place the transaction exists: an outbox event that is not committed with its message
// is exactly the lost notification the outbox pattern exists to prevent.
func (s *Store) InsertMessage(ctx context.Context, item messaging.Message) (messaging.Message, error) {
	// The id is generated before the insert because it is part of the encryption
	// purpose: the ciphertext is bound to the row it belongs to, so the row identity
	// must be known before the body can be sealed.
	id, err := uuid.NewV7()
	if err != nil {
		return messaging.Message{}, fmt.Errorf("messagingstore: generate message id: %w", err)
	}
	messageID := id.String()

	body, err := s.sealBody(item.ConversationID, messageID, item.Body)
	if err != nil {
		return messaging.Message{}, err
	}

	tx, err := s.client.Tx(ctx)
	if err != nil {
		return messaging.Message{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	created, err := tx.Message.Create().
		SetID(messageID).
		SetSiteID(item.SiteID).
		SetConversationID(item.ConversationID).
		SetSenderID(item.SenderID).
		SetBody(body).
		SetCreatedAt(item.CreatedAt).
		Save(ctx)
	if err != nil {
		return messaging.Message{}, err
	}

	members, err := tx.ConversationMember.Query().
		Where(conversationmember.ConversationIDEQ(item.ConversationID)).
		All(ctx)
	if err != nil {
		return messaging.Message{}, err
	}

	for _, member := range members {
		if member.UserID == item.SenderID {
			continue
		}
		builder := tx.OutboxEvent.Create().
			SetEventID(newEventID()).
			SetSiteID(item.SiteID).
			SetEventType("message.created").
			SetAggregateType("message").
			SetAggregateID(created.ID).
			SetAudienceUserID(member.UserID).
			SetOccurredAt(item.CreatedAt).
			SetPayload(map[string]any{
				"conversation_id": item.ConversationID,
				"message_id":      created.ID,
				"sender_id":       item.SenderID,
				"occurred_at":     item.CreatedAt.Format(time.RFC3339Nano),
			})
		if _, err := builder.Save(ctx); err != nil {
			return messaging.Message{}, err
		}
	}

	if err := tx.Commit(); err != nil {
		return messaging.Message{}, err
	}
	committed = true

	result := item
	result.ID = created.ID
	return result, nil
}

// newEventID returns a time ordered id so replay can rely on ordering.
func newEventID() string { return uuid.Must(uuid.NewV7()).String() }

// messageBodyPurpose is the fieldcrypto purpose (the AEAD associated data) of a
// message body.
//
// It binds the ciphertext to both the conversation and the message id, so a value
// copied out of one row into another, or into another conversation, fails to
// authenticate instead of decrypting into the wrong thread.
func messageBodyPurpose(conversationID, messageID string) string {
	return "message.body|" + conversationID + "|" + messageID
}

// sealBody seals a body for storage, or returns it unchanged when no cipher is
// configured.
func (s *Store) sealBody(conversationID, messageID, plain string) (string, error) {
	if s.cipher == nil {
		return plain, nil
	}
	sealed, err := s.cipher.Seal(plain, messageBodyPurpose(conversationID, messageID))
	if err != nil {
		return "", fmt.Errorf("messagingstore: seal message body: %w", err)
	}
	return sealed, nil
}

// openBody decrypts a stored body, passing a value that is not sealed through
// unchanged.
//
// The pass-through is what keeps rows written before this change readable during the
// migration; BackfillMessageEncryption rewrites them. A sealed value that fails to
// authenticate is an error: returning it as plaintext would surface a corrupted or
// moved body as if it were real.
func (s *Store) openBody(conversationID, messageID, value string) (string, error) {
	if s.cipher == nil {
		return value, nil
	}
	plain, _, err := s.cipher.OpenOrPlain(value, messageBodyPurpose(conversationID, messageID))
	if err != nil {
		return "", fmt.Errorf("messagingstore: open message body %q: %w", messageID, err)
	}
	return plain, nil
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
		body, err := s.openBody(row.ConversationID, row.ID, row.Body)
		if err != nil {
			return nil, err
		}
		items = append(items, messaging.Message{
			ID:             row.ID,
			SiteID:         row.SiteID,
			ConversationID: row.ConversationID,
			SenderID:       row.SenderID,
			Body:           body,
			CreatedAt:      row.CreatedAt,
		})
	}
	return items, nil
}

// backfillBatchSize bounds how many message rows BackfillMessageEncryption loads
// per query, so the migration does not hold the whole table in memory.
const backfillBatchSize = 200

// BackfillMessageEncryption seals message bodies that were written before body
// encryption was enabled.
//
// It pages through rows by id (UUIDv7, so insert ordered), skipping anything already
// sealed, and rewrites the rest with the same purpose InsertMessage uses. It returns
// how many rows it sealed. Running it again on an already migrated database is a
// no-op, which makes it safe to call on every startup.
//
// It is meant for the startup path: concurrent inserts are not locked out, and a row
// inserted mid-run is picked up by the next call rather than by this one.
func BackfillMessageEncryption(ctx context.Context, client *entgen.Client, cipher *fieldcrypto.Cipher) (sealed int, err error) {
	if client == nil {
		return 0, errors.New("messagingstore: backfill requires an ent client")
	}
	if cipher == nil {
		return 0, errors.New("messagingstore: backfill requires a field cipher")
	}

	cursor := ""
	for {
		query := client.Message.Query().
			Order(entgen.Asc(message.FieldID)).
			Limit(backfillBatchSize)
		if cursor != "" {
			query = query.Where(message.IDGT(cursor))
		}
		rows, err := query.All(ctx)
		if err != nil {
			return sealed, fmt.Errorf("messagingstore: scan message bodies: %w", err)
		}
		if len(rows) == 0 {
			return sealed, nil
		}
		cursor = rows[len(rows)-1].ID

		for _, row := range rows {
			// The envelope format is owned by fieldcrypto, so detection is delegated
			// to it instead of matching prefixes here.
			if fieldcrypto.IsSealed(row.Body) {
				continue
			}
			body, err := cipher.Seal(row.Body, messageBodyPurpose(row.ConversationID, row.ID))
			if err != nil {
				return sealed, fmt.Errorf("messagingstore: seal message body %q: %w", row.ID, err)
			}
			if _, err := client.Message.UpdateOneID(row.ID).SetBody(body).Save(ctx); err != nil {
				return sealed, fmt.Errorf("messagingstore: backfill message body %q: %w", row.ID, err)
			}
			sealed++
		}

		if len(rows) < backfillBatchSize {
			return sealed, nil
		}
	}
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
