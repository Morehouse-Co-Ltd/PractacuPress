package content

import (
	"context"
	"fmt"
	"strings"
)

// Batch workflow actions (Beta 1.2 contract G).
//
// A bulk request is a sequence of independent decisions, never one transaction: each
// id is loaded, authorised and validated on its own, and a rejected row does not roll
// back the ones that succeeded. That is what lets an editor tick a page of the queue
// and still see exactly which item the site policy refused. The loop deliberately
// reuses the single item methods instead of reimplementing them in batch: there is one
// authorisation rule for "publish", whether it is reached by one request or a hundred.

// MaxBulkItems bounds one batch request.
const MaxBulkItems = 100

// bulkActionTrash is the batch spelling of the recycle bin move.
//
// It is not the workflow action "delete": the single item HTTP surface spells trashing
// as DELETE, while the batch contract (G) names it "trash" so a client can switch on
// one enum.
const bulkActionTrash Action = "trash"

// BulkItemResult is the outcome of one id in a batch.
type BulkItemResult struct {
	ID string `json:"id"`
	// OK is false when this item alone was refused; the others still ran.
	OK bool `json:"ok"`
	// Error is the stable API error code of the refusal, or the empty string on
	// success. It is the machine readable code rather than a localised message, so a
	// client can render or branch on it.
	Error string `json:"error"`
}

// BulkResult is the batch response.
type BulkResult struct {
	Results   []BulkItemResult `json:"results"`
	Succeeded int              `json:"succeeded"`
	Failed    int              `json:"failed"`
}

// bulkActions is the closed vocabulary of a batch request.
var bulkActions = map[Action]struct{}{
	ActionSubmit:    {},
	ActionPublish:   {},
	ActionArchive:   {},
	ActionUnpublish: {},
	bulkActionTrash: {},
	ActionUndelete:  {},
	ActionPurge:     {},
}

// Bulk applies one action to many items, independently.
//
// A request level failure (unknown action, too many ids, wrong kind) is returned as an
// error so the client gets a 400/404; every per item failure is reported inside the
// result instead, which keeps a partly successful batch a 200.
func (s *Service) Bulk(
	ctx context.Context,
	actor Actor,
	kind Kind,
	ids []string,
	action string,
) (BulkResult, error) {
	if !kind.Valid() {
		return BulkResult{}, ErrInvalidInput
	}
	act := Action(strings.TrimSpace(action))
	if _, ok := bulkActions[act]; !ok {
		return BulkResult{}, fmt.Errorf("%w: unsupported bulk action", ErrInvalidInput)
	}
	if len(ids) == 0 || len(ids) > MaxBulkItems {
		return BulkResult{}, fmt.Errorf("%w: bulk size must be between 1 and %d", ErrInvalidInput, MaxBulkItems)
	}

	result := BulkResult{Results: make([]BulkItemResult, 0, len(ids))}
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		outcome := BulkItemResult{ID: id, OK: true}
		if id == "" {
			outcome.OK = false
			outcome.Error = string(mapError(ErrInvalidInput).Code)
		} else if err := s.bulkOne(ctx, actor, id, act); err != nil {
			outcome.OK = false
			outcome.Error = bulkErrorCode(err)
		}

		if outcome.OK {
			result.Succeeded++
		} else {
			result.Failed++
		}
		result.Results = append(result.Results, outcome)
	}
	return result, nil
}

// bulkOne runs one item through the ordinary service method of the action.
func (s *Service) bulkOne(ctx context.Context, actor Actor, id string, action Action) error {
	switch action {
	case ActionSubmit, ActionPublish, ActionArchive, ActionUnpublish:
		_, err := s.Apply(ctx, actor, id, action, "")
		return err
	case bulkActionTrash:
		_, err := s.Trash(ctx, actor, id)
		return err
	case ActionUndelete:
		_, err := s.Undelete(ctx, actor, id)
		return err
	case ActionPurge:
		return s.Purge(ctx, actor, id)
	default:
		return ErrInvalidInput
	}
}

// bulkErrorCode projects an item failure onto its stable API error code.
func bulkErrorCode(err error) string {
	problem := mapError(err)
	if problem == nil {
		return ""
	}
	return string(problem.Code)
}
