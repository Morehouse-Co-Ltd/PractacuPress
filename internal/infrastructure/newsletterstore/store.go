// Package newsletterstore implements the newsletter persistence ports with Ent.
//
// One store implements both the newsletter repository and the email gateway's log
// port: they share the same tables, and splitting them into two types would only
// duplicate the row mapping.
package newsletterstore

import (
	"context"
	"strings"
	"time"

	entgen "github.com/practacu/practacu-press/internal/ent"
	"github.com/practacu/practacu-press/internal/ent/emaillog"
	"github.com/practacu/practacu-press/internal/ent/emailtemplate"
	"github.com/practacu/practacu-press/internal/ent/site"
	"github.com/practacu/practacu-press/internal/ent/subscriber"
	"github.com/practacu/practacu-press/internal/newsletter"
	"github.com/practacu/practacu-press/internal/platform/emailgateway"
	"github.com/practacu/practacu-press/internal/platform/page"
)

// Store is the Ent backed newsletter repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store {
	return &Store{client: client}
}

var (
	_ newsletter.Repository = (*Store)(nil)
	_ emailgateway.Store    = (*Store)(nil)
)

// -------------------------------------------------------------------------------
// Email log port (emailgateway.Store)
// -------------------------------------------------------------------------------

// InsertEmailLog writes the pre-delivery row.
func (s *Store) InsertEmailLog(ctx context.Context, entry emailgateway.Log) (emailgateway.Log, error) {
	createdAt := entry.CreatedAt
	if createdAt.IsZero() {
		createdAt = time.Now().UTC()
	}
	builder := s.client.EmailLog.Create().
		SetSiteID(entry.SiteID).
		SetToEmail(entry.ToEmail).
		SetKind(normalizeKind(entry.Kind)).
		SetTemplateKey(entry.TemplateKey).
		SetSubject(entry.Subject).
		SetStatus(normalizeStatus(entry.Status)).
		SetCreatedAt(createdAt)
	if entry.SubscriberID != "" {
		builder.SetSubscriberID(entry.SubscriberID)
	}
	row, err := builder.Save(ctx)
	if err != nil {
		return emailgateway.Log{}, err
	}
	return emailgateway.Log{
		ID:          row.ID,
		SiteID:      row.SiteID,
		ToEmail:     row.ToEmail,
		Kind:        row.Kind,
		TemplateKey: row.TemplateKey,
		Subject:     row.Subject,
		Status:      row.Status,
		CreatedAt:   row.CreatedAt,
	}, nil
}

// MarkEmailLogSent finalises a successful delivery.
func (s *Store) MarkEmailLogSent(ctx context.Context, id, providerMessageID string, at time.Time) error {
	update := s.client.EmailLog.UpdateOneID(id).
		SetStatus(emailgateway.StatusSent).
		SetSentAt(at).
		ClearError()
	if providerMessageID != "" {
		update.SetProviderMessageID(providerMessageID)
	}
	return update.Exec(ctx)
}

// MarkEmailLogFailed records a failed delivery.
func (s *Store) MarkEmailLogFailed(ctx context.Context, id, reason string, at time.Time) error {
	return s.client.EmailLog.UpdateOneID(id).
		SetStatus(emailgateway.StatusFailed).
		SetError(truncate(reason, emailgateway.MaxErrorLength)).
		Exec(ctx)
}

// MarkEmailLogSkipped records a delivery that was never attempted.
func (s *Store) MarkEmailLogSkipped(ctx context.Context, id string, at time.Time) error {
	return s.client.EmailLog.UpdateOneID(id).
		SetStatus(emailgateway.StatusSkipped).
		Exec(ctx)
}

// -------------------------------------------------------------------------------
// Subscribers
// -------------------------------------------------------------------------------

// FindSubscriberByEmail resolves one site's list entry by address.
func (s *Store) FindSubscriberByEmail(ctx context.Context, siteID, email string) (newsletter.Subscriber, error) {
	row, err := s.client.Subscriber.Query().
		Where(subscriber.SiteIDEQ(siteID), subscriber.EmailEQ(email)).
		First(ctx)
	if err != nil {
		return newsletter.Subscriber{}, mapNotFound(err)
	}
	return toSubscriber(row), nil
}

// FindSubscriberByTokenHash resolves a hashed confirmation/unsubscribe token.
func (s *Store) FindSubscriberByTokenHash(ctx context.Context, tokenHash string) (newsletter.Subscriber, error) {
	row, err := s.client.Subscriber.Query().
		Where(subscriber.TokenHashEQ(tokenHash)).
		First(ctx)
	if err != nil {
		return newsletter.Subscriber{}, mapNotFound(err)
	}
	return toSubscriber(row), nil
}

// FindSubscriberByID resolves one row inside a site.
func (s *Store) FindSubscriberByID(ctx context.Context, siteID, id string) (newsletter.Subscriber, error) {
	row, err := s.client.Subscriber.Query().
		Where(subscriber.IDEQ(id), subscriber.SiteIDEQ(siteID)).
		First(ctx)
	if err != nil {
		return newsletter.Subscriber{}, mapNotFound(err)
	}
	return toSubscriber(row), nil
}

// SaveSubscriber inserts a new entry or replaces the mutable fields of an existing
// one.
func (s *Store) SaveSubscriber(ctx context.Context, entry newsletter.Subscriber) (newsletter.Subscriber, error) {
	if entry.ID == "" {
		createdAt := entry.CreatedAt
		if createdAt.IsZero() {
			createdAt = time.Now().UTC()
		}
		builder := s.client.Subscriber.Create().
			SetSiteID(entry.SiteID).
			SetEmail(entry.Email).
			SetStatus(normalizeSubscriberStatus(entry.Status)).
			SetTokenHash(entry.TokenHash).
			SetSource(normalizeSource(entry.Source)).
			SetNillableUserID(nilIfEmpty(entry.UserID)).
			SetNillableConfirmedAt(entry.ConfirmedAt).
			SetNillableUnsubscribedAt(entry.UnsubscribedAt).
			SetNillableLastSentAt(entry.LastSentAt).
			SetCreatedAt(createdAt)
		row, err := builder.Save(ctx)
		if err != nil {
			return newsletter.Subscriber{}, err
		}
		return toSubscriber(row), nil
	}

	update := s.client.Subscriber.UpdateOneID(entry.ID).
		SetEmail(entry.Email).
		SetStatus(normalizeSubscriberStatus(entry.Status)).
		SetTokenHash(entry.TokenHash).
		SetSource(normalizeSource(entry.Source)).
		SetNillableUserID(nilIfEmpty(entry.UserID)).
		SetNillableConfirmedAt(entry.ConfirmedAt).
		SetNillableUnsubscribedAt(entry.UnsubscribedAt).
		SetNillableLastSentAt(entry.LastSentAt)
	if err := update.Exec(ctx); err != nil {
		return newsletter.Subscriber{}, mapNotFound(err)
	}
	row, err := s.client.Subscriber.Get(ctx, entry.ID)
	if err != nil {
		return newsletter.Subscriber{}, mapNotFound(err)
	}
	return toSubscriber(row), nil
}

// ListSubscribers returns one newest first page plus the next cursor.
func (s *Store) ListSubscribers(
	ctx context.Context,
	siteID string,
	filter newsletter.SubscriberFilter,
	limit int,
	after page.Cursor,
) ([]newsletter.Subscriber, string, error) {
	query := s.client.Subscriber.Query().Where(subscriber.SiteIDEQ(siteID))
	if filter.Status != "" {
		query.Where(subscriber.StatusEQ(filter.Status))
	}
	if filter.Query != "" {
		query.Where(subscriber.EmailContainsFold(filter.Query))
	}
	if !after.IsZero() {
		key, err := time.Parse(time.RFC3339Nano, after.Key)
		if err != nil {
			return nil, "", page.ErrInvalidCursor
		}
		query.Where(subscriber.Or(
			subscriber.CreatedAtLT(key),
			subscriber.And(subscriber.CreatedAtEQ(key), subscriber.IDLT(after.ID)),
		))
	}
	rows, err := query.
		Order(entgen.Desc(subscriber.FieldCreatedAt), entgen.Desc(subscriber.FieldID)).
		Limit(limit + 1).
		All(ctx)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next = page.Cursor{
			Key: last.CreatedAt.UTC().Format(time.RFC3339Nano),
			ID:  last.ID,
		}.Encode()
	}
	items := make([]newsletter.Subscriber, 0, len(rows))
	for _, row := range rows {
		items = append(items, toSubscriber(row))
	}
	return items, next, nil
}

// ListConfirmedSubscribers returns the recipient set of one campaign.
func (s *Store) ListConfirmedSubscribers(ctx context.Context, siteID string) ([]newsletter.Subscriber, error) {
	rows, err := s.client.Subscriber.Query().
		Where(
			subscriber.SiteIDEQ(siteID),
			subscriber.StatusEQ(newsletter.StatusConfirmed),
		).
		Order(entgen.Asc(subscriber.FieldCreatedAt), entgen.Asc(subscriber.FieldID)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]newsletter.Subscriber, 0, len(rows))
	for _, row := range rows {
		items = append(items, toSubscriber(row))
	}
	return items, nil
}

// DeleteSubscriber removes one entry.
func (s *Store) DeleteSubscriber(ctx context.Context, siteID, id string) error {
	deleted, err := s.client.Subscriber.Delete().
		Where(subscriber.IDEQ(id), subscriber.SiteIDEQ(siteID)).
		Exec(ctx)
	if err != nil {
		return err
	}
	if deleted == 0 {
		return newsletter.ErrNotFound
	}
	return nil
}

// CountSubscribers returns the list counts.
func (s *Store) CountSubscribers(ctx context.Context, siteID string) (newsletter.SubscriberCounts, error) {
	count := func(status string) (int, error) {
		return s.client.Subscriber.Query().
			Where(subscriber.SiteIDEQ(siteID), subscriber.StatusEQ(status)).
			Count(ctx)
	}
	var counts newsletter.SubscriberCounts
	var err error
	if counts.Confirmed, err = count(newsletter.StatusConfirmed); err != nil {
		return newsletter.SubscriberCounts{}, err
	}
	if counts.Pending, err = count(newsletter.StatusPending); err != nil {
		return newsletter.SubscriberCounts{}, err
	}
	if counts.Unsubscribed, err = count(newsletter.StatusUnsubscribed); err != nil {
		return newsletter.SubscriberCounts{}, err
	}
	if counts.Bounced, err = count(newsletter.StatusBounced); err != nil {
		return newsletter.SubscriberCounts{}, err
	}
	return counts, nil
}

// UpdateSubscriberLastSent stamps the row after a successful delivery.
func (s *Store) UpdateSubscriberLastSent(ctx context.Context, id string, at time.Time) error {
	err := s.client.Subscriber.UpdateOneID(id).SetLastSentAt(at).Exec(ctx)
	if err != nil {
		return mapNotFound(err)
	}
	return nil
}

// -------------------------------------------------------------------------------
// Templates
// -------------------------------------------------------------------------------

// GetEmailTemplate returns one site override.
func (s *Store) GetEmailTemplate(ctx context.Context, siteID, key string) (newsletter.EmailTemplate, bool, error) {
	row, err := s.client.EmailTemplate.Query().
		Where(emailtemplate.SiteIDEQ(siteID), emailtemplate.KeyEQ(key)).
		First(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return newsletter.EmailTemplate{}, false, nil
		}
		return newsletter.EmailTemplate{}, false, err
	}
	return toEmailTemplate(row), true, nil
}

// ListEmailTemplates returns every override of a site.
func (s *Store) ListEmailTemplates(ctx context.Context, siteID string) ([]newsletter.EmailTemplate, error) {
	rows, err := s.client.EmailTemplate.Query().
		Where(emailtemplate.SiteIDEQ(siteID)).
		Order(entgen.Asc(emailtemplate.FieldKey)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]newsletter.EmailTemplate, 0, len(rows))
	for _, row := range rows {
		items = append(items, toEmailTemplate(row))
	}
	return items, nil
}

// SaveEmailTemplate upserts one override.
func (s *Store) SaveEmailTemplate(ctx context.Context, template newsletter.EmailTemplate) (newsletter.EmailTemplate, error) {
	if strings.TrimSpace(template.SiteID) == "" || strings.TrimSpace(template.Key) == "" {
		return newsletter.EmailTemplate{}, newsletter.ErrInvalidTemplate
	}
	existing, err := s.client.EmailTemplate.Query().
		Where(emailtemplate.SiteIDEQ(template.SiteID), emailtemplate.KeyEQ(template.Key)).
		First(ctx)
	if err != nil && !entgen.IsNotFound(err) {
		return newsletter.EmailTemplate{}, err
	}
	if existing != nil {
		updated, updateErr := s.client.EmailTemplate.UpdateOneID(existing.ID).
			SetName(template.Name).
			SetSubject(template.Subject).
			SetBodyHTML(template.BodyHTML).
			SetBodyText(template.BodyText).
			SetEnabled(template.Enabled).
			Save(ctx)
		if updateErr != nil {
			return newsletter.EmailTemplate{}, updateErr
		}
		return toEmailTemplate(updated), nil
	}
	row, createErr := s.client.EmailTemplate.Create().
		SetSiteID(template.SiteID).
		SetKey(template.Key).
		SetName(template.Name).
		SetSubject(template.Subject).
		SetBodyHTML(template.BodyHTML).
		SetBodyText(template.BodyText).
		SetEnabled(template.Enabled).
		Save(ctx)
	if createErr != nil {
		return newsletter.EmailTemplate{}, createErr
	}
	return toEmailTemplate(row), nil
}

// DeleteEmailTemplate drops one override.
func (s *Store) DeleteEmailTemplate(ctx context.Context, siteID, key string) error {
	deleted, err := s.client.EmailTemplate.Delete().
		Where(emailtemplate.SiteIDEQ(siteID), emailtemplate.KeyEQ(key)).
		Exec(ctx)
	if err != nil {
		return err
	}
	if deleted == 0 {
		return newsletter.ErrNotFound
	}
	return nil
}

// DeleteEmailTemplateIfUnqueued drops a campaign body once no queued delivery
// references it.
func (s *Store) DeleteEmailTemplateIfUnqueued(ctx context.Context, siteID, key string) (bool, error) {
	referenced, err := s.client.EmailLog.Query().
		Where(
			emaillog.SiteIDEQ(siteID),
			emaillog.TemplateKeyEQ(key),
			emaillog.StatusEQ(emailgateway.StatusQueued),
		).
		Exist(ctx)
	if err != nil {
		return false, err
	}
	if referenced {
		return false, nil
	}
	deleted, err := s.client.EmailTemplate.Delete().
		Where(emailtemplate.SiteIDEQ(siteID), emailtemplate.KeyEQ(key)).
		Exec(ctx)
	if err != nil {
		return false, err
	}
	return deleted > 0, nil
}

// -------------------------------------------------------------------------------
// Logs
// -------------------------------------------------------------------------------

// InsertEmailLogs writes the queued campaign rows in one batch.
func (s *Store) InsertEmailLogs(ctx context.Context, entries []newsletter.EmailLog) error {
	if len(entries) == 0 {
		return nil
	}
	builders := make([]*entgen.EmailLogCreate, 0, len(entries))
	for _, entry := range entries {
		createdAt := entry.CreatedAt
		if createdAt.IsZero() {
			createdAt = time.Now().UTC()
		}
		builder := s.client.EmailLog.Create().
			SetSiteID(entry.SiteID).
			SetToEmail(entry.ToEmail).
			SetKind(normalizeKind(entry.Kind)).
			SetTemplateKey(entry.TemplateKey).
			SetSubject(entry.Subject).
			SetStatus(normalizeStatus(entry.Status)).
			SetCreatedAt(createdAt)
		if entry.SubscriberID != "" {
			builder.SetSubscriberID(entry.SubscriberID)
		}
		builders = append(builders, builder)
	}
	return s.client.EmailLog.CreateBulk(builders...).Exec(ctx)
}

// ListEmailLogs returns one newest first page plus the next cursor.
func (s *Store) ListEmailLogs(
	ctx context.Context,
	siteID string,
	filter newsletter.EmailLogFilter,
	limit int,
	after page.Cursor,
) ([]newsletter.EmailLog, string, error) {
	query := s.client.EmailLog.Query().Where(emaillog.SiteIDEQ(siteID))
	if filter.Status != "" {
		query.Where(emaillog.StatusEQ(filter.Status))
	}
	if filter.Kind != "" {
		query.Where(emaillog.KindEQ(filter.Kind))
	}
	if !after.IsZero() {
		key, err := time.Parse(time.RFC3339Nano, after.Key)
		if err != nil {
			return nil, "", page.ErrInvalidCursor
		}
		query.Where(emaillog.Or(
			emaillog.CreatedAtLT(key),
			emaillog.And(emaillog.CreatedAtEQ(key), emaillog.IDLT(after.ID)),
		))
	}
	rows, err := query.
		Order(entgen.Desc(emaillog.FieldCreatedAt), entgen.Desc(emaillog.FieldID)).
		Limit(limit + 1).
		All(ctx)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next = page.Cursor{
			Key: last.CreatedAt.UTC().Format(time.RFC3339Nano),
			ID:  last.ID,
		}.Encode()
	}
	items := make([]newsletter.EmailLog, 0, len(rows))
	for _, row := range rows {
		items = append(items, toEmailLog(row))
	}
	return items, next, nil
}

// ListQueuedNewsletterLogs returns the oldest queued campaign rows.
func (s *Store) ListQueuedNewsletterLogs(ctx context.Context, limit int) ([]newsletter.EmailLog, error) {
	rows, err := s.client.EmailLog.Query().
		Where(
			emaillog.KindEQ(emailgateway.KindNewsletter),
			emaillog.StatusEQ(emailgateway.StatusQueued),
		).
		Order(entgen.Asc(emaillog.FieldCreatedAt), entgen.Asc(emaillog.FieldID)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]newsletter.EmailLog, 0, len(rows))
	for _, row := range rows {
		items = append(items, toEmailLog(row))
	}
	return items, nil
}

// RequeueEmailLog puts a failed attempt back into the queue.
func (s *Store) RequeueEmailLog(ctx context.Context, id, reason string) error {
	return s.client.EmailLog.UpdateOneID(id).
		SetStatus(emailgateway.StatusQueued).
		SetError(truncate(reason, emailgateway.MaxErrorLength)).
		Exec(ctx)
}

// FinalizeEmailLogFailure records the last failed attempt.
func (s *Store) FinalizeEmailLogFailure(ctx context.Context, id, reason string, at time.Time) error {
	return s.client.EmailLog.UpdateOneID(id).
		SetStatus(emailgateway.StatusFailed).
		SetError(truncate(reason, emailgateway.MaxErrorLength)).
		Exec(ctx)
}

// CountEmailLogsSince counts deliveries in a time window.
func (s *Store) CountEmailLogsSince(ctx context.Context, siteID string, since time.Time) (newsletter.EmailLogCounts, error) {
	count := func(status string) (int, error) {
		return s.client.EmailLog.Query().
			Where(
				emaillog.SiteIDEQ(siteID),
				emaillog.StatusEQ(status),
				emaillog.CreatedAtGTE(since),
			).
			Count(ctx)
	}
	var counts newsletter.EmailLogCounts
	var err error
	if counts.Sent, err = count(emailgateway.StatusSent); err != nil {
		return newsletter.EmailLogCounts{}, err
	}
	if counts.Failed, err = count(emailgateway.StatusFailed); err != nil {
		return newsletter.EmailLogCounts{}, err
	}
	return counts, nil
}

// GetSiteInfo returns the site name templates render.
func (s *Store) GetSiteInfo(ctx context.Context, siteID string) (newsletter.SiteInfo, error) {
	row, err := s.client.Site.Query().Where(site.IDEQ(siteID)).First(ctx)
	if err != nil {
		return newsletter.SiteInfo{}, mapNotFound(err)
	}
	info := newsletter.SiteInfo{ID: row.ID, Name: row.Name}
	if row.Domain != nil {
		info.Domain = *row.Domain
	}
	return info, nil
}

// -------------------------------------------------------------------------------
// Row mapping
// -------------------------------------------------------------------------------

func toSubscriber(row *entgen.Subscriber) newsletter.Subscriber {
	out := newsletter.Subscriber{
		ID:             row.ID,
		SiteID:         row.SiteID,
		Email:          row.Email,
		Status:         row.Status,
		Source:         row.Source,
		TokenHash:      row.TokenHash,
		ConfirmedAt:    row.ConfirmedAt,
		UnsubscribedAt: row.UnsubscribedAt,
		LastSentAt:     row.LastSentAt,
		CreatedAt:      row.CreatedAt,
	}
	if row.UserID != nil {
		out.UserID = *row.UserID
	}
	return out
}

func toEmailLog(row *entgen.EmailLog) newsletter.EmailLog {
	out := newsletter.EmailLog{
		ID:          row.ID,
		SiteID:      row.SiteID,
		ToEmail:     row.ToEmail,
		Kind:        row.Kind,
		TemplateKey: row.TemplateKey,
		Subject:     row.Subject,
		Status:      row.Status,
		SentAt:      row.SentAt,
		CreatedAt:   row.CreatedAt,
	}
	if row.Error != nil {
		out.Error = *row.Error
	}
	if row.ProviderMessageID != nil {
		out.ProviderMessageID = *row.ProviderMessageID
	}
	if row.SubscriberID != nil {
		out.SubscriberID = *row.SubscriberID
	}
	return out
}

func toEmailTemplate(row *entgen.EmailTemplate) newsletter.EmailTemplate {
	return newsletter.EmailTemplate{
		SiteID:    row.SiteID,
		Key:       row.Key,
		Name:      row.Name,
		Subject:   row.Subject,
		BodyHTML:  row.BodyHTML,
		BodyText:  row.BodyText,
		Enabled:   row.Enabled,
		Builtin:   false,
		UpdatedAt: &row.UpdatedAt,
	}
}

// normalizeKind keeps an unknown kind inside the generated validator's closed set.
func normalizeKind(kind string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case emailgateway.KindNewsletter:
		return emailgateway.KindNewsletter
	default:
		return emailgateway.KindSystem
	}
}

// normalizeStatus keeps an unknown delivery status inside the closed set.
func normalizeStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case emailgateway.StatusSent, emailgateway.StatusFailed, emailgateway.StatusSkipped:
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return emailgateway.StatusQueued
	}
}

// normalizeSubscriberStatus keeps an unknown state inside the closed set.
func normalizeSubscriberStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case newsletter.StatusConfirmed, newsletter.StatusUnsubscribed, newsletter.StatusBounced:
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return newsletter.StatusPending
	}
}

// normalizeSource bounds the free form source label.
func normalizeSource(source string) string {
	source = strings.ToLower(strings.TrimSpace(source))
	if source == "" {
		return newsletter.SourceSite
	}
	if len(source) > newsletter.MaxSourceLength {
		return source[:newsletter.MaxSourceLength]
	}
	return source
}

// nilIfEmpty turns an optional string into the pointer Ent's nillable setters take.
func nilIfEmpty(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

// truncate bounds a stored string.
func truncate(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return value[:max]
}

// mapNotFound translates the generated not found error into the module's sentinel.
func mapNotFound(err error) error {
	if entgen.IsNotFound(err) {
		return newsletter.ErrNotFound
	}
	return err
}
