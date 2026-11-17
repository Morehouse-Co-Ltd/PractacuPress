// Package main — shared mail log adapters.
//
// Three modules record outbound mail: the newsletter campaign sender, the auth
// module (password reset and address verification) and notifications (the mail half
// of an inbox notification). They all write the same email_logs row shape, but each
// declares its own narrow port so the modules stay decoupled. This file is the one
// place that knows how those ports map onto the shared store, which is what keeps
// the dashboard's mail log complete.
package main

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/notifications"
	"github.com/practacu/practacu-press/apps/api/internal/platform/emailgateway"
)

// insertSystemMail writes the queued row shared by every system mail path.
func insertSystemMail(
	ctx context.Context,
	store emailgateway.Store,
	siteID, toEmail, kind, templateKey, subject string,
) (string, error) {
	row, err := store.InsertEmailLog(ctx, emailgateway.Log{
		SiteID:      siteID,
		ToEmail:     toEmail,
		Kind:        kind,
		TemplateKey: templateKey,
		Subject:     subject,
		Status:      emailgateway.StatusQueued,
		CreatedAt:   time.Now().UTC(),
	})
	if err != nil {
		return "", err
	}
	return row.ID, nil
}

// authMailLog adapts the shared store to auth's mail log port.
type authMailLog struct{ store emailgateway.Store }

var _ auth.MailLog = authMailLog{}

func (m authMailLog) Record(ctx context.Context, entry auth.MailLogEntry) (string, error) {
	return insertSystemMail(ctx, m.store, entry.SiteID, entry.ToEmail, entry.Kind,
		entry.TemplateKey, entry.Subject)
}

func (m authMailLog) MarkSent(ctx context.Context, id, providerMessageID string) error {
	return m.store.MarkEmailLogSent(ctx, id, providerMessageID, time.Now().UTC())
}

func (m authMailLog) MarkFailed(ctx context.Context, id, reason string) error {
	return m.store.MarkEmailLogFailed(ctx, id, reason, time.Now().UTC())
}

// MarkSkipped drops the reason: email_logs carries the answer in status, and the
// module already logged why it skipped.
func (m authMailLog) MarkSkipped(ctx context.Context, id, _ string) error {
	return m.store.MarkEmailLogSkipped(ctx, id, time.Now().UTC())
}

// notificationMailLog does the same for notifications, which declares its own entry
// type so the two modules never import each other.
type notificationMailLog struct{ store emailgateway.Store }

var _ notifications.MailLog = notificationMailLog{}

func (m notificationMailLog) Record(ctx context.Context, entry notifications.MailLogEntry) (string, error) {
	return insertSystemMail(ctx, m.store, entry.SiteID, entry.ToEmail, entry.Kind,
		entry.TemplateKey, entry.Subject)
}

func (m notificationMailLog) MarkSent(ctx context.Context, id, providerMessageID string) error {
	return m.store.MarkEmailLogSent(ctx, id, providerMessageID, time.Now().UTC())
}

func (m notificationMailLog) MarkFailed(ctx context.Context, id, reason string) error {
	return m.store.MarkEmailLogFailed(ctx, id, reason, time.Now().UTC())
}

func (m notificationMailLog) MarkSkipped(ctx context.Context, id, _ string) error {
	return m.store.MarkEmailLogSkipped(ctx, id, time.Now().UTC())
}
