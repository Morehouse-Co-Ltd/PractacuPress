package newsletter

import (
	"context"
	"errors"
	"html"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/platform/emailgateway"
	"github.com/practacu/practacu-press/apps/api/internal/platform/page"
)

// SubscriberPage is one page of the admin subscriber list.
type SubscriberPage struct {
	Items      []Subscriber
	NextCursor string
	HasMore    bool
}

// EmailLogPage is one page of the admin mail log.
type EmailLogPage struct {
	Items      []EmailLog
	NextCursor string
	HasMore    bool
}

// EmailTemplateInput is one template override write.
type EmailTemplateInput struct {
	Name     string
	Subject  string
	BodyHTML string
	BodyText string
	// Enabled is nil when the client omitted it, which defaults to true.
	Enabled *bool
}

// SendNewsletterInput is one campaign queued by an operator.
type SendNewsletterInput struct {
	// Site is the site the campaign belongs to.
	Site SiteInfo
	// Subject is the mail subject, required.
	Subject string
	// BodyHTML and BodyText are the operator's own copy. They are appended after the
	// content block, which is what makes a content linked campaign read naturally.
	BodyHTML string
	BodyText string
	// ContentID, when set, renders that item's title, summary and link into the body.
	ContentID string
	// RequestBase is the origin of the request, used when PublicBaseURL is empty.
	RequestBase string
}

// SendNewsletterResult reports how many deliveries were queued.
type SendNewsletterResult struct {
	Queued int
}

// MaxLogBatch bounds one InsertEmailLogs call so a huge list does not build one
// enormous statement.
const MaxLogBatch = 100

// ListSubscribers returns one page of the admin subscriber list.
func (s *Service) ListSubscribers(
	ctx context.Context,
	siteID string,
	filter SubscriberFilter,
	limit int,
	after page.Cursor,
) (SubscriberPage, error) {
	filter.Status = strings.ToLower(strings.TrimSpace(filter.Status))
	if filter.Status != "" && !validStatus(filter.Status) {
		return SubscriberPage{}, ErrInvalidFilter
	}
	filter.Query = strings.TrimSpace(filter.Query)
	if len(filter.Query) > MaxEmailLength {
		filter.Query = filter.Query[:MaxEmailLength]
	}

	items, next, err := s.repo.ListSubscribers(ctx, siteID, filter, pageSize(limit), after)
	if err != nil {
		return SubscriberPage{}, err
	}
	return SubscriberPage{Items: items, NextCursor: next, HasMore: next != ""}, nil
}

// DeleteSubscriber removes one list entry.
func (s *Service) DeleteSubscriber(ctx context.Context, siteID, subscriberID string) error {
	if strings.TrimSpace(subscriberID) == "" {
		return ErrNotFound
	}
	if err := s.repo.DeleteSubscriber(ctx, siteID, subscriberID); err != nil {
		if errors.Is(err, ErrNotFound) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

// Stats returns the dashboard counts.
func (s *Service) Stats(ctx context.Context, siteID string) (Stats, error) {
	counts, err := s.repo.CountSubscribers(ctx, siteID)
	if err != nil {
		return Stats{}, err
	}
	since := s.now().Add(-7 * 24 * time.Hour)
	deliveries, err := s.repo.CountEmailLogsSince(ctx, siteID, since)
	if err != nil {
		return Stats{}, err
	}
	return Stats{
		Confirmed:    counts.Confirmed,
		Pending:      counts.Pending,
		Unsubscribed: counts.Unsubscribed,
		Sent7d:       deliveries.Sent,
		Failed7d:     deliveries.Failed,
	}, nil
}

// ListTemplates merges the shipped defaults with the site's overrides.
//
// The editor always receives a complete list: an override replaces the default in
// place, and keys that only exist as overrides are appended after the shipped set so
// a custom template is editable too. Campaign bodies are internal and never listed.
func (s *Service) ListTemplates(ctx context.Context, siteID string) ([]EmailTemplate, error) {
	overrides, err := s.repo.ListEmailTemplates(ctx, siteID)
	if err != nil {
		return nil, err
	}
	byKey := make(map[string]EmailTemplate, len(overrides))
	extra := make([]EmailTemplate, 0, len(overrides))
	for _, override := range overrides {
		if IsCampaignTemplateKey(override.Key) {
			continue
		}
		override.Builtin = false
		byKey[override.Key] = override
		if !IsBuiltinTemplateKey(override.Key) {
			extra = append(extra, override)
		}
	}

	items := make([]EmailTemplate, 0, len(builtinTemplates)+len(extra))
	for _, builtin := range BuiltinTemplates() {
		if override, ok := byKey[builtin.Key]; ok {
			items = append(items, override)
			continue
		}
		items = append(items, builtin)
	}
	items = append(items, extra...)
	return items, nil
}

// SaveTemplate stores one override.
func (s *Service) SaveTemplate(
	ctx context.Context,
	siteID, key string,
	in EmailTemplateInput,
) (EmailTemplate, error) {
	key = normalizeTemplateKey(key)
	if !validTemplateKey(key) {
		return EmailTemplate{}, ErrInvalidTemplate
	}
	subject := strings.TrimSpace(in.Subject)
	if subject == "" || len(subject) > MaxSubjectLength {
		return EmailTemplate{}, ErrInvalidTemplate
	}
	name := strings.TrimSpace(in.Name)
	if len(name) > MaxTemplateNameLength {
		return EmailTemplate{}, ErrInvalidTemplate
	}
	if name == "" {
		name = defaultTemplateName(key)
	}
	if len(in.BodyHTML)+len(in.BodyText) == 0 || len(in.BodyHTML) > MaxTemplateBodyBytes || len(in.BodyText) > MaxTemplateBodyBytes {
		return EmailTemplate{}, ErrInvalidTemplate
	}
	enabled := true
	if in.Enabled != nil {
		enabled = *in.Enabled
	}

	return s.repo.SaveEmailTemplate(ctx, EmailTemplate{
		SiteID:   siteID,
		Key:      key,
		Name:     name,
		Subject:  subject,
		BodyHTML: in.BodyHTML,
		BodyText: in.BodyText,
		Enabled:  enabled,
		Builtin:  false,
	})
}

// ResetTemplate drops an override so the shipped default is used again.
//
// Dropping an override that does not exist is a no-op for a shipped key (it already
// is the default) and a not found for an unknown key.
func (s *Service) ResetTemplate(ctx context.Context, siteID, key string) error {
	key = normalizeTemplateKey(key)
	if !validTemplateKey(key) {
		return ErrTemplateNotFound
	}
	err := s.repo.DeleteEmailTemplate(ctx, siteID, key)
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrNotFound) {
		if IsBuiltinTemplateKey(key) {
			return nil
		}
		return ErrTemplateNotFound
	}
	return err
}

// ListEmailLogs returns one page of the admin mail log.
func (s *Service) ListEmailLogs(
	ctx context.Context,
	siteID string,
	filter EmailLogFilter,
	limit int,
	after page.Cursor,
) (EmailLogPage, error) {
	filter.Status = strings.ToLower(strings.TrimSpace(filter.Status))
	if filter.Status != "" && !validEmailStatus(filter.Status) {
		return EmailLogPage{}, ErrInvalidFilter
	}
	filter.Kind = strings.ToLower(strings.TrimSpace(filter.Kind))
	if filter.Kind != "" && filter.Kind != emailgateway.KindSystem && filter.Kind != emailgateway.KindNewsletter {
		return EmailLogPage{}, ErrInvalidFilter
	}
	items, next, err := s.repo.ListEmailLogs(ctx, siteID, filter, pageSize(limit), after)
	if err != nil {
		return EmailLogPage{}, err
	}
	return EmailLogPage{Items: items, NextCursor: next, HasMore: next != ""}, nil
}

// SendNewsletter queues one delivery per confirmed subscriber and returns at once.
//
// The body is persisted as a transient campaign override, because email_logs stores
// only the subject and the template key (a body can contain a one off token and must
// not be kept forever). The background sender later renders that stored body per
// subscriber, which is what makes the queue survive a restart.
func (s *Service) SendNewsletter(ctx context.Context, in SendNewsletterInput) (SendNewsletterResult, error) {
	subject := strings.TrimSpace(in.Subject)
	if subject == "" || len(subject) > MaxSubjectLength {
		return SendNewsletterResult{}, ErrInvalidTemplate
	}
	if len(in.BodyHTML) > MaxTemplateBodyBytes || len(in.BodyText) > MaxTemplateBodyBytes {
		return SendNewsletterResult{}, ErrInvalidTemplate
	}

	recipients, err := s.repo.ListConfirmedSubscribers(ctx, in.Site.ID)
	if err != nil {
		return SendNewsletterResult{}, err
	}
	if len(recipients) == 0 {
		return SendNewsletterResult{Queued: 0}, nil
	}

	base := s.linkBase(in.RequestBase)
	renderedSubject, bodyHTML, bodyText, err := s.composeCampaign(ctx, in, base)
	if err != nil {
		return SendNewsletterResult{}, err
	}

	campaignID, err := NewToken()
	if err != nil {
		return SendNewsletterResult{}, err
	}
	key := CampaignTemplateKey(campaignID)

	if !s.gatewayConfigured() {
		// Nothing is delivered, but the operator still needs to see why: record one
		// skipped row per recipient instead of leaving an invisible queue behind.
		entries := make([]EmailLog, 0, len(recipients))
		now := s.now()
		for _, subscriber := range recipients {
			entries = append(entries, EmailLog{
				SiteID:       in.Site.ID,
				ToEmail:      subscriber.Email,
				Kind:         emailgateway.KindNewsletter,
				TemplateKey:  KeyNewsletterPost,
				Subject:      renderedSubject,
				Status:       emailgateway.StatusSkipped,
				SubscriberID: subscriber.ID,
				CreatedAt:    now,
			})
		}
		if err := s.insertEmailLogs(ctx, entries); err != nil {
			return SendNewsletterResult{}, err
		}
		return SendNewsletterResult{Queued: 0}, nil
	}

	// Persist the body before the queue rows: a crash between the two leaves an
	// unused template, while the reverse would leave deliveries that can never be
	// rendered.
	if _, err := s.repo.SaveEmailTemplate(ctx, EmailTemplate{
		SiteID:   in.Site.ID,
		Key:      key,
		Name:     "Newsletter",
		Subject:  renderedSubject,
		BodyHTML: bodyHTML,
		BodyText: bodyText,
		Enabled:  true,
	}); err != nil {
		return SendNewsletterResult{}, err
	}

	now := s.now()
	entries := make([]EmailLog, 0, len(recipients))
	for _, subscriber := range recipients {
		entries = append(entries, EmailLog{
			SiteID:       in.Site.ID,
			ToEmail:      subscriber.Email,
			Kind:         emailgateway.KindNewsletter,
			TemplateKey:  key,
			Subject:      renderedSubject,
			Status:       emailgateway.StatusQueued,
			SubscriberID: subscriber.ID,
			CreatedAt:    now,
		})
	}
	if err := s.insertEmailLogs(ctx, entries); err != nil {
		// The campaign body would otherwise linger as an override no queue references.
		if _, cleanupErr := s.repo.DeleteEmailTemplateIfUnqueued(ctx, in.Site.ID, key); cleanupErr != nil {
			s.logger.Warn("newsletter: drop orphan campaign template", "site_id", in.Site.ID, "key", key, "error", cleanupErr)
		}
		return SendNewsletterResult{}, err
	}
	return SendNewsletterResult{Queued: len(entries)}, nil
}

// composeCampaign builds the stored campaign body.
func (s *Service) composeCampaign(
	ctx context.Context,
	in SendNewsletterInput,
	base string,
) (subject, bodyHTML, bodyText string, err error) {
	vars := siteTemplateVars(in.Site, base)
	htmlParts := make([]string, 0, 3)
	textParts := make([]string, 0, 3)

	contentID := strings.TrimSpace(in.ContentID)
	if contentID != "" {
		contentHTML, contentText, contentVars, digestErr := s.contentBlock(ctx, in.Site, base, contentID)
		if digestErr != nil {
			return "", "", "", digestErr
		}
		for key, value := range contentVars {
			vars[key] = value
		}
		htmlParts = append(htmlParts, contentHTML)
		textParts = append(textParts, contentText)
	}

	if body := strings.TrimSpace(in.BodyHTML); body != "" {
		htmlParts = append(htmlParts, body)
	}
	if body := strings.TrimSpace(in.BodyText); body != "" {
		textParts = append(textParts, body)
	}
	if len(htmlParts) == 0 && len(textParts) == 0 {
		// No content link and no copy: fall back to the editable newsletter template
		// with a neutral announcement so the mail is never empty.
		vars[VarContentTitle] = in.Site.Name
		vars[VarContentSummary] = "这里有新的内容更新。"
		vars[VarContentURL] = base
		template, templateErr := s.resolveTemplate(ctx, in.Site.ID, KeyNewsletterPost)
		if templateErr != nil {
			return "", "", "", templateErr
		}
		_, renderedHTML, renderedText := RenderTemplate(template, vars)
		htmlParts = append(htmlParts, renderedHTML)
		textParts = append(textParts, renderedText)
	}

	combinedHTML, combinedText := WrapCampaignFooter(strings.Join(htmlParts, "\n"), strings.Join(textParts, "\n"))
	if len(combinedHTML) > MaxTemplateBodyBytes || len(combinedText) > MaxTemplateBodyBytes {
		return "", "", "", ErrInvalidTemplate
	}
	subject = strings.TrimSpace(Render(in.Subject, vars, false))
	if subject == "" {
		subject = strings.TrimSpace(in.Site.Name + " 的更新")
	}
	return subject, combinedHTML, combinedText, nil
}

// contentBlock renders one content item into the campaign body.
func (s *Service) contentBlock(
	ctx context.Context,
	site SiteInfo,
	base, contentID string,
) (htmlBlock, textBlock string, vars map[string]string, err error) {
	if s.digest == nil {
		return "", "", nil, ErrContentNotFound
	}
	title, summary, contentURL, ok, err := s.digest.Digest(ctx, site.ID, contentID)
	if err != nil {
		return "", "", nil, err
	}
	if !ok {
		return "", "", nil, ErrContentNotFound
	}
	title = strings.TrimSpace(title)
	summary = strings.TrimSpace(summary)
	contentURL = strings.TrimSpace(contentURL)
	if strings.HasPrefix(contentURL, "/") && base != "" {
		contentURL = base + contentURL
	}

	vars = map[string]string{
		VarContentTitle:   title,
		VarContentSummary: summary,
		VarContentURL:     contentURL,
	}

	var markup strings.Builder
	markup.WriteString(`<h1 style="margin:0 0 16px;font-size:22px;font-weight:600">`)
	markup.WriteString(html.EscapeString(title))
	markup.WriteString(`</h1>`)
	if summary != "" {
		markup.WriteString(`<p style="margin:0 0 18px;font-size:14px;line-height:1.75;color:#4a4a45">`)
		markup.WriteString(html.EscapeString(summary))
		markup.WriteString(`</p>`)
	}
	if contentURL != "" {
		markup.WriteString(`<p style="margin:0 0 20px"><a href="`)
		markup.WriteString(html.EscapeString(contentURL))
		markup.WriteString(`" style="display:inline-block;background:#1c1c1a;color:#ffffff;text-decoration:none;font-size:14px;padding:12px 22px;border-radius:999px">阅读全文</a></p>`)
	}

	var text strings.Builder
	text.WriteString(title)
	text.WriteString("\n")
	if summary != "" {
		text.WriteString("\n")
		text.WriteString(summary)
		text.WriteString("\n")
	}
	if contentURL != "" {
		text.WriteString("\n阅读全文：")
		text.WriteString(contentURL)
		text.WriteString("\n")
	}
	return markup.String(), text.String(), vars, nil
}

// insertEmailLogs writes queued rows in bounded batches.
func (s *Service) insertEmailLogs(ctx context.Context, entries []EmailLog) error {
	for start := 0; start < len(entries); start += MaxLogBatch {
		end := start + MaxLogBatch
		if end > len(entries) {
			end = len(entries)
		}
		if err := s.repo.InsertEmailLogs(ctx, entries[start:end]); err != nil {
			return err
		}
	}
	return nil
}

// gatewayConfigured reports whether a relay exists.
func (s *Service) gatewayConfigured() bool {
	return s.gateway != nil && s.gateway.Configured()
}

// validStatus reports whether value is a subscriber status.
func validStatus(value string) bool {
	switch value {
	case StatusPending, StatusConfirmed, StatusUnsubscribed, StatusBounced:
		return true
	default:
		return false
	}
}

// validEmailStatus reports whether value is a delivery status.
func validEmailStatus(value string) bool {
	switch value {
	case emailgateway.StatusQueued, emailgateway.StatusSent, emailgateway.StatusFailed, emailgateway.StatusSkipped:
		return true
	default:
		return false
	}
}

// normalizeTemplateKey canonicalises a template key.
func normalizeTemplateKey(key string) string {
	return strings.ToLower(strings.TrimSpace(key))
}

// validTemplateKey accepts a short stable identifier.
//
// The internal campaign namespace is rejected on purpose: those rows are written by
// the sender, and a client must not be able to edit the body of a queued campaign.
func validTemplateKey(key string) bool {
	if key == "" || len(key) > 80 || IsCampaignTemplateKey(key) {
		return false
	}
	for index, char := range key {
		switch {
		case char >= 'a' && char <= 'z':
		case char >= '0' && char <= '9':
		case index > 0 && (char == '_' || char == '-' || char == '.'):
		default:
			return false
		}
	}
	return true
}

// defaultTemplateName keeps the editor readable when the client omits a name.
func defaultTemplateName(key string) string {
	if builtin, ok := BuiltinTemplate(key); ok {
		return builtin.Name
	}
	return key
}
