package notifications

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
)

// prefsRepo layers the optional notification ports on top of the plain fake, so
// tests that predate preferences keep using the default behaviour.
type prefsRepo struct {
	*fakeRepo
	prefs  Preferences
	dedupe map[string]bool
	names  map[string]string
	emails map[string]string
}

func newPrefsRepo() *prefsRepo {
	return &prefsRepo{
		fakeRepo: newFakeRepo(),
		prefs:    DefaultPreferences(),
		dedupe:   map[string]bool{},
		names:    map[string]string{},
		emails:   map[string]string{},
	}
}

func (r *prefsRepo) LoadPreferences(context.Context, string, string) (Preferences, error) {
	return r.prefs, nil
}

func (r *prefsRepo) SavePreferences(_ context.Context, _, _ string, preferences Preferences) error {
	r.prefs = preferences
	return nil
}

func (r *prefsRepo) ExistsRecent(_ context.Context, _, _, key string, _ time.Time) (bool, error) {
	if r.dedupe[key] {
		return true, nil
	}
	r.dedupe[key] = true
	return false, nil
}

func (r *prefsRepo) DisplayName(_ context.Context, userID string) (string, error) {
	return r.names[userID], nil
}

func (r *prefsRepo) Email(_ context.Context, userID string) (string, error) {
	return r.emails[userID], nil
}

type fakeMailer struct {
	configured bool
	sent       []mailer.Message
}

func (m *fakeMailer) Send(_ context.Context, message mailer.Message) error {
	m.sent = append(m.sent, message)
	return nil
}

func (m *fakeMailer) Configured() bool { return m.configured }

func newEmailService(t *testing.T, repo *prefsRepo, sender mailer.Sender) *Service {
	t.Helper()
	service, err := NewService(repo,
		WithMailer(sender),
		WithSynchronousEmail(),
		WithBaseURL("https://press.example/"),
	)
	require.NoError(t, err)
	service.now = func() time.Time { return time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC) }
	return service
}

func TestNotifySendsEmailWhenInAppIsMuted(t *testing.T) {
	repo := newPrefsRepo()
	repo.prefs.InApp.Enabled = false
	repo.prefs.Email.Enabled = true
	repo.prefs.Email.Comments = true
	repo.emails["u2"] = "u2@example.com"

	sender := &fakeMailer{configured: true}
	service := newEmailService(t, repo, sender)

	_, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeComment, ActorID: "u1",
		Payload: map[string]string{"title": "hello", "excerpt": "first comment"},
	})
	require.NoError(t, err)
	require.Empty(t, repo.items, "the in-app channel is muted")
	require.Len(t, sender.sent, 1)

	message := sender.sent[0]
	require.Equal(t, []string{"u2@example.com"}, message.To)
	require.Contains(t, message.Subject, "评论")
	require.Contains(t, message.HTML, "https://press.example/notifications")
}

func TestNotifyHonoursEmailCategorySwitches(t *testing.T) {
	repo := newPrefsRepo()
	repo.prefs.Email.Enabled = true
	repo.prefs.Email.Comments = false
	repo.emails["u2"] = "u2@example.com"

	sender := &fakeMailer{configured: true}
	service := newEmailService(t, repo, sender)

	_, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeComment, ActorID: "u1",
		Payload: map[string]string{"title": "hello"},
	})
	require.NoError(t, err)
	require.Len(t, repo.items, 1, "in-app stays on")
	require.Empty(t, sender.sent, "the comments email category is off")
}

func TestNotifySuppressedWhenBothChannelsAreOff(t *testing.T) {
	repo := newPrefsRepo()
	repo.prefs.InApp.Enabled = false
	repo.prefs.Email.Enabled = false

	sender := &fakeMailer{configured: true}
	service := newEmailService(t, repo, sender)

	_, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeFollow, ActorID: "u1",
	})
	require.NoError(t, err)
	require.Empty(t, repo.items)
	require.Empty(t, sender.sent)
}

func TestNotifySkipsEmailWhenRelayIsUnconfigured(t *testing.T) {
	repo := newPrefsRepo()
	repo.prefs.InApp.Enabled = false
	repo.prefs.Email.Enabled = true
	repo.emails["u2"] = "u2@example.com"

	service := newEmailService(t, repo, nil)

	_, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeFollow, ActorID: "u1",
	})
	require.NoError(t, err, "an unconfigured relay is not an error")
	require.Empty(t, repo.items)
	require.False(t, service.EmailConfigured())
}

func TestNotifyDedupesRepeatedInteraction(t *testing.T) {
	repo := newPrefsRepo()
	service := newEmailService(t, repo, nil)

	for i := 0; i < 3; i++ {
		_, err := service.Notify(context.Background(), NewInput{
			SiteID: "s1", UserID: "u2", Type: TypeReaction, ActorID: "u1",
			DedupeKey: "reaction:u1:article:a1:like",
			Payload:   map[string]string{"target_id": "a1"},
		})
		require.NoError(t, err)
	}
	require.Len(t, repo.items, 1, "a like/unlike/like burst is one inbox row")
}

func TestNotifyAddsActorNameToPayload(t *testing.T) {
	repo := newPrefsRepo()
	repo.names["u1"] = "林知远"
	service := newEmailService(t, repo, nil)

	created, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeFollow, ActorID: "u1",
	})
	require.NoError(t, err)
	require.Equal(t, "林知远", created.Payload["actor_name"])
}

func TestPreferencesRoundTripAndDefaults(t *testing.T) {
	repo := newPrefsRepo()
	service := newEmailService(t, repo, nil)
	actor := Actor{UserID: "u2", SiteID: "s1"}

	defaults, err := service.Preferences(context.Background(), actor)
	require.NoError(t, err)
	require.True(t, defaults.InApp.Enabled)
	require.False(t, defaults.Email.Enabled)

	updated := Preferences{
		InApp: ChannelPreferences{Enabled: true, Comments: false, Reactions: true, Follows: true, Moderation: true},
		Email: ChannelPreferences{Enabled: true, Comments: true, Reactions: false, Follows: true, Moderation: false},
	}
	saved, err := service.UpdatePreferences(context.Background(), actor, updated)
	require.NoError(t, err)
	require.False(t, saved.InApp.Comments)

	loaded, err := service.Preferences(context.Background(), actor)
	require.NoError(t, err)
	require.Equal(t, updated, loaded)
}

func TestNotificationEmailEscapesUserContent(t *testing.T) {
	repo := newPrefsRepo()
	repo.prefs.InApp.Enabled = false
	repo.prefs.Email.Enabled = true
	repo.emails["u2"] = "u2@example.com"
	repo.names["u1"] = `<img src=x onerror="alert(1)">`

	sender := &fakeMailer{configured: true}
	service := newEmailService(t, repo, sender)

	_, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeComment, ActorID: "u1",
		Payload: map[string]string{
			"title":   `<script>alert("title")</script>`,
			"excerpt": `a & b <b>bold</b>`,
		},
	})
	require.NoError(t, err)
	require.Len(t, sender.sent, 1)

	html := sender.sent[0].HTML
	require.NotContains(t, html, "<script>")
	require.NotContains(t, html, `<img src=x`)
	require.NotContains(t, html, "<b>bold</b>")
	require.Contains(t, html, "&lt;script&gt;")
	require.Contains(t, html, "a &amp; b")
}

func TestNotificationEmailOmitsLinkWithoutBaseURL(t *testing.T) {
	repo := newPrefsRepo()
	repo.prefs.InApp.Enabled = false
	repo.prefs.Email.Enabled = true
	repo.emails["u2"] = "u2@example.com"

	sender := &fakeMailer{configured: true}
	service, err := NewService(repo, WithMailer(sender), WithSynchronousEmail())
	require.NoError(t, err)
	service.now = func() time.Time { return time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC) }

	_, err = service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeFollow, ActorID: "u1",
	})
	require.NoError(t, err)
	require.Len(t, sender.sent, 1)
	require.NotContains(t, sender.sent[0].Text, "在站内查看")
	require.False(t, strings.Contains(sender.sent[0].HTML, "href=\"/notifications\""))
}
