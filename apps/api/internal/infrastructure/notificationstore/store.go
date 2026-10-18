// Package notificationstore implements the notification persistence port with Ent.
package notificationstore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/notifications"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/notification"
)

// Store is the Ent backed notification repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

// Insert stores one notification.
func (s *Store) Insert(ctx context.Context, item notifications.Notification) (notifications.Notification, error) {
	builder := s.client.Notification.Create().
		SetSiteID(item.SiteID).
		SetUserID(item.UserID).
		SetType(string(item.Type)).
		SetCreatedAt(item.CreatedAt)
	if item.ActorID != "" {
		builder.SetActorID(item.ActorID)
	}
	if item.SubjectID != "" {
		builder.SetSubjectID(item.SubjectID)
	}
	if item.Payload != nil {
		builder.SetPayload(item.Payload)
	}

	created, err := builder.Save(ctx)
	if err != nil {
		return notifications.Notification{}, err
	}
	return toNotification(created), nil
}

// List returns one user's notifications, newest first.
func (s *Store) List(ctx context.Context, siteID, userID string, limit int) ([]notifications.Notification, error) {
	rows, err := s.client.Notification.Query().
		Where(notification.SiteIDEQ(siteID), notification.UserIDEQ(userID)).
		Order(entgen.Desc(notification.FieldCreatedAt)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	items := make([]notifications.Notification, 0, len(rows))
	for _, row := range rows {
		items = append(items, toNotification(row))
	}
	return items, nil
}

// Find loads one notification inside a site and user scope.
func (s *Store) Find(ctx context.Context, siteID, userID, notificationID string) (notifications.Notification, error) {
	row, err := s.client.Notification.Query().
		Where(
			notification.IDEQ(notificationID),
			notification.SiteIDEQ(siteID),
			notification.UserIDEQ(userID),
		).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return notifications.Notification{}, notifications.ErrNotFound
		}
		return notifications.Notification{}, err
	}
	return toNotification(row), nil
}

// MarkRead sets the read timestamp once.
func (s *Store) MarkRead(ctx context.Context, notificationID string, at time.Time) error {
	_, err := s.client.Notification.Update().
		Where(notification.IDEQ(notificationID), notification.ReadAtIsNil()).
		SetReadAt(at).
		Save(ctx)
	return err
}

// MarkAllRead marks every unread notification of a user.
func (s *Store) MarkAllRead(ctx context.Context, siteID, userID string, at time.Time) (int, error) {
	return s.client.Notification.Update().
		Where(
			notification.SiteIDEQ(siteID),
			notification.UserIDEQ(userID),
			notification.ReadAtIsNil(),
		).
		SetReadAt(at).
		Save(ctx)
}

func toNotification(row *entgen.Notification) notifications.Notification {
	item := notifications.Notification{
		ID:        row.ID,
		SiteID:    row.SiteID,
		UserID:    row.UserID,
		Type:      notifications.Type(row.Type),
		Payload:   row.Payload,
		ReadAt:    row.ReadAt,
		CreatedAt: row.CreatedAt,
	}
	if row.ActorID != nil {
		item.ActorID = *row.ActorID
	}
	if row.SubjectID != nil {
		item.SubjectID = *row.SubjectID
	}
	return item
}