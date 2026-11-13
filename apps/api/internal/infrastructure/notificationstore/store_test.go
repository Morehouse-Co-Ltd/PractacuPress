package notificationstore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/notificationstore"
	"github.com/practacu/practacu-press/apps/api/internal/notifications"
	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
)

type captureMailer struct {
	sent []mailer.Message
}

func (m *captureMailer) Send(_ context.Context, message mailer.Message) error {
	m.sent = append(m.sent, message)
	return nil
}

func (m *captureMailer) Configured() bool { return true }

type smoke struct {
	store     *notificationstore.Store
	service   *notifications.Service
	handle    *db.DB
	siteID    string
	recipient string
	actor     string
	mailer    *captureMailer
}

// newSmoke builds the real Ent store over a throwaway SQLite file and wires the
// notification service the same way the server does.
func newSmoke(t *testing.T) *smoke {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "notifications.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	recipient, err := handle.Client.User.Create().SetDisplayName("收件人").Save(ctx)
	require.NoError(t, err)
	actor, err := handle.Client.User.Create().SetDisplayName("评论者").Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.UserIdentity.Create().
		SetUserID(recipient.ID).
		SetProvider("email").
		SetProviderSubject("recipient@example.com").
		SetEmail("recipient@example.com").
		Save(ctx)
	require.NoError(t, err)

	store := notificationstore.New(handle.Client)
	sender := &captureMailer{}
	service, err := notifications.NewService(store,
		notifications.WithMailer(sender),
		notifications.WithSynchronousEmail(),
		notifications.WithBaseURL("https://press.example"),
	)
	require.NoError(t, err)

	return &smoke{
		store:     store,
		service:   service,
		handle:    handle,
		siteID:    siteRow.ID,
		recipient: recipient.ID,
		actor:     actor.ID,
		mailer:    sender,
	}
}

func (s *smoke) actorID() notifications.Actor {
	return notifications.Actor{UserID: s.recipient, SiteID: s.siteID}
}

func TestSQLiteInboxPreferencesAndEmail(t *testing.T) {
	ctx := context.Background()
	s := newSmoke(t)

	// Defaults: in-app on, email off.
	preferences, err := s.service.Preferences(ctx, s.actorID())
	require.NoError(t, err)
	require.True(t, preferences.InApp.Enabled)
	require.False(t, preferences.Email.Enabled)

	// Turn email on and live with the default categories.
	preferences.Email.Enabled = true
	_, err = s.service.UpdatePreferences(ctx, s.actorID(), preferences)
	require.NoError(t, err)
	loaded, err := s.service.Preferences(ctx, s.actorID())
	require.NoError(t, err)
	require.True(t, loaded.Email.Enabled)

	created, err := s.service.Notify(ctx, notifications.NewInput{
		SiteID: s.siteID, UserID: s.recipient, Type: notifications.TypeComment, ActorID: s.actor,
		SubjectID: "c1",
		Payload:   map[string]string{"title": "测试文章", "excerpt": "第一条评论"},
	})
	require.NoError(t, err)
	require.NotEmpty(t, created.ID)
	require.Equal(t, "评论者", created.Payload["actor_name"])

	inbox, err := s.service.Inbox(ctx, s.actorID(), 0)
	require.NoError(t, err)
	require.Len(t, inbox, 1)
	require.Equal(t, notifications.TypeComment, inbox[0].Type)
	require.Equal(t, "评论者", inbox[0].Payload["actor_name"])
	require.Len(t, s.mailer.sent, 1, "email goes out when the member enabled it")
	require.Contains(t, s.mailer.sent[0].HTML, "https://press.example/notifications")

	// Muting the in-app channel stops new rows but email keeps its own switch.
	muted := loaded
	muted.InApp.Enabled = false
	_, err = s.service.UpdatePreferences(ctx, s.actorID(), muted)
	require.NoError(t, err)

	_, err = s.service.Notify(ctx, notifications.NewInput{
		SiteID: s.siteID, UserID: s.recipient, Type: notifications.TypeFollow, ActorID: s.actor,
	})
	require.NoError(t, err)
	inbox, err = s.service.Inbox(ctx, s.actorID(), 0)
	require.NoError(t, err)
	require.Len(t, inbox, 1, "muted in-app type must not grow the inbox")
	require.Len(t, s.mailer.sent, 2, "email is independent of the in-app switch")

	// Turning email off as well suppresses both channels.
	muted.Email.Enabled = false
	_, err = s.service.UpdatePreferences(ctx, s.actorID(), muted)
	require.NoError(t, err)
	_, err = s.service.Notify(ctx, notifications.NewInput{
		SiteID: s.siteID, UserID: s.recipient, Type: notifications.TypeFollow, ActorID: s.actor,
	})
	require.NoError(t, err)
	require.Len(t, s.mailer.sent, 2)

	// An email-category switch is honoured without touching the inbox.
	partial := muted
	partial.InApp.Enabled = true
	partial.Email.Enabled = true
	partial.Email.Comments = false
	_, err = s.service.UpdatePreferences(ctx, s.actorID(), partial)
	require.NoError(t, err)
	_, err = s.service.Notify(ctx, notifications.NewInput{
		SiteID: s.siteID, UserID: s.recipient, Type: notifications.TypeComment, ActorID: s.actor,
	})
	require.NoError(t, err)
	require.Len(t, s.mailer.sent, 2, "comments email is off")
}

func TestSQLiteDedupeAndSiteIsolation(t *testing.T) {
	ctx := context.Background()
	s := newSmoke(t)

	for i := 0; i < 3; i++ {
		_, err := s.service.Notify(ctx, notifications.NewInput{
			SiteID: s.siteID, UserID: s.recipient, Type: notifications.TypeReaction, ActorID: s.actor,
			DedupeKey: "reaction:" + s.actor + ":article:a1:like",
			Payload:   map[string]string{"target_id": "a1"},
		})
		require.NoError(t, err)
	}
	inbox, err := s.service.Inbox(ctx, s.actorID(), 0)
	require.NoError(t, err)
	require.Len(t, inbox, 1, "the repeated interaction is collapsed")

	// A different site sees nothing, even for the same user.
	otherSite, err := s.handle.Client.Site.Create().SetSlug("other").SetName("Other").Save(ctx)
	require.NoError(t, err)
	otherInbox, err := s.service.Inbox(ctx, notifications.Actor{UserID: s.recipient, SiteID: otherSite.ID}, 0)
	require.NoError(t, err)
	require.Empty(t, otherInbox)

	// Self notification is refused before it reaches the store.
	_, err = s.service.Notify(ctx, notifications.NewInput{
		SiteID: s.siteID, UserID: s.recipient, Type: notifications.TypeFollow, ActorID: s.recipient,
	})
	require.ErrorIs(t, err, notifications.ErrSelfNotification)
}

func TestSQLiteDedupeWindowExpires(t *testing.T) {
	ctx := context.Background()
	s := newSmoke(t)

	_, err := s.store.Insert(ctx, notifications.Notification{
		SiteID: s.siteID, UserID: s.recipient, Type: notifications.TypeReaction,
		ActorID: s.actor, DedupeKey: "reaction:key",
		CreatedAt: time.Now().UTC().Add(-notifications.DedupeWindow - time.Hour),
	})
	require.NoError(t, err)

	recent, err := s.store.ExistsRecent(ctx, s.siteID, s.recipient, "reaction:key",
		time.Now().UTC().Add(-notifications.DedupeWindow))
	require.NoError(t, err)
	require.False(t, recent, "a row older than the window does not suppress a new event")

	_, err = s.store.Insert(ctx, notifications.Notification{
		SiteID: s.siteID, UserID: s.recipient, Type: notifications.TypeReaction,
		ActorID: s.actor, DedupeKey: "reaction:key", CreatedAt: time.Now().UTC(),
	})
	require.NoError(t, err)
	recent, err = s.store.ExistsRecent(ctx, s.siteID, s.recipient, "reaction:key",
		time.Now().UTC().Add(-notifications.DedupeWindow))
	require.NoError(t, err)
	require.True(t, recent)
}
