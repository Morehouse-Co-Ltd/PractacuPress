// Package content holds the content aggregate: articles and posts, their
// revisions, and the review state machine that decides when content may be shown.
//
// The state machine is data, not branching code: every allowed move is one row in
// the workflow table below. That is what makes "can a member publish directly?"
// answerable from the table instead of from whichever handler happens to run.
package content

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
)

// Kind distinguishes the two content types.
type Kind string

// Supported kinds.
const (
	KindArticle Kind = "article"
	KindPost    Kind = "post"
)

// Valid reports whether the kind is defined.
func (k Kind) Valid() bool { return k == KindArticle || k == KindPost }

// Status is a position in the review state machine.
type Status string

// The states an item can be in (design §5.2).
const (
	StatusDraft                Status = "draft"
	StatusPendingReview        Status = "pending_review"
	StatusPublished            Status = "published"
	StatusRejected             Status = "rejected"
	StatusArchived             Status = "archived"
	StatusPendingSecurityCheck Status = "pending_security_check"
)

// Valid reports whether the status is defined.
func (s Status) Valid() bool {
	switch s {
	case StatusDraft, StatusPendingReview, StatusPublished,
		StatusRejected, StatusArchived, StatusPendingSecurityCheck:
		return true
	default:
		return false
	}
}

// IsPublic reports whether the status is readable by anonymous visitors.
func (s Status) IsPublic() bool { return s == StatusPublished }

// AccessMode decides who may read a published item (C-18).
type AccessMode string

// The access modes.
const (
	// AccessPublic is the ordinary, every visitor may read mode.
	AccessPublic AccessMode = "public"
	// AccessPassword requires the visitor to unlock the item with its password.
	// Password protected items never appear in listings, search, feeds or sitemaps.
	AccessPassword AccessMode = "password"
	// AccessMembers requires a signed in reader. Like password mode it is a direct
	// link only mode: it never appears in a public listing or crawler file.
	AccessMembers AccessMode = "members"
)

// Valid reports whether the access mode is defined.
func (m AccessMode) Valid() bool {
	return m == AccessPublic || m == AccessPassword || m == AccessMembers
}

// CommentPolicy is the per item override of the site comment switches (C-19).
type CommentPolicy string

// The per item comment policies.
const (
	// CommentPolicyInherit follows the site level switches.
	CommentPolicyInherit CommentPolicy = "inherit"
	// CommentPolicyOpen opens comments even when the site closed them.
	CommentPolicyOpen CommentPolicy = "open"
	// CommentPolicyDisabled closes comments for this item.
	CommentPolicyDisabled CommentPolicy = "disabled"
	// CommentPolicyReview sends new comments to the moderation queue.
	CommentPolicyReview CommentPolicy = "review"
)

// Valid reports whether the comment policy is defined.
func (p CommentPolicy) Valid() bool {
	switch p {
	case CommentPolicyInherit, CommentPolicyOpen, CommentPolicyDisabled, CommentPolicyReview:
		return true
	default:
		return false
	}
}

// Robots is the per item crawler directive (C-29).
type Robots string

// The crawler directives an item may carry.
const (
	// RobotsInherit follows the site level indexing switch.
	RobotsInherit Robots = ""
	// RobotsIndex keeps the item indexable even when the site default says otherwise.
	RobotsIndex Robots = "index"
	// RobotsNoIndex keeps the item out of crawler files and marks its page noindex.
	RobotsNoIndex Robots = "noindex"
)

// Valid reports whether the directive is defined.
func (r Robots) Valid() bool {
	return r == RobotsInherit || r == RobotsIndex || r == RobotsNoIndex
}

// NoIndex reports whether the item asks crawlers to skip it.
func (r Robots) NoIndex() bool { return r == RobotsNoIndex }

// CoverPosition is the focal point of a cover image.
type CoverPosition string

// The supported focal points.
const (
	CoverTop    CoverPosition = "top"
	CoverCenter CoverPosition = "center"
	CoverBottom CoverPosition = "bottom"
)

// Valid reports whether the focal point is defined.
func (p CoverPosition) Valid() bool {
	return p == CoverTop || p == CoverCenter || p == CoverBottom
}

// Bounds on an access password.
const (
	// MinAccessPasswordLength is the shortest access password accepted.
	MinAccessPasswordLength = 4
	// MaxAccessPasswordLength bounds the plaintext before hashing.
	MaxAccessPasswordLength = 128
)

// ScheduledPublicationBounds controls the background publisher (C-17).
const (
	// ScheduledPublishBatch caps how many due items one tick handles.
	ScheduledPublishBatch = 50
	// MaxScheduledPublishAttempts is the retry bound after which the schedule is
	// cancelled instead of being retried on every tick.
	MaxScheduledPublishAttempts = 3
)

// SourceFormat is the format the author wrote in.
type SourceFormat string

// Supported source formats.
const (
	FormatMarkdown SourceFormat = "markdown"
	FormatHTML     SourceFormat = "html"
	FormatPlain    SourceFormat = "plain"
)

// Valid reports whether the format is defined.
func (f SourceFormat) Valid() bool {
	return f == FormatMarkdown || f == FormatHTML || f == FormatPlain
}

// Action is a requested state change.
type Action string

// The workflow actions.
const (
	ActionSubmit  Action = "submit"
	ActionPublish Action = "publish"
	// ActionUnpublish withdraws a live item back to draft (Beta 1.2 contract I): the
	// published_at stamp is cleared and the item returns to the editor under its
	// current revision. It is deliberately not the same verb as delete: the row stays
	// addressable and the history is untouched.
	ActionUnpublish Action = "unpublish"
	ActionReject    Action = "reject"
	ActionArchive   Action = "archive"
	ActionRestore   Action = "restore"
)

// The lifecycle actions.
//
// They are deliberately kept out of the workflow table: deleting an item is
// orthogonal to where it sits in the review state machine (a published and a draft
// item can both be trashed), so a transition row would have to be duplicated for
// every status. They are decided by authorizeLifecycle instead, and they live in the
// separate recycle bin vocabulary the client switches on.
const (
	// ActionDelete moves an item into the recycle bin.
	ActionDelete Action = "delete"
	// ActionUndelete restores an item from the recycle bin.
	ActionUndelete Action = "undelete"
	// ActionPurge destroys a trashed item and its history for good.
	ActionPurge Action = "purge"
)

// Sentinel errors.
var (
	// ErrInvalidTransition means the action is not available from the current state.
	ErrInvalidTransition = errors.New("content: invalid state transition")
	// ErrPermissionDenied means the actor may not perform the action on this item.
	ErrPermissionDenied = errors.New("content: permission denied")
	// ErrCrossSite means the item belongs to another site.
	ErrCrossSite = errors.New("content: cross site access")
	// ErrReviewRequired means the publish mode requires review first.
	ErrReviewRequired = errors.New("content: review required before publishing")
	// ErrInvalidInput means a field failed validation.
	ErrInvalidInput = errors.New("content: invalid input")
	// ErrNotFound means the item does not exist.
	ErrNotFound = errors.New("content: not found")
	// ErrSecurityUnavailable means sanitization could not be performed, so the item
	// must stay held rather than be published unaudited.
	ErrSecurityUnavailable = errors.New("content: security check unavailable")
	// ErrQuotaExceeded means the author already has as many active drafts, or as many
	// bytes of active draft source, as the account quota allows (V-06).
	ErrQuotaExceeded = errors.New("content: draft quota exceeded")
	// ErrConflict means the stored item changed after it was read, so the write was
	// refused instead of silently overwriting a newer revision.
	ErrConflict = errors.New("content: concurrent modification")
	// ErrPasswordRequired means the item is password protected and this request has
	// not been unlocked in the current browser session.
	ErrPasswordRequired = errors.New("content: password required")
	// ErrMembersOnly means the item is readable only by signed in members.
	ErrMembersOnly = errors.New("content: members only")
	// ErrInvalidPassword means the unlock attempt used the wrong password.
	ErrInvalidPassword = errors.New("content: invalid password")
	// ErrUnlockLocked means too many failed unlock attempts; the caller must wait.
	ErrUnlockLocked = errors.New("content: unlock locked")
	// ErrPasswordNotSet means password access was requested without a stored hash.
	ErrPasswordNotSet = errors.New("content: access password not set")
	// ErrAccessPasswordRequired means access mode password needs a password.
	ErrAccessPasswordRequired = errors.New("content: access password required")
	// ErrScheduleNotAllowed means the caller may not publish directly, so it may not
	// schedule a publication either.
	ErrScheduleNotAllowed = errors.New("content: schedule not allowed")
	// ErrPreviewUnavailable means the preview signer was not wired, so no draft
	// preview link can be minted on this deployment.
	ErrPreviewUnavailable = errors.New("content: preview signing unavailable")
)

// VersionConflictError reports a save that carried a stale revision token (Beta 1.2
// contract F).
//
// Current is the stored revision the client has to reload before retrying; the HTTP
// layer exposes it as details.current_revision under the content_version_conflict
// code.
type VersionConflictError struct {
	Current int
}

// Error implements the error interface.
func (e *VersionConflictError) Error() string { return "content: version conflict" }

// Unwrap makes a revision conflict matchable as the package's general ErrConflict.
func (e *VersionConflictError) Unwrap() error { return ErrConflict }

// RevisionRetention bounds the history kept per item (C-20 keeps 20 versions).
const RevisionRetention = 20

// Recycle bin retention.
const (
	// TrashRetentionDays is how long a trashed item stays recoverable. The value is
	// a product promise, not a cache TTL: a longer window means the site keeps
	// deleted bodies and their media references around for that much longer, so it
	// is fixed here and swept by ProcessTrashRetention rather than left to a caller.
	TrashRetentionDays = 30
	// TrashRetentionBatch bounds one retention pass. A large backlog must not hold a
	// single write transaction open; the scheduler calls the sweep again on its next
	// tick, so the bound only affects how fast a backlog drains.
	TrashRetentionBatch = 100
)

// RevisionAction records which write produced a history snapshot.
type RevisionAction string

// The writes that create a history entry.
const (
	RevisionCreated        RevisionAction = "created"
	RevisionUpdated        RevisionAction = "updated"
	RevisionRollbackBackup RevisionAction = "rollback_backup"
	RevisionRollback       RevisionAction = "rollback"
)

// Per-author draft quotas.
//
// They bound the cheap-growth attack from the audit: registration is open, so without
// quotas one account can grow the database and the review queue without limit. A
// published or archived item is no longer counted: it already passed the review
// process, which is the natural place to bound storage.
const (
	// MaxActiveDraftsPerAuthor bounds the number of editable draft states per author
	// and site.
	MaxActiveDraftsPerAuthor = 200
	// MaxActiveDraftBytesPerAuthor bounds the total source bytes of those drafts.
	MaxActiveDraftBytesPerAuthor int64 = 20 << 20 // 20 MiB
)

// Bounds on caller supplied content.
const (
	// MaxTitleLength bounds a title.
	MaxTitleLength = 200
	// MaxSummaryLength bounds a summary.
	MaxSummaryLength = 500
	// MaxSourceLength bounds the source body, in characters.
	MaxSourceLength = 200_000
	// MaxSlugLength bounds a slug.
	MaxSlugLength = 120
	// MaxTags bounds the number of labels attached to one item.
	MaxTags = 12
	// MaxTagLength bounds one label.
	MaxTagLength = 24
	// MaxSeoKeywordsLength bounds the comma separated keyword hint. The value is
	// stored verbatim and never split server side, so the bound guards storage only.
	MaxSeoKeywordsLength = 500
	// MaxURLLength bounds the canonical URL override. It matches the column bound and
	// is generous enough for a signed media URL; the two image fields are unbounded
	// text on purpose, because a cover or share card may be an inline data URL.
	MaxURLLength = 500
	// MaxCoverAltLength bounds the cover's alternative text.
	MaxCoverAltLength = 200
)

// slugPattern admits Unicode letters, digits and combining marks so a Chinese or
// accented title can be used verbatim as the public address. Hyphens are only
// separators: leading, trailing and doubled hyphens stay invalid.
var slugPattern = regexp.MustCompile(`^[\p{L}\p{N}\p{M}]+(?:-[\p{L}\p{N}\p{M}]+)*$`)

// invalidField builds a field error that stays matchable as ErrInvalidInput.
//
// Both sentinels are wrapped: errors.Is(err, ErrInvalidInput) keeps working for the
// transport, while errors.As(err, &FieldError) recovers the field and rule the client
// translates. FieldError itself lives in the error model package and cannot reference
// this package's sentinel without an import cycle, which is why the wrapping happens
// here rather than in an Unwrap method.
func invalidField(field, rule, reason string) error {
	return fmt.Errorf("%w: %w", ErrInvalidInput, &apperr.FieldError{
		Field:  field,
		Rule:   rule,
		Reason: reason,
	})
}

// Actor is the caller performing a content action.
type Actor struct {
	UserID string
	SiteID string
	Role   site.Role
}

// Content is one article or post.
type Content struct {
	ID            string
	SiteID        string
	AuthorID      string
	Kind          Kind
	Status        Status
	Title         string
	Slug          string
	Summary       string
	SourceFormat  SourceFormat
	SourceBody    string
	RenderedHTML  string
	PolicyVersion string
	CategoryID    string
	Tags          []string
	PublishedAt   *time.Time
	ArchivedAt    *time.Time
	// DeletedAt is the recycle bin marker: nil means the item is live, any value
	// means it is trashed. Soft delete is the only delete an author can reach, so a
	// mistaken removal stays recoverable for TrashRetentionDays; only Purge destroys
	// the row, and every read path filters on this marker.
	DeletedAt *time.Time
	// PublishAt is the scheduled publication instant (C-17). The scheduler claims
	// due drafts; a manual publish clears it.
	PublishAt *time.Time
	// PublishAttempts counts failed scheduler passes for a scheduled draft.
	PublishAttempts int
	// AccessMode decides who may read the published item (C-18).
	AccessMode AccessMode
	// AccessPasswordHash is the Argon2id hash of the access password. It is never
	// returned to a client.
	AccessPasswordHash string
	// CommentPolicy overrides the site comment switches for this item (C-19).
	CommentPolicy CommentPolicy
	// ViewCount is the de-duplicated number of reads of the published item
	// (FSD A-16). It is a counter on the row, not a derived aggregate: see views.go
	// for why it is not computed from the page_view ledger.
	ViewCount int
	CreatedAt time.Time
	UpdatedAt time.Time
	// Revision is the current version number. It starts at 1 for a newly created
	// item and increments on every save; the history table uses the same number.
	Revision int

	// The SEO overrides (C-29). An empty value means "inherit the site template", so
	// an item that never touches them renders exactly as it did before they existed.
	// They are not part of the revision snapshot: history restores text, and silently
	// reverting a canonical URL or a noindex decision alongside it would be a
	// crawler facing side effect nobody asked for.
	SeoTitle       string
	SeoDescription string
	SeoKeywords    string
	CanonicalURL   string
	OgImage        string
	// Robots is the per item crawler directive. The empty value inherits the site
	// switch; noindex keeps the item out of the sitemap and marks its page noindex.
	Robots Robots
	// The cover belongs to the item rather than to the site design document, so it
	// survives an export, a feed entry and a share card.
	CoverURL      string
	CoverAlt      string
	CoverPosition CoverPosition
	CoverHidden   bool
}

// Revision is one immutable snapshot of a Content item.
//
// The snapshot copies every author editable field plus the rendered output, so a
// historical version can be reviewed and restored without reading the live item.
type Revision struct {
	ID            string
	SiteID        string
	ContentID     string
	Version       int
	EditorID      string
	EditorName    string
	Action        RevisionAction
	Status        Status
	Title         string
	Slug          string
	Summary       string
	SourceFormat  SourceFormat
	SourceBody    string
	RenderedHTML  string
	PolicyVersion string
	CategoryID    string
	Tags          []string
	CreatedAt     time.Time
}

// snapshot builds a history entry from the item's current state.
func (c Content) Snapshot(version int, editorID string, action RevisionAction, at time.Time) Revision {
	return Revision{
		SiteID:        c.SiteID,
		ContentID:     c.ID,
		Version:       version,
		EditorID:      editorID,
		Action:        action,
		Status:        c.Status,
		Title:         c.Title,
		Slug:          c.Slug,
		Summary:       c.Summary,
		SourceFormat:  c.SourceFormat,
		SourceBody:    c.SourceBody,
		RenderedHTML:  c.RenderedHTML,
		PolicyVersion: c.PolicyVersion,
		CategoryID:    c.CategoryID,
		Tags:          c.Tags,
		CreatedAt:     at,
	}
}

// applyRevision copies the author editable fields of a snapshot onto the item.
//
// The workflow status is deliberately not copied: restoring an old text must not
// silently republish or archive the item, so the caller keeps its current state.
func (c *Content) applyRevision(rev Revision) {
	c.Title = rev.Title
	c.Slug = rev.Slug
	c.Summary = rev.Summary
	c.SourceFormat = rev.SourceFormat
	c.SourceBody = rev.SourceBody
	c.CategoryID = rev.CategoryID
	c.Tags = rev.Tags
}

// IsAuthor reports whether the actor wrote this item.
func (c Content) IsAuthor(actor Actor) bool { return c.AuthorID == actor.UserID }

// IsTrashed reports whether the item sits in the recycle bin.
func (c Content) IsTrashed() bool { return c.DeletedAt != nil }

// IsPasswordProtected reports whether reading the item needs its access password.
func (c Content) IsPasswordProtected() bool { return c.AccessMode == AccessPassword }

// IsMembersOnly reports whether reading the item requires a signed in member.
func (c Content) IsMembersOnly() bool { return c.AccessMode == AccessMembers }

// IsScheduled reports whether a draft carries a pending publication instant.
func (c Content) IsScheduled() bool {
	return c.Status == StatusDraft && c.PublishAt != nil
}

// EffectiveCommentSettings resolves the item's comment policy against the site
// switches. It is the same rule the community service applies, exposed so the
// content response and the reader UI cannot drift from the server.
func (c Content) EffectiveCommentSettings(siteEnabled, siteReview bool) (enabled, requireReview bool) {
	enabled, requireReview = siteEnabled, siteReview
	switch c.CommentPolicy {
	case CommentPolicyOpen:
		enabled, requireReview = true, false
	case CommentPolicyDisabled:
		enabled, requireReview = false, false
	case CommentPolicyReview:
		enabled, requireReview = true, true
	}
	return enabled, requireReview
}

// DraftInput is a create or update request.
type DraftInput struct {
	Title        string
	Slug         string
	Summary      string
	SourceFormat SourceFormat
	SourceBody   string
	CategoryID   string
	Tags         []string
	// PublishAt schedules a publication. Nil means "no schedule" and, on an update,
	// removes an existing one.
	PublishAt *time.Time
	// AccessMode is empty on an update that keeps the stored mode; an empty value
	// on create means AccessPublic.
	AccessMode AccessMode
	// AccessPassword is the plaintext new access password. Empty keeps the stored
	// hash; switching away from AccessPassword clears it.
	AccessPassword string
	// CommentPolicy is empty on an update that keeps the stored policy; an empty
	// value on create means CommentPolicyInherit.
	CommentPolicy CommentPolicy
	// The SEO and cover overrides use replace semantics, not merge: a save always
	// carries the whole table, so an empty value means "clear the override and inherit
	// the site default again". That is what makes the field removable from the editor
	// without a second, "unset this one" endpoint.
	SeoTitle       string
	SeoDescription string
	SeoKeywords    string
	CanonicalURL   string
	OgImage        string
	Robots         Robots
	CoverURL       string
	CoverAlt       string
	CoverPosition  CoverPosition
	CoverHidden    bool
	// Revision is the optional optimistic concurrency token of a PATCH (Beta 1.2
	// contract F). Nil keeps the historical last-write-wins behaviour; a non nil value
	// that does not match the stored revision is refused as a conflict instead of
	// overwriting an editor's newer save. It is never persisted as a form field.
	Revision *int
}

// Transition is one row of the workflow table.
type Transition struct {
	Action Action
	From   Status
	To     Status
	// NeedsPublishRight marks the move that skips review, so the publish mode can
	// veto it without hard coding the mode into the table.
	NeedsPublishRight bool
}

// workflow is the complete set of allowed moves (design §5.2).
//
// rejected -> draft is expressed as submit from rejected, because the next state a
// rejected item reaches when revised is review again, not draft.
var workflow = []Transition{
	{Action: ActionSubmit, From: StatusDraft, To: StatusPendingReview},
	{Action: ActionSubmit, From: StatusRejected, To: StatusPendingReview},
	{Action: ActionSubmit, From: StatusPendingSecurityCheck, To: StatusPendingReview},

	{Action: ActionPublish, From: StatusPendingReview, To: StatusPublished},
	{Action: ActionPublish, From: StatusDraft, To: StatusPublished, NeedsPublishRight: true},

	// Withdrawing a live item returns it to draft and clears published_at, so the
	// next publish is an ordinary transition from draft again. It does not need the
	// publish right: the authority to take a page down is decided by
	// authorizeAction (author or editor), not by the ability to skip review.
	{Action: ActionUnpublish, From: StatusPublished, To: StatusDraft},

	{Action: ActionReject, From: StatusPendingReview, To: StatusRejected},
	{Action: ActionArchive, From: StatusPublished, To: StatusArchived},
	{Action: ActionRestore, From: StatusArchived, To: StatusDraft},
}

// Policy is the site level publishing rule set.
type Policy struct {
	PublishMode site.PublishMode
}

// CanPublishDirectly reports whether a role may skip review.
//
// Open publishing lets any member publish. Review and role based modes both require
// at least an editor, because in those modes publication is itself a moderation act.
func CanPublishDirectly(mode site.PublishMode, role site.Role) bool {
	if mode == site.PublishModeOpen {
		return role.AtLeast(site.RoleMember)
	}
	return role.AtLeast(site.RoleEditor)
}

// Next returns the status an action moves the item to.
//
// It checks, in order: site isolation, that the move exists, that the publish mode
// allows skipping review, and finally that this actor may perform the action.
func (p Policy) Next(item Content, action Action, actor Actor) (Status, error) {
	if item.SiteID != actor.SiteID {
		return "", ErrCrossSite
	}

	for _, transition := range workflow {
		if transition.Action != action || transition.From != item.Status {
			continue
		}

		if transition.NeedsPublishRight && !CanPublishDirectly(p.PublishMode, actor.Role) {
			return "", ErrReviewRequired
		}

		if err := authorizeAction(action, transition.From, item, actor); err != nil {
			return "", err
		}

		return transition.To, nil
	}

	return "", ErrInvalidTransition
}

// authorizeAction decides who may perform an action from a given state.
func authorizeAction(action Action, from Status, item Content, actor Actor) error {
	switch action {
	case ActionSubmit:
		// Authors drive their own work through review; editors may do it for them.
		if item.IsAuthor(actor) || actor.Role.AtLeast(site.RoleEditor) {
			return nil
		}
		return ErrPermissionDenied

	case ActionPublish:
		if from == StatusDraft {
			// NeedsPublishRight has already checked the publish mode. Authorship is
			// still required so an editor cannot publish somebody else's private
			// draft; editors may publish their own without review.
			if item.IsAuthor(actor) {
				return nil
			}
			if actor.Role.AtLeast(site.RoleEditor) {
				return nil
			}
			return ErrPermissionDenied
		}
		// Approving a pending item is moderation, never authorship.
		if actor.Role.AtLeast(site.RoleEditor) {
			return nil
		}
		return ErrPermissionDenied

	case ActionReject, ActionRestore:
		if actor.Role.AtLeast(site.RoleEditor) {
			return nil
		}
		return ErrPermissionDenied

	case ActionUnpublish:
		// Taking one's own page down is an author decision; an editor may spare a
		// contributor from having to ask. The published state is the precondition,
		// not the authority.
		if item.IsAuthor(actor) || actor.Role.AtLeast(site.RoleEditor) {
			return nil
		}
		return ErrPermissionDenied

	case ActionArchive:
		if item.IsAuthor(actor) || actor.Role.AtLeast(site.RoleEditor) {
			return nil
		}
		return ErrPermissionDenied

	default:
		return ErrInvalidTransition
	}
}

// authorizeLifecycle decides who may move an item in or out of the recycle bin.
//
// The rule is the write rule, not the workflow rule: the caller needs the site's
// write_content capability, which in the role model means a signed in member, and
// then either authorship or an editor seat. The item's status is deliberately not
// consulted - an author must be able to withdraw a published article without asking
// a moderator first, and a moderator must be able to clean up somebody's abandoned
// draft. Reusing this one function for all three lifecycle actions is what keeps
// "who may delete" from drifting away from "who may restore".
func authorizeLifecycle(item Content, actor Actor) error {
	if item.SiteID != actor.SiteID {
		return ErrCrossSite
	}
	if actor.UserID == "" {
		// write_content is a member capability; an anonymous reader holds nothing.
		return ErrPermissionDenied
	}
	if item.IsAuthor(actor) || actor.Role.AtLeast(site.RoleEditor) {
		return nil
	}
	return ErrPermissionDenied
}

// AvailableActions lists the actions the actor may take on the item right now.
//
// Handlers use it to build the UI affordances, which keeps the client from guessing
// and keeps the rule in one place.
func (p Policy) AvailableActions(item Content, actor Actor) []Action {
	actions := make([]Action, 0, len(workflow))
	for _, candidate := range []Action{
		ActionSubmit, ActionPublish, ActionUnpublish, ActionReject, ActionArchive, ActionRestore,
	} {
		if _, err := p.Next(item, candidate, actor); err == nil {
			actions = append(actions, candidate)
		}
	}
	return actions
}

// ValidateDraft checks a create or update request.
func ValidateDraft(in DraftInput) (DraftInput, error) {
	in.Title = strings.TrimSpace(in.Title)
	in.Summary = strings.TrimSpace(in.Summary)
	in.Slug = strings.ToLower(strings.TrimSpace(in.Slug))
	in.CategoryID = strings.TrimSpace(in.CategoryID)
	in.SeoTitle = strings.TrimSpace(in.SeoTitle)
	in.SeoDescription = strings.TrimSpace(in.SeoDescription)
	in.SeoKeywords = strings.TrimSpace(in.SeoKeywords)
	in.CanonicalURL = strings.TrimSpace(in.CanonicalURL)
	in.OgImage = strings.TrimSpace(in.OgImage)
	in.CoverURL = strings.TrimSpace(in.CoverURL)
	in.CoverAlt = strings.TrimSpace(in.CoverAlt)

	tags, err := NormalizeTags(in.Tags)
	if err != nil {
		return DraftInput{}, err
	}
	in.Tags = tags

	if in.Title == "" {
		return DraftInput{}, invalidField("title", "required", "title is required")
	}
	if len([]rune(in.Title)) > MaxTitleLength {
		return DraftInput{}, invalidField("title", "too_long", "title is too long")
	}
	if len([]rune(in.Summary)) > MaxSummaryLength {
		return DraftInput{}, invalidField("summary", "too_long", "summary is too long")
	}
	if in.SourceFormat == "" {
		in.SourceFormat = FormatMarkdown
	}
	if !in.SourceFormat.Valid() {
		// The format is part of the body's declaration, and the closed vocabulary has no
		// source_format name yet, so the failure is attributed to the body.
		return DraftInput{}, invalidField("body", "unknown", "unknown source format")
	}
	if in.SourceBody == "" {
		return DraftInput{}, invalidField("body", "required", "body is required")
	}
	if len([]rune(in.SourceBody)) > MaxSourceLength {
		return DraftInput{}, invalidField("body", "too_long", "body is too long")
	}
	if in.Slug != "" {
		if len([]rune(in.Slug)) > MaxSlugLength {
			return DraftInput{}, invalidField("slug", "too_long", "slug is too long")
		}
		if !slugPattern.MatchString(in.Slug) {
			return DraftInput{}, invalidField("slug", "malformed",
				"slug must use letters, digits and hyphens")
		}
	}
	if in.CategoryID != "" && len(in.CategoryID) > 36 {
		return DraftInput{}, fmt.Errorf("%w: category id is malformed", ErrInvalidInput)
	}

	if in.AccessMode != "" && !in.AccessMode.Valid() {
		return DraftInput{}, invalidField("access_mode", "unknown", "unknown access mode")
	}
	if in.AccessPassword != "" {
		if in.AccessMode != "" && in.AccessMode != AccessPassword {
			return DraftInput{}, invalidField("access_password", "not_allowed",
				"an access password is only valid for password access")
		}
		if len([]rune(in.AccessPassword)) < MinAccessPasswordLength {
			return DraftInput{}, invalidField("access_password", "too_short",
				"access password is too short")
		}
		if len([]rune(in.AccessPassword)) > MaxAccessPasswordLength {
			return DraftInput{}, invalidField("access_password", "too_long",
				"access password is too long")
		}
	}
	if in.CommentPolicy != "" && !in.CommentPolicy.Valid() {
		return DraftInput{}, invalidField("comment_policy", "unknown", "unknown comment policy")
	}

	// The SEO and cover overrides are bounded here rather than only by the column
	// validator: a too long value must come back as a field error the editor can
	// point at, not as a failed insert the client reads as a server fault.
	if len([]rune(in.SeoTitle)) > MaxTitleLength {
		return DraftInput{}, invalidField("seo_title", "too_long", "seo title is too long")
	}
	if len([]rune(in.SeoDescription)) > MaxSummaryLength {
		return DraftInput{}, invalidField("seo_description", "too_long", "seo description is too long")
	}
	if len([]rune(in.SeoKeywords)) > MaxSeoKeywordsLength {
		return DraftInput{}, invalidField("seo_keywords", "too_long", "seo keywords are too long")
	}
	if len([]rune(in.CanonicalURL)) > MaxURLLength {
		return DraftInput{}, invalidField("canonical_url", "too_long", "canonical url is too long")
	}
	if len([]rune(in.CoverAlt)) > MaxCoverAltLength {
		return DraftInput{}, invalidField("cover_alt", "too_long", "cover alt text is too long")
	}
	if !in.Robots.Valid() {
		return DraftInput{}, invalidField("robots", "unknown", "unknown robots directive")
	}
	// An empty focal point means "the default crop", which is what a create without a
	// cover sends; storing it as center keeps the column's closed vocabulary intact.
	if in.CoverPosition == "" {
		in.CoverPosition = CoverCenter
	}
	if !in.CoverPosition.Valid() {
		return DraftInput{}, invalidField("cover_position", "unknown", "unknown cover position")
	}

	return in, nil
}

// NormalizeTags trims labels, drops blanks and duplicates, and enforces the
// per item bounds. Order is preserved because the author chose it and the editor
// renders tags in that order.
func NormalizeTags(raw []string) ([]string, error) {
	tags := make([]string, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))

	for _, label := range raw {
		label = strings.TrimSpace(label)
		if label == "" {
			continue
		}
		if len([]rune(label)) > MaxTagLength {
			return nil, invalidField("tags", "too_long", "tag is too long")
		}
		if _, exists := seen[label]; exists {
			continue
		}
		seen[label] = struct{}{}
		tags = append(tags, label)
		if len(tags) > MaxTags {
			return nil, invalidField("tags", "out_of_range", "too many tags")
		}
	}
	return tags, nil
}

// EncodeTags renders tags for storage. The content table keeps them as JSON text so
// the portable schema needs no join table; a nil slice is stored as an empty array
// rather than NULL so reads never have to special case it.
func EncodeTags(tags []string) string {
	if len(tags) == 0 {
		return "[]"
	}
	raw, err := json.Marshal(tags)
	if err != nil {
		return "[]"
	}
	return string(raw)
}

// DecodeTags reads a stored tags column. Corrupt or legacy values decode to an empty
// slice: a malformed label list must not make the whole item unreadable.
func DecodeTags(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return []string{}
	}
	var tags []string
	if err := json.Unmarshal([]byte(raw), &tags); err != nil {
		return []string{}
	}
	if tags == nil {
		return []string{}
	}
	return tags
}

// SlugFromTitle derives a stable slug from a title.
//
// The title is kept in its own script instead of being transliterated: "中文标题"
// becomes "中文标题", while spaces and punctuation collapse to one hyphen. This is
// deliberately not a pinyin transliterator, so two different Chinese titles can
// never collide because of a lossy romanisation. A title with no letters or digits
// (emoji, punctuation only) still yields an empty slug and keeps the id based URL.
func SlugFromTitle(title string) string {
	var builder strings.Builder
	lastHyphen := true

	for _, r := range strings.ToLower(title) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r):
			builder.WriteRune(r)
			lastHyphen = false
		case !lastHyphen:
			builder.WriteRune('-')
			lastHyphen = true
		}
	}

	runes := []rune(strings.Trim(builder.String(), "-"))
	if len(runes) > MaxSlugLength {
		runes = []rune(strings.Trim(string(runes[:MaxSlugLength]), "-"))
	}
	return string(runes)
}

// withDefaultSlug keeps a manual slug and otherwise derives one from the title.
// Create, update, manual publish and scheduled publish all go through this helper so
// "leave the address empty" means the same thing on every path.
func withDefaultSlug(title, slug string) string {
	if slug != "" {
		return slug
	}
	return SlugFromTitle(title)
}
