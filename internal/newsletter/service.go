package newsletter

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/platform/emailgateway"
)

// ConfirmPath is the public confirmation endpoint rendered into the mail link.
const ConfirmPath = "/newsletter/confirm"

// UnsubscribePath is the public unsubscribe endpoint rendered into mail footers.
const UnsubscribePath = "/newsletter/unsubscribe"

// Service is the newsletter application service.
type Service struct {
	repo          Repository
	gateway       EmailGateway
	publicBaseURL string
	accountEmail  func(ctx context.Context, userID string) (string, error)
	digest        ContentDigest
	limiter       *Limiter
	now           func() time.Time
	logger        *slog.Logger
}

// ServiceConfig holds the injected dependencies of a Service.
type ServiceConfig struct {
	// Repository is the persistence port. It is required.
	Repository Repository
	// Gateway is the delivery port. Nil behaves like an unconfigured relay: every
	// attempt is recorded as skipped instead of crashing the module.
	Gateway EmailGateway
	// PublicBaseURL is the pinned origin used in mail links (PUBLIC_BASE_URL).
	// Empty means the HTTP layer's request origin is used, which keeps a desktop
	// install working without configuration.
	PublicBaseURL string
	// AccountEmail resolves the signed in account's address for /me/newsletter.
	// Nil makes the account endpoints report "no email".
	AccountEmail func(ctx context.Context, userID string) (string, error)
	// ContentDigest renders content backed newsletters. Nil rejects content ids.
	ContentDigest ContentDigest
	// Limiter is the public subscribe budget. Nil installs the contract default of
	// ten attempts per IP per hour.
	Limiter *Limiter
	// Now is the clock. Nil means time.Now().UTC.
	Now func() time.Time
	// Logger receives best effort delivery failures. Nil discards them.
	Logger *slog.Logger
}

// NewService builds a Service.
func NewService(cfg ServiceConfig) (*Service, error) {
	if cfg.Repository == nil {
		return nil, errors.New("newsletter: repository is required")
	}
	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	limiter := cfg.Limiter
	if limiter == nil {
		limiter = NewLimiter(SubscribeRateLimit, SubscribeRateWindow, now)
	}
	return &Service{
		repo:          cfg.Repository,
		gateway:       cfg.Gateway,
		publicBaseURL: strings.TrimRight(strings.TrimSpace(cfg.PublicBaseURL), "/"),
		accountEmail:  cfg.AccountEmail,
		digest:        cfg.ContentDigest,
		limiter:       limiter,
		now:           now,
		logger:        logger,
	}, nil
}

// SubscribeInput is one public subscription attempt.
type SubscribeInput struct {
	// Site is the host resolved site.
	Site SiteInfo
	// Email is the address as typed by the visitor.
	Email string
	// Source is the optional form label; empty becomes "site".
	Source string
	// RequestBase is the origin of the request, used when PublicBaseURL is empty.
	RequestBase string
	// IPHash is the hashed caller address for the rate limit. The plaintext address
	// is never passed into this package.
	IPHash string
}

// SubscribeResult is the public subscribe answer.
type SubscribeResult struct {
	// Status is pending or confirmed.
	Status string
}

// Subscribe starts the double opt in flow.
//
// A repeat call for a confirmed address is a no-op: it does not mail again and
// reports confirmed. A pending address is also left alone, which makes the endpoint
// idempotent under a double click. An unsubscribed address is reset to pending and
// receives a fresh confirmation mail, because that is the only way back onto the
// list.
func (s *Service) Subscribe(ctx context.Context, in SubscribeInput) (SubscribeResult, error) {
	email, err := NormalizeEmail(in.Email)
	if err != nil {
		return SubscribeResult{}, err
	}
	source, err := NormalizeSource(in.Source)
	if err != nil {
		return SubscribeResult{}, err
	}
	if !s.limiter.Allow(in.IPHash) {
		return SubscribeResult{}, ErrRateLimited
	}

	existing, err := s.repo.FindSubscriberByEmail(ctx, in.Site.ID, email)
	switch {
	case errors.Is(err, ErrNotFound):
		return s.createPending(ctx, in.Site, email, source, in.RequestBase, "")
	case err != nil:
		return SubscribeResult{}, err
	}

	switch existing.Status {
	case StatusConfirmed:
		return SubscribeResult{Status: StatusConfirmed}, nil
	case StatusPending:
		return SubscribeResult{Status: StatusPending}, nil
	default:
		// unsubscribed or bounced: restart the opt in.
		return s.restartPending(ctx, existing, in.Site, source, in.RequestBase, "")
	}
}

// createPending inserts a new pending subscriber and mails the confirmation link.
func (s *Service) createPending(
	ctx context.Context,
	site SiteInfo,
	email, source, requestBase, userID string,
) (SubscribeResult, error) {
	token, err := NewToken()
	if err != nil {
		return SubscribeResult{}, err
	}
	now := s.now()
	subscriber, err := s.repo.SaveSubscriber(ctx, Subscriber{
		SiteID:    site.ID,
		Email:     email,
		Status:    StatusPending,
		Source:    source,
		UserID:    userID,
		TokenHash: HashToken(token),
		CreatedAt: now,
	})
	if err != nil {
		return SubscribeResult{}, err
	}
	s.sendConfirmation(ctx, site, requestBase, subscriber, token)
	return SubscribeResult{Status: StatusPending}, nil
}

// restartPending resets an unsubscribed entry and mails a new confirmation link.
func (s *Service) restartPending(
	ctx context.Context,
	existing Subscriber,
	site SiteInfo,
	source, requestBase, userID string,
) (SubscribeResult, error) {
	token, err := NewToken()
	if err != nil {
		return SubscribeResult{}, err
	}
	existing.Status = StatusPending
	existing.Source = source
	if userID != "" {
		existing.UserID = userID
	}
	existing.ConfirmedAt = nil
	existing.UnsubscribedAt = nil
	existing.TokenHash = HashToken(token)
	subscriber, err := s.repo.SaveSubscriber(ctx, existing)
	if err != nil {
		return SubscribeResult{}, err
	}
	s.sendConfirmation(ctx, site, requestBase, subscriber, token)
	return SubscribeResult{Status: StatusPending}, nil
}

// sendConfirmation renders and sends the double opt in mail.
//
// A delivery failure is logged, never returned: the subscriber row exists and the
// failed attempt is visible in the mail log, so failing the HTTP request would only
// make the visitor retry and queue another address.
func (s *Service) sendConfirmation(
	ctx context.Context,
	site SiteInfo,
	requestBase string,
	subscriber Subscriber,
	token string,
) {
	base := s.linkBase(requestBase)
	vars := siteTemplateVars(site, base)
	vars[VarEmail] = subscriber.Email
	vars[VarConfirmURL] = s.tokenLink(base, ConfirmPath, token)
	vars[VarUnsubscribeURL] = s.tokenLink(base, UnsubscribePath, token)

	if err := s.sendTemplate(ctx, site.ID, KeySubscriberConfirm, subscriber.Email, subscriber.ID, vars); err != nil {
		s.logger.Warn("newsletter: confirmation mail failed",
			"site_id", site.ID, "subscriber_id", subscriber.ID, "error", err)
	}
}

// Confirm completes the double opt in.
//
// A confirmed subscriber is reported as confirmed again instead of failing: a mail
// client may prefetch the link, and a double click must not look like an error.
func (s *Service) Confirm(ctx context.Context, token string) (string, error) {
	subscriber, err := s.subscriberByToken(ctx, token)
	if err != nil {
		return "", err
	}
	switch subscriber.Status {
	case StatusConfirmed:
		return StatusConfirmed, nil
	case StatusUnsubscribed:
		// The address opted out after this link was mailed; confirming it again
		// would silently resubscribe someone who asked to leave.
		return "", ErrInvalidToken
	}
	now := s.now()
	subscriber.Status = StatusConfirmed
	subscriber.ConfirmedAt = &now
	subscriber.UnsubscribedAt = nil
	if _, err := s.repo.SaveSubscriber(ctx, subscriber); err != nil {
		return "", err
	}
	return StatusConfirmed, nil
}

// Unsubscribe removes the address from every future newsletter.
//
// The row is kept (not deleted) so the operator can see the opt out and so a stale
// link reports success instead of 404.
func (s *Service) Unsubscribe(ctx context.Context, token string) (string, error) {
	subscriber, err := s.subscriberByToken(ctx, token)
	if err != nil {
		return "", err
	}
	if subscriber.Status == StatusUnsubscribed {
		return StatusUnsubscribed, nil
	}
	now := s.now()
	subscriber.Status = StatusUnsubscribed
	subscriber.UnsubscribedAt = &now
	if _, err := s.repo.SaveSubscriber(ctx, subscriber); err != nil {
		return "", err
	}
	return StatusUnsubscribed, nil
}

// subscriberByToken resolves a token to its subscriber or reports it as invalid.
func (s *Service) subscriberByToken(ctx context.Context, token string) (Subscriber, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return Subscriber{}, ErrInvalidToken
	}
	subscriber, err := s.repo.FindSubscriberByTokenHash(ctx, HashToken(token))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Subscriber{}, ErrInvalidToken
		}
		return Subscriber{}, err
	}
	return subscriber, nil
}

// MyPreference returns the signed in account's newsletter state.
func (s *Service) MyPreference(ctx context.Context, siteID, userID string) (MyPreference, error) {
	email, err := s.accountAddress(ctx, userID)
	if err != nil {
		return MyPreference{}, err
	}
	if email == "" {
		return MyPreference{Subscribed: false}, nil
	}
	subscriber, err := s.repo.FindSubscriberByEmail(ctx, siteID, email)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return MyPreference{Subscribed: false, Email: email}, nil
		}
		return MyPreference{}, err
	}
	return MyPreference{
		Subscribed: subscriber.Status == StatusConfirmed,
		Email:      subscriber.Email,
		Status:     subscriber.Status,
	}, nil
}

// SetMyPreference subscribes or unsubscribes the signed in account's address.
//
// Subscribing still goes through the confirmation mail: owning a session on one site
// does not prove the mailbox belongs to the account holder, and the list is mailed to
// that mailbox.
func (s *Service) SetMyPreference(
	ctx context.Context,
	site SiteInfo,
	userID, requestBase string,
	enabled bool,
) (MyPreference, error) {
	email, err := s.accountAddress(ctx, userID)
	if err != nil {
		return MyPreference{}, err
	}
	if email == "" {
		return MyPreference{}, ErrAccountEmailMissing
	}

	existing, findErr := s.repo.FindSubscriberByEmail(ctx, site.ID, email)
	if findErr != nil && !errors.Is(findErr, ErrNotFound) {
		return MyPreference{}, findErr
	}

	if enabled {
		var result SubscribeResult
		switch {
		case errors.Is(findErr, ErrNotFound):
			result, err = s.createPending(ctx, site, email, SourceAccount, requestBase, userID)
		case existing.Status == StatusConfirmed:
			result = SubscribeResult{Status: StatusConfirmed}
		case existing.Status == StatusPending:
			result = SubscribeResult{Status: StatusPending}
		default:
			result, err = s.restartPending(ctx, existing, site, SourceAccount, requestBase, userID)
		}
		if err != nil {
			return MyPreference{}, err
		}
		return MyPreference{
			Subscribed: result.Status == StatusConfirmed,
			Email:      email,
			Status:     result.Status,
		}, nil
	}

	if errors.Is(findErr, ErrNotFound) {
		// Nothing to opt out of; report the honest state instead of creating a row.
		return MyPreference{Subscribed: false, Email: email}, nil
	}
	if existing.Status != StatusUnsubscribed {
		now := s.now()
		existing.Status = StatusUnsubscribed
		existing.UnsubscribedAt = &now
		if existing.UserID == "" {
			existing.UserID = userID
		}
		if _, err := s.repo.SaveSubscriber(ctx, existing); err != nil {
			return MyPreference{}, err
		}
	}
	return MyPreference{
		Subscribed: false,
		Email:      email,
		Status:     StatusUnsubscribed,
	}, nil
}

// accountAddress resolves and normalises the account's email identity.
func (s *Service) accountAddress(ctx context.Context, userID string) (string, error) {
	if s.accountEmail == nil || strings.TrimSpace(userID) == "" {
		return "", nil
	}
	raw, err := s.accountEmail(ctx, userID)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	normalized, err := NormalizeEmail(raw)
	if err != nil {
		return "", nil
	}
	return normalized, nil
}

// resolveTemplate returns the site override when it is enabled, otherwise the
// shipped default.
func (s *Service) resolveTemplate(ctx context.Context, siteID, key string) (EmailTemplate, error) {
	override, ok, err := s.repo.GetEmailTemplate(ctx, siteID, key)
	if err != nil {
		return EmailTemplate{}, err
	}
	if ok && override.Enabled {
		override.Builtin = false
		return override, nil
	}
	if builtin, ok := BuiltinTemplate(key); ok {
		return builtin, nil
	}
	return EmailTemplate{}, ErrTemplateNotFound
}

// sendTemplate renders one template and hands it to the gateway.
func (s *Service) sendTemplate(
	ctx context.Context,
	siteID, key, to, subscriberID string,
	vars map[string]string,
) error {
	if s.gateway == nil {
		return nil
	}
	template, err := s.resolveTemplate(ctx, siteID, key)
	if err != nil {
		return err
	}
	subject, bodyHTML, bodyText := RenderTemplate(template, vars)
	return s.gateway.Send(ctx, emailgateway.Request{
		SiteID:       siteID,
		Kind:         emailgateway.KindSystem,
		TemplateKey:  template.Key,
		To:           to,
		Subject:      subject,
		HTML:         bodyHTML,
		Text:         bodyText,
		SubscriberID: subscriberID,
	})
}

// linkBase resolves the origin used in mail links.
func (s *Service) linkBase(requestBase string) string {
	if s.publicBaseURL != "" {
		return s.publicBaseURL
	}
	return strings.TrimRight(strings.TrimSpace(requestBase), "/")
}

// siteOrigin resolves the origin the background sender uses.
//
// A queued delivery has no request to inherit a Host from, so it falls back to the
// site's verified domain. A site without a domain (a fresh install) and without
// PUBLIC_BASE_URL yields a relative link, which the mailer still sends; the operator
// gets a working absolute link once PUBLIC_BASE_URL is set, which the configuration
// already requires whenever SMTP is configured outside desktop mode.
func (s *Service) siteOrigin(site SiteInfo) string {
	if s.publicBaseURL != "" {
		return s.publicBaseURL
	}
	domain := strings.TrimSpace(site.Domain)
	if domain == "" {
		return ""
	}
	return "https://" + strings.TrimSuffix(domain, "/")
}

// tokenLink builds an absolute link, or a relative one when the deployment has no
// known origin (a desktop install without PUBLIC_BASE_URL).
func (s *Service) tokenLink(base, path, token string) string {
	query := url.Values{"token": {token}}.Encode()
	if base == "" {
		return path + "?" + query
	}
	return base + path + "?" + query
}

// siteTemplateVars returns the variables every template can use.
func siteTemplateVars(site SiteInfo, base string) map[string]string {
	return map[string]string{
		VarSiteName: site.Name,
		VarSiteURL:  base,
		VarYear:     time.Now().UTC().Format("2006"),
	}
}

// pageSize clamps a requested page size to the documented range.
func pageSize(limit int) int {
	switch {
	case limit <= 0:
		return DefaultPageSize
	case limit > MaxPageSize:
		return MaxPageSize
	default:
		return limit
	}
}
