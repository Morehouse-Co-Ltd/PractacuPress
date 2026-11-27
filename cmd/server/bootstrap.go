package main

import (
	"context"
	"fmt"
	"log/slog"

	"entgo.io/ent/dialect/sql/schema"

	entgen "github.com/practacu/practacu-press/internal/ent"
	entsite "github.com/practacu/practacu-press/internal/ent/site"
	entmember "github.com/practacu/practacu-press/internal/ent/sitemember"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
)

// Desktop install defaults.
//
// The desktop install starts with a missing or empty SQLite file, so the very first
// start has to produce a database the setup wizard can talk to: tables first, then
// exactly one site. The wizard updates that site instead of creating one, which is
// what keeps the desktop path zero configuration.
const (
	desktopSiteSlug = "main"
	desktopSiteName = "Practacu Press"
)

// bootstrapDesktop prepares the database of a single site desktop install and
// returns the site id to use as the request default.
//
// It is additive and idempotent: the schema step never drops columns or indexes,
// and an existing site is reused untouched, so restarting the desktop install is safe.
func bootstrapDesktop(ctx context.Context, handle *db.DB, logger *slog.Logger) (string, error) {
	if err := handle.Client.Schema.Create(ctx,
		schema.WithDropColumn(false),
		schema.WithDropIndex(false),
	); err != nil {
		return "", fmt.Errorf("apply schema: %w", err)
	}

	// Any existing site wins, whatever its slug: an operator may have renamed it
	// before this bootstrap existed, and creating a second site would break the
	// single site resolution the desktop install depends on.
	existing, err := handle.Client.Site.Query().
		Order(entgen.Asc(entsite.FieldCreatedAt)).
		First(ctx)
	switch {
	case err == nil:
		logger.Info("desktop bootstrap: reusing site", "site_id", existing.ID, "slug", existing.Slug)
		if err := ensureDesktopAdmin(ctx, handle, existing.ID, logger); err != nil {
			return "", fmt.Errorf("ensure desktop admin: %w", err)
		}
		return existing.ID, nil
	case !entgen.IsNotFound(err):
		return "", fmt.Errorf("find site: %w", err)
	}

	created, err := handle.Client.Site.Create().
		SetSlug(desktopSiteSlug).
		SetName(desktopSiteName).
		Save(ctx)
	if err != nil {
		return "", fmt.Errorf("create site: %w", err)
	}

	logger.Info("desktop bootstrap: created site", "site_id", created.ID, "slug", created.Slug)
	return created.ID, nil
}

// ensureDesktopAdmin repairs a desktop database whose only account was registered
// before the desktop flag was set.
//
// A single user install has no operator console to promote the first account, so a
// member-only database can never finish the setup wizard. This only acts when the
// site has no administrator at all: an existing site_admin or platform_admin is never
// demoted or replaced.
func ensureDesktopAdmin(ctx context.Context, handle *db.DB, siteID string, logger *slog.Logger) error {
	hasAdmin, err := handle.Client.SiteMember.Query().
		Where(
			entmember.SiteIDEQ(siteID),
			entmember.StatusEQ("active"),
			entmember.RoleIn("platform_admin", "site_admin"),
		).
		Exist(ctx)
	if err != nil {
		return err
	}
	if hasAdmin {
		return nil
	}

	first, err := handle.Client.SiteMember.Query().
		Where(entmember.SiteIDEQ(siteID), entmember.StatusEQ("active")).
		Order(entgen.Asc(entmember.FieldCreatedAt)).
		First(ctx)
	if entgen.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}

	if _, err := handle.Client.SiteMember.UpdateOneID(first.ID).
		SetRole("platform_admin").
		Save(ctx); err != nil {
		return err
	}
	logger.Warn("desktop bootstrap: promoted the earliest member to platform_admin",
		"site_id", siteID, "user_id", first.UserID, "member_id", first.ID)
	return nil
}
