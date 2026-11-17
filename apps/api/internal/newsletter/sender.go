package newsletter

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/platform/emailgateway"
	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
)

// Queue sender defaults. They are contract values: one batch every ten seconds of at
// most fifty deliveries, with three attempts per message before it is parked as
// failed.
const (
	// DefaultSendInterval is how often the background sender drains the queue.
	DefaultSendInterval = 10 * time.Second
	// DefaultSendBatch is the batch size of one drain.
	DefaultSendBatch = 50
	// DefaultMaxAttempts is the total number of tries per queued delivery.
	DefaultMaxAttempts = 3
)

// SenderConfig configures the background queue sender.
type SenderConfig struct {
	// Interval is the drain period. Nil means DefaultSendInterval.
	Interval time.Duration
	// BatchSize is the maximum rows one drain reads. Nil means DefaultSendBatch.
	BatchSize int
	// MaxAttempts is the total tries per delivery. Nil means DefaultMaxAttempts.
	MaxAttempts int
	// Logger receives per-drain summaries. Nil discards them.
	Logger *slog.Logger
}

// DeliveryReport summarises one drain.
type DeliveryReport struct {
	// Delivered counts rows the relay accepted.
	Delivered int
	// Skipped counts rows that were not sent (subscriber left, relay missing).
	Skipped int
	// Retried counts failed rows that were put back into the queue.
	Retried int
	// Failed counts rows that exhausted their attempts.
	Failed int
}

// Sender drains the queued newsletter deliveries.
//
// It lives in the same process as the HTTP service, so the composition root starts it
// with a goroutine and stops it by cancelling the context. Running it in one
// goroutine is enough: the queue is a FIFO and a single installation sends far fewer
// messages than one SMTP connection can handle.
type Sender struct {
	service     *Service
	interval    time.Duration
	batchSize   int
	maxAttempts int
	logger      *slog.Logger
}

// NewSender builds a queue sender over a Service.
func NewSender(service *Service, cfg SenderConfig) *Sender {
	interval := cfg.Interval
	if interval <= 0 {
		interval = DefaultSendInterval
	}
	batch := cfg.BatchSize
	if batch <= 0 {
		batch = DefaultSendBatch
	}
	attempts := cfg.MaxAttempts
	if attempts <= 0 {
		attempts = DefaultMaxAttempts
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Sender{
		service:     service,
		interval:    interval,
		batchSize:   batch,
		maxAttempts: attempts,
		logger:      logger,
	}
}

// Start drains the queue forever, once immediately and then every interval.
//
// It blocks until ctx is cancelled, so main runs it in a goroutine:
//
//	go sender.Start(startupCtx)
func (s *Sender) Start(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	s.drain(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.drain(ctx)
		}
	}
}

// drain runs one batch and logs the outcome without ever surfacing a fatal error:
// the sender is a loop, and one bad batch must not stop every future mail.
func (s *Sender) drain(ctx context.Context) {
	report, err := s.RunOnce(ctx)
	if err != nil {
		s.logger.Warn("newsletter: queue drain failed", "error", err)
	}
	if report.Delivered > 0 || report.Retried > 0 || report.Failed > 0 || report.Skipped > 0 {
		s.logger.Info("newsletter: queue drain",
			"delivered", report.Delivered,
			"skipped", report.Skipped,
			"retried", report.Retried,
			"failed", report.Failed,
		)
	}
}

// RunOnce processes one batch. It is exported so tests (and an operator triggered
// drain) can drive the queue deterministically.
func (s *Sender) RunOnce(ctx context.Context) (DeliveryReport, error) {
	if s.service == nil {
		return DeliveryReport{}, errors.New("newsletter: sender has no service")
	}
	rows, err := s.service.repo.ListQueuedNewsletterLogs(ctx, s.batchSize)
	if err != nil {
		return DeliveryReport{}, err
	}

	var report DeliveryReport
	touched := make(map[[2]string]struct{})
	for _, row := range rows {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		touched[[2]string{row.SiteID, row.TemplateKey}] = struct{}{}
		outcome, err := s.deliverOne(ctx, row)
		if err != nil {
			return report, err
		}
		switch outcome {
		case emailgateway.OutcomeSent:
			report.Delivered++
		case emailgateway.OutcomeSkipped:
			report.Skipped++
		case outcomeRequeued:
			report.Retried++
		default:
			report.Failed++
		}
	}

	// A campaign body is only needed while at least one delivery still references it.
	for pair := range touched {
		if _, err := s.service.repo.DeleteEmailTemplateIfUnqueued(ctx, pair[0], pair[1]); err != nil {
			s.logger.Warn("newsletter: drop campaign template", "site_id", pair[0], "key", pair[1], "error", err)
		}
	}
	return report, nil
}

// outcomeRequeued is the internal outcome when a failure was put back in the queue.
// It is not one of the gateway outcomes: the row goes from failed back to queued, so
// the caller cannot treat it as terminal.
const outcomeRequeued emailgateway.Outcome = "requeued"

// deliverOne renders and sends one queued row.
func (s *Sender) deliverOne(ctx context.Context, row EmailLog) (emailgateway.Outcome, error) {
	service := s.service

	subscriber, err := service.repo.FindSubscriberByID(ctx, row.SiteID, row.SubscriberID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return s.skip(ctx, row, "subscriber removed")
		}
		return emailgateway.OutcomeFailed, err
	}
	if subscriber.Status != StatusConfirmed {
		// The address left between queueing and sending; mailing it would break the
		// opt out.
		return s.skip(ctx, row, "subscriber is not confirmed")
	}
	if !service.gatewayConfigured() {
		// A queue row can only exist when a relay was configured at queue time; if it
		// was removed since, record the honest skipped state instead of retrying.
		return s.skip(ctx, row, "smtp relay is not configured")
	}

	template, ok, err := service.repo.GetEmailTemplate(ctx, row.SiteID, row.TemplateKey)
	if err != nil {
		return emailgateway.OutcomeFailed, err
	}
	if !ok {
		// The body is gone (it is deployment state, not queue state). Retrying cannot
		// fix that, so park the row instead of burning the attempts.
		return s.finalFailure(ctx, row, "campaign body is missing")
	}

	site, err := service.repo.GetSiteInfo(ctx, row.SiteID)
	if err != nil {
		return emailgateway.OutcomeFailed, err
	}

	// Every mail carries its own unsubscribe link, which means a fresh token: the
	// plaintext token exists only in this message, and the previous link keeps
	// working until it is rotated. Rotation is what lets the hash-only storage rule
	// hold for a link that must be generated long after the subscription.
	token, err := NewToken()
	if err != nil {
		return emailgateway.OutcomeFailed, err
	}
	subscriber.TokenHash = HashToken(token)
	if _, err := service.repo.SaveSubscriber(ctx, subscriber); err != nil {
		return emailgateway.OutcomeFailed, err
	}

	base := service.siteOrigin(site)
	vars := siteTemplateVars(site, base)
	vars[VarEmail] = subscriber.Email
	vars[VarUnsubscribeURL] = service.tokenLink(base, UnsubscribePath, token)

	subject, bodyHTML, bodyText := RenderTemplate(template, vars)
	if strings.TrimSpace(subject) == "" {
		subject = row.Subject
	}

	outcome, sendErr := service.gateway.Deliver(ctx, row.ID, mailer.Message{
		To:      []string{row.ToEmail},
		Subject: subject,
		HTML:    bodyHTML,
		Text:    bodyText,
	})
	switch outcome {
	case emailgateway.OutcomeSent:
		if sendErr != nil {
			// The relay accepted the message; a bookkeeping failure is worth a log
			// but must never trigger a resend (the subscriber would get two mails).
			s.logger.Warn("newsletter: record sent delivery", "log_id", row.ID, "error", sendErr)
		}
		if err := service.repo.UpdateSubscriberLastSent(ctx, subscriber.ID, service.now()); err != nil {
			s.logger.Warn("newsletter: stamp last sent", "subscriber_id", subscriber.ID, "error", err)
		}
		return emailgateway.OutcomeSent, nil
	case emailgateway.OutcomeSkipped:
		return emailgateway.OutcomeSkipped, nil
	default:
		return s.retryOrFail(ctx, row, sendErr)
	}
}

// retryOrFail applies the attempt budget after a failed delivery.
func (s *Sender) retryOrFail(ctx context.Context, row EmailLog, sendErr error) (emailgateway.Outcome, error) {
	attempts := attemptCount(row.Error) + 1
	reason := fmt.Sprintf("attempt %d/%d: %v", attempts, s.maxAttempts, sendErr)
	if len(reason) > emailgateway.MaxErrorLength {
		reason = reason[:emailgateway.MaxErrorLength]
	}
	if attempts >= s.maxAttempts {
		if err := s.service.repo.FinalizeEmailLogFailure(ctx, row.ID, reason, s.service.now()); err != nil {
			return emailgateway.OutcomeFailed, err
		}
		s.logger.Warn("newsletter: delivery failed permanently", "log_id", row.ID, "error", reason)
		return emailgateway.OutcomeFailed, nil
	}
	if err := s.service.repo.RequeueEmailLog(ctx, row.ID, reason); err != nil {
		return emailgateway.OutcomeFailed, err
	}
	return outcomeRequeued, nil
}

// skip records a row that must not be delivered.
func (s *Sender) skip(ctx context.Context, row EmailLog, reason string) (emailgateway.Outcome, error) {
	if err := s.service.repo.MarkEmailLogSkipped(ctx, row.ID, s.service.now()); err != nil {
		return emailgateway.OutcomeSkipped, err
	}
	s.logger.Info("newsletter: skipped delivery", "log_id", row.ID, "reason", reason)
	return emailgateway.OutcomeSkipped, nil
}

// finalFailure parks a row that cannot succeed by retrying.
func (s *Sender) finalFailure(ctx context.Context, row EmailLog, reason string) (emailgateway.Outcome, error) {
	if err := s.service.repo.FinalizeEmailLogFailure(ctx, row.ID, reason, s.service.now()); err != nil {
		return emailgateway.OutcomeFailed, err
	}
	s.logger.Warn("newsletter: delivery parked", "log_id", row.ID, "reason", reason)
	return emailgateway.OutcomeFailed, nil
}

// attemptCount parses the attempt marker the sender writes into email_logs.error.
//
// email_logs has no attempts column, so the marker is how the retry budget survives
// a restart: an empty error means "never tried".
func attemptCount(reason string) int {
	const prefix = "attempt "
	if !strings.HasPrefix(reason, prefix) {
		return 0
	}
	rest := strings.TrimPrefix(reason, prefix)
	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		return 0
	}
	value, err := strconv.Atoi(rest[:slash])
	if err != nil || value < 0 {
		return 0
	}
	return value
}
