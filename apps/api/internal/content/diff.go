package content

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/practacu/practacu-press/apps/api/internal/platform/textdiff"
)

// Revision diffing (Beta 1.2 contract E).
//
// The diff is computed from the raw source text of the two versions, not from the
// rendered HTML: what an editor reviews is the manuscript they wrote, and the rendered
// output of an old revision is not the thing being compared. The source therefore
// comes from the revision history table, which is why this endpoint shares the
// history endpoints' permission rule: only the author and editors may look at
// pre-sanitized text.

// CurrentRevision is the selector that addresses the live version of an item.
const CurrentRevision = "current"

// DiffStats counts the changed lines of a diff.
type DiffStats struct {
	Added   int `json:"added"`
	Removed int `json:"removed"`
}

// DiffResult is the version diff response.
type DiffResult struct {
	// FromVersion and ToVersion are the resolved version numbers, so a client that
	// asked for "current" learns which version it actually got.
	FromVersion int             `json:"from_version"`
	ToVersion   int             `json:"to_version"`
	Stats       DiffStats       `json:"stats"`
	Hunks       []textdiff.Hunk `json:"hunks"`
	// Truncated reports that at least one side was longer than the diff budget and
	// only its head was compared (contract E).
	Truncated bool `json:"truncated,omitempty"`
}

// Diff compares two versions of one item line by line.
//
// from is required and accepts a version number or CurrentRevision; to is optional and
// defaults to the live version. A version that the retention window no longer keeps
// answers ErrNotFound rather than an empty diff: a missing history entry is a missing
// resource, not "no changes".
func (s *Service) Diff(
	ctx context.Context,
	actor Actor,
	contentID, from, to string,
) (DiffResult, error) {
	item, err := s.load(ctx, actor, contentID)
	if err != nil {
		return DiffResult{}, err
	}
	if !canReadHistory(item, actor) {
		return DiffResult{}, ErrNotFound
	}

	from = strings.TrimSpace(from)
	if from == "" {
		return DiffResult{}, fmt.Errorf("%w: from is required", ErrInvalidInput)
	}
	to = strings.TrimSpace(to)
	if to == "" {
		to = CurrentRevision
	}

	fromVersion, fromSource, err := s.diffSide(ctx, item, from)
	if err != nil {
		return DiffResult{}, err
	}
	toVersion, toSource, err := s.diffSide(ctx, item, to)
	if err != nil {
		return DiffResult{}, err
	}

	fromLines := textdiff.SplitLines(fromSource)
	toLines := textdiff.SplitLines(toSource)
	hunks := textdiff.Diff(fromLines, toLines)
	if hunks == nil {
		hunks = []textdiff.Hunk{}
	}

	result := DiffResult{
		FromVersion: fromVersion,
		ToVersion:   toVersion,
		Hunks:       hunks,
		Truncated:   textdiff.TruncatedLines(fromLines, toLines),
	}
	for _, hunk := range hunks {
		switch hunk.Op {
		case textdiff.OpInsert:
			result.Stats.Added++
		case textdiff.OpDelete:
			result.Stats.Removed++
		}
	}
	return result, nil
}

// diffSide resolves one side of the diff to its version and source text.
func (s *Service) diffSide(ctx context.Context, item Content, spec string) (int, string, error) {
	if strings.EqualFold(spec, CurrentRevision) {
		return item.Revision, item.SourceBody, nil
	}

	version, err := strconv.Atoi(spec)
	if err != nil || version <= 0 {
		// A non numeric selector is a bad request, not a missing version: the client
		// sent something the endpoint does not understand.
		return 0, "", fmt.Errorf("%w: %q is not a version", ErrInvalidInput, spec)
	}

	revision, err := s.findRevisionVersion(ctx, item, version)
	if err != nil {
		return 0, "", err
	}
	return revision.Version, revision.SourceBody, nil
}

// findRevisionVersion loads one snapshot by version.
//
// The dedicated lookup is preferred; the bounded history scan is the fallback for a
// repository that predates the optional port. The retention policy keeps twenty
// versions, so the scan is a small, correct fallback rather than a workaround.
func (s *Service) findRevisionVersion(ctx context.Context, item Content, version int) (Revision, error) {
	if s.revisions != nil {
		revision, err := s.revisions.FindRevisionByVersion(ctx, item.SiteID, item.ID, version)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				return Revision{}, ErrNotFound
			}
			return Revision{}, err
		}
		return revision, nil
	}

	history, err := s.repo.ListRevisions(ctx, item.SiteID, item.ID, RevisionRetention)
	if err != nil {
		return Revision{}, err
	}
	for _, revision := range history {
		if revision.Version == version {
			return revision, nil
		}
	}
	return Revision{}, ErrNotFound
}
