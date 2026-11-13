// Package notificationstore implements the notification persistence port with Ent.
package notificationstore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/notifications"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/notification"
	"github.com/practacu/practacu-press/apps/api/ent/notificationpreference"
	"github.com/practacu/practacu-press/apps/api/ent/user"
	"github.com/practacu/practacu-press/apps/api/ent/useridentity"
)

// Store is the Ent backed notification repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var (
	_ notifications.Repository           = (*Store)(nil)
	_ notifications.PreferenceRepository = (*Store)(nil)
	_ notifications.DedupeChecker        = (*Store)(nil)
	_ notifications.ProfileLookup        = (*Store)(nil)
	_ notifications.EmailLookup          = (*Store)(nil)
)

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
	if item.DedupeKey != "" {
		builder.SetDedupeKey(item.DedupeKey)
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

// ExistsRecent reports whether the same dedupe key already produced a row inside
// the window.
func (s *Store) ExistsRecent(
	ctx context.Context,
	siteID, userID, dedupeKey string,
	since time.Time,
) (bool, error) {
	return s.client.Notification.Query().
		Where(
			notification.SiteIDEQ(siteID),
			notification.UserIDEQ(userID),
			notification.DedupeKeyEQ(dedupeKey),
			notification.CreatedAtGTE(since),
		).
		Exist(ctx)
}

// LoadPreferences returns the stored choices, or the defaults when the member never
// opened the settings.
func (s *Store) LoadPreferences(
	ctx context.Context,
	siteID, userID string,
) (notifications.Preferences, error) {
	row, err := s.client.NotificationPreference.Query().
		Where(
			notificationpreference.SiteIDEQ(siteID),
			notificationpreference.UserIDEQ(userID),
		).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return notifications.DefaultPreferences(), nil
		}
		return notifications.Preferences{}, err
	}

	return notifications.Preferences{
		InApp: notifications.ChannelPreferences{
			Enabled:    row.InAppEnabled,
			Comments:   row.InAppComments,
			Reactions:  row.InAppReactions,
			Follows:    row.InAppFollows,
			Moderation: row.InAppModeration,
		},
		Email: notifications.ChannelPreferences{
			Enabled:    row.EmailEnabled,
			Comments:   row.EmailComments,
			Reactions:  row.EmailReactions,
			Follows:    row.EmailFollows,
			Moderation: row.EmailModeration,
		},
	}, nil
}

// SavePreferences upserts the member's choices.
func (s *Store) SavePreferences(
	ctx context.Context,
	siteID, userID string,
	preferences notifications.Preferences,
) error {
	return s.client.NotificationPreference.Create().
		SetSiteID(siteID).
		SetUserID(userID).
		SetInAppEnabled(preferences.InApp.Enabled).
		SetEmailEnabled(preferences.Email.Enabled).
		SetInAppComments(preferences.InApp.Comments).
		SetInAppReactions(preferences.InApp.Reactions).
		SetInAppFollows(preferences.InApp.Follows).
		SetInAppModeration(preferences.InApp.Moderation).
		SetEmailComments(preferences.Email.Comments).
		SetEmailReactions(preferences.Email.Reactions).
		SetEmailFollows(preferences.Email.Follows).
		SetEmailModeration(preferences.Email.Moderation).
		OnConflictColumns(
			notificationpreference.FieldSiteID,
			notificationpreference.FieldUserID,
		).
		Update(func(upsert *entgen.NotificationPreferenceUpsert) {
			upsert.SetInAppEnabled(preferences.InApp.Enabled)
			upsert.SetEmailEnabled(preferences.Email.Enabled)
			upsert.SetInAppComments(preferences.InApp.Comments)
			upsert.SetInAppReactions(preferences.InApp.Reactions)
			upsert.SetInAppFollows(preferences.InApp.Follows)
			upsert.SetInAppModeration(preferences.InApp.Moderation)
			upsert.SetEmailComments(preferences.Email.Comments)
			upsert.SetEmailReactions(preferences.Email.Reactions)
			upsert.SetEmailFollows(preferences.Email.Follows)
			upsert.SetEmailModeration(preferences.Email.Moderation)
		}).
		Exec(ctx)
}

// DisplayName resolves the public name of an account.
func (s *Store) DisplayName(ctx context.Context, userID string) (string, error) {
	row, err := s.client.User.Query().Where(user.IDEQ(userID)).Only(ctx)
	if err != nil {
		return "", err
	}
	return row.DisplayName, nil
}

// Email resolves the address of an account.
//
// The email identity is the only place a deliverable address exists; an account
// that signed up through a provider with no email simply has none.
func (s *Store) Email(ctx context.Context, userID string) (string, error) {
	row, err := s.client.UserIdentity.Query().
		Where(
			useridentity.UserIDEQ(userID),
			useridentity.ProviderEQ("email"),
			useridentity.EmailNotNil(),
		).
		First(ctx)
	if err != nil {
		return "", err
	}
	if row.Email == nil {
		return "", nil
	}
	return *row.Email, nil
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
	if row.DedupeKey != nil {
		item.DedupeKey = *row.DedupeKey
	}
	return item
}
