// Package moderationstore implements the moderation persistence port with Ent.
package moderationstore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/internal/moderation"
	"github.com/practacu/practacu-press/internal/site"

	entgen "github.com/practacu/practacu-press/internal/ent"
	"github.com/practacu/practacu-press/internal/ent/comment"
	"github.com/practacu/practacu-press/internal/ent/contentitem"
	"github.com/practacu/practacu-press/internal/ent/moderationreport"
	"github.com/practacu/practacu-press/internal/ent/sitemember"
)

// Store is the Ent backed implementation of moderation.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ moderation.Repository = (*Store)(nil)

// InsertReport records a new report.
func (s *Store) InsertReport(ctx context.Context, report moderation.Report) (moderation.Report, error) {
	builder := s.client.ModerationReport.Create().
		SetSiteID(report.SiteID).
		SetReporterID(report.ReporterID).
		SetTargetType(string(report.TargetType)).
		SetTargetID(report.TargetID).
		SetReason(string(report.Reason)).
		SetStatus(string(report.Status)).
		SetCreatedAt(report.CreatedAt).
		SetUpdatedAt(report.UpdatedAt)
	if report.Note != "" {
		builder.SetNote(report.Note)
	}

	created, err := builder.Save(ctx)
	if err != nil {
		// The unique index on (reporter, target) is the duplicate guard; a violation
		// surfaces as a dialect error, so it is reported as invalid input rather than
		// leaking a driver message to the client.
		return moderation.Report{}, moderation.ErrInvalidInput
	}
	return toReport(created), nil
}

// FindReport loads a report inside a site scope.
func (s *Store) FindReport(ctx context.Context, siteID, reportID string) (moderation.Report, error) {
	row, err := s.client.ModerationReport.Query().
		Where(moderationreport.IDEQ(reportID), moderationreport.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return moderation.Report{}, moderation.ErrNotFound
		}
		return moderation.Report{}, err
	}
	return toReport(row), nil
}

// UpdateReport stores a status or assignee change.
func (s *Store) UpdateReport(ctx context.Context, report moderation.Report) (moderation.Report, error) {
	builder := s.client.ModerationReport.Update().
		Where(moderationreport.IDEQ(report.ID), moderationreport.SiteIDEQ(report.SiteID)).
		SetStatus(string(report.Status)).
		SetUpdatedAt(report.UpdatedAt)

	if report.AssigneeID != "" {
		builder.SetAssigneeID(report.AssigneeID)
	}
	if report.Note != "" {
		builder.SetNote(report.Note)
	}

	affected, err := builder.Save(ctx)
	if err != nil {
		return moderation.Report{}, err
	}
	if affected == 0 {
		return moderation.Report{}, moderation.ErrNotFound
	}

	updated, err := s.client.ModerationReport.Get(ctx, report.ID)
	if err != nil {
		return moderation.Report{}, err
	}
	return toReport(updated), nil
}

// UpdateReportWithAudit stores the final report state and its audit entry atomically.
func (s *Store) UpdateReportWithAudit(
	ctx context.Context,
	report moderation.Report,
	audit site.AuditEntry,
) (moderation.Report, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return moderation.Report{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	builder := tx.ModerationReport.Update().
		Where(moderationreport.IDEQ(report.ID), moderationreport.SiteIDEQ(report.SiteID)).
		SetStatus(string(report.Status)).
		SetUpdatedAt(report.UpdatedAt)
	if report.AssigneeID != "" {
		builder.SetAssigneeID(report.AssigneeID)
	}
	if report.Note != "" {
		builder.SetNote(report.Note)
	}
	affected, err := builder.Save(ctx)
	if err != nil {
		return moderation.Report{}, err
	}
	if affected == 0 {
		return moderation.Report{}, moderation.ErrNotFound
	}

	at := audit.At
	if at.IsZero() {
		at = time.Now().UTC()
	}
	auditBuilder := tx.AuditLog.Create().
		SetAction(audit.Action).
		SetTargetType("moderation_report").
		SetTargetID(report.ID).
		SetCreatedAt(at)
	if audit.SiteID != "" {
		auditBuilder.SetSiteID(audit.SiteID)
	}
	if audit.ActorID != "" {
		auditBuilder.SetActorID(audit.ActorID)
	}
	if audit.RequestID != "" {
		auditBuilder.SetRequestID(audit.RequestID)
	}
	if audit.Detail != nil {
		auditBuilder.SetDetail(audit.Detail)
	}
	if _, err := auditBuilder.Save(ctx); err != nil {
		return moderation.Report{}, err
	}

	if err := tx.Commit(); err != nil {
		return moderation.Report{}, err
	}
	committed = true

	updated, err := s.client.ModerationReport.Get(ctx, report.ID)
	if err != nil {
		return moderation.Report{}, err
	}
	return toReport(updated), nil
}

// FindByReporter returns the reporter's existing report for a target.
//
// It deliberately includes closed reports: the unique index covers the pair forever,
// so treating only open rows as duplicates would let the service pass its check and
// then fail on insert.
func (s *Store) FindByReporter(
	ctx context.Context,
	siteID, reporterID string,
	targetType moderation.TargetType,
	targetID string,
) (moderation.Report, error) {
	row, err := s.client.ModerationReport.Query().
		Where(
			moderationreport.SiteIDEQ(siteID),
			moderationreport.ReporterIDEQ(reporterID),
			moderationreport.TargetTypeEQ(string(targetType)),
			moderationreport.TargetIDEQ(targetID),
		).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return moderation.Report{}, moderation.ErrNotFound
		}
		return moderation.Report{}, err
	}
	return toReport(row), nil
}

// AuthorOf resolves the author of a reported article, post, comment or member.
func (s *Store) AuthorOf(
	ctx context.Context,
	siteID string,
	targetType moderation.TargetType,
	targetID string,
) (string, error) {
	switch targetType {
	case moderation.TargetArticle, moderation.TargetPost:
		row, err := s.client.ContentItem.Query().
			Where(contentitem.IDEQ(targetID), contentitem.SiteIDEQ(siteID)).
			Only(ctx)
		if err != nil {
			if entgen.IsNotFound(err) {
				return "", moderation.ErrTargetNotFound
			}
			return "", err
		}
		return row.AuthorID, nil
	case moderation.TargetComment:
		row, err := s.client.Comment.Query().
			Where(comment.IDEQ(targetID), comment.SiteIDEQ(siteID)).
			Only(ctx)
		if err != nil {
			if entgen.IsNotFound(err) {
				return "", moderation.ErrTargetNotFound
			}
			return "", err
		}
		return row.AuthorID, nil
	case moderation.TargetUser:
		// A reported account must still be a member of this site; an arbitrary user
		// id from another tenant is not a reportable target here.
		exists, err := s.client.SiteMember.Query().
			Where(sitemember.SiteIDEQ(siteID), sitemember.UserIDEQ(targetID)).
			Exist(ctx)
		if err != nil {
			return "", err
		}
		if !exists {
			return "", moderation.ErrTargetNotFound
		}
		return targetID, nil
	default:
		return "", moderation.ErrTargetNotFound
	}
}

// ListOpen returns the reports still needing an action, oldest first.
func (s *Store) ListOpen(ctx context.Context, siteID string, limit int) ([]moderation.Report, error) {
	rows, err := s.client.ModerationReport.Query().
		Where(
			moderationreport.SiteIDEQ(siteID),
			moderationreport.StatusIn(
				string(moderation.StatusOpen),
				string(moderation.StatusAssigned),
			),
		).
		Order(entgen.Asc(moderationreport.FieldCreatedAt)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	reports := make([]moderation.Report, 0, len(rows))
	for _, row := range rows {
		reports = append(reports, toReport(row))
	}
	return reports, nil
}

func toReport(row *entgen.ModerationReport) moderation.Report {
	report := moderation.Report{
		ID:         row.ID,
		SiteID:     row.SiteID,
		ReporterID: row.ReporterID,
		TargetType: moderation.TargetType(row.TargetType),
		TargetID:   row.TargetID,
		Reason:     moderation.Reason(row.Reason),
		Status:     moderation.Status(row.Status),
		CreatedAt:  row.CreatedAt,
		UpdatedAt:  row.UpdatedAt,
	}
	report.Note = row.Note
	if row.AssigneeID != nil {
		report.AssigneeID = *row.AssigneeID
	}
	return report
}
