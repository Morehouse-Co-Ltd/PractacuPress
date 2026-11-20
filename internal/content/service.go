package content

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/permalink"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/safety"
	"github.com/practacu/practacu-press/internal/site"
)

// Sanitized is the sanitizer's result for a revision.
type Sanitized struct {
	HTML          string
	PolicyVersion string
	Violations    []string
}

// Sanitizer turns author supplied source into safe HTML.
//
// It is a narrow interface so this package does not depend on the security client's
// implementation, and so a test can control exactly when sanitization fails.
type Sanitizer interface {
	Sanitize(ctx context.Context, format SourceFormat, source string) (Sanitized, error)
}

// ContentGuard applies the site's sensitive word policy to a submission.
//
// The safety service implements it. A nil guard (tests, legacy callers) skips the
// word list; the server always wires one.
type ContentGuard interface {
	CheckText(ctx context.Context, siteID, text string) (safety.TextVerdict, error)
}

// safetyResult is the aggregated word-list outcome for one content item.
type safetyResult struct {
	Matched []string
	// Review is true when at least one matched word asks for human review.
	Review bool
}

// Hit reports whether any word matched.
func (r safetyResult) Hit() bool { return len(r.Matched) > 0 }

// action names the strictest action for the audit trail.
func (r safetyResult) action() string {
	if r.Review {
		return string(safety.ModeReview)
	}
	return string(safety.ModeReplace)
}

// Repository is the persistence contract for content.
type Repository interface {
	// Insert stores a new item, its first history entry and its audit entry.
	Insert(ctx context.Context, item Content, audit site.AuditEntry) (Content, error)
	// SaveDraft updates an editable item, appends a history entry and writes the
	// audit entry in one transaction. The update only succeeds when the stored
	// revision still equals item.Revision.
	SaveDraft(ctx context.Context, item Content, audit site.AuditEntry) (Content, error)
	// FindByID loads an item inside a site scope. A trashed item is reported as
	// missing: the recycle bin has its own lookup, so no read path can accidentally
	// serve deleted content by loading it the ordinary way.
	FindByID(ctx context.Context, siteID, contentID string) (Content, error)
	// FindByIDIncludingTrashed loads an item even when it sits in the recycle bin.
	// Only the lifecycle operations use it, because they are the ones that act on
	// what every reader path must hide.
	FindByIDIncludingTrashed(ctx context.Context, siteID, contentID string) (Content, error)
	// List returns items of a site filtered by what the caller may see.
	List(ctx context.Context, filter ListFilter) ([]Content, error)
	// Search returns one relevance ordered page of published, public items whose
	// title, summary or body matches the filter. Implementations may fall back to
	// a portable LIKE query and report that through SearchPage.Degraded.
	Search(ctx context.Context, filter SearchFilter) (SearchPage, error)
	// Transition applies a status change only when the stored status still equals
	// from, which makes concurrent moderator decisions safe.
	Transition(ctx context.Context, item Content, from Status, audit site.AuditEntry) (Content, error)
	// ListRevisions returns the newest history entries of one item.
	ListRevisions(ctx context.Context, siteID, contentID string, limit int) ([]Revision, error)
	// FindRevision loads one history entry inside a site scope.
	FindRevision(ctx context.Context, siteID, contentID, revisionID string) (Revision, error)
	// RestoreRevision snapshots the current state (the backup), applies the target
	// revision and appends the restored state in one transaction. The conditional
	// update uses item.Revision as the optimistic guard.
	RestoreRevision(ctx context.Context, item Content, backup Revision, audit site.AuditEntry) (Content, error)
	// DueSchedules returns drafts whose publish_at is at or before now, oldest
	// first. The scheduler promotes them; a conditional update makes a second
	// replica's identical pass a no-op.
	DueSchedules(ctx context.Context, now time.Time, limit int) ([]Content, error)
	// RecordScheduleFailure stores the failed attempt count and optionally clears
	// the schedule once the retry bound is exhausted.
	RecordScheduleFailure(
		ctx context.Context,
		siteID, contentID string,
		attempts int,
		cancel bool,
		audit site.AuditEntry,
	) error
	// IncrementViewCount adds one to the read counter of a published item. It must
	// be a single incrementing update, never a read-modify-write of the row, so a
	// concurrent edit cannot be clobbered by a reader.
	IncrementViewCount(ctx context.Context, siteID, contentID string) error
	// Popular returns the leaderboard candidates of one site ordered by raw view
	// count, newest first on a tie. The service applies the time decay afterwards.
	Popular(ctx context.Context, filter PopularFilter) ([]Content, error)
	// Trash stamps the recycle bin marker on an item. A row that is already trashed
	// is returned unchanged so a retried delete stays idempotent.
	Trash(ctx context.Context, item Content, audit site.AuditEntry) (Content, error)
	// Undelete clears the recycle bin marker and returns the restored item.
	Undelete(ctx context.Context, item Content, audit site.AuditEntry) (Content, error)
	// Purge removes a trashed item, its revision history and its search index rows.
	// It refuses a live item: the two step delete is the only destruction path.
	Purge(ctx context.Context, siteID, contentID string, audit site.AuditEntry) error
	// PurgeExpired removes up to limit items deleted before the given instant and
	// reports how many rows it removed. It backs the retention sweep.
	PurgeExpired(ctx context.Context, before time.Time, limit int) (int, error)
}

// DraftQuotaStore is the optional storage capability that backs the per-author draft
// quota.
//
// It is an optional port rather than a method on Repository so a deployment that has
// not wired it still compiles and still serves content reads: when ServiceConfig
// leaves DraftQuota nil the quota is not enforced (documented degraded mode). The
// server wires the content store into it, which implements both counts.
type DraftQuotaStore interface {
	// CountActiveDraftsByAuthor counts the author's items in draft, pending_review,
	// rejected and pending_security_check on one site.
	CountActiveDraftsByAuthor(ctx context.Context, siteID, authorID string) (int, error)
	// SumActiveDraftBytesByAuthor sums the source body bytes of those items.
	SumActiveDraftBytesByAuthor(ctx context.Context, siteID, authorID string) (int64, error)
}

// RevisionLookupStore is the optional storage capability behind the version diff
// (Beta 1.2 contract E).
//
// It is an optional port rather than a Repository method so a test double or an
// alternative store that predates the diff endpoint keeps satisfying Repository. When
// it is missing the service falls back to scanning the bounded revision list, which
// is correct for the twenty versions the retention policy keeps.
type RevisionLookupStore interface {
	// FindRevisionByVersion loads one history snapshot by its version number inside a
	// site and content scope.
	FindRevisionByVersion(ctx context.Context, siteID, contentID string, version int) (Revision, error)
}

// SlugLookupStore is the optional storage capability that resolves a site scoped slug
// to its item (Beta 1.2 contract J1).
//
// It is optional for the same reason as RevisionLookupStore: a repository that does
// not implement it keeps the pre Beta 1.2 id only addressing instead of failing to
// compile.
type SlugLookupStore interface {
	// FindBySlug loads the live item of one kind carrying slug on the site. An
	// unknown slug answers ErrNotFound; a trashed row is never returned.
	FindBySlug(ctx context.Context, siteID string, kind Kind, slug string) (Content, error)
}

// PreviewSigner mints and verifies the draft preview tokens of contract H.
//
// It mirrors *preview.Signer without importing the platform package, so this package
// stays independent of where the key is stored. Verify reports the content id the
// token was minted for; the caller must compare it with the item it is reading, which
// is what scopes a token to one draft. A nil signer disables preview links.
type PreviewSigner interface {
	// Issue mints a token for one content id, valid for ttl.
	Issue(contentID string, ttl time.Duration) (token string, expiresAt time.Time, err error)
	// Verify returns the content id a valid token authorizes.
	Verify(token string) (contentID string, ok bool)
}

// RedirectRecorder records the redirect a slug change of a published item creates
// (Beta 1.2 contract J4).
//
// It is a port instead of an import because the redirect module owns that table. A nil
// recorder (a deployment that does not run the redirect feature) simply skips the
// recording: the save itself must not depend on it.
type RedirectRecorder interface {
	// RecordSlugChange stores the 301 rule from fromPath to toPath, both of which are
	// site relative paths already carrying the content kind prefix.
	RecordSlugChange(ctx context.Context, siteID, fromPath, toPath string) error
}

// PublishModeFunc resolves the publishing rule of a site.
type PublishModeFunc func(ctx context.Context, siteID string) (site.PublishMode, error)

// AccessPasswordHasher hashes and verifies the password that protects an item.
//
// The server wires the same Argon2id implementation the authentication module uses,
// so a password hash never leaves the security boundary; content only stores the
// already hashed value.
type AccessPasswordHasher interface {
	Hash(ctx context.Context, plain string) (string, error)
	Verify(ctx context.Context, plain, encoded string) (bool, error)
}

// UnlockTokens mints and verifies the session level authorization a password
// protected item grants after a successful unlock (C-18).
//
// It is a narrow port so the content package does not depend on the auth package:
// the server adapts auth.TokenIssuer. When it is nil the unlock endpoint reports
// that password access is unavailable rather than weakening the check.
type UnlockTokens interface {
	IssueContentUnlock(ctx context.Context, siteID, contentID string) (string, time.Time, error)
	VerifyContentUnlock(ctx context.Context, token, siteID, contentID string) bool
}

// UnlockGrant is the result of a successful unlock.
type UnlockGrant struct {
	Token     string
	ExpiresAt time.Time
}

// ScheduledPublishResult reports one scheduler pass.
type ScheduledPublishResult struct {
	// Due is the number of due drafts the pass considered.
	Due int
	// Published is the number of drafts it promoted.
	Published int
	// Failed is the number of drafts that stayed scheduled after a failure.
	Failed int
	// Cancelled is the number of drafts whose schedule was dropped after the retry
	// bound was reached.
	Cancelled int
}

// ReviewNotification is the outcome a review decision delivers to the author.
type ReviewNotification struct {
	SiteID    string
	UserID    string
	ActorID   string
	ContentID string
	Kind      string
	Title     string
	Status    Status
	Reason    string
}

// ReviewNotifier tells an author that a moderator decided on their submission.
//
// It is a narrow port so the content package does not import the notification
// storage: the server adapts notifications.Service to it. Notification failure must
// not undo the decision, so the service treats it as best effort.
type ReviewNotifier interface {
	NotifyReview(ctx context.Context, in ReviewNotification) error
}

// Service implements the content use cases.
type Service struct {
	repo        Repository
	sanitizer   Sanitizer
	guard       ContentGuard
	publishMode PublishModeFunc
	draftQuota  DraftQuotaStore
	notifier    ReviewNotifier
	hasher      AccessPasswordHasher
	unlocks     UnlockTokens
	unlockGuard *unlockLimiter
	// The optional storage capabilities of the Beta 1.2 endpoints. They are resolved
	// from the repository once, at construction, so a read path never type asserts per
	// request.
	revisions RevisionLookupStore
	slugs     SlugLookupStore
	// preview mints the draft preview links (contract H); nil disables them.
	preview PreviewSigner
	// redirects receives the slug change rule of a published item (contract J4); nil
	// skips the recording.
	redirects RedirectRecorder
	// views is the in-process de-duplication table of the read counter. It is bound
	// to the service clock so a test can move time across the window.
	views      *viewGate
	now        func() time.Time
	permalinks func(context.Context, string) (permalink.Settings, error)
}

// ServiceConfig configures a Service.
type ServiceConfig struct {
	Repository  Repository
	Sanitizer   Sanitizer
	PublishMode PublishModeFunc
	// DraftQuota enables the per-author draft quota (V-06). When nil the quota is
	// skipped so an unwired deployment keeps working; the server must set it.
	DraftQuota DraftQuotaStore
	// ReviewNotifier reports publish/reject decisions to the author. Nil disables
	// the inbox notification; the decision itself is unaffected.
	ReviewNotifier ReviewNotifier
	// ContentGuard applies the site's sensitive word list to the title, summary and
	// source body. Nil skips the word list (tests and legacy callers); the server
	// always sets it.
	ContentGuard ContentGuard
	// AccessPasswordHasher hashes and verifies private item passwords (C-18). Nil
	// disables password access: an item cannot be switched to password mode.
	AccessPasswordHasher AccessPasswordHasher
	// UnlockTokens mints the session grant the unlock endpoint returns. Nil disables
	// password access in the same way as a missing hasher.
	UnlockTokens UnlockTokens
	// PreviewSigner mints draft preview links (Beta 1.2 contract H). Nil disables the
	// preview endpoint with ErrPreviewUnavailable; the server wires
	// *preview.Signer, which persists its key under the data directory.
	PreviewSigner PreviewSigner
	// RedirectRecorder receives the 301 rule a published item's slug change creates
	// (contract J4). Nil skips the recording without failing the save.
	RedirectRecorder RedirectRecorder
	Permalinks       func(context.Context, string) (permalink.Settings, error)
	Now              func() time.Time
}

// NewService builds a Service.
func NewService(cfg ServiceConfig) (*Service, error) {
	if cfg.Repository == nil {
		return nil, ErrInvalidInput
	}
	if cfg.Sanitizer == nil {
		return nil, ErrInvalidInput
	}

	service := &Service{
		repo:        cfg.Repository,
		sanitizer:   cfg.Sanitizer,
		guard:       cfg.ContentGuard,
		publishMode: cfg.PublishMode,
		draftQuota:  cfg.DraftQuota,
		notifier:    cfg.ReviewNotifier,
		hasher:      cfg.AccessPasswordHasher,
		unlocks:     cfg.UnlockTokens,
		preview:     cfg.PreviewSigner,
		redirects:   cfg.RedirectRecorder,
		now:         cfg.Now,
		permalinks:  cfg.Permalinks,
	}
	// The Beta 1.2 features are storage capabilities of the same repository, so they
	// are detected here instead of being threaded through a second config field: the
	// content store implements them, and a pre Beta 1.2 test double simply does not.
	if store, ok := cfg.Repository.(RevisionLookupStore); ok {
		service.revisions = store
	}
	if store, ok := cfg.Repository.(SlugLookupStore); ok {
		service.slugs = store
	}
	if service.publishMode == nil {
		// The safe default is review: content never publishes without a human.
		service.publishMode = func(context.Context, string) (site.PublishMode, error) {
			return site.PublishModeReview, nil
		}
	}
	if service.now == nil {
		service.now = func() time.Time { return time.Now().UTC() }
	}
	// The limiter must share the service clock so tests can move time.
	service.unlockGuard = newUnlockLimiter(service.now)
	// So must the read counter's de-duplication window.
	service.views = newViewGate(service.now, ViewDedupeWindow, MaxTrackedViewKeys)
	return service, nil
}

// CreateDraft stores a new draft after sanitizing it.
//
// If sanitization is unavailable the item is stored in
// pending_security_check and the error is returned: the content is preserved for the
// author, but it cannot be published until a real sanitization succeeds.
//
// The author quota is checked first: once an account holds too many active drafts, or
// too many bytes of draft source, the write is refused with ErrQuotaExceeded so an
// open registration cannot grow the database and the review queue without limit (V-06).
func (s *Service) CreateDraft(ctx context.Context, actor Actor, kind Kind, in DraftInput) (Content, error) {
	if !kind.Valid() {
		return Content{}, ErrInvalidInput
	}
	validated, err := ValidateDraft(in)
	if err != nil {
		return Content{}, err
	}
	if err := s.checkDraftQuota(ctx, actor, validated.SourceBody); err != nil {
		return Content{}, err
	}

	now := s.now()
	item := Content{
		SiteID:       actor.SiteID,
		AuthorID:     actor.UserID,
		Kind:         kind,
		Status:       StatusDraft,
		Title:        validated.Title,
		Slug:         validated.Slug,
		Summary:      validated.Summary,
		SourceFormat: validated.SourceFormat,
		SourceBody:   validated.SourceBody,
		CategoryID:   validated.CategoryID,
		Tags:         validated.Tags,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if item.Slug == "" {
		item.Slug = SlugFromTitle(item.Title)
	}
	// Access mode, password hash and the comment override are part of the draft, so
	// they are validated and written before sanitization changes the status.
	if err := s.applyAccessFields(ctx, &item, validated, true); err != nil {
		return Content{}, err
	}
	applySeoFields(&item, validated)
	if err := s.applySchedule(ctx, actor, &item, validated.PublishAt, now); err != nil {
		return Content{}, err
	}

	// The word list runs on the submitted text before sanitization so replace-mode
	// matches are already rewritten when the rendered HTML is produced. A reject match
	// aborts the write; a review match files the item in the moderation queue.
	safetyOutcome, safetyErr := s.applyContentSafety(ctx, &item)
	if safetyErr != nil {
		return Content{}, safetyErr
	}

	securityErr := s.applySanitization(ctx, &item)
	if safetyOutcome.Review && item.Status == StatusDraft {
		item.Status = StatusPendingReview
	}
	// Only a draft can be scheduled. A review hold means a human must decide
	// first, so the pending schedule is dropped instead of waiting forever.
	if item.Status != StatusDraft {
		item.PublishAt = nil
		item.PublishAttempts = 0
	}

	auditDetail := map[string]any{"kind": string(kind)}
	if safetyOutcome.Hit() {
		auditDetail["content_safety"] = map[string]any{
			"matched": safetyOutcome.Matched,
			"action":  safetyOutcome.action(),
		}
	}
	audit := site.AuditEntry{
		SiteID:  item.SiteID,
		ActorID: actor.UserID,
		Action:  "content.created",
		Detail:  auditDetail,
		At:      now,
	}
	saved, err := s.repo.Insert(ctx, item, audit)
	if err != nil {
		return Content{}, err
	}
	return saved, securityErr
}

// checkDraftQuota refuses a new draft that would exceed the author's quota.
//
// The incoming body counts against the byte quota, so the check bounds the result of
// the write rather than only the already stored state. Both counts and the write are
// separate operations, so two concurrent requests can race past the limit by one item
// or one body; that is accepted: the quota bounds growth, it is not an exact ledger.
func (s *Service) checkDraftQuota(ctx context.Context, actor Actor, incomingSource string) error {
	if s.draftQuota == nil {
		return nil
	}

	count, err := s.draftQuota.CountActiveDraftsByAuthor(ctx, actor.SiteID, actor.UserID)
	if err != nil {
		return err
	}
	if count >= MaxActiveDraftsPerAuthor {
		return fmt.Errorf("%w: too many active drafts", ErrQuotaExceeded)
	}
	return s.checkDraftByteQuota(ctx, actor, int64(len(incomingSource)))
}

// checkDraftByteQuota refuses a write that would push the author's stored active
// draft source over the byte limit. growth is the number of bytes the write adds:
// shrinking a draft (or rewriting it to the same size) is always allowed, so an author
// can recover from a full quota by editing rather than only by deleting.
func (s *Service) checkDraftByteQuota(ctx context.Context, actor Actor, growth int64) error {
	if s.draftQuota == nil || growth <= 0 {
		return nil
	}
	used, err := s.draftQuota.SumActiveDraftBytesByAuthor(ctx, actor.SiteID, actor.UserID)
	if err != nil {
		return err
	}
	if used+growth > MaxActiveDraftBytesPerAuthor {
		return fmt.Errorf("%w: draft source is too large", ErrQuotaExceeded)
	}
	return nil
}

// UpdateDraft edits an item the caller may still write.
//
// The editable states are draft, rejected, pending_security_check and published.
// A published item is revised in place, but every save applies the same checks it
// had before: the body is sanitized again, the author (or an editor) must own the
// item, and the previous state is kept as a history entry, so an editorial
// correction never destroys what readers saw (C-20).
func (s *Service) UpdateDraft(ctx context.Context, actor Actor, contentID string, in DraftInput) (Content, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return Content{}, err
	}
	if !editable(item.Status) {
		return Content{}, ErrInvalidTransition
	}
	if !item.IsAuthor(actor) && !actor.Role.AtLeast(site.RoleEditor) {
		return Content{}, ErrPermissionDenied
	}
	// The optimistic concurrency token of contract F: a save that carries a stale
	// revision is refused with the current one so the editor reloads instead of
	// overwriting a colleague's newer text. Omitted keeps last-write-wins.
	if in.Revision != nil && *in.Revision != item.Revision {
		return Content{}, &VersionConflictError{Current: item.Revision}
	}

	validated, err := ValidateDraft(in)
	if err != nil {
		return Content{}, err
	}
	// The public address before the save, captured for the automatic redirect a slug
	// change of a live item creates (contract J4).
	previousSlug := item.Slug
	wasPublished := item.Status == StatusPublished
	// Editing a draft can grow its source, so the same byte quota applies to growth
	// here: otherwise an author could create small drafts and then inflate each one
	// past the limit. Published content no longer counts as an active draft, so a
	// revision of it is not charged against the draft quota.
	if item.Status != StatusPublished {
		if err := s.checkDraftByteQuota(
			ctx,
			Actor{SiteID: item.SiteID, UserID: item.AuthorID},
			int64(len(validated.SourceBody))-int64(len(item.SourceBody)),
		); err != nil {
			return Content{}, err
		}
	}

	item.Title = validated.Title
	item.Slug = validated.Slug
	if item.Slug == "" {
		item.Slug = SlugFromTitle(item.Title)
	}
	item.Summary = validated.Summary
	item.SourceFormat = validated.SourceFormat
	item.SourceBody = validated.SourceBody
	item.CategoryID = validated.CategoryID
	item.Tags = validated.Tags
	item.UpdatedAt = s.now()
	if err := s.applyAccessFields(ctx, &item, validated, false); err != nil {
		return Content{}, err
	}
	applySeoFields(&item, validated)
	// Scheduling only applies to a draft: a published item is already live, and a
	// pending/rejected item has to pass its review first.
	if validated.PublishAt != nil && item.Status != StatusDraft {
		return Content{}, ErrScheduleNotAllowed
	}
	if item.Status != StatusDraft {
		item.PublishAt = nil
		item.PublishAttempts = 0
	} else if err := s.applySchedule(ctx, actor, &item, validated.PublishAt, item.UpdatedAt); err != nil {
		// The scheduler may not have run yet for an instant that just passed. An
		// edit that keeps the existing schedule must still save, so the author can
		// fix the item instead of being locked out by a past timestamp.
		unchanged := validated.PublishAt != nil && item.PublishAt != nil &&
			validated.PublishAt.UTC().Truncate(time.Minute).Equal(item.PublishAt.UTC()) &&
			errors.Is(err, ErrInvalidInput)
		if !unchanged {
			return Content{}, err
		}
	}

	// A failed sanitization holds an unpublished draft for a retry, but it must
	// never take a live item offline: publishing an empty rendered body would be a
	// silent outage, so a published revision fails closed without being saved.
	// The word list runs before sanitization for the same reason as CreateDraft. A
	// review match only queues unpublished items: silently unpublishing a live
	// article because an editor fixed a typo would be a bigger harm than the word.
	safetyOutcome, safetyErr := s.applyContentSafety(ctx, &item)
	if safetyErr != nil {
		return Content{}, safetyErr
	}
	securityErr := s.applySanitization(ctx, &item)
	if safetyOutcome.Review && !wasPublished && item.Status == StatusDraft {
		item.Status = StatusPendingReview
	}
	// A review hold cancels the pending schedule; only a draft may be scheduled.
	if item.Status != StatusDraft {
		item.PublishAt = nil
		item.PublishAttempts = 0
	}
	if securityErr != nil && wasPublished {
		return Content{}, ErrSecurityUnavailable
	}

	auditDetail := map[string]any(nil)
	if safetyOutcome.Hit() {
		auditDetail = map[string]any{
			"content_safety": map[string]any{
				"matched": safetyOutcome.Matched,
				"action":  safetyOutcome.action(),
			},
		}
	}

	saved, err := s.repo.SaveDraft(ctx, item, site.AuditEntry{
		SiteID:  item.SiteID,
		ActorID: actor.UserID,
		Action:  "content.updated",
		Target:  item.ID,
		Detail:  auditDetail,
		At:      s.now(),
	})
	if err != nil {
		return Content{}, err
	}
	// A live item whose slug changed left its old address behind: a bookmarked or
	// crawled /a/old-slug URL must keep working, so a 301 is recorded through the
	// optional redirect port. The save has already committed, so a failed recording is
	// not turned into a failed edit; the rule can also be created by hand afterwards.
	if wasPublished {
		previous := item
		previous.Slug = previousSlug
		s.recordSlugChange(ctx, previous, saved)
	}
	return saved, securityErr
}

// Apply performs a workflow action on an item.
func (s *Service) Apply(ctx context.Context, actor Actor, contentID string, action Action, reason string) (Content, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return Content{}, err
	}

	mode, err := s.publishMode(ctx, item.SiteID)
	if err != nil {
		return Content{}, err
	}

	next, err := Policy{PublishMode: mode}.Next(item, action, actor)
	if err != nil {
		return Content{}, err
	}

	// A word added after the draft was written must not slip out through a publish
	// action. Reject mode refuses the transition; review mode downgrades it to the
	// moderation queue instead of publishing. Replace mode cannot rewrite stored text
	// at this point, so it leaves the transition alone.
	if next == StatusPublished {
		probe := item
		safetyOutcome, safetyErr := s.applyContentSafety(ctx, &probe)
		if safetyErr != nil {
			return Content{}, safetyErr
		}
		if safetyOutcome.Review {
			next = StatusPendingReview
		}
	}

	// Publication requires a revision that passed sanitization under the current
	// policy. Without it, publishing would serve unaudited HTML.
	if next == StatusPublished && !item.IsSanitized() {
		return Content{}, ErrSecurityUnavailable
	}

	now := s.now()
	updated := item
	updated.Status = next
	updated.UpdatedAt = now
	switch next {
	case StatusPublished:
		updated.PublishedAt = &now
		// A manual publish consumes the schedule: keeping it would let the
		// background publisher act on an item that is already live.
		updated.PublishAt = nil
		updated.PublishAttempts = 0
	case StatusArchived:
		updated.ArchivedAt = &now
		updated.PublishAt = nil
		updated.PublishAttempts = 0
	case StatusDraft:
		updated.PublishedAt = nil
		updated.ArchivedAt = nil
		updated.PublishAt = nil
		updated.PublishAttempts = 0
	case StatusPendingReview, StatusRejected:
		// A pending or rejected item is not schedulable, so a stale schedule is
		// cancelled with the transition.
		updated.PublishAt = nil
		updated.PublishAttempts = 0
	}

	detail := map[string]any{
		"from": string(item.Status),
		"to":   string(next),
	}
	if reason != "" {
		detail["reason"] = reason
	}

	saved, err := s.repo.Transition(ctx, updated, item.Status, site.AuditEntry{
		SiteID:  item.SiteID,
		ActorID: actor.UserID,
		Action:  "content." + string(action),
		Target:  item.ID,
		Detail:  detail,
		At:      now,
	})
	if err != nil {
		return Content{}, err
	}

	// Approval and rejection are the two decisions an author waits for. A self
	// decision (the author is also an editor) is not a notification, and a failed
	// notification must not turn a committed decision into an API error.
	if s.notifier != nil && item.AuthorID != "" && item.AuthorID != actor.UserID &&
		(next == StatusPublished || next == StatusRejected) {
		_ = s.notifier.NotifyReview(ctx, ReviewNotification{
			SiteID:    item.SiteID,
			UserID:    item.AuthorID,
			ActorID:   actor.UserID,
			ContentID: item.ID,
			Kind:      string(item.Kind),
			Title:     item.Title,
			Status:    next,
			Reason:    strings.TrimSpace(reason),
		})
	}
	return saved, nil
}

// RetrySecurityCheck re-runs sanitization on an item held for security review.
//
// On success the item returns to draft; on failure it stays held, so a retry loop
// cannot accidentally publish something that never passed the check.
func (s *Service) RetrySecurityCheck(ctx context.Context, actor Actor, contentID string) (Content, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return Content{}, err
	}
	if item.Status != StatusPendingSecurityCheck {
		return Content{}, ErrInvalidTransition
	}
	if !item.IsAuthor(actor) && !actor.Role.AtLeast(site.RoleEditor) {
		return Content{}, ErrPermissionDenied
	}

	return s.UpdateDraft(ctx, actor, contentID, DraftInput{
		Title:        item.Title,
		Slug:         item.Slug,
		Summary:      item.Summary,
		SourceFormat: item.SourceFormat,
		SourceBody:   item.SourceBody,
		CategoryID:   item.CategoryID,
		Tags:         item.Tags,
		// The retry re-saves the whole item, so the overrides travel with it: a
		// security retry must not silently drop the SEO and cover settings an editor
		// already saved.
		SeoTitle:       item.SeoTitle,
		SeoDescription: item.SeoDescription,
		SeoKeywords:    item.SeoKeywords,
		CanonicalURL:   item.CanonicalURL,
		OgImage:        item.OgImage,
		Robots:         item.Robots,
		CoverURL:       item.CoverURL,
		CoverAlt:       item.CoverAlt,
		CoverPosition:  item.CoverPosition,
		CoverHidden:    item.CoverHidden,
	})
}

// ListRevisions returns the newest history entries of an item.
//
// History exposes the raw source text, which may contain markup the sanitizer
// removed, so it is readable only by the item's author and by editors. Anyone
// else receives ErrNotFound rather than a permission error: the history must not
// confirm that a private item exists.
func (s *Service) ListRevisions(ctx context.Context, actor Actor, contentID string) ([]Revision, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return nil, err
	}
	if !canReadHistory(item, actor) {
		return nil, ErrNotFound
	}
	return s.repo.ListRevisions(ctx, actor.SiteID, contentID, RevisionRetention)
}

// GetRevision returns one full history snapshot, including its source body.
func (s *Service) GetRevision(ctx context.Context, actor Actor, contentID, revisionID string) (Revision, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return Revision{}, err
	}
	if !canReadHistory(item, actor) {
		return Revision{}, ErrNotFound
	}
	revision, err := s.repo.FindRevision(ctx, actor.SiteID, contentID, revisionID)
	if err != nil {
		return Revision{}, err
	}
	return revision, nil
}

// RestoreRevision rolls an item back to a stored history entry.
//
// The current state is snapshotted as a rollback_backup row before the target is
// applied, so a rollback can itself be undone, and the restored state is stored
// as the newest version. The workflow status is preserved: restoring text must
// not republish or archive the item behind an editor's back. Restoration goes
// through the same sanitizer as an ordinary save, and a published item is never
// taken offline by a failed check.
func (s *Service) RestoreRevision(
	ctx context.Context,
	actor Actor,
	contentID,
	revisionID string,
) (Content, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return Content{}, err
	}
	if !canReadHistory(item, actor) {
		return Content{}, ErrNotFound
	}
	if !editable(item.Status) {
		return Content{}, ErrInvalidTransition
	}

	target, err := s.repo.FindRevision(ctx, actor.SiteID, contentID, revisionID)
	if err != nil {
		return Content{}, err
	}

	now := s.now()
	backup := item.Snapshot(item.Revision+1, actor.UserID, RevisionRollbackBackup, now)

	restored := item
	restored.applyRevision(target)
	restored.UpdatedAt = now

	wasPublished := item.Status == StatusPublished
	securityErr := s.applySanitization(ctx, &restored)
	if securityErr != nil && wasPublished {
		return Content{}, ErrSecurityUnavailable
	}

	saved, err := s.repo.RestoreRevision(ctx, restored, backup, site.AuditEntry{
		SiteID:  item.SiteID,
		ActorID: actor.UserID,
		Action:  "content.rollback",
		Target:  item.ID,
		Detail:  map[string]any{"revision_id": target.ID, "version": target.Version},
		At:      now,
	})
	if err != nil {
		return Content{}, err
	}
	return saved, securityErr
}

// canReadHistory reports whether the actor may see an item's raw source history.
func canReadHistory(item Content, actor Actor) bool {
	return item.IsAuthor(actor) || actor.Role.AtLeast(site.RoleEditor)
}

// Actions reports what the actor may do to an item right now.
//
// The handler needs this to render affordances, and it must agree with Apply, so it
// runs the same policy with the site's real publish mode.
func (s *Service) Actions(ctx context.Context, actor Actor, item Content) ([]Action, error) {
	// A trashed item is not in the review state machine at all: no workflow move is
	// legal from the bin, so offering one would be a button that always fails. The
	// bin has its own two moves, decided by the lifecycle rule.
	if item.IsTrashed() {
		actions := make([]Action, 0, 2)
		if err := authorizeLifecycle(item, actor); err != nil {
			return actions, nil
		}
		return append(actions, ActionUndelete, ActionPurge), nil
	}

	mode, err := s.publishMode(ctx, item.SiteID)
	if err != nil {
		return nil, err
	}
	return Policy{PublishMode: mode}.AvailableActions(item, actor), nil
}

// Listing orders accepted by the list endpoints.
const (
	// SortNewest is the default order: most recent first.
	SortNewest = "newest"
	// SortOldest reads the same listing backwards: oldest first.
	SortOldest = "oldest"
)

// MaxTagFilterLength bounds the tag name a listing request may ask for.
//
// It sits above MaxTagLength, the storage bound, because the contract advertises the
// filter bound and a client should not have to know the per item one. A longer value
// cannot be a name this site ever stored, so it is refused rather than truncated into
// a different tag.
const MaxTagFilterLength = 40

// maxCategoryIDLength mirrors the column bound on content_item.category_id.
const maxCategoryIDLength = 36

// ListFilter narrows a listing query.
//
// The service fills SiteID, Kind, Statuses, After and Limit itself; the remaining
// fields are the caller's narrowing. Keeping both in one value means the repository
// has a single argument to read.
type ListFilter struct {
	SiteID string
	Kind   Kind
	// Statuses restricts the result; empty means every status the caller may see.
	Statuses []Status
	// AccessModes restricts the result to these access modes. Empty means every
	// mode; public listings always set it to public only.
	AccessModes []AccessMode
	// AuthorID restricts the result to one author.
	AuthorID string
	// CategoryID restricts the result to one category. Empty means any.
	CategoryID string
	// Tag restricts the result to items carrying this tag.
	Tag string
	// Since keeps items created at or after this instant. Zero means unbounded.
	Since time.Time
	// Sort picks the ordering: "newest" (default) or "oldest".
	Sort string
	// Trashed selects the recycle bin: only items carrying a delete marker are
	// returned, and the caller must be signed in. The zero value is the ordinary
	// listing, which excludes trashed items, so a caller that never sets this field
	// keeps the pre recycle bin behaviour exactly.
	Trashed bool
	// After is the page boundary; zero means the first page.
	After page.Cursor
	Limit int
}

// NormalizeTag turns a raw tag query value into the name the store may search for.
//
// The returned name never contains a double quote or a backslash. That is what makes
// the quoted token match in the repository safe: the value cannot break out of the
// JSON array text it is compared against. An empty result means the value is not a tag
// name at all —blank, too long, or carrying a character the JSON encoding would
// escape —and the caller must refuse it instead of dropping the filter, because a
// dropped filter would widen the page.
func NormalizeTag(raw string) string {
	name := strings.TrimSpace(raw)
	if name == "" || len([]rune(name)) > MaxTagFilterLength {
		return ""
	}
	if strings.ContainsAny(name, `"\`) {
		return ""
	}
	return name
}

// ValidateSort returns the ordering the repository understands.
//
// An empty value is the documented default rather than an error, so a client that
// sends no sort gets exactly the page it would get from "newest". Any other value is
// rejected: silently falling back would make a typo look like a working filter.
func ValidateSort(raw string) (string, error) {
	switch strings.TrimSpace(raw) {
	case "", SortNewest:
		return SortNewest, nil
	case SortOldest:
		return SortOldest, nil
	default:
		return "", fmt.Errorf("%w: unsupported sort", ErrInvalidInput)
	}
}

// listFilter merges the caller's narrowing with the fields the service owns.
//
// Site, kind, page size and page boundary describe the request, and visibility is
// decided here, so neither is taken from the caller: a filter that arrives with
// statuses set cannot widen what the actor may see.
func (s *Service) listFilter(
	actor Actor,
	kind Kind,
	limit int,
	after page.Cursor,
	narrow ListFilter,
) (ListFilter, error) {
	filter := ListFilter{
		SiteID:   actor.SiteID,
		Kind:     kind,
		AuthorID: strings.TrimSpace(narrow.AuthorID),
		After:    after,
		Limit:    limit,
	}

	if narrow.CategoryID != "" {
		categoryID := strings.TrimSpace(narrow.CategoryID)
		if len([]rune(categoryID)) > maxCategoryIDLength {
			return ListFilter{}, fmt.Errorf("%w: category id is malformed", ErrInvalidInput)
		}
		filter.CategoryID = categoryID
	}

	if narrow.Tag != "" {
		tag := NormalizeTag(narrow.Tag)
		if tag == "" {
			return ListFilter{}, fmt.Errorf("%w: tag is malformed", ErrInvalidInput)
		}
		filter.Tag = tag
	}

	filter.Since = narrow.Since

	sort, err := ValidateSort(narrow.Sort)
	if err != nil {
		return ListFilter{}, err
	}
	filter.Sort = sort

	// The recycle bin is an authoring surface, not a reader one: it lists what nobody
	// may read any more, so the published/public visibility rule below must not apply
	// to it. A signed-in member keeps exactly the live listing's authorship rule -
	// their own rows only - while an editor sees the whole site. Who is allowed to ask
	// at all is decided by the callers through canListTrash.
	if narrow.Trashed {
		filter.Trashed = true
		if !actor.Role.AtLeast(site.RoleEditor) {
			filter.AuthorID = actor.UserID
		}
		return filter, nil
	}

	// Visibility is recomputed, never inherited from the caller's filter.
	if !actor.Role.AtLeast(site.RoleEditor) {
		filter.Statuses = []Status{StatusPublished}
		// Password and members-only items are direct-link-only: they are excluded
		// from every listing surface so a reader cannot discover them by browsing.
		filter.AccessModes = []AccessMode{AccessPublic}
	}

	return filter, nil
}

// ListAfter returns one page of visible items plus the cursor for the next page.
//
// The cursor is only issued when a full page came back: a short page means the end,
// and handing out a cursor there would make the client ask for an empty page.
func (s *Service) ListAfter(
	ctx context.Context,
	actor Actor,
	kind Kind,
	limit int,
	after page.Cursor,
) ([]Content, string, error) {
	return s.ListAfterFilter(ctx, actor, kind, limit, after, ListFilter{})
}

// canListTrash reports whether the actor may list the recycle bin.
//
// Listing the bin is an authoring surface, so it needs write_content, which in the
// role model means a signed-in account. A caller without it is answered with the empty
// page a site with nothing trashed would produce rather than a 403: a listing never
// confirms what exists on a site, and a 403 would tell every anonymous visitor that
// this site has a recycle bin to ask for.
func canListTrash(actor Actor) bool { return actor.UserID != "" }

// ListAfterFilter is ListAfter narrowed by the caller's query filters.
//
// It backs the public listing and the author archive (/u/{userID}): the visibility
// rules stay exactly those of ListAfter, so a reader only ever gets published items
// while a moderator may also see the author's queue. The narrowing values are plain
// filter values, not validated resources: an unknown author or category simply matches
// nothing, which is why a stale archive link yields an empty page instead of an error.
func (s *Service) ListAfterFilter(
	ctx context.Context,
	actor Actor,
	kind Kind,
	limit int,
	after page.Cursor,
	narrow ListFilter,
) ([]Content, string, error) {
	if kind != "" && !kind.Valid() {
		return nil, "", ErrInvalidInput
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	if narrow.Trashed && !canListTrash(actor) {
		return []Content{}, "", nil
	}

	filter, err := s.listFilter(actor, kind, limit, after, narrow)
	if err != nil {
		return nil, "", err
	}

	items, err := s.repo.List(ctx, filter)
	if err != nil {
		return nil, "", err
	}

	next := ""
	if len(items) == limit && len(items) > 0 {
		last := items[len(items)-1]
		next = page.Cursor{Key: last.CreatedAt.UTC().Format(time.RFC3339Nano), ID: last.ID}.Encode()
	}
	return items, next, nil
}

// List returns the items of a site that the actor is allowed to see.
//
// Visibility is decided here, not by the caller: anonymous and ordinary readers only
// ever get published items, while an author additionally sees their own work and a
// moderator sees everything on the site. narrow carries the optional query filters;
// the fields the service owns are overwritten, so a filter can only narrow the page.
func (s *Service) List(
	ctx context.Context,
	actor Actor,
	kind Kind,
	limit int,
	narrow ListFilter,
) ([]Content, error) {
	if kind != "" && !kind.Valid() {
		return nil, ErrInvalidInput
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	if narrow.Trashed && !canListTrash(actor) {
		return []Content{}, nil
	}

	filter, err := s.listFilter(actor, kind, limit, page.Cursor{}, narrow)
	if err != nil {
		return nil, err
	}

	return s.repo.List(ctx, filter)
}

// ListOwn returns the caller's own items in every state.
func (s *Service) ListOwn(ctx context.Context, actor Actor, kind Kind, limit int) ([]Content, error) {
	if kind != "" && !kind.Valid() {
		return nil, ErrInvalidInput
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	return s.repo.List(ctx, ListFilter{
		SiteID:   actor.SiteID,
		Kind:     kind,
		AuthorID: actor.UserID,
		Limit:    limit,
	})
}

// SearchQuery bounds a search term.
const (
	// MinSearchTerm is the shortest term worth a query.
	MinSearchTerm = 2
	// MaxSearchTerm bounds the term so a pathological input cannot be indexed.
	MaxSearchTerm = 100
	// DefaultSearchLimit is the page size for search.
	DefaultSearchLimit = 20
)

// Search finds published public content by title, summary or body.
//
// Only published, public items are searched: a draft or a password/members-only
// item leaking through search would be the same disclosure the read endpoint
// exists to prevent (C-18). The term is trimmed, bounded and normalized here so
// the repository never receives an unbounded pattern, and a term made only of
// punctuation yields an empty page rather than an error.
func (s *Service) Search(ctx context.Context, actor Actor, query SearchQuery) (SearchResult, error) {
	if query.Kind != "" && !query.Kind.Valid() {
		return SearchResult{}, ErrInvalidInput
	}

	term := strings.TrimSpace(query.Term)
	if len([]rune(term)) < MinSearchTerm {
		return SearchResult{}, ErrInvalidInput
	}
	if len([]rune(term)) > MaxSearchTerm {
		term = string([]rune(term)[:MaxSearchTerm])
	}
	if !query.Until.IsZero() && !query.Since.IsZero() && query.Until.Before(query.Since) {
		return SearchResult{}, fmt.Errorf("%w: until is before since", ErrInvalidInput)
	}

	categoryID := strings.TrimSpace(query.CategoryID)
	if len([]rune(categoryID)) > maxCategoryIDLength {
		return SearchResult{}, fmt.Errorf("%w: category id is malformed", ErrInvalidInput)
	}
	tag := ""
	if raw := strings.TrimSpace(query.Tag); raw != "" {
		tag = NormalizeTag(raw)
		if tag == "" {
			return SearchResult{}, fmt.Errorf("%w: tag is malformed", ErrInvalidInput)
		}
	}

	limit := query.Limit
	if limit <= 0 || limit > 100 {
		limit = DefaultSearchLimit
	}

	// Punctuation-only terms have no searchable token. Returning an empty page
	// keeps the endpoint total and avoids a match-everything prefix query.
	if !SearchHasTokens(term) {
		return SearchResult{Hits: []SearchHit{}}, nil
	}

	pageResult, err := s.repo.Search(ctx, SearchFilter{
		SiteID:     actor.SiteID,
		Term:       term,
		Kind:       query.Kind,
		CategoryID: categoryID,
		Tag:        tag,
		AuthorID:   strings.TrimSpace(query.AuthorID),
		Since:      query.Since,
		Until:      query.Until,
		After:      query.After,
		Limit:      limit,
	})
	if err != nil {
		return SearchResult{}, err
	}

	hits := make([]SearchHit, 0, len(pageResult.Items))
	for _, item := range pageResult.Items {
		hit := SearchHit{Content: item}
		if query.Highlight {
			body := PlainText(item.RenderedHTML, item.SourceBody, item.SourceFormat)
			hit.Snippet = SearchSnippet(body, term, 160)
			if hit.Snippet == "" {
				hit.Snippet = SearchSnippet(item.Summary, term, 160)
			}
		}
		hits = append(hits, hit)
	}

	return SearchResult{
		Hits:       hits,
		Total:      pageResult.Total,
		NextCursor: pageResult.NextCursor,
		Degraded:   pageResult.Degraded,
	}, nil
}

// Get returns one item, restricted to what the actor may read.
//
// It is the internal read used by moderation and other services: a password
// protected item is returned because those callers are authors or moderators.
// The public read path goes through Read, which also carries the session grant.
func (s *Service) Get(ctx context.Context, actor Actor, contentID string) (Content, error) {
	return s.Read(ctx, actor, contentID, false)
}

// Read returns one item for a reader that may have unlocked it in this session.
//
// Visibility order is deliberate:
//   - unpublished content is only visible to its author and to moderators, and
//     anyone else receives ErrNotFound so its existence is not disclosed;
//   - the author and moderators always may read their own item;
//   - public items are readable by everyone;
//   - members-only items need a signed in caller;
//   - password items need the session grant the unlock endpoint issues.
func (s *Service) Read(ctx context.Context, actor Actor, contentID string, unlocked bool) (Content, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return Content{}, err
	}
	if err := readableBy(item, actor, unlocked); err != nil {
		return Content{}, err
	}
	return item, nil
}

// readableBy applies the read access rules to a loaded item.
func readableBy(item Content, actor Actor, unlocked bool) error {
	return readableWithPreview(item, actor, unlocked, false)
}

// readableWithPreview applies the read rules, optionally with a valid preview grant.
//
// A preview bypasses exactly one rule: unpublished status. The access mode still
// applies, because a preview link is a shareable URL and must not turn a password or
// members-only draft into a public page. A privileged caller (author or editor) keeps
// its unconditional access as before.
func readableWithPreview(item Content, actor Actor, unlocked, preview bool) error {
	privileged := item.IsAuthor(actor) || actor.Role.AtLeast(site.RoleEditor)
	if privileged {
		return nil
	}
	if !item.Status.IsPublic() && !preview {
		// Unpublished content is visible to its author and to moderators only.
		return ErrNotFound
	}
	switch item.AccessMode {
	case AccessPassword:
		if !unlocked {
			return ErrPasswordRequired
		}
	case AccessMembers:
		if actor.UserID == "" {
			return ErrMembersOnly
		}
	}
	return nil
}

// applyContentSafety runs the sensitive word list over the three author supplied
// text fields and rewrites replace-mode matches in place.
//
// The fields are evaluated separately so a replacement never spans a field boundary
// and a hit in the title is audited with the title's own text context. A reject match
// returns safety.ErrRejected and leaves the mutation to the caller's undo (the item
// is not saved).
func (s *Service) applyContentSafety(ctx context.Context, item *Content) (safetyResult, error) {
	if s.guard == nil {
		return safetyResult{}, nil
	}
	result := safetyResult{}
	fields := []*string{&item.Title, &item.Summary, &item.SourceBody}
	for _, field := range fields {
		verdict, err := s.guard.CheckText(ctx, item.SiteID, *field)
		if err != nil {
			return result, err
		}
		if verdict.Hit() {
			result.Matched = append(result.Matched, verdict.Matched...)
		}
		if verdict.RequiresReview() {
			result.Review = true
		}
		*field = verdict.Text
	}
	return result, nil
}

// applySanitization fills the rendered HTML or marks the item as held.
func (s *Service) applySanitization(ctx context.Context, item *Content) error {
	format := item.SourceFormat
	source := item.SourceBody

	// Markdown is expanded to HTML first: the sanitizer cleans markup, it does not
	// parse a markdown dialect. Plain and HTML already reach it in their final shape.
	if format == FormatMarkdown {
		rendered, err := renderMarkdown(source)
		if err != nil {
			return fmt.Errorf("render markdown: %w", err)
		}
		format, source = FormatHTML, rendered
	}

	result, err := s.sanitizer.Sanitize(ctx, format, source)
	if err != nil {
		// Fail closed: keep the item, drop any previously rendered HTML, and hold it.
		item.Status = StatusPendingSecurityCheck
		item.RenderedHTML = ""
		item.PolicyVersion = ""
		return ErrSecurityUnavailable
	}

	item.RenderedHTML = result.HTML
	item.PolicyVersion = result.PolicyVersion
	if item.Status == StatusPendingSecurityCheck {
		item.Status = StatusDraft
	}
	return nil
}

func (s *Service) load(ctx context.Context, actor Actor, contentID string) (Content, error) {
	item, err := s.repo.FindByID(ctx, actor.SiteID, contentID)
	if err != nil {
		return Content{}, err
	}
	if item.SiteID != actor.SiteID {
		// The repository already scopes by site; this is defence in depth.
		return Content{}, ErrCrossSite
	}
	return item, nil
}

// IsSanitized reports whether the item carries HTML produced by a security policy.
func (c Content) IsSanitized() bool {
	return c.RenderedHTML != "" && c.PolicyVersion != ""
}

// applySeoFields copies the validated SEO and cover overrides onto the item.
//
// It writes every field on every save, including the empty ones: the request carries
// the whole table, so an empty value is the client clearing an override and falling
// back to the site template. Keeping that in one function is what stops a create and
// an update from disagreeing about which fields they persist.
func applySeoFields(item *Content, in DraftInput) {
	item.SeoTitle = in.SeoTitle
	item.SeoDescription = in.SeoDescription
	item.SeoKeywords = in.SeoKeywords
	item.CanonicalURL = in.CanonicalURL
	item.OgImage = in.OgImage
	item.Robots = in.Robots
	item.CoverURL = in.CoverURL
	item.CoverAlt = in.CoverAlt
	item.CoverPosition = in.CoverPosition
	item.CoverHidden = in.CoverHidden
}

// editable reports whether a save may write to the item in this state.
//
// Published content stays editable: a correction is a save that keeps the item
// live while the previous state is preserved in its revision history.
func editable(status Status) bool {
	switch status {
	case StatusDraft, StatusRejected, StatusPendingSecurityCheck, StatusPublished:
		return true
	default:
		return false
	}
}
