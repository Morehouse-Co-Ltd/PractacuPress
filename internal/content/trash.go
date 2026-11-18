package content

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/internal/site"
)

// The recycle bin: soft delete, restore and the retention sweep.
//
// Soft delete is the only delete an author can reach, because a mistaken removal of a
// finished article is the cheapest mistake to make and the most expensive to accept.
// The row therefore stays in place: it is what keeps its revision history, its
// comments and the media references inside its body resolvable, and it is what a
// restore puts back. Destruction is a separate, deliberate second step (Purge), and
// the retention sweep only takes it after TrashRetentionDays.
//
// Visibility is the invariant this file exists to protect: every read path filters the
// marker out at the store, so a trashed item is invisible to listings, detail reads,
// search, the leaderboard, feeds and the sitemap at once. The operations here are the
// only code that looks at a trashed row on purpose.

// Trash moves an item into the recycle bin.
//
// Trashing an already trashed item succeeds without touching it: a double click or a
// retried request must not look like a failure, and re-stamping the marker would let a
// polling client postpone the retention sweep indefinitely.
func (s *Service) Trash(ctx context.Context, actor Actor, contentID string) (Content, error) {
	item, err := s.loadIncludingTrashed(ctx, actor, contentID)
	if err != nil {
		return Content{}, err
	}
	if err := authorizeLifecycle(item, actor); err != nil {
		return Content{}, err
	}
	if item.IsTrashed() {
		return item, nil
	}

	now := s.now()
	updated := item
	updated.DeletedAt = &now
	updated.UpdatedAt = now
	// A pending schedule is left alone: the item is not being rewritten, it is being
	// hidden, and a restore must put back exactly the state the author left. The
	// scheduler skips trashed rows, so nothing is published while it sits in the bin.
	return s.repo.Trash(ctx, updated, site.AuditEntry{
		SiteID:  item.SiteID,
		ActorID: actor.UserID,
		Action:  "content." + string(ActionDelete),
		Target:  item.ID,
		Detail:  map[string]any{"kind": string(item.Kind), "status": string(item.Status)},
		At:      now,
	})
}

// Undelete restores an item from the recycle bin.
//
// Like Trash it is idempotent: restoring a live item returns it unchanged instead of
// reporting a state error the caller cannot act on.
func (s *Service) Undelete(ctx context.Context, actor Actor, contentID string) (Content, error) {
	item, err := s.loadIncludingTrashed(ctx, actor, contentID)
	if err != nil {
		return Content{}, err
	}
	if err := authorizeLifecycle(item, actor); err != nil {
		return Content{}, err
	}
	if !item.IsTrashed() {
		return item, nil
	}

	now := s.now()
	updated := item
	updated.DeletedAt = nil
	updated.UpdatedAt = now
	return s.repo.Undelete(ctx, updated, site.AuditEntry{
		SiteID:  item.SiteID,
		ActorID: actor.UserID,
		Action:  "content." + string(ActionUndelete),
		Target:  item.ID,
		Detail:  map[string]any{"kind": string(item.Kind), "status": string(item.Status)},
		At:      now,
	})
}

// Purge destroys an item for good.
//
// Only a trashed item may be purged. Without that precondition a moderator could
// destroy live content with one call, and the recycle bin would be a promise the API
// does not always keep; with it, every destruction is two deliberate steps.
func (s *Service) Purge(ctx context.Context, actor Actor, contentID string) error {
	item, err := s.loadIncludingTrashed(ctx, actor, contentID)
	if err != nil {
		return err
	}
	if err := authorizeLifecycle(item, actor); err != nil {
		return err
	}
	if !item.IsTrashed() {
		return ErrInvalidTransition
	}

	detail := map[string]any{"kind": string(item.Kind), "status": string(item.Status)}
	if item.DeletedAt != nil {
		detail["deleted_at"] = item.DeletedAt.UTC().Format(time.RFC3339)
	}
	return s.repo.Purge(ctx, item.SiteID, item.ID, site.AuditEntry{
		SiteID:  item.SiteID,
		ActorID: actor.UserID,
		Action:  "content." + string(ActionPurge),
		Target:  item.ID,
		Detail:  detail,
		At:      s.now(),
	})
}

// ProcessTrashRetention removes the items that have sat in the recycle bin past
// TrashRetentionDays and reports how many it removed.
//
// It runs from the scheduler, so it is bounded and safe to call repeatedly: one pass
// removes at most TrashRetentionBatch rows and the next tick continues where it
// stopped. Nothing here consults the caller's role: the retention window is the site
// policy, not a per request decision.
func (s *Service) ProcessTrashRetention(ctx context.Context) (int, error) {
	cutoff := s.now().Add(-TrashRetentionDays * 24 * time.Hour)
	return s.repo.PurgeExpired(ctx, cutoff, TrashRetentionBatch)
}

// loadIncludingTrashed loads an item for a lifecycle action.
func (s *Service) loadIncludingTrashed(ctx context.Context, actor Actor, contentID string) (Content, error) {
	item, err := s.repo.FindByIDIncludingTrashed(ctx, actor.SiteID, contentID)
	if err != nil {
		return Content{}, err
	}
	if item.SiteID != actor.SiteID {
		// The repository already scopes by site; this is defence in depth.
		return Content{}, ErrCrossSite
	}
	return item, nil
}
