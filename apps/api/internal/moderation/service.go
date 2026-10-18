package moderation

import (
	"context"
	"errors"
	"time"
)

// Repository is the persistence contract for moderation.
type Repository interface {
	InsertReport(ctx context.Context, report Report) (Report, error)
	FindReport(ctx context.Context, siteID, reportID string) (Report, error)
	UpdateReport(ctx context.Context, report Report) (Report, error)
	ListOpen(ctx context.Context, siteID string, limit int) ([]Report, error)
}

// Service implements the report queue use cases.
type Service struct {
	repo Repository
	now  func() time.Time
}

// NewService builds a Service.
func NewService(repo Repository) (*Service, error) {
	if repo == nil {
		return nil, errors.New("moderation: repository is required")
	}
	return &Service{repo: repo, now: func() time.Time { return time.Now().UTC() }}, nil
}

// File records a new report.
//
// targetAuthorID is supplied by the caller because only the content module knows who
// wrote the target; passing it in keeps this package free of a dependency on content.
func (s *Service) File(ctx context.Context, actor Actor, in NewReportInput, targetAuthorID string) (Report, error) {
	validated, err := ValidateReport(in, actor.UserID, targetAuthorID)
	if err != nil {
		return Report{}, err
	}

	now := s.now()
	report := Report{
		SiteID:     actor.SiteID,
		ReporterID: actor.UserID,
		TargetType: validated.TargetType,
		TargetID:   validated.TargetID,
		Reason:     validated.Reason,
		Note:       validated.Note,
		Status:     StatusOpen,
		CreatedAt:  now,
		UpdatedAt:  now,
	}

	return s.repo.InsertReport(ctx, report)
}

// Assign claims a report for the caller.
func (s *Service) Assign(ctx context.Context, actor Actor, reportID string) (Report, error) {
	report, err := s.repo.FindReport(ctx, actor.SiteID, reportID)
	if err != nil {
		return Report{}, err
	}

	updated, err := report.Assign(actor, s.now())
	if err != nil {
		return Report{}, err
	}
	return s.repo.UpdateReport(ctx, updated)
}

// Resolve closes a report as handled or dismissed.
func (s *Service) Resolve(ctx context.Context, actor Actor, reportID string, dismiss bool, note string) (Report, error) {
	report, err := s.repo.FindReport(ctx, actor.SiteID, reportID)
	if err != nil {
		return Report{}, err
	}

	updated, err := report.Resolve(actor, dismiss, note, s.now())
	if err != nil {
		return Report{}, err
	}
	return s.repo.UpdateReport(ctx, updated)
}

// Queue returns the open reports of a site.
//
// Listing the queue is a moderation capability, so a member is refused before the
// repository is touched.
func (s *Service) Queue(ctx context.Context, actor Actor, limit int) ([]Report, error) {
	if !CanModerate(actor) {
		return nil, ErrPermissionDenied
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	return s.repo.ListOpen(ctx, actor.SiteID, limit)
}
