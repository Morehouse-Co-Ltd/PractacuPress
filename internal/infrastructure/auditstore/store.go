// Package auditstore implements the audit query and recorder ports with Ent.
package auditstore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/platform/page"

	entgen "github.com/practacu/practacu-press/internal/ent"
	"github.com/practacu/practacu-press/internal/ent/auditlog"
	"github.com/practacu/practacu-press/internal/ent/comment"
	"github.com/practacu/practacu-press/internal/ent/contentitem"
	entsite "github.com/practacu/practacu-press/internal/ent/site"
	"github.com/practacu/practacu-press/internal/ent/user"
)

// Store is the Ent backed implementation of audit.Repository and audit.Recorder.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ audit.Repository = (*Store)(nil)
var _ audit.Recorder = (*Store)(nil)

// Record appends one audit entry.
//
// Auditing must not fail the business operation that produced it: the integration
// points log the returned error and continue. This method itself stays strict so a
// caller that does care (a test, a migration) sees the failure.
func (s *Store) Record(ctx context.Context, entry audit.Entry) error {
	at := entry.At
	if at.IsZero() {
		at = time.Now().UTC()
	}
	outcome := entry.Outcome
	if outcome == "" {
		outcome = "success"
	}

	builder := s.client.AuditLog.Create().
		SetAction(entry.Action).
		SetOutcome(outcome).
		SetCreatedAt(at)

	if entry.SiteID != "" {
		builder.SetSiteID(entry.SiteID)
	}
	if entry.ActorID != "" {
		builder.SetActorID(entry.ActorID)
	}
	if entry.TargetType != "" {
		builder.SetTargetType(entry.TargetType)
	}
	if entry.TargetID != "" {
		builder.SetTargetID(entry.TargetID)
	}
	if entry.RequestID != "" {
		builder.SetRequestID(entry.RequestID)
	}
	if entry.Detail != nil {
		builder.SetDetail(entry.Detail)
	}

	_, err := builder.Save(ctx)
	return err
}

// List returns one bucket of audit rows, newest first.
func (s *Store) List(
	ctx context.Context,
	filter audit.Filter,
	limit int,
	after page.Cursor,
) ([]audit.Log, string, error) {
	return s.list(ctx, filter, limit, after, false)
}

// ListAll returns one bucket of audit rows across every site, newest first.
//
// It is the platform console's read: the site filter is optional, so an empty SiteID
// means "the whole deployment" instead of a site that has no rows (which is what List
// would ask for). Names are resolved by the same helper as List, so a row shows the
// same actor and target labels on both screens.
func (s *Store) ListAll(
	ctx context.Context,
	filter audit.Filter,
	limit int,
	after page.Cursor,
) ([]audit.Log, string, error) {
	return s.list(ctx, filter, limit, after, true)
}

func (s *Store) list(
	ctx context.Context,
	filter audit.Filter,
	limit int,
	after page.Cursor,
	allSites bool,
) ([]audit.Log, string, error) {
	query := s.client.AuditLog.Query()
	if !allSites {
		query.Where(auditlog.SiteIDEQ(filter.SiteID))
	} else if filter.SiteID != "" {
		query.Where(auditlog.SiteIDEQ(filter.SiteID))
	}

	if filter.From != nil {
		query.Where(auditlog.CreatedAtGTE(*filter.From))
	}
	if filter.To != nil {
		query.Where(auditlog.CreatedAtLTE(*filter.To))
	}
	if filter.ActorID != "" {
		query.Where(auditlog.ActorIDEQ(filter.ActorID))
	}
	if filter.Action != "" {
		query.Where(auditlog.ActionEQ(filter.Action))
	}
	if filter.TargetType != "" {
		query.Where(auditlog.TargetTypeEQ(filter.TargetType))
	}
	if filter.TargetID != "" {
		query.Where(auditlog.TargetIDEQ(filter.TargetID))
	}
	if filter.Outcome != "" {
		query.Where(auditlog.OutcomeEQ(filter.Outcome))
	}

	if !after.IsZero() {
		key, err := time.Parse(time.RFC3339Nano, after.Key)
		if err != nil {
			return nil, "", err
		}
		// The sort is (created_at DESC, id DESC); both halves are needed or rows
		// sharing a timestamp would be skipped at the page boundary.
		query.Where(auditlog.Or(
			auditlog.CreatedAtLT(key),
			auditlog.And(
				auditlog.CreatedAtEQ(key),
				auditlog.IDLT(after.ID),
			),
		))
	}

	rows, err := query.
		Order(entgen.Desc(auditlog.FieldCreatedAt), entgen.Desc(auditlog.FieldID)).
		Limit(limit + 1).
		All(ctx)
	if err != nil {
		return nil, "", err
	}

	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next = page.Cursor{
			Key: last.CreatedAt.UTC().Format(time.RFC3339Nano),
			ID:  last.ID,
		}.Encode()
	}

	items := make([]audit.Log, 0, len(rows))
	for _, row := range rows {
		items = append(items, toLog(row))
	}
	if err := s.attachNames(ctx, items); err != nil {
		return nil, "", err
	}
	return items, next, nil
}

func toLog(row *entgen.AuditLog) audit.Log {
	entry := audit.Log{
		ID:        row.ID,
		Action:    row.Action,
		Outcome:   row.Outcome,
		Detail:    row.Detail,
		CreatedAt: row.CreatedAt,
	}
	if row.SiteID != nil {
		entry.SiteID = *row.SiteID
	}
	if row.ActorID != nil {
		entry.ActorID = *row.ActorID
	}
	if row.TargetType != nil {
		entry.TargetType = *row.TargetType
	}
	if row.TargetID != nil {
		entry.TargetID = *row.TargetID
	}
	if row.RequestID != nil {
		entry.RequestID = *row.RequestID
	}
	return entry
}

// attachNames resolves the display names of actors and targets for the page.
//
// The audit row stores ids only, by design: a deleted account must not erase the
// audit trail, and a renamed account should show its current name. Resolution is
// best effort per type; an unknown id simply leaves the name empty and the UI
// falls back to the id.
func (s *Store) attachNames(ctx context.Context, items []audit.Log) error {
	actorIDs := make([]string, 0, len(items))
	userTargetIDs := make([]string, 0, len(items))
	contentTargetIDs := make([]string, 0, len(items))
	commentTargetIDs := make([]string, 0, len(items))
	siteTargetIDs := make([]string, 0, len(items))

	for _, item := range items {
		if item.ActorID != "" {
			actorIDs = append(actorIDs, item.ActorID)
		}
		switch item.TargetType {
		case "article", "post", "content":
			if item.TargetID != "" {
				contentTargetIDs = append(contentTargetIDs, item.TargetID)
			}
		case "comment":
			if item.TargetID != "" {
				commentTargetIDs = append(commentTargetIDs, item.TargetID)
			}
		case "site_member", "user":
			if item.TargetID != "" {
				userTargetIDs = append(userTargetIDs, item.TargetID)
			}
		case "site", "site_customization":
			if item.TargetID != "" {
				siteTargetIDs = append(siteTargetIDs, item.TargetID)
			}
		}
	}

	names := make(map[string]string)
	if len(actorIDs)+len(userTargetIDs) > 0 {
		ids := append(append([]string{}, actorIDs...), userTargetIDs...)
		accounts, err := s.client.User.Query().
			Where(user.IDIn(unique(ids)...)).
			All(ctx)
		if err != nil {
			return err
		}
		for _, account := range accounts {
			names[account.ID] = account.DisplayName
		}
	}

	contentNames := make(map[string]string)
	if len(contentTargetIDs) > 0 {
		rows, err := s.client.ContentItem.Query().
			Where(contentitem.IDIn(unique(contentTargetIDs)...)).
			All(ctx)
		if err != nil {
			return err
		}
		for _, row := range rows {
			contentNames[row.ID] = row.Title
		}
	}

	commentNames := make(map[string]string)
	if len(commentTargetIDs) > 0 {
		rows, err := s.client.Comment.Query().
			Where(comment.IDIn(unique(commentTargetIDs)...)).
			All(ctx)
		if err != nil {
			return err
		}
		for _, row := range rows {
			commentNames[row.ID] = excerpt(row.Body, 80)
		}
	}

	siteNames := make(map[string]string)
	if len(siteTargetIDs) > 0 {
		rows, err := s.client.Site.Query().
			Where(entsite.IDIn(unique(siteTargetIDs)...)).
			All(ctx)
		if err != nil {
			return err
		}
		for _, row := range rows {
			siteNames[row.ID] = row.Name
		}
	}

	for index := range items {
		item := &items[index]
		item.ActorName = names[item.ActorID]
		switch item.TargetType {
		case "article", "post", "content":
			item.TargetName = contentNames[item.TargetID]
		case "comment":
			item.TargetName = commentNames[item.TargetID]
		case "site_member", "user":
			item.TargetName = names[item.TargetID]
		case "site", "site_customization":
			item.TargetName = siteNames[item.TargetID]
		}
	}
	return nil
}

func unique(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func excerpt(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}
