package community

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Notification type strings understood by the notifications module.
//
// They are duplicated instead of imported so the community module keeps its own
// vocabulary; the composition root maps them onto notifications.Type.
const (
	NotificationComment    = "comment.created"
	NotificationReaction   = "reaction.created"
	NotificationFollow     = "follow.created"
	NotificationModeration = "moderation.updated"
)

// Notification is one inbox message the community module wants to produce.
//
// It is a transport free description: the notifier adapter in the composition root
// translates it into the notifications package input.
type Notification struct {
	SiteID    string
	UserID    string
	ActorID   string
	SubjectID string
	Type      string
	DedupeKey string
	Payload   map[string]string
}

// Notifier writes one inbox row for an interaction.
//
// It is optional and best effort: the interaction itself is already committed by
// the time this runs, so a notification failure must not roll it back or turn the
// request into an error.
type Notifier interface {
	NotifyInteraction(ctx context.Context, in Notification) error
}

// sendNotification forwards one message when a notifier was wired and the
// recipient is not the actor.
func (s *Service) sendNotification(ctx context.Context, in Notification) {
	if s.notifier == nil || in.UserID == "" {
		return
	}
	if in.ActorID != "" && in.ActorID == in.UserID {
		return
	}
	// Best effort: the interaction already landed.
	_ = s.notifier.NotifyInteraction(ctx, in)
}

// notifyCommentPublished tells the person a visible comment is addressed to.
//
// A reply goes to the author of the parent comment; a top level comment goes to
// the author of the content. Both are suppressed when the author is the commenter.
func (s *Service) notifyCommentPublished(
	ctx context.Context,
	actor Actor,
	comment Comment,
	parent *Comment,
) {
	recipient := ""
	if parent != nil {
		recipient = parent.AuthorID
	} else {
		author, err := s.authors.AuthorOf(ctx, comment.SiteID, comment.TargetType, comment.TargetID)
		if err == nil {
			recipient = author
		}
	}
	if recipient == "" || recipient == comment.AuthorID {
		return
	}

	rootType, rootID := s.contentRoot(ctx, comment.SiteID, comment.TargetType, comment.TargetID)
	target, hasTarget := s.contentTarget(ctx, comment.SiteID, rootType, rootID)

	payload := map[string]string{
		"comment_id":  comment.ID,
		"target_type": string(rootType),
		"target_id":   rootID,
		"excerpt":     clip(comment.Body, maxNotificationValue),
	}
	if hasTarget {
		payload["kind"] = target.Kind
		if target.Title != "" {
			payload["title"] = clip(target.Title, maxNotificationValue)
		}
	}
	if parent != nil {
		payload["reply"] = "1"
		payload["reply_to_comment_id"] = parent.ID
	}

	s.sendNotification(ctx, Notification{
		SiteID:    comment.SiteID,
		UserID:    recipient,
		ActorID:   comment.AuthorID,
		SubjectID: comment.ID,
		Type:      NotificationComment,
		DedupeKey: "comment:" + comment.ID,
		Payload:   payload,
	})
}

// notifyCommentModerated tells a comment author that a moderator changed its status.
func (s *Service) notifyCommentModerated(
	ctx context.Context,
	actor Actor,
	comment Comment,
	status string,
) {
	if comment.AuthorID == "" || comment.AuthorID == actor.UserID {
		return
	}

	rootType, rootID := s.contentRoot(ctx, comment.SiteID, comment.TargetType, comment.TargetID)
	target, hasTarget := s.contentTarget(ctx, comment.SiteID, rootType, rootID)

	payload := map[string]string{
		"comment_id":  comment.ID,
		"target_type": string(rootType),
		"target_id":   rootID,
		"status":      status,
		"decision":    status,
		"excerpt":     clip(comment.Body, maxNotificationValue),
	}
	if hasTarget {
		payload["kind"] = target.Kind
		if target.Title != "" {
			payload["title"] = clip(target.Title, maxNotificationValue)
		}
	}

	s.sendNotification(ctx, Notification{
		SiteID:    comment.SiteID,
		UserID:    comment.AuthorID,
		ActorID:   actor.UserID,
		SubjectID: comment.ID,
		Type:      NotificationModeration,
		Payload:   payload,
	})
}

// notifyReaction tells a target author that someone reacted to their content.
func (s *Service) notifyReaction(
	ctx context.Context,
	actor Actor,
	targetType TargetType,
	targetID string,
	target Target,
	kind string,
) {
	recipient, err := s.authors.AuthorOf(ctx, actor.SiteID, targetType, targetID)
	if err != nil || recipient == "" || recipient == actor.UserID {
		return
	}

	payload := map[string]string{
		"target_type": string(targetType),
		"target_id":   targetID,
		"reaction":    kind,
	}
	if target.Kind != "" {
		// The inbox uses "kind" to decide which content route to open, so it must
		// carry article/post, not the reaction name.
		payload["kind"] = target.Kind
	}
	if target.Title != "" {
		payload["title"] = clip(target.Title, maxNotificationValue)
	}

	s.sendNotification(ctx, Notification{
		SiteID:    actor.SiteID,
		UserID:    recipient,
		ActorID:   actor.UserID,
		SubjectID: targetID,
		Type:      NotificationReaction,
		DedupeKey: fmt.Sprintf("reaction:%s:%s:%s:%s", actor.UserID, targetType, targetID, kind),
		Payload:   payload,
	})
}

// notifyFollow tells a member that someone started following them.
func (s *Service) notifyFollow(ctx context.Context, actor Actor, followeeID string) {
	s.sendNotification(ctx, Notification{
		SiteID:    actor.SiteID,
		UserID:    followeeID,
		ActorID:   actor.UserID,
		SubjectID: actor.UserID,
		Type:      NotificationFollow,
		DedupeKey: "follow:" + actor.UserID,
		Payload: map[string]string{
			"target_type": "user",
			"target_id":   actor.UserID,
		},
	})
}

// contentRoot walks a comment chain up to the article, post or page the thread is
// attached to. That is the row a notification should link to.
func (s *Service) contentRoot(
	ctx context.Context,
	siteID string,
	targetType TargetType,
	targetID string,
) (TargetType, string) {
	for depth := 0; depth <= MaxReplyDepth && targetType == TargetComment; depth++ {
		parent, err := s.repo.FindComment(ctx, siteID, targetID)
		if err != nil {
			return targetType, targetID
		}
		targetType, targetID = parent.TargetType, parent.TargetID
	}
	return targetType, targetID
}

// contentTarget resolves the title and kind of a content target, when possible.
func (s *Service) contentTarget(
	ctx context.Context,
	siteID string,
	targetType TargetType,
	targetID string,
) (Target, bool) {
	if s.targets == nil {
		return Target{}, false
	}
	switch targetType {
	case TargetArticle, TargetPost:
		target, err := s.targets.TargetOf(ctx, siteID, targetType, targetID)
		if err != nil {
			return Target{}, false
		}
		return target, true
	default:
		return Target{}, false
	}
}

// maxNotificationValue keeps one payload value inside the notifications bound.
const maxNotificationValue = 200

// clip cuts a string at a byte bound without splitting a UTF-8 sequence.
func clip(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	cut := value[:limit]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut
}
