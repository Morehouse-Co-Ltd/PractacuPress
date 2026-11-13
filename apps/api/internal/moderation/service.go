package moderation

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Repository is the persistence contract for moderation.
type Repository interface {
	InsertReport(ctx context.Context, report Report) (Report, error)
	FindReport(ctx context.Context, siteID, reportID string) (Report, error)
	UpdateReport(ctx context.Context, report Report) (Report, error)
	// UpdateReportWithAudit stores the final report state and the operator audit
	// entry in one transaction, so a resolved report and its decision cannot drift.
	UpdateReportWithAudit(ctx context.Context, report Report, audit site.AuditEntry) (Report, error)
	// FindByReporter returns the reporter's existing report for a target, if any.
	// The unique index allows one report per reporter and target for the lifetime of
	// the row, so a closed report still blocks a duplicate filing.
	FindByReporter(ctx context.Context, siteID, reporterID string, targetType TargetType, targetID string) (Report, error)
	ListOpen(ctx context.Context, siteID string, limit int) ([]Report, error)
}

// TargetResolver resolves the author of a reported target.
//
// It lives here as a port so the moderation package does not import content or
// community storage; the infrastructure store implements it with Ent queries.
type TargetResolver interface {
	AuthorOf(ctx context.Context, siteID string, targetType TargetType, targetID string) (string, error)
}

// TargetModerator applies a resolution action to the reported target.
//
// The composition root adapts the content, community and site services to this port,
// so a report cannot become a second, parallel way to publish or hide something.
type TargetModerator interface {
	Takedown(ctx context.Context, actor Actor, targetType TargetType, targetID string) error
	Ban(ctx context.Context, actor Actor, userID string) error
}

// ModerationNotification is one inbox message produced by a resolution.
type ModerationNotification struct {
	SiteID     string
	UserID     string
	ActorID    string
	ReportID   string
	TargetType TargetType
	TargetID   string
	Action     Action
	Status     Status
	Note       string
}

// Notifier delivers resolution outcomes to the reporter and the target author.
type Notifier interface {
	NotifyModeration(ctx context.Context, in ModerationNotification) error
}

// ServiceOption customises a Service without breaking existing callers.
type ServiceOption func(*Service)

// WithTargetResolver installs the author lookup used to reject self reports and to
// tell the reported author about the decision. The server must pass it.
func WithTargetResolver(resolver TargetResolver) ServiceOption {
	return func(s *Service) { s.targets = resolver }
}

// WithTargetModerator installs the module that applies takedown and ban actions.
// Without it only ActionIgnore is available.
func WithTargetModerator(moderator TargetModerator) ServiceOption {
	return func(s *Service) { s.moderator = moderator }
}

// WithNotifier installs the inbox notifier used by resolution.
func WithNotifier(notifier Notifier) ServiceOption {
	return func(s *Service) { s.notifier = notifier }
}

// WithRateLimit changes the per reporter filing budget.
//
// The default is ten reports per hour. A non-positive limit disables the limiter,
// which is only useful in tests.
func WithRateLimit(limit int, window time.Duration) ServiceOption {
	return func(s *Service) {
		if limit <= 0 || window <= 0 {
			s.limiter = nil
			return
		}
		s.limiter = newReportLimiter(limit, window)
	}
}

// Service implements the report queue use cases.
type Service struct {
	repo      Repository
	targets   TargetResolver
	moderator TargetModerator
	notifier  Notifier
	limiter   *reportLimiter
	now       func() time.Time
}

// NewService builds a Service.
func NewService(repo Repository, options ...ServiceOption) (*Service, error) {
	if repo == nil {
		return nil, errors.New("moderation: repository is required")
	}
	service := &Service{
		repo:    repo,
		limiter: newReportLimiter(defaultReportsPerWindow, defaultReportWindow),
		now:     func() time.Time { return time.Now().UTC() },
	}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service, nil
}

// Filing budget. Ten reports an hour is enough for a reader who encounters several
// bad posts, while a script cannot bury the queue.
const (
	defaultReportsPerWindow = 10
	defaultReportWindow     = time.Hour
)

// reportLimiter is an in-process sliding window keyed by site and reporter.
//
// It is deliberately small: the queue is human moderated, and a multi-instance
// deployment still has the engine's request rate limiter as the fleet-wide bound.
type reportLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string][]time.Time
}

func newReportLimiter(limit int, window time.Duration) *reportLimiter {
	return &reportLimiter{
		limit:  limit,
		window: window,
		hits:   make(map[string][]time.Time),
	}
}

// allow records a filing attempt when the caller is under budget.
func (l *reportLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	cutoff := now.Add(-l.window)
	recent := l.hits[key][:0]
	for _, at := range l.hits[key] {
		if at.After(cutoff) {
			recent = append(recent, at)
		}
	}
	if len(recent) >= l.limit {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	return true
}

// File records a new report.
//
// targetAuthorID is supplied by the caller because only the content module knows who
// wrote the target; when a resolver is installed it replaces the argument, so the
// server does not have to re-implement the lookup. Filing checks, in order: target
// existence, validation, open duplicate and the per reporter budget.
func (s *Service) File(ctx context.Context, actor Actor, in NewReportInput, targetAuthorID string) (Report, error) {
	if actor.UserID == "" || actor.SiteID == "" {
		return Report{}, ErrInvalidInput
	}

	validated, err := ValidateReport(in, actor.UserID, "")
	if err != nil {
		return Report{}, err
	}

	if s.targets != nil {
		author, lookupErr := s.targets.AuthorOf(ctx, actor.SiteID, validated.TargetType, validated.TargetID)
		if lookupErr != nil {
			return Report{}, lookupErr
		}
		targetAuthorID = author
	}
	if targetAuthorID != "" && targetAuthorID == actor.UserID {
		return Report{}, ErrSelfReport
	}

	// The unique index is the last line of defence; this check turns the common case
	// into a stable error instead of a driver error.
	if _, findErr := s.repo.FindByReporter(ctx, actor.SiteID, actor.UserID, validated.TargetType, validated.TargetID); findErr == nil {
		return Report{}, ErrDuplicateReport
	} else if !errors.Is(findErr, ErrNotFound) {
		return Report{}, findErr
	}

	now := s.now()
	if s.limiter != nil && !s.limiter.allow(actor.SiteID+"|"+actor.UserID, now) {
		return Report{}, ErrRateLimited
	}

	report := Report{
		SiteID:     actor.SiteID,
		ReporterID: actor.UserID,
		TargetType: validated.TargetType,
		TargetID:   validated.TargetID,
		Reason:     validated.Reason,
		Note:       validated.Note,
		Status:     StatusOpen,
		CreatedAt:  now,
		UpdatedAt:  now,
	}

	return s.repo.InsertReport(ctx, report)
}

// Assign claims a report for the caller.
func (s *Service) Assign(ctx context.Context, actor Actor, reportID string) (Report, error) {
	report, err := s.repo.FindReport(ctx, actor.SiteID, reportID)
	if err != nil {
		return Report{}, err
	}

	updated, err := report.Assign(actor, s.now())
	if err != nil {
		return Report{}, err
	}
	return s.repo.UpdateReport(ctx, updated)
}

// Resolve closes a report as handled or dismissed.
func (s *Service) Resolve(ctx context.Context, actor Actor, reportID string, dismiss bool, note string) (Report, error) {
	report, err := s.repo.FindReport(ctx, actor.SiteID, reportID)
	if err != nil {
		return Report{}, err
	}

	updated, err := report.Resolve(actor, dismiss, note, s.now())
	if err != nil {
		return Report{}, err
	}
	return s.repo.UpdateReport(ctx, updated)
}

// ResolveInput is one moderated decision.
type ResolveInput struct {
	Action Action
	Note   string
}

// ResolveAction applies a moderation action to the target, closes the report, writes
// the audit entry and notifies the reporter and the target author.
//
// The target action runs first: if it fails (the content moved on, the member is
// already suspended), the report stays open so a moderator can retry instead of
// seeing a closed report whose promised action never happened.
func (s *Service) ResolveAction(
	ctx context.Context,
	actor Actor,
	reportID string,
	in ResolveInput,
) (Report, error) {
	report, err := s.repo.FindReport(ctx, actor.SiteID, reportID)
	if err != nil {
		return Report{}, err
	}
	if report.Status.Closed() {
		return Report{}, ErrAlreadyClosed
	}

	action := in.Action
	if action == "" {
		action = ActionIgnore
	}
	if !action.Valid() {
		return Report{}, fmt.Errorf("%w: unknown action", ErrInvalidInput)
	}
	note := strings.TrimSpace(in.Note)
	if len([]rune(note)) > MaxNoteLength {
		return Report{}, fmt.Errorf("%w: note is too long", ErrInvalidInput)
	}
	if action == ActionBan {
		// Suspension is administrator work. A site administrator may act on any open
		// report, so an editor cannot lock a report by claiming it and then being
		// unable to apply the only suitable action. Taking ownership here keeps the
		// stored report accountable to the administrator who applied the ban.
		if !CanBanTarget(actor) {
			return Report{}, ErrActionNotAllowed
		}
		report.AssigneeID = actor.UserID
	} else if !report.CanResolve(actor) {
		return Report{}, ErrNotAssignee
	}

	targetAuthorID := ""
	if s.targets != nil {
		author, lookupErr := s.targets.AuthorOf(ctx, report.SiteID, report.TargetType, report.TargetID)
		if lookupErr == nil {
			targetAuthorID = author
		} else if action != ActionIgnore {
			return Report{}, lookupErr
		}
	}

	switch action {
	case ActionTakedown:
		if s.moderator == nil {
			return Report{}, ErrActionNotAllowed
		}
		if err := s.moderator.Takedown(ctx, actor, report.TargetType, report.TargetID); err != nil {
			return Report{}, err
		}
	case ActionBan:
		if s.moderator == nil {
			return Report{}, ErrActionNotAllowed
		}
		userID := report.TargetID
		if report.TargetType != TargetUser {
			userID = targetAuthorID
		}
		if userID == "" {
			return Report{}, ErrTargetNotFound
		}
		if err := s.moderator.Ban(ctx, actor, userID); err != nil {
			return Report{}, err
		}
	}

	now := s.now()
	resolved, err := report.Resolve(actor, action == ActionIgnore, note, now)
	if err != nil {
		return Report{}, err
	}

	saved, err := s.repo.UpdateReportWithAudit(ctx, resolved, site.AuditEntry{
		SiteID:  report.SiteID,
		ActorID: actor.UserID,
		Action:  "moderation.report." + string(action),
		Target:  report.ID,
		Detail: map[string]any{
			"action":      string(action),
			"target_type": string(report.TargetType),
			"target_id":   report.TargetID,
			"status":      string(resolved.Status),
			"reason":      string(report.Reason),
			"note":        note,
		},
		At: now,
	})
	if err != nil {
		return Report{}, err
	}

	// Notification is secondary: the decision and its audit entry are already
	// committed, so a full inbox or a transient storage error must not fail the API.
	if s.notifier != nil {
		s.notify(ctx, saved, actor, targetAuthorID, action, note)
	}
	return saved, nil
}

// notify writes the two inbox rows of a resolution.
func (s *Service) notify(
	ctx context.Context,
	report Report,
	actor Actor,
	targetAuthorID string,
	action Action,
	note string,
) {
	message := ModerationNotification{
		SiteID:     report.SiteID,
		ActorID:    actor.UserID,
		ReportID:   report.ID,
		TargetType: report.TargetType,
		TargetID:   report.TargetID,
		Action:     action,
		Status:     report.Status,
		Note:       note,
	}
	if report.ReporterID != "" && report.ReporterID != actor.UserID {
		message.UserID = report.ReporterID
		_ = s.notifier.NotifyModeration(ctx, message)
	}
	// An ignored report is not a decision about the author; telling them they were
	// reported would leak the report itself. Only a takedown or ban affects them.
	if action != ActionIgnore &&
		targetAuthorID != "" && targetAuthorID != actor.UserID && targetAuthorID != report.ReporterID {
		message.UserID = targetAuthorID
		_ = s.notifier.NotifyModeration(ctx, message)
	}
}

// Queue returns the open reports of a site.
//
// Listing the queue is a moderation capability, so a member is refused before the
// repository is touched.
func (s *Service) Queue(ctx context.Context, actor Actor, limit int) ([]Report, error) {
	if !CanModerate(actor) {
		return nil, ErrPermissionDenied
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	return s.repo.ListOpen(ctx, actor.SiteID, limit)
}
