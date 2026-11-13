package content

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Unlock failure lockout parameters.
//
// The limiter is deliberately in-process: the project already documents that the
// general rate limiter is per replica, and the lockout is a brute force speed bump,
// not an authorization decision. A multi-replica deployment still bounds guessing
// through the engine level rate limit; an attacker cannot turn a wrong password into
// a read.
const (
	unlockFailureLimit   = 5
	unlockFailureWindow  = 10 * time.Minute
	unlockLockDuration   = 15 * time.Minute
	unlockEntryRetention = 24 * time.Hour
)

// UnlockLockedError reports how long a caller must wait before trying again.
//
// It unwraps to ErrUnlockLocked so callers can match the sentinel while the HTTP
// layer still sets a Retry-After header.
type UnlockLockedError struct {
	RetryAfter time.Duration
}

// Error implements the error interface.
func (e *UnlockLockedError) Error() string { return ErrUnlockLocked.Error() }

// Unwrap makes errors.Is(err, ErrUnlockLocked) work.
func (e *UnlockLockedError) Unwrap() error { return ErrUnlockLocked }

// unlockLimiter counts failed unlock attempts per content and client address.
type unlockLimiter struct {
	mu      sync.Mutex
	now     func() time.Time
	entries map[string]*unlockEntry
}

type unlockEntry struct {
	failures    int
	windowStart time.Time
	lockedUntil time.Time
	lastSeen    time.Time
}

// newUnlockLimiter builds a limiter. A nil clock falls back to time.Now so the
// limiter is usable before NewService has defaulted it (and in tests).
func newUnlockLimiter(now func() time.Time) *unlockLimiter {
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &unlockLimiter{now: now, entries: make(map[string]*unlockEntry)}
}

// locked reports the remaining lockout for a key.
func (l *unlockLimiter) locked(key string) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	l.prune(now)

	entry, ok := l.entries[key]
	if !ok {
		return 0, false
	}
	if now.Before(entry.lockedUntil) {
		return entry.lockedUntil.Sub(now), true
	}
	return 0, false
}

// fail records one wrong password and reports whether the key is now locked.
func (l *unlockLimiter) fail(key string) (time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	l.prune(now)

	entry, ok := l.entries[key]
	if !ok {
		entry = &unlockEntry{windowStart: now}
		l.entries[key] = entry
	}
	entry.lastSeen = now
	if now.Sub(entry.windowStart) > unlockFailureWindow {
		entry.failures = 0
		entry.windowStart = now
	}
	entry.failures++
	if entry.failures >= unlockFailureLimit {
		entry.lockedUntil = now.Add(unlockLockDuration)
		entry.failures = 0
		entry.windowStart = now
		return unlockLockDuration, true
	}
	return 0, false
}

// reset clears the failure history after a successful unlock.
func (l *unlockLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}

// prune drops entries that have not been touched for a day. It runs only when the
// map has grown, so the common path stays cheap.
func (l *unlockLimiter) prune(now time.Time) {
	if len(l.entries) < 512 {
		return
	}
	for key, entry := range l.entries {
		if now.Sub(entry.lastSeen) > unlockEntryRetention && !now.Before(entry.lockedUntil) {
			delete(l.entries, key)
		}
	}
}

// applyAccessFields resolves the access mode, its password hash and the comment
// policy of a create or update.
//
// On update an empty mode or policy keeps the stored value; an empty password keeps
// the stored hash. Switching away from password access clears the hash so a stale
// secret can never be reused after the item is made public again.
func (s *Service) applyAccessFields(
	ctx context.Context,
	item *Content,
	in DraftInput,
	creating bool,
) error {
	mode := in.AccessMode
	if mode == "" {
		if creating {
			mode = AccessPublic
		} else {
			mode = item.AccessMode
		}
		if in.AccessPassword != "" {
			// Supplying a password is an unambiguous request for password access.
			mode = AccessPassword
		}
	}

	switch mode {
	case AccessPassword:
		if s.hasher == nil {
			// No hasher means password access was never wired: refusing is safer
			// than storing a plaintext secret or silently making the item public.
			return ErrPasswordNotSet
		}
		if in.AccessPassword != "" {
			hash, err := s.hasher.Hash(ctx, in.AccessPassword)
			if err != nil {
				return err
			}
			item.AccessPasswordHash = hash
		} else if item.AccessPasswordHash == "" {
			return ErrAccessPasswordRequired
		}
	default:
		item.AccessPasswordHash = ""
	}
	item.AccessMode = mode

	policy := in.CommentPolicy
	if policy == "" {
		if creating {
			policy = CommentPolicyInherit
		} else {
			policy = item.CommentPolicy
		}
	}
	if !policy.Valid() {
		policy = CommentPolicyInherit
	}
	item.CommentPolicy = policy
	return nil
}

// applySchedule validates and stores a publication schedule.
//
// Scheduling is only offered to callers that could publish directly, so the
// background publisher never bypasses the site review policy. The instant is
// truncated to the minute, which is the precision the product promises (C-17).
func (s *Service) applySchedule(
	ctx context.Context,
	actor Actor,
	item *Content,
	publishAt *time.Time,
	now time.Time,
) error {
	if publishAt == nil {
		item.PublishAt = nil
		item.PublishAttempts = 0
		return nil
	}

	at := publishAt.UTC().Truncate(time.Minute)
	if !at.After(now) {
		return invalidField("publish_at", "future", "publish_at must be in the future")
	}

	mode, err := s.publishMode(ctx, item.SiteID)
	if err != nil {
		return err
	}
	if !CanPublishDirectly(mode, actor.Role) {
		return ErrScheduleNotAllowed
	}

	item.PublishAt = &at
	item.PublishAttempts = 0
	return nil
}

// Unlock verifies the access password of one item and returns the session grant.
//
// A wrong password is only reported as ErrInvalidPassword; the item's existence is
// never confirmed to a caller that may not read it. After unlockFailureLimit wrong
// attempts the key is locked for unlockLockDuration.
func (s *Service) Unlock(
	ctx context.Context,
	actor Actor,
	contentID, password, clientIP string,
) (UnlockGrant, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return UnlockGrant{}, err
	}

	privileged := item.IsAuthor(actor) || actor.Role.AtLeast(site.RoleEditor)
	if !item.Status.IsPublic() && !privileged {
		return UnlockGrant{}, ErrNotFound
	}
	if item.AccessMode != AccessPassword {
		return UnlockGrant{}, ErrPasswordNotSet
	}
	if s.hasher == nil || s.unlocks == nil || item.AccessPasswordHash == "" {
		return UnlockGrant{}, ErrPasswordNotSet
	}

	key := item.SiteID + ":" + item.ID + ":" + strings.TrimSpace(clientIP)
	if wait, locked := s.unlockGuard.locked(key); locked {
		return UnlockGrant{}, &UnlockLockedError{RetryAfter: wait}
	}

	matches, err := s.hasher.Verify(ctx, password, item.AccessPasswordHash)
	if err != nil {
		return UnlockGrant{}, err
	}
	if !matches {
		if wait, locked := s.unlockGuard.fail(key); locked {
			return UnlockGrant{}, &UnlockLockedError{RetryAfter: wait}
		}
		return UnlockGrant{}, ErrInvalidPassword
	}
	s.unlockGuard.reset(key)

	token, expiresAt, err := s.unlocks.IssueContentUnlock(ctx, item.SiteID, item.ID)
	if err != nil {
		return UnlockGrant{}, err
	}
	return UnlockGrant{Token: token, ExpiresAt: expiresAt}, nil
}

// VerifyUnlock reports whether token grants read access to one item. A deployment
// without an issuer treats every unlock as invalid rather than guessing.
func (s *Service) VerifyUnlock(ctx context.Context, token, siteID, contentID string) bool {
	if s.unlocks == nil || strings.TrimSpace(token) == "" {
		return false
	}
	return s.unlocks.VerifyContentUnlock(ctx, token, siteID, contentID)
}

// ProcessScheduledPublishing promotes every due draft and records a failure for a
// draft that cannot be published yet.
//
// The repository transition is conditional on the draft status and revision, so two
// replicas running the same tick cannot publish an item twice: the loser sees
// ErrInvalidTransition and simply stops. A failed pass is retried on the next tick
// until MaxScheduledPublishAttempts is reached, after which the schedule is cleared
// and the failure stays in the audit trail.
func (s *Service) ProcessScheduledPublishing(ctx context.Context) (ScheduledPublishResult, error) {
	now := s.now()
	due, err := s.repo.DueSchedules(ctx, now, ScheduledPublishBatch)
	if err != nil {
		return ScheduledPublishResult{}, err
	}

	result := ScheduledPublishResult{Due: len(due)}
	for _, item := range due {
		if item.Status != StatusDraft || item.PublishAt == nil {
			continue
		}
		if !item.IsSanitized() {
			s.recordScheduleFailure(ctx, item, now, errors.New("not sanitized"), &result)
			continue
		}

		updated := item
		updated.Status = StatusPublished
		updated.PublishedAt = &now
		updated.PublishAt = nil
		updated.PublishAttempts = 0
		updated.UpdatedAt = now

		_, transitionErr := s.repo.Transition(ctx, updated, StatusDraft, site.AuditEntry{
			SiteID:  item.SiteID,
			ActorID: "system",
			Action:  "content.scheduled_publish",
			Target:  item.ID,
			Detail: map[string]any{
				"scheduled_at": item.PublishAt.UTC().Format(time.RFC3339),
				"attempt":      item.PublishAttempts + 1,
			},
			At: now,
		})
		if transitionErr != nil {
			// A concurrent pass already published (or removed) the item. That is
			// the intended multi-replica behaviour, not a failure worth retrying.
			if errors.Is(transitionErr, ErrInvalidTransition) || errors.Is(transitionErr, ErrNotFound) {
				continue
			}
			s.recordScheduleFailure(ctx, item, now, transitionErr, &result)
			continue
		}
		result.Published++
	}
	return result, nil
}

// recordScheduleFailure increments the attempt count and cancels the schedule once
// the retry bound is exhausted.
func (s *Service) recordScheduleFailure(
	ctx context.Context,
	item Content,
	now time.Time,
	cause error,
	result *ScheduledPublishResult,
) {
	attempts := item.PublishAttempts + 1
	cancel := attempts >= MaxScheduledPublishAttempts
	detail := map[string]any{
		"attempts":  attempts,
		"cancelled": cancel,
	}
	if cause != nil {
		detail["reason"] = cause.Error()
	}
	err := s.repo.RecordScheduleFailure(ctx, item.SiteID, item.ID, attempts, cancel, site.AuditEntry{
		SiteID:  item.SiteID,
		ActorID: "system",
		Action:  "content.scheduled_publish_failed",
		Target:  item.ID,
		Detail:  detail,
		At:      now,
	})
	if err != nil {
		return
	}
	result.Failed++
	if cancel {
		result.Cancelled++
	}
}
