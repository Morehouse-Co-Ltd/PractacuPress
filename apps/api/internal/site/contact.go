package site

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/practacu/practacu-press/apps/api/internal/notifications"
	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
)

// The public contact form.
//
// Scope: contact only. A subscriber list would need a subscribers table, an unsubscribe
// flow, an export and a compliance statement, which is a separate feature; a reader
// leaving one sentence for the site owner closes the loop through the existing
// notification pipeline and stores nothing anywhere else.
//
// Bounds, in the unit the API actually enforces:
//   - name and email are bounded in bytes, because the notification payload stores them
//     and caps its values by bytes;
//   - the message is bounded in characters (runes): a Chinese message is up to three
//     bytes per character, and counting bytes would silently cut the limit to a third
//     for precisely the readers this product is written for. The payload exception in
//     the notifications package matches this bound (see notifications.ContactNotification).
const (
	// MaxContactNameLength bounds the optional sender name, in bytes.
	MaxContactNameLength = 80
	// MaxContactEmailLength bounds the optional sender address, in bytes.
	MaxContactEmailLength = 200
	// MaxContactMessageLength bounds the message, in characters.
	MaxContactMessageLength = notifications.MaxContactMessageLength
	// ContactCooldown is the minimum gap between two submissions from one visitor.
	ContactCooldown = 60 * time.Second
	// maxContactRequestBytes bounds the body before it is decoded. A legal body is at
	// most ~9 KB of JSON; the rest is headroom for framing, not for content.
	maxContactRequestBytes = 16 << 10
	// maxContactAdmins bounds the fan-out. A site with more administrators than this
	// still gets the message: the first maxContactAdmins of them do.
	maxContactAdmins = 50
)

// Contact form failures.
var (
	// ErrContactTooFast means the visitor submitted again inside ContactCooldown.
	ErrContactTooFast = errors.New("site: contact form throttled")
	// ErrContactUnavailable means no notification pipeline was wired, so the message
	// could not be delivered to anyone.
	ErrContactUnavailable = errors.New("site: contact form is not configured")
)

// ContactRequest is one anonymous contact form submission.
type ContactRequest struct {
	Name    string
	Email   string
	Message string
	// Website is the honeypot. A real visitor never fills a field it cannot see, so a
	// non-empty value means a bot: the request is answered exactly like a delivery and
	// nothing is sent.
	Website string
	// Session scopes the cooldown. It is derived by the handler from the caller —
	// the account when there is one, otherwise the client address — and never sent by
	// the browser.
	Session string
}

// ContactReceipt reports what a submission did, for logs and tests. The HTTP response
// deliberately does not expose it: how many administrators a site has is not the
// visitor's business.
type ContactReceipt struct {
	Delivered int
}

// ContactNotifier delivers one notification to one recipient.
//
// It is the notifications service, narrowed to the one method this package needs.
type ContactNotifier interface {
	Notify(ctx context.Context, in notifications.NewInput) (notifications.Notification, error)
}

// ContactConfig configures a ContactService.
type ContactConfig struct {
	// Repository resolves the site's administrators. It is the same repository the
	// rest of the module uses; there is no separate member lookup path.
	Repository Repository
	// Notifier delivers the notification. Nil means the endpoint answers 503 instead
	// of silently accepting messages nobody will read.
	Notifier ContactNotifier
	// Now replaces the clock in tests.
	Now func() time.Time
	// Cooldown replaces ContactCooldown in tests. Zero keeps the default.
	Cooldown time.Duration
}

// ContactService turns an anonymous submission into notifications for the site's
// administrators.
type ContactService struct {
	repo     Repository
	notifier ContactNotifier
	now      func() time.Time
	throttle *contactThrottle
}

// NewContactService builds a ContactService.
func NewContactService(cfg ContactConfig) (*ContactService, error) {
	if cfg.Repository == nil {
		return nil, errors.New("site: contact repository is required")
	}

	now := cfg.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	cooldown := cfg.Cooldown
	if cooldown <= 0 {
		cooldown = ContactCooldown
	}

	return &ContactService{
		repo:     cfg.Repository,
		notifier: cfg.Notifier,
		now:      now,
		throttle: newContactThrottle(cooldown, now),
	}, nil
}

// Submit validates one submission and notifies every administrator of the site.
//
// Order matters and is deliberate:
//
//  1. the honeypot is checked first: a bot that filled it gets a 202 with no delivery
//     and no state change, whatever else the body contains;
//  2. validation comes before the cooldown, so a reader who typed an over-long message
//     can fix it immediately instead of being locked out for a minute;
//  3. only a submission that would really be delivered consumes the cooldown slot.
func (s *ContactService) Submit(
	ctx context.Context,
	siteID string,
	in ContactRequest,
) (ContactReceipt, error) {
	if s == nil || s.notifier == nil {
		return ContactReceipt{}, ErrContactUnavailable
	}
	if strings.TrimSpace(in.Website) != "" {
		return ContactReceipt{}, nil
	}

	clean, err := validateContact(in)
	if err != nil {
		return ContactReceipt{}, err
	}

	if !s.throttle.allow(contactThrottleKey(siteID, clean.Session)) {
		return ContactReceipt{}, ErrContactTooFast
	}

	members, err := s.repo.ListMembers(ctx, siteID, maxContactAdmins)
	if err != nil {
		return ContactReceipt{}, err
	}

	receipt := ContactReceipt{}
	for _, member := range members {
		// Only active administrators hear about it: an invited or suspended account
		// cannot act on the message, and a plain member is not the site's owner.
		if !member.IsActive() || !member.Role.AtLeast(RoleSiteAdmin) {
			continue
		}
		if _, notifyErr := s.notifier.Notify(ctx, notifications.ContactNotification(
			siteID,
			member.UserID,
			notifications.ContactInput{
				Name:    clean.Name,
				Email:   clean.Email,
				Message: clean.Message,
			},
		)); notifyErr != nil {
			return receipt, notifyErr
		}
		receipt.Delivered++
	}
	return receipt, nil
}

// contactThrottleKey scopes the cooldown to one site and one visitor.
func contactThrottleKey(siteID, session string) string {
	return siteID + "|" + session
}

// validateContact normalises and bounds one submission.
func validateContact(in ContactRequest) (ContactRequest, error) {
	clean := ContactRequest{
		Name:    strings.TrimSpace(in.Name),
		Email:   strings.TrimSpace(in.Email),
		Message: strings.TrimSpace(in.Message),
		Session: in.Session,
	}

	if clean.Message == "" {
		return ContactRequest{}, formatInvalid("message is required")
	}
	if utf8.RuneCountInString(clean.Message) > MaxContactMessageLength {
		return ContactRequest{}, formatInvalid("message is too long")
	}
	if len(clean.Name) > MaxContactNameLength {
		return ContactRequest{}, formatInvalid("name is too long")
	}
	if clean.Email != "" {
		if len(clean.Email) > MaxContactEmailLength {
			return ContactRequest{}, formatInvalid("email is too long")
		}
		// The brief's rule, and the only rule a contact form needs: an address has to
		// contain an "@". Validating deliverability here would reject valid addresses
		// and would not prove anything anyway.
		if !strings.Contains(clean.Email, "@") || strings.HasPrefix(clean.Email, "@") ||
			strings.HasSuffix(clean.Email, "@") || strings.ContainsAny(clean.Email, " \t\r\n") {
			return ContactRequest{}, formatInvalid("email is invalid")
		}
	}
	return clean, nil
}

// contactThrottle is the in-process submission floor.
//
// It is per instance, not distributed: two API processes behind a load balancer each
// hold their own map, so a visitor can send one message per instance per minute. The
// engine's global rate limiter is the layer that covers the fleet; this one exists to
// keep a single visitor from flooding a slow endpoint, and it is documented as such.
type contactThrottle struct {
	mu       sync.Mutex
	cooldown time.Duration
	now      func() time.Time
	last     map[string]time.Time
}

func newContactThrottle(cooldown time.Duration, now func() time.Time) *contactThrottle {
	return &contactThrottle{
		cooldown: cooldown,
		now:      now,
		last:     make(map[string]time.Time),
	}
}

// allow records one submission for key, or reports that the cooldown is still running.
//
// Expired entries are pruned on the way through, which is what keeps the map bounded by
// "visitors active in the last minute" instead of by every visitor the process ever
// served. Pruning on write is enough: a key that never comes back leaves one entry
// behind, and the next submission from anywhere sweeps it.
func (t *contactThrottle) allow(key string) bool {
	now := t.now()

	t.mu.Lock()
	defer t.mu.Unlock()

	for candidate, at := range t.last {
		if now.Sub(at) >= t.cooldown {
			delete(t.last, candidate)
		}
	}

	if at, seen := t.last[key]; seen && now.Sub(at) < t.cooldown {
		return false
	}
	t.last[key] = now
	return true
}

// contactSubmitRequest is the wire shape of the contact form.
type contactSubmitRequest struct {
	Name    string `json:"name"`
	Email   string `json:"email"`
	Message string `json:"message"`
	// Website is the honeypot: present in the payload, invisible in the form.
	Website string `json:"website"`
}

// contactAcceptedResponse is what a successful submission answers.
//
// It says nothing about how many administrators were notified: the visitor only needs
// to know the message was accepted.
type contactAcceptedResponse struct {
	Status string `json:"status"`
}

// ContactMessage accepts one anonymous message for the site's administrators.
//
// The route is anonymous on purpose — a reader who wants to write to the site owner is
// exactly the person who has no account — which is why the anti-abuse layers are inside
// the handler: the engine's rate limiter, the honeypot and the per-visitor cooldown.
//
// The site always comes from host resolution, never from the path alone; a request for
// another tenant is refused before any work is done.
func (h *Handler) ContactMessage(c *gin.Context) {
	siteID := c.Param("siteID")

	resolved, ok := h.site(c)
	if !ok {
		_ = c.Error(apperr.New(apperr.CodeSiteNotFound).WithRequestID(h.requestID(c)))
		return
	}
	if resolved.ID != siteID {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "cross_site"))
		return
	}
	if h.contact == nil {
		// Nothing was wired to deliver the message: that is a deployment fault, not a
		// client one, so it must not look like "this site has no contact form".
		_ = c.Error(apperr.Internal(ErrContactUnavailable).WithRequestID(h.requestID(c)))
		return
	}

	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxContactRequestBytes)

	var req contactSubmitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		_ = c.Error(apperr.Validation("malformed json body"))
		return
	}

	_, err := h.contact.Submit(c.Request.Context(), siteID, ContactRequest{
		Name:    req.Name,
		Email:   req.Email,
		Message: req.Message,
		Website: req.Website,
		Session: h.contactSession(c),
	})
	if err != nil {
		_ = c.Error(mapContactError(err))
		return
	}

	c.JSON(http.StatusAccepted, contactAcceptedResponse{Status: "accepted"})
}

// contactSession scopes the cooldown to the calling visitor.
//
// A signed-in reader is scoped by account; an anonymous one by client address, which is
// the only identity an anonymous route has. Neither value is taken from the request
// body: a caller that could choose its own key could rotate it and bypass the floor.
func (h *Handler) contactSession(c *gin.Context) string {
	if userID, _, ok := h.principal(c); ok && userID != "" {
		return "user:" + userID
	}
	return "ip:" + c.ClientIP()
}

// mapContactError translates contact failures into the API error model.
func mapContactError(err error) *apperr.Problem {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, ErrContactTooFast):
		return apperr.RateLimited().WithDetail("reason", "contact_cooldown")
	case errors.Is(err, ErrContactUnavailable):
		return apperr.Internal(err)
	case errors.Is(err, ErrInvalidInput):
		return apperr.Validation(cleanValidation(err))
	}
	return apperr.Internal(err)
}
