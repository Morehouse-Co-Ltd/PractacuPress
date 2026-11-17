package newsletter_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/newsletter"
	"github.com/practacu/practacu-press/apps/api/internal/platform/emailgateway"
)

func addConfirmedSubscriber(t *testing.T, repo *fakeRepo, email, id string) {
	t.Helper()
	now := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	_, err := repo.SaveSubscriber(context.Background(), newsletter.Subscriber{
		ID:          id,
		SiteID:      testSite().ID,
		Email:       email,
		Status:      newsletter.StatusConfirmed,
		Source:      newsletter.SourceSite,
		ConfirmedAt: &now,
		TokenHash:   newsletter.HashToken("old-token-" + id),
		CreatedAt:   now,
	})
	require.NoError(t, err)
}

func queuedLogs(repo *fakeRepo) []*newsletter.EmailLog {
	out := make([]*newsletter.EmailLog, 0)
	for _, row := range repo.logs {
		if row.Kind == emailgateway.KindNewsletter && row.Status == emailgateway.StatusQueued {
			out = append(out, row)
		}
	}
	return out
}

func TestSendNewsletterQueuesOneDeliveryPerConfirmedSubscriber(t *testing.T) {
	repo := newFakeRepo()
	gateway := newFakeGateway(repo, true)
	service := serviceWith(t, repo, gateway)
	addConfirmedSubscriber(t, repo, "one@example.com", "sub-one")
	addConfirmedSubscriber(t, repo, "two@example.com", "sub-two")
	// A pending address must not be mailed.
	_, err := repo.SaveSubscriber(context.Background(), newsletter.Subscriber{
		SiteID:    testSite().ID,
		Email:     "pending@example.com",
		Status:    newsletter.StatusPending,
		TokenHash: newsletter.HashToken("pending-token"),
		CreatedAt: time.Now().UTC(),
	})
	require.NoError(t, err)

	result, err := service.SendNewsletter(context.Background(), newsletter.SendNewsletterInput{
		Site:        testSite(),
		Subject:     "{{site_name}} 周报",
		BodyHTML:    "<p>本周更新。</p>",
		BodyText:    "本周更新。",
		RequestBase: "https://request.example.com",
	})
	require.NoError(t, err)
	require.Equal(t, 2, result.Queued)

	queued := queuedLogs(repo)
	require.Len(t, queued, 2)
	for _, row := range queued {
		require.Equal(t, emailgateway.KindNewsletter, row.Kind)
		require.Equal(t, "测试站点 周报", row.Subject, "the subject is rendered with the site name")
		require.True(t, newsletter.IsCampaignTemplateKey(row.TemplateKey))
		require.Contains(t, row.TemplateKey, "campaign:")
	}
	require.Equal(t, 0, gateway.deliveries, "queueing must not deliver synchronously")

	// The campaign body is persisted so a restart can still render the queue.
	campaignKey := queued[0].TemplateKey
	campaign, ok := repo.templates[templateMapKey(testSite().ID, campaignKey)]
	require.True(t, ok)
	require.Contains(t, campaign.BodyHTML, "本周更新。")
	require.Contains(t, campaign.BodyHTML, "{{unsubscribe_url}}")

	sender := newsletter.NewSender(service, newsletter.SenderConfig{})
	report, err := sender.RunOnce(context.Background())
	require.NoError(t, err)
	require.Equal(t, 2, report.Delivered)

	for _, row := range repo.logs {
		require.Equal(t, emailgateway.StatusSent, row.Status)
		require.NotNil(t, row.SentAt)
	}
	require.Equal(t, 2, gateway.deliveries)
	for _, message := range gateway.delivered {
		require.Contains(t, message.Text, "/newsletter/unsubscribe?token=")
		require.NotContains(t, message.Text, "{{unsubscribe_url}}")
	}
	for _, subscriber := range repo.subscribers {
		if subscriber.Status == newsletter.StatusConfirmed {
			require.NotNil(t, subscriber.LastSentAt)
		}
	}

	// The campaign body is dropped once nothing references it.
	_, stillThere := repo.templates[templateMapKey(testSite().ID, campaignKey)]
	require.False(t, stillThere)

	report, err = sender.RunOnce(context.Background())
	require.NoError(t, err)
	require.Zero(t, report.Delivered)
	require.Zero(t, report.Retried)
}

func TestSenderRetriesThreeTimesThenParksTheRow(t *testing.T) {
	repo := newFakeRepo()
	gateway := newFakeGateway(repo, true)
	gateway.deliverErr = errors.New("smtp: temporary failure")
	service := serviceWith(t, repo, gateway)
	addConfirmedSubscriber(t, repo, "one@example.com", "sub-one")

	_, err := service.SendNewsletter(context.Background(), newsletter.SendNewsletterInput{
		Site:     testSite(),
		Subject:  "周报",
		BodyHTML: "<p>本周更新。</p>",
	})
	require.NoError(t, err)

	sender := newsletter.NewSender(service, newsletter.SenderConfig{})
	ctx := context.Background()

	report, err := sender.RunOnce(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, report.Retried)
	rows := queuedLogs(repo)
	require.Len(t, rows, 1)
	require.Contains(t, rows[0].Error, "attempt 1/3")

	report, err = sender.RunOnce(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, report.Retried)
	rows = queuedLogs(repo)
	require.Len(t, rows, 1)
	require.Contains(t, rows[0].Error, "attempt 2/3")

	report, err = sender.RunOnce(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, report.Failed)
	require.Empty(t, queuedLogs(repo))
	var failed *newsletter.EmailLog
	for _, row := range repo.logs {
		if row.Status == emailgateway.StatusFailed {
			failed = row
		}
	}
	require.NotNil(t, failed)
	require.Contains(t, failed.Error, "attempt 3/3")
	require.Equal(t, 3, gateway.deliveries, "three attempts in total")
}

func TestSendNewsletterWithoutRelayRecordsSkippedRows(t *testing.T) {
	repo := newFakeRepo()
	gateway := newFakeGateway(repo, false)
	service := serviceWith(t, repo, gateway)
	addConfirmedSubscriber(t, repo, "one@example.com", "sub-one")

	result, err := service.SendNewsletter(context.Background(), newsletter.SendNewsletterInput{
		Site:     testSite(),
		Subject:  "周报",
		BodyHTML: "<p>本周更新。</p>",
	})
	require.NoError(t, err)
	require.Equal(t, 0, result.Queued, "nothing is queued when no relay is configured")

	require.Len(t, repo.logs, 1)
	require.Equal(t, emailgateway.StatusSkipped, repo.logs[0].Status)
	require.Equal(t, emailgateway.KindNewsletter, repo.logs[0].Kind)

	sender := newsletter.NewSender(service, newsletter.SenderConfig{})
	report, err := sender.RunOnce(context.Background())
	require.NoError(t, err)
	require.Zero(t, report.Delivered)
}

func TestSendNewsletterRendersContentDigest(t *testing.T) {
	repo := newFakeRepo()
	gateway := newFakeGateway(repo, true)
	service := serviceWith(t, repo, gateway, func(cfg *newsletter.ServiceConfig) {
		cfg.ContentDigest = fakeDigest{
			title:   "标题 <测试>",
			summary: "摘要内容",
			url:     "/a/slug",
			found:   true,
		}
	})
	addConfirmedSubscriber(t, repo, "one@example.com", "sub-one")

	_, err := service.SendNewsletter(context.Background(), newsletter.SendNewsletterInput{
		Site:        testSite(),
		Subject:     "新文章",
		BodyHTML:    "<p>编辑说明</p>",
		ContentID:   "content-1",
		RequestBase: "https://request.example.com",
	})
	require.NoError(t, err)

	queued := queuedLogs(repo)
	require.Len(t, queued, 1)
	campaign, ok := repo.templates[templateMapKey(testSite().ID, queued[0].TemplateKey)]
	require.True(t, ok)
	require.Contains(t, campaign.BodyHTML, "标题 &lt;测试&gt;")
	require.Contains(t, campaign.BodyHTML, "摘要内容")
	require.Contains(t, campaign.BodyHTML, "https://press.example.com/a/slug")
	require.Contains(t, campaign.BodyHTML, "编辑说明")
	require.Contains(t, campaign.BodyText, "标题 <测试>")
}

func TestSendNewsletterRejectsUnknownContent(t *testing.T) {
	repo := newFakeRepo()
	service := serviceWith(t, repo, newFakeGateway(repo, true))
	addConfirmedSubscriber(t, repo, "one@example.com", "sub-one")

	_, err := service.SendNewsletter(context.Background(), newsletter.SendNewsletterInput{
		Site:      testSite(),
		Subject:   "新文章",
		ContentID: "missing",
	})
	require.ErrorIs(t, err, newsletter.ErrContentNotFound, "a deployment without a digest cannot send content backed mail")

	service = serviceWith(t, repo, newFakeGateway(repo, true), func(cfg *newsletter.ServiceConfig) {
		cfg.ContentDigest = fakeDigest{found: false}
	})
	_, err = service.SendNewsletter(context.Background(), newsletter.SendNewsletterInput{
		Site:      testSite(),
		Subject:   "新文章",
		ContentID: "missing",
	})
	require.ErrorIs(t, err, newsletter.ErrContentNotFound)
}

func TestSenderSkipsSubscriberWhoLeftTheList(t *testing.T) {
	repo := newFakeRepo()
	gateway := newFakeGateway(repo, true)
	service := serviceWith(t, repo, gateway)
	addConfirmedSubscriber(t, repo, "one@example.com", "sub-one")

	_, err := service.SendNewsletter(context.Background(), newsletter.SendNewsletterInput{
		Site:     testSite(),
		Subject:  "周报",
		BodyHTML: "<p>本周更新。</p>",
	})
	require.NoError(t, err)

	// The subscriber opts out between queueing and delivery.
	for _, row := range repo.subscribers {
		row.Status = newsletter.StatusUnsubscribed
	}

	sender := newsletter.NewSender(service, newsletter.SenderConfig{})
	report, err := sender.RunOnce(context.Background())
	require.NoError(t, err)
	require.Equal(t, 1, report.Skipped)
	require.Zero(t, report.Delivered)
	require.Zero(t, gateway.deliveries)
	require.Equal(t, emailgateway.StatusSkipped, repo.logs[0].Status)
}

func TestSendNewsletterWithEmptyListQueuesNothing(t *testing.T) {
	repo := newFakeRepo()
	service := serviceWith(t, repo, newFakeGateway(repo, true))

	result, err := service.SendNewsletter(context.Background(), newsletter.SendNewsletterInput{
		Site:    testSite(),
		Subject: "周报",
	})
	require.NoError(t, err)
	require.Equal(t, 0, result.Queued)
	require.Empty(t, repo.logs)
}

func TestSendNewsletterValidation(t *testing.T) {
	repo := newFakeRepo()
	service := serviceWith(t, repo, newFakeGateway(repo, true))
	addConfirmedSubscriber(t, repo, "one@example.com", "sub-one")

	_, err := service.SendNewsletter(context.Background(), newsletter.SendNewsletterInput{
		Site:    testSite(),
		Subject: "",
	})
	require.ErrorIs(t, err, newsletter.ErrInvalidTemplate)

	_, err = service.SendNewsletter(context.Background(), newsletter.SendNewsletterInput{
		Site:     testSite(),
		Subject:  strings.Repeat("主", 400),
		BodyHTML: "<p>x</p>",
	})
	require.ErrorIs(t, err, newsletter.ErrInvalidTemplate)
}

// fakeDigest is a ContentDigest controlled by the test.
type fakeDigest struct {
	title   string
	summary string
	url     string
	found   bool
	err     error
}

func (d fakeDigest) Digest(context.Context, string, string) (string, string, string, bool, error) {
	if d.err != nil {
		return "", "", "", false, d.err
	}
	if !d.found {
		return "", "", "", false, nil
	}
	return d.title, d.summary, d.url, true, nil
}
