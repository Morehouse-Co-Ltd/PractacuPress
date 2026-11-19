package newsletterstore_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	_ "modernc.org/sqlite"

	"github.com/stretchr/testify/require"

	entgen "github.com/practacu/practacu-press/internal/ent"
	"github.com/practacu/practacu-press/internal/infrastructure/newsletterstore"
	"github.com/practacu/practacu-press/internal/newsletter"
	"github.com/practacu/practacu-press/internal/platform/emailgateway"
	"github.com/practacu/practacu-press/internal/platform/mailer"
	"github.com/practacu/practacu-press/internal/platform/page"
)

type fixture struct {
	store  *newsletterstore.Store
	client *entgen.Client
	siteID string
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	ctx := context.Background()

	sqlDB, err := sql.Open("sqlite", sqliteDSN(filepath.Join(t.TempDir(), "newsletter.db")))
	require.NoError(t, err)
	client := entgen.NewClient(entgen.Driver(entsql.OpenDB(dialect.SQLite, sqlDB)))
	require.NoError(t, client.Schema.Create(ctx))
	t.Cleanup(func() {
		require.NoError(t, client.Close())
		require.NoError(t, sqlDB.Close())
	})

	siteRow, err := client.Site.Create().
		SetSlug("main").
		SetName("主站").
		SetDomain("press.example.com").
		Save(ctx)
	require.NoError(t, err)

	return fixture{store: newsletterstore.New(client), client: client, siteID: siteRow.ID}
}

func (f fixture) subscriber(email, status string) newsletter.Subscriber {
	now := time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)
	return newsletter.Subscriber{
		SiteID:    f.siteID,
		Email:     email,
		Status:    status,
		Source:    newsletter.SourceSite,
		TokenHash: newsletter.HashToken("token-" + email),
		CreatedAt: now,
	}
}

func TestSubscriberRoundTripAndTokenLookup(t *testing.T) {
	fixture := newFixture(t)
	ctx := context.Background()

	created, err := fixture.store.SaveSubscriber(ctx, fixture.subscriber("reader@example.com", newsletter.StatusPending))
	require.NoError(t, err)
	require.NotEmpty(t, created.ID)
	require.Equal(t, "reader@example.com", created.Email)

	found, err := fixture.store.FindSubscriberByEmail(ctx, fixture.siteID, "reader@example.com")
	require.NoError(t, err)
	require.Equal(t, created.ID, found.ID)

	byToken, err := fixture.store.FindSubscriberByTokenHash(ctx, newsletter.HashToken("token-reader@example.com"))
	require.NoError(t, err)
	require.Equal(t, created.ID, byToken.ID)

	_, err = fixture.store.FindSubscriberByTokenHash(ctx, newsletter.HashToken("wrong"))
	require.ErrorIs(t, err, newsletter.ErrNotFound)

	// Cross site lookups fail closed.
	_, err = fixture.store.FindSubscriberByID(ctx, "another-site", created.ID)
	require.ErrorIs(t, err, newsletter.ErrNotFound)

	now := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)
	created.Status = newsletter.StatusConfirmed
	created.ConfirmedAt = &now
	created.UserID = "user-1"
	updated, err := fixture.store.SaveSubscriber(ctx, created)
	require.NoError(t, err)
	require.Equal(t, newsletter.StatusConfirmed, updated.Status)
	require.NotNil(t, updated.ConfirmedAt)
	require.Equal(t, "user-1", updated.UserID)

	require.NoError(t, fixture.store.UpdateSubscriberLastSent(ctx, created.ID, now))
	found, err = fixture.store.FindSubscriberByID(ctx, fixture.siteID, created.ID)
	require.NoError(t, err)
	require.NotNil(t, found.LastSentAt)
}

func TestSubscriberListingFilteringAndPagination(t *testing.T) {
	fixture := newFixture(t)
	ctx := context.Background()

	base := time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)
	for index, item := range []struct {
		email  string
		status string
	}{
		{"a@example.com", newsletter.StatusConfirmed},
		{"b@example.com", newsletter.StatusPending},
		{"c@example.com", newsletter.StatusConfirmed},
	} {
		entry := fixture.subscriber(item.email, item.status)
		entry.CreatedAt = base.Add(time.Duration(index) * time.Minute)
		_, err := fixture.store.SaveSubscriber(ctx, entry)
		require.NoError(t, err)
	}

	first, next, err := fixture.store.ListSubscribers(ctx, fixture.siteID, newsletter.SubscriberFilter{}, 2, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, first, 2)
	require.NotEmpty(t, next)
	require.Equal(t, "c@example.com", first[0].Email, "newest first")

	cursor, err := page.Decode(next)
	require.NoError(t, err)
	second, last, err := fixture.store.ListSubscribers(ctx, fixture.siteID, newsletter.SubscriberFilter{}, 2, cursor)
	require.NoError(t, err)
	require.Len(t, second, 1)
	require.Equal(t, "a@example.com", second[0].Email)
	require.Empty(t, last)

	confirmed, _, err := fixture.store.ListSubscribers(ctx, fixture.siteID,
		newsletter.SubscriberFilter{Status: newsletter.StatusConfirmed}, 10, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, confirmed, 2)

	filtered, _, err := fixture.store.ListSubscribers(ctx, fixture.siteID,
		newsletter.SubscriberFilter{Query: "B@"}, 10, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, filtered, 1, "the email filter is case insensitive")
	require.Equal(t, "b@example.com", filtered[0].Email)

	counts, err := fixture.store.CountSubscribers(ctx, fixture.siteID)
	require.NoError(t, err)
	require.Equal(t, 2, counts.Confirmed)
	require.Equal(t, 1, counts.Pending)

	recipients, err := fixture.store.ListConfirmedSubscribers(ctx, fixture.siteID)
	require.NoError(t, err)
	require.Len(t, recipients, 2)

	require.NoError(t, fixture.store.DeleteSubscriber(ctx, fixture.siteID, first[0].ID))
	require.ErrorIs(t, fixture.store.DeleteSubscriber(ctx, fixture.siteID, first[0].ID), newsletter.ErrNotFound)
}

func TestTemplateUpsertAndCampaignCleanup(t *testing.T) {
	fixture := newFixture(t)
	ctx := context.Background()

	_, ok, err := fixture.store.GetEmailTemplate(ctx, fixture.siteID, newsletter.KeySubscriberConfirm)
	require.NoError(t, err)
	require.False(t, ok)

	saved, err := fixture.store.SaveEmailTemplate(ctx, newsletter.EmailTemplate{
		SiteID:   fixture.siteID,
		Key:      newsletter.KeySubscriberConfirm,
		Name:     "确认",
		Subject:  "请确认",
		BodyHTML: "<p>{{confirm_url}}</p>",
		BodyText: "{{confirm_url}}",
		Enabled:  true,
	})
	require.NoError(t, err)
	require.False(t, saved.Builtin)

	override, ok, err := fixture.store.GetEmailTemplate(ctx, fixture.siteID, newsletter.KeySubscriberConfirm)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "请确认", override.Subject)

	// Saving again updates in place rather than violating the unique index.
	saved, err = fixture.store.SaveEmailTemplate(ctx, newsletter.EmailTemplate{
		SiteID:   fixture.siteID,
		Key:      newsletter.KeySubscriberConfirm,
		Name:     "确认",
		Subject:  "请再次确认",
		BodyHTML: "<p>{{confirm_url}}</p>",
		BodyText: "{{confirm_url}}",
		Enabled:  true,
	})
	require.NoError(t, err)
	require.Equal(t, "请再次确认", saved.Subject)

	items, err := fixture.store.ListEmailTemplates(ctx, fixture.siteID)
	require.NoError(t, err)
	require.Len(t, items, 1)

	// Campaign cleanup refuses to drop a body a queued delivery still references.
	campaignKey := newsletter.CampaignTemplateKey("campaign-1")
	_, err = fixture.store.SaveEmailTemplate(ctx, newsletter.EmailTemplate{
		SiteID:   fixture.siteID,
		Key:      campaignKey,
		Name:     "Newsletter",
		Subject:  "周报",
		BodyHTML: "<p>正文</p>",
		BodyText: "正文",
		Enabled:  true,
	})
	require.NoError(t, err)
	require.NoError(t, fixture.store.InsertEmailLogs(ctx, []newsletter.EmailLog{{
		SiteID:      fixture.siteID,
		ToEmail:     "a@example.com",
		Kind:        emailgateway.KindNewsletter,
		TemplateKey: campaignKey,
		Subject:     "周报",
		Status:      emailgateway.StatusQueued,
		CreatedAt:   time.Now().UTC(),
	}}))
	dropped, err := fixture.store.DeleteEmailTemplateIfUnqueued(ctx, fixture.siteID, campaignKey)
	require.NoError(t, err)
	require.False(t, dropped)

	queued, err := fixture.store.ListQueuedNewsletterLogs(ctx, 10)
	require.NoError(t, err)
	require.Len(t, queued, 1)
	require.NoError(t, fixture.store.MarkEmailLogSent(ctx, queued[0].ID, "", time.Now().UTC()))

	dropped, err = fixture.store.DeleteEmailTemplateIfUnqueued(ctx, fixture.siteID, campaignKey)
	require.NoError(t, err)
	require.True(t, dropped, "the campaign body is dropped once the queue is empty")

	require.NoError(t, fixture.store.DeleteEmailTemplate(ctx, fixture.siteID, newsletter.KeySubscriberConfirm))
	require.ErrorIs(t,
		fixture.store.DeleteEmailTemplate(ctx, fixture.siteID, newsletter.KeySubscriberConfirm),
		newsletter.ErrNotFound)
}

func TestEmailLogPortAndGatewayIntegration(t *testing.T) {
	fixture := newFixture(t)
	ctx := context.Background()

	// No relay: the gateway records the attempt as skipped and reports success.
	gateway := emailgateway.New(fixture.store, nil)
	require.False(t, gateway.Configured())
	require.NoError(t, gateway.Send(ctx, emailgateway.Request{
		SiteID:      fixture.siteID,
		Kind:        emailgateway.KindSystem,
		TemplateKey: newsletter.KeySubscriberConfirm,
		To:          "reader@example.com",
		Subject:     "请确认订阅",
		Text:        "hi",
	}))

	logs, next, err := fixture.store.ListEmailLogs(ctx, fixture.siteID, newsletter.EmailLogFilter{}, 10, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, logs, 1)
	require.Empty(t, next)
	require.Equal(t, emailgateway.StatusSkipped, logs[0].Status)
	require.Equal(t, "reader@example.com", logs[0].ToEmail)
	require.Equal(t, newsletter.KeySubscriberConfirm, logs[0].TemplateKey)

	// A configured sender delivers and the row is finalised as sent.
	sender := &recordingSender{}
	gateway = emailgateway.New(fixture.store, sender)
	require.NoError(t, gateway.Send(ctx, emailgateway.Request{
		SiteID:  fixture.siteID,
		To:      "second@example.com",
		Subject: "欢迎",
		Text:    "hi",
	}))
	require.Len(t, sender.messages, 1)

	logs, _, err = fixture.store.ListEmailLogs(ctx, fixture.siteID,
		newsletter.EmailLogFilter{Status: emailgateway.StatusSent}, 10, page.Cursor{})
	require.NoError(t, err)
	require.Len(t, logs, 1)
	require.NotNil(t, logs[0].SentAt)

	counts, err := fixture.store.CountEmailLogsSince(ctx, fixture.siteID, time.Now().UTC().Add(-time.Hour))
	require.NoError(t, err)
	require.Equal(t, 1, counts.Sent)
	require.Equal(t, 0, counts.Failed)

	// The queue rejects rows that a failed attempt left behind.
	require.NoError(t, fixture.store.InsertEmailLogs(ctx, []newsletter.EmailLog{{
		SiteID:      fixture.siteID,
		ToEmail:     "third@example.com",
		Kind:        emailgateway.KindNewsletter,
		TemplateKey: newsletter.CampaignTemplateKey("campaign-2"),
		Subject:     "周报",
		Status:      emailgateway.StatusQueued,
		CreatedAt:   time.Now().UTC(),
	}}))
	queued, err := fixture.store.ListQueuedNewsletterLogs(ctx, 10)
	require.NoError(t, err)
	require.Len(t, queued, 1)
	require.NoError(t, fixture.store.RequeueEmailLog(ctx, queued[0].ID, "attempt 1/3: smtp down"))
	requeued, err := fixture.store.ListQueuedNewsletterLogs(ctx, 10)
	require.NoError(t, err)
	require.Len(t, requeued, 1)
	require.Contains(t, requeued[0].Error, "attempt 1/3")
	require.NoError(t, fixture.store.FinalizeEmailLogFailure(ctx, queued[0].ID, "attempt 3/3: smtp down", time.Now().UTC()))
	remaining, err := fixture.store.ListQueuedNewsletterLogs(ctx, 10)
	require.NoError(t, err)
	require.Empty(t, remaining)
}

func TestSiteInfo(t *testing.T) {
	fixture := newFixture(t)
	info, err := fixture.store.GetSiteInfo(context.Background(), fixture.siteID)
	require.NoError(t, err)
	require.Equal(t, "主站", info.Name)
	require.Equal(t, "press.example.com", info.Domain)
}

// sqliteDSN builds a modernc/sqlite DSN with the pragmas the Ent schema needs.
//
// The repository does not open the database here on purpose: the test covers the
// store, not the process configuration, and the schema migration refuses to run with
// foreign keys disabled.
func sqliteDSN(path string) string {
	return "file:" + filepath.ToSlash(path) +
		"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
}

// recordingSender is a mailer.Sender that records messages.
type recordingSender struct {
	messages []mailer.Message
}

func (s *recordingSender) Send(_ context.Context, msg mailer.Message) error {
	s.messages = append(s.messages, msg)
	return nil
}

func (s *recordingSender) Configured() bool { return true }
