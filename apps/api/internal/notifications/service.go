package notifications

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
)

// Repository is the persistence contract for notifications.
type Repository interface {
	Insert(ctx context.Context, item Notification) (Notification, error)
	List(ctx context.Context, siteID, userID string, limit int) ([]Notification, error)
	Find(ctx context.Context, siteID, userID, notificationID string) (Notification, error)
	MarkRead(ctx context.Context, notificationID string, at time.Time) error
	MarkAllRead(ctx context.Context, siteID, userID string, at time.Time) (int, error)
}

// Actor is the caller.
type Actor struct {
	UserID string
	SiteID string
}

// Bounds.
const (
	// DefaultInboxLimit is the inbox page size.
	DefaultInboxLimit = 30
	// MaxInboxLimit caps the page size.
	MaxInboxLimit = 100
	// emailTimeout bounds one background delivery attempt.
	emailTimeout = 25 * time.Second
)

// LiveEvent is one best-effort push to a live subscriber.
//
// The transport shape lives in the composition root: this package only says what
// happened, so it does not import the WebSocket package.
//
// It deliberately has no replay id. Notification pushes are not outbox rows, so
// feeding their id to the browser as a resume cursor would move the cursor past
// outbox events that were created earlier but published later. The inbox read is the
// authoritative recovery path; the push only wakes the badge.
type LiveEvent struct {
	Type           string
	SiteID         string
	AudienceUserID string
	OccurredAt     time.Time
	Payload        map[string]any
}

// Publisher forwards a created notification to live subscribers.
//
// It is optional: a deployment without a WebSocket transport (tests, single-process
// CLI use) simply does not wire it, and the inbox read stays authoritative.
type Publisher interface {
	Publish(ctx context.Context, event LiveEvent)
}

// ServiceOption customises a Service without breaking existing callers.
type ServiceOption func(*Service)

// WithPublisher installs the live push adapter used by Notify.
func WithPublisher(publisher Publisher) ServiceOption {
	return func(s *Service) {
		if publisher != nil {
			s.publisher = publisher
		}
	}
}

// WithMailer installs the SMTP sender used for notification email.
//
// A nil sender means email is not configured: produced notifications stay in the
// inbox and the email path is skipped without an error.
func WithMailer(sender mailer.Sender) ServiceOption {
	return func(s *Service) { s.mailer = sender }
}

// WithEmailLookup installs the address resolver used for notification email.
func WithEmailLookup(lookup EmailLookup) ServiceOption {
	return func(s *Service) {
		if lookup != nil {
			s.emails = lookup
		}
	}
}

// WithProfileLookup installs the display name resolver used to fill actor_name.
func WithProfileLookup(lookup ProfileLookup) ServiceOption {
	return func(s *Service) {
		if lookup != nil {
			s.profiles = lookup
		}
	}
}

// WithBaseURL sets the absolute origin used for links inside notification email.
func WithBaseURL(baseURL string) ServiceOption {
	return func(s *Service) { s.baseURL = baseURL }
}

// WithLogger installs the logger used for best-effort email failures.
func WithLogger(logger *slog.Logger) ServiceOption {
	return func(s *Service) {
		if logger != nil {
			s.logger = logger
		}
	}
}

// WithSynchronousEmail sends email inline instead of on a background goroutine.
//
// Production always sends in the background: a slow relay must not hold a request
// open. Tests use this option to observe the mail without waiting for a goroutine.
func WithSynchronousEmail() ServiceOption {
	return func(s *Service) { s.syncEmail = true }
}

// Service implements the notification use cases.
type Service struct {
	repo      Repository
	publisher Publisher
	now       func() time.Time

	mailer   mailer.Sender
	emails   EmailLookup
	profiles ProfileLookup
	baseURL  string
	logger   *slog.Logger
	// syncEmail is false in production; see WithSynchronousEmail.
	syncEmail bool
}

// NewService builds a Service.
func NewService(repo Repository, options ...ServiceOption) (*Service, error) {
	if repo == nil {
		return nil, errors.New("notifications: repository is required")
	}
	service := &Service{
		repo: repo,
		now:  func() time.Time { return time.Now().UTC() },
	}
	// The store that persists notifications also knows the user table, so the
	// server usually passes one object for all of these. The type assertions keep
	// older fakes working.
	if lookup, ok := repo.(ProfileLookup); ok {
		service.profiles = lookup
	}
	if lookup, ok := repo.(EmailLookup); ok {
		service.emails = lookup
	}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service, nil
}

// Notify creates a notification for one user.
//
// It is called by the modules that produce events, so validation lives here rather
// than in the caller: a notification with a bad payload must be rejected before it
// reaches the inbox.
//
// A notification is best effort from the producer's point of view. A type the
// recipient muted is not stored and not mailed; the producer still sees success,
// because the underlying interaction (a comment, a like, a follow) already
// committed and must not be rolled back by a delivery preference.
func (s *Service) Notify(ctx context.Context, in NewInput) (Notification, error) {
	validated, err := Validate(in)
	if err != nil {
		return Notification{}, err
	}

	preferences := s.loadPreferences(ctx, validated.SiteID, validated.UserID)
	if !preferences.Allows(ChannelInApp, validated.Type) &&
		!preferences.Allows(ChannelEmail, validated.Type) {
		return Notification{}, nil
	}

	now := s.now()
	if validated.DedupeKey != "" {
		if checker, ok := s.repo.(DedupeChecker); ok {
			recent, checkErr := checker.ExistsRecent(ctx, validated.SiteID, validated.UserID,
				validated.DedupeKey, now.Add(-DedupeWindow))
			if checkErr != nil {
				// Failing open is deliberate: an index hiccup must not drop a
				// notification the recipient never saw.
				s.logError("notification dedupe check failed", "error", checkErr)
			} else if recent {
				return Notification{}, nil
			}
		}
	}

	payload := s.withActorName(ctx, validated.Payload, validated.ActorID)
	if payload == nil {
		// Keep the API shape stable: an inbox row always has a payload object, even
		// when the producer has nothing to add beyond the type and actor.
		payload = map[string]string{}
	}
	item := Notification{
		SiteID:    validated.SiteID,
		UserID:    validated.UserID,
		Type:      validated.Type,
		ActorID:   validated.ActorID,
		SubjectID: validated.SubjectID,
		Payload:   payload,
		DedupeKey: validated.DedupeKey,
		CreatedAt: now,
	}

	// Email is dispatched even when the in-app channel is muted: the two channels
	// are independent switches.
	if !preferences.Allows(ChannelInApp, validated.Type) {
		s.maybeEmail(ctx, item, preferences)
		return Notification{}, nil
	}

	created, err := s.repo.Insert(ctx, item)
	if err != nil {
		return Notification{}, err
	}

	// The push is best effort and runs after the row is committed: the inbox read is
	// authoritative, and a missing live connection must not turn a stored
	// notification into an error the producer has to retry.
	s.publish(ctx, created)
	s.maybeEmail(ctx, created, preferences)
	return created, nil
}

// withActorName fills actor_name so the inbox and the email can say who did it.
//
// The lookup is best effort: a missing account must not turn an interaction into a
// failed notification, and the UI already falls back to "someone".
func (s *Service) withActorName(
	ctx context.Context,
	payload map[string]string,
	actorID string,
) map[string]string {
	if len(payload) > 0 {
		if _, exists := payload["actor_name"]; exists {
			return payload
		}
	}
	if s.profiles == nil || actorID == "" {
		return payload
	}
	name, err := s.profiles.DisplayName(ctx, actorID)
	if err != nil || name == "" {
		if err != nil {
			s.logError("resolve notification actor failed", "error", err, "actor_id", actorID)
		}
		return payload
	}

	enriched := make(map[string]string, len(payload)+1)
	for key, value := range payload {
		enriched[key] = value
	}
	enriched["actor_name"] = name
	return enriched
}

// loadPreferences reads the recipient's choices and falls back to the defaults.
//
// A store that cannot persist choices, or a transient read failure, must not make
// the inbox silently disappear: the failure is logged and delivery is allowed.
func (s *Service) loadPreferences(ctx context.Context, siteID, userID string) Preferences {
	store, ok := s.repo.(PreferenceRepository)
	if !ok {
		return DefaultPreferences()
	}
	preferences, err := store.LoadPreferences(ctx, siteID, userID)
	if err != nil {
		s.logError("load notification preferences failed", "error", err)
		return DefaultPreferences()
	}
	return preferences
}

// maybeEmail sends the notification by email when the recipient enabled it, the
// type is eligible and the deployment has a relay.
func (s *Service) maybeEmail(ctx context.Context, item Notification, preferences Preferences) {
	if !preferences.Allows(ChannelEmail, item.Type) || !emailEligible(item.Type) {
		return
	}
	if s.emails == nil {
		s.logInfo("notification email skipped: no address resolver")
		return
	}
	if s.mailer == nil || !s.mailer.Configured() {
		// SMTP is optional: skip silently for the caller, but leave a trace for the
		// operator who wonders why mail is not going out.
		s.logInfo("notification email skipped: SMTP is not configured",
			"notification_type", string(item.Type), "user_id", item.UserID)
		return
	}

	address, err := s.emails.Email(ctx, item.UserID)
	if err != nil || address == "" {
		s.logInfo("notification email skipped: no email identity",
			"notification_type", string(item.Type), "user_id", item.UserID)
		return
	}

	message, ok := buildNotificationEmail(item, address,
		item.Payload["actor_name"], notificationLink(s.baseURL))
	if !ok {
		return
	}

	deliver := func(deliverCtx context.Context) {
		if sendErr := s.mailer.Send(deliverCtx, message); sendErr != nil {
			s.logError("notification email failed",
				"error", sendErr, "notification_type", string(item.Type), "user_id", item.UserID)
			return
		}
		s.logInfo("notification email sent",
			"notification_type", string(item.Type), "user_id", item.UserID)
	}

	if s.syncEmail {
		deliver(ctx)
		return
	}
	// The row is already committed and the response is on its way out; the relay
	// must not add its timeout to the interaction request.
	go func() {
		deliverCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), emailTimeout)
		defer cancel()
		deliver(deliverCtx)
	}()
}

// publish forwards a committed notification to live subscribers, when a transport
// was wired.
//
// The payload carries the fields the browser needs to refresh its badge and route a
// click; it is flat on purpose because it crosses the same WebSocket envelope as the
// outbox events.
func (s *Service) publish(ctx context.Context, item Notification) {
	if s.publisher == nil {
		return
	}
	payload := map[string]any{
		"notification_id":   item.ID,
		"notification_type": string(item.Type),
		"occurred_at":       item.CreatedAt.Format(time.RFC3339Nano),
	}
	if item.ActorID != "" {
		payload["actor_id"] = item.ActorID
	}
	if item.SubjectID != "" {
		payload["subject_id"] = item.SubjectID
	}
	for key, value := range item.Payload {
		// The event payload is add-only: a stored key wins over the fixed fields so a
		// producer can add context without the transport inventing a second schema.
		if _, exists := payload[key]; !exists {
			payload[key] = value
		}
	}
	s.publisher.Publish(ctx, LiveEvent{
		Type:           "notification.created",
		SiteID:         item.SiteID,
		AudienceUserID: item.UserID,
		OccurredAt:     item.CreatedAt,
		Payload:        payload,
	})
}

// Inbox returns the caller's notifications, newest first.
func (s *Service) Inbox(ctx context.Context, actor Actor, limit int) ([]Notification, error) {
	if actor.UserID == "" || actor.SiteID == "" {
		return nil, ErrInvalidInput
	}
	if limit <= 0 || limit > MaxInboxLimit {
		limit = DefaultInboxLimit
	}
	return s.repo.List(ctx, actor.SiteID, actor.UserID, limit)
}

// MarkRead marks one notification read.
//
// Marking an already read notification is a no-op, so the endpoint is safe to retry.
func (s *Service) MarkRead(ctx context.Context, actor Actor, notificationID string) (Notification, error) {
	found, err := s.repo.Find(ctx, actor.SiteID, actor.UserID, notificationID)
	if err != nil {
		return Notification{}, err
	}

	updated, changed, err := found.MarkRead(actor.UserID, actor.SiteID, s.now())
	if err != nil {
		return Notification{}, err
	}
	if !changed {
		return updated, nil
	}
	if markErr := s.repo.MarkRead(ctx, notificationID, *updated.ReadAt); markErr != nil {
		return Notification{}, markErr
	}
	return updated, nil
}

// MarkAllRead clears the caller's unread badge.
func (s *Service) MarkAllRead(ctx context.Context, actor Actor) (int, error) {
	if actor.UserID == "" || actor.SiteID == "" {
		return 0, ErrInvalidInput
	}
	return s.repo.MarkAllRead(ctx, actor.SiteID, actor.UserID, s.now())
}

// Preferences returns the caller's settings. A missing row means the defaults.
func (s *Service) Preferences(ctx context.Context, actor Actor) (Preferences, error) {
	if actor.UserID == "" || actor.SiteID == "" {
		return Preferences{}, ErrInvalidInput
	}
	store, ok := s.repo.(PreferenceRepository)
	if !ok {
		return Preferences{}, ErrPreferencesUnavailable
	}
	return store.LoadPreferences(ctx, actor.SiteID, actor.UserID)
}

// UpdatePreferences stores the caller's settings.
func (s *Service) UpdatePreferences(
	ctx context.Context,
	actor Actor,
	preferences Preferences,
) (Preferences, error) {
	if actor.UserID == "" || actor.SiteID == "" {
		return Preferences{}, ErrInvalidInput
	}
	store, ok := s.repo.(PreferenceRepository)
	if !ok {
		return Preferences{}, ErrPreferencesUnavailable
	}
	if err := store.SavePreferences(ctx, actor.SiteID, actor.UserID, preferences); err != nil {
		return Preferences{}, err
	}
	return preferences, nil
}

// EmailConfigured reports whether this deployment can send notification email.
//
// The settings UI uses it to explain why the email switches have no effect yet.
func (s *Service) EmailConfigured() bool {
	return s.mailer != nil && s.mailer.Configured()
}

func (s *Service) logInfo(msg string, args ...any) {
	if s.logger != nil {
		s.logger.Info(msg, args...)
	}
}

func (s *Service) logError(msg string, args ...any) {
	if s.logger != nil {
		s.logger.Error(msg, args...)
	}
}
