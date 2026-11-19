package newsletter_test

import (
	"context"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/practacu/practacu-press/internal/newsletter"
	"github.com/practacu/practacu-press/internal/platform/emailgateway"
	"github.com/practacu/practacu-press/internal/platform/mailer"
	"github.com/practacu/practacu-press/internal/platform/page"
)

// fakeRepo is an in-memory newsletter.Repository.
type fakeRepo struct {
	seq         int
	subscribers []*newsletter.Subscriber
	templates   map[string]newsletter.EmailTemplate
	logs        []*newsletter.EmailLog
	sites       map[string]newsletter.SiteInfo
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		templates: make(map[string]newsletter.EmailTemplate),
		sites: map[string]newsletter.SiteInfo{
			"site-1": {ID: "site-1", Name: "测试站点", Domain: "press.example.com"},
		},
	}
}

func templateMapKey(siteID, key string) string { return siteID + "\x00" + key }

func (r *fakeRepo) nextID(prefix string) string {
	r.seq++
	return prefix + "-" + itoa(r.seq)
}

func (r *fakeRepo) InsertEmailLog(_ context.Context, entry emailgateway.Log) (emailgateway.Log, error) {
	row := &newsletter.EmailLog{
		ID:           r.nextID("log"),
		SiteID:       entry.SiteID,
		ToEmail:      entry.ToEmail,
		Kind:         entry.Kind,
		TemplateKey:  entry.TemplateKey,
		Subject:      entry.Subject,
		Status:       entry.Status,
		SubscriberID: entry.SubscriberID,
		CreatedAt:    entry.CreatedAt,
	}
	r.logs = append(r.logs, row)
	return emailgateway.Log{ID: row.ID, SiteID: row.SiteID, Status: row.Status}, nil
}

func (r *fakeRepo) findLog(id string) *newsletter.EmailLog {
	for _, row := range r.logs {
		if row.ID == id {
			return row
		}
	}
	return nil
}

func (r *fakeRepo) MarkEmailLogSent(_ context.Context, id, providerMessageID string, at time.Time) error {
	row := r.findLog(id)
	if row == nil {
		return newsletter.ErrNotFound
	}
	row.Status = emailgateway.StatusSent
	row.ProviderMessageID = providerMessageID
	row.Error = ""
	row.SentAt = &at
	return nil
}

func (r *fakeRepo) MarkEmailLogFailed(_ context.Context, id, reason string, at time.Time) error {
	row := r.findLog(id)
	if row == nil {
		return newsletter.ErrNotFound
	}
	row.Status = emailgateway.StatusFailed
	row.Error = reason
	return nil
}

func (r *fakeRepo) MarkEmailLogSkipped(_ context.Context, id string, at time.Time) error {
	row := r.findLog(id)
	if row == nil {
		return newsletter.ErrNotFound
	}
	row.Status = emailgateway.StatusSkipped
	return nil
}

func (r *fakeRepo) FindSubscriberByEmail(_ context.Context, siteID, email string) (newsletter.Subscriber, error) {
	for _, row := range r.subscribers {
		if row.SiteID == siteID && row.Email == email {
			return *row, nil
		}
	}
	return newsletter.Subscriber{}, newsletter.ErrNotFound
}

func (r *fakeRepo) FindSubscriberByTokenHash(_ context.Context, tokenHash string) (newsletter.Subscriber, error) {
	for _, row := range r.subscribers {
		if row.TokenHash == tokenHash {
			return *row, nil
		}
	}
	return newsletter.Subscriber{}, newsletter.ErrNotFound
}

func (r *fakeRepo) FindSubscriberByID(_ context.Context, siteID, id string) (newsletter.Subscriber, error) {
	for _, row := range r.subscribers {
		if row.ID == id && row.SiteID == siteID {
			return *row, nil
		}
	}
	return newsletter.Subscriber{}, newsletter.ErrNotFound
}

func (r *fakeRepo) SaveSubscriber(_ context.Context, subscriber newsletter.Subscriber) (newsletter.Subscriber, error) {
	if subscriber.ID == "" {
		subscriber.ID = r.nextID("sub")
	}
	for _, row := range r.subscribers {
		if row.ID == subscriber.ID {
			*row = subscriber
			return *row, nil
		}
	}
	row := subscriber
	r.subscribers = append(r.subscribers, &row)
	return row, nil
}

func (r *fakeRepo) ListSubscribers(
	_ context.Context,
	siteID string,
	filter newsletter.SubscriberFilter,
	limit int,
	after page.Cursor,
) ([]newsletter.Subscriber, string, error) {
	items := make([]newsletter.Subscriber, 0, len(r.subscribers))
	for _, row := range r.subscribers {
		if row.SiteID != siteID {
			continue
		}
		if filter.Status != "" && row.Status != filter.Status {
			continue
		}
		if filter.Query != "" && !strings.Contains(strings.ToLower(row.Email), strings.ToLower(filter.Query)) {
			continue
		}
		items = append(items, *row)
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].CreatedAt.Equal(items[j].CreatedAt) {
			return items[i].ID > items[j].ID
		}
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})
	start := 0
	if !after.IsZero() {
		for index, item := range items {
			if item.ID == after.ID {
				start = index + 1
				break
			}
		}
	}
	items = items[start:]
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = page.Cursor{Key: items[len(items)-1].CreatedAt.Format(time.RFC3339Nano), ID: items[len(items)-1].ID}.Encode()
	}
	return items, next, nil
}

func (r *fakeRepo) ListConfirmedSubscribers(_ context.Context, siteID string) ([]newsletter.Subscriber, error) {
	items := make([]newsletter.Subscriber, 0, len(r.subscribers))
	for _, row := range r.subscribers {
		if row.SiteID == siteID && row.Status == newsletter.StatusConfirmed {
			items = append(items, *row)
		}
	}
	return items, nil
}

func (r *fakeRepo) DeleteSubscriber(_ context.Context, siteID, id string) error {
	for index, row := range r.subscribers {
		if row.ID == id && row.SiteID == siteID {
			r.subscribers = append(r.subscribers[:index], r.subscribers[index+1:]...)
			return nil
		}
	}
	return newsletter.ErrNotFound
}

func (r *fakeRepo) CountSubscribers(_ context.Context, siteID string) (newsletter.SubscriberCounts, error) {
	var counts newsletter.SubscriberCounts
	for _, row := range r.subscribers {
		if row.SiteID != siteID {
			continue
		}
		switch row.Status {
		case newsletter.StatusConfirmed:
			counts.Confirmed++
		case newsletter.StatusPending:
			counts.Pending++
		case newsletter.StatusUnsubscribed:
			counts.Unsubscribed++
		case newsletter.StatusBounced:
			counts.Bounced++
		}
	}
	return counts, nil
}

func (r *fakeRepo) UpdateSubscriberLastSent(_ context.Context, id string, at time.Time) error {
	for _, row := range r.subscribers {
		if row.ID == id {
			row.LastSentAt = &at
			return nil
		}
	}
	return newsletter.ErrNotFound
}

func (r *fakeRepo) GetEmailTemplate(_ context.Context, siteID, key string) (newsletter.EmailTemplate, bool, error) {
	template, ok := r.templates[templateMapKey(siteID, key)]
	return template, ok, nil
}

func (r *fakeRepo) ListEmailTemplates(_ context.Context, siteID string) ([]newsletter.EmailTemplate, error) {
	out := make([]newsletter.EmailTemplate, 0, len(r.templates))
	for key, template := range r.templates {
		if strings.HasPrefix(key, siteID+"\x00") {
			out = append(out, template)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

func (r *fakeRepo) SaveEmailTemplate(_ context.Context, template newsletter.EmailTemplate) (newsletter.EmailTemplate, error) {
	now := time.Now().UTC()
	template.UpdatedAt = &now
	template.Builtin = false
	r.templates[templateMapKey(template.SiteID, template.Key)] = template
	return template, nil
}

func (r *fakeRepo) DeleteEmailTemplate(_ context.Context, siteID, key string) error {
	index := templateMapKey(siteID, key)
	if _, ok := r.templates[index]; !ok {
		return newsletter.ErrNotFound
	}
	delete(r.templates, index)
	return nil
}

func (r *fakeRepo) DeleteEmailTemplateIfUnqueued(_ context.Context, siteID, key string) (bool, error) {
	for _, row := range r.logs {
		if row.SiteID == siteID && row.TemplateKey == key && row.Status == emailgateway.StatusQueued {
			return false, nil
		}
	}
	index := templateMapKey(siteID, key)
	if _, ok := r.templates[index]; !ok {
		return false, nil
	}
	delete(r.templates, index)
	return true, nil
}

func (r *fakeRepo) InsertEmailLogs(_ context.Context, entries []newsletter.EmailLog) error {
	for _, entry := range entries {
		row := entry
		row.ID = r.nextID("log")
		r.logs = append(r.logs, &row)
	}
	return nil
}

func (r *fakeRepo) ListEmailLogs(
	_ context.Context,
	siteID string,
	filter newsletter.EmailLogFilter,
	limit int,
	after page.Cursor,
) ([]newsletter.EmailLog, string, error) {
	items := make([]newsletter.EmailLog, 0, len(r.logs))
	for _, row := range r.logs {
		if row.SiteID != siteID {
			continue
		}
		if filter.Status != "" && row.Status != filter.Status {
			continue
		}
		if filter.Kind != "" && row.Kind != filter.Kind {
			continue
		}
		items = append(items, *row)
	}
	sort.SliceStable(items, func(i, j int) bool {
		return items[i].CreatedAt.After(items[j].CreatedAt)
	})
	start := 0
	if !after.IsZero() {
		for index, item := range items {
			if item.ID == after.ID {
				start = index + 1
				break
			}
		}
	}
	items = items[start:]
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = page.Cursor{Key: items[len(items)-1].CreatedAt.Format(time.RFC3339Nano), ID: items[len(items)-1].ID}.Encode()
	}
	return items, next, nil
}

func (r *fakeRepo) ListQueuedNewsletterLogs(_ context.Context, limit int) ([]newsletter.EmailLog, error) {
	items := make([]newsletter.EmailLog, 0, len(r.logs))
	for _, row := range r.logs {
		if row.Kind == emailgateway.KindNewsletter && row.Status == emailgateway.StatusQueued {
			items = append(items, *row)
		}
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].CreatedAt.Equal(items[j].CreatedAt) {
			return items[i].ID < items[j].ID
		}
		return items[i].CreatedAt.Before(items[j].CreatedAt)
	})
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (r *fakeRepo) RequeueEmailLog(_ context.Context, id, reason string) error {
	row := r.findLog(id)
	if row == nil {
		return newsletter.ErrNotFound
	}
	row.Status = emailgateway.StatusQueued
	row.Error = reason
	return nil
}

func (r *fakeRepo) FinalizeEmailLogFailure(_ context.Context, id, reason string, at time.Time) error {
	row := r.findLog(id)
	if row == nil {
		return newsletter.ErrNotFound
	}
	row.Status = emailgateway.StatusFailed
	row.Error = reason
	return nil
}

func (r *fakeRepo) CountEmailLogsSince(_ context.Context, siteID string, since time.Time) (newsletter.EmailLogCounts, error) {
	var counts newsletter.EmailLogCounts
	for _, row := range r.logs {
		if row.SiteID != siteID || row.CreatedAt.Before(since) {
			continue
		}
		switch row.Status {
		case emailgateway.StatusSent:
			counts.Sent++
		case emailgateway.StatusFailed:
			counts.Failed++
		}
	}
	return counts, nil
}

func (r *fakeRepo) GetSiteInfo(_ context.Context, siteID string) (newsletter.SiteInfo, error) {
	info, ok := r.sites[siteID]
	if !ok {
		return newsletter.SiteInfo{}, newsletter.ErrNotFound
	}
	return info, nil
}

// fakeGateway implements newsletter.EmailGateway and mirrors the real gateway's
// bookkeeping so the sender's state transitions can be asserted.
type fakeGateway struct {
	repo       *fakeRepo
	configured bool
	sendErr    error
	deliverErr error
	sends      []emailgateway.Request
	delivered  []mailer.Message
	deliveries int
}

func newFakeGateway(repo *fakeRepo, configured bool) *fakeGateway {
	return &fakeGateway{repo: repo, configured: configured}
}

func (g *fakeGateway) Configured() bool { return g.configured }

func (g *fakeGateway) Send(_ context.Context, req emailgateway.Request) error {
	g.sends = append(g.sends, req)
	if g.sendErr != nil {
		return g.sendErr
	}
	return nil
}

func (g *fakeGateway) Deliver(_ context.Context, logID string, msg mailer.Message) (emailgateway.Outcome, error) {
	g.deliveries++
	g.delivered = append(g.delivered, msg)
	if !g.configured {
		_ = g.repo.MarkEmailLogSkipped(context.Background(), logID, time.Now().UTC())
		return emailgateway.OutcomeSkipped, nil
	}
	if g.deliverErr != nil {
		_ = g.repo.MarkEmailLogFailed(context.Background(), logID, g.deliverErr.Error(), time.Now().UTC())
		return emailgateway.OutcomeFailed, g.deliverErr
	}
	_ = g.repo.MarkEmailLogSent(context.Background(), logID, "", time.Now().UTC())
	return emailgateway.OutcomeSent, nil
}

// helper constructors -------------------------------------------------------------

func testSite() newsletter.SiteInfo {
	return newsletter.SiteInfo{ID: "site-1", Name: "测试站点", Domain: "press.example.com"}
}

func serviceWith(t *testing.T, repo newsletter.Repository, gateway newsletter.EmailGateway, opts ...func(*newsletter.ServiceConfig)) *newsletter.Service {
	t.Helper()
	cfg := newsletter.ServiceConfig{
		Repository:    repo,
		Gateway:       gateway,
		PublicBaseURL: "https://press.example.com",
		AccountEmail: func(context.Context, string) (string, error) {
			return "reader@example.com", nil
		},
		Now: func() time.Time { return time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC) },
	}
	for _, opt := range opts {
		opt(&cfg)
	}
	service, err := newsletter.NewService(cfg)
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	return service
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 8)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

var errTestDigest = errors.New("digest failed")
