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

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
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
	ActionReject  Action = "reject"
	ActionArchive Action = "archive"
	ActionRestore Action = "restore"
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
)

var slugPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

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
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

// IsAuthor reports whether the actor wrote this item.
func (c Content) IsAuthor(actor Actor) bool { return c.AuthorID == actor.UserID }

// DraftInput is a create or update request.
type DraftInput struct {
	Title        string
	Slug         string
	Summary      string
	SourceFormat SourceFormat
	SourceBody   string
	CategoryID   string
	Tags         []string
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

	case ActionArchive:
		if item.IsAuthor(actor) || actor.Role.AtLeast(site.RoleEditor) {
			return nil
		}
		return ErrPermissionDenied

	default:
		return ErrInvalidTransition
	}
}

// AvailableActions lists the actions the actor may take on the item right now.
//
// Handlers use it to build the UI affordances, which keeps the client from guessing
// and keeps the rule in one place.
func (p Policy) AvailableActions(item Content, actor Actor) []Action {
	actions := make([]Action, 0, len(workflow))
	for _, candidate := range []Action{ActionSubmit, ActionPublish, ActionReject, ActionArchive, ActionRestore} {
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
		if len(in.Slug) > MaxSlugLength {
			return DraftInput{}, invalidField("slug", "too_long", "slug is too long")
		}
		if !slugPattern.MatchString(in.Slug) {
			return DraftInput{}, invalidField("slug", "malformed",
				"slug must be lowercase letters, digits and hyphens")
		}
	}
	if in.CategoryID != "" && len(in.CategoryID) > 36 {
		return DraftInput{}, fmt.Errorf("%w: category id is malformed", ErrInvalidInput)
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
// Non ASCII titles produce an empty slug on purpose: inventing a transliteration
// would produce collisions across languages, so the caller keeps the id based URL.
func SlugFromTitle(title string) string {
	var builder strings.Builder
	lastHyphen := true

	for _, r := range strings.ToLower(title) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			builder.WriteRune(r)
			lastHyphen = false
		case !lastHyphen:
			builder.WriteRune('-')
			lastHyphen = true
		}
	}

	slug := strings.Trim(builder.String(), "-")
	if len(slug) > MaxSlugLength {
		slug = strings.Trim(slug[:MaxSlugLength], "-")
	}
	return slug
}
