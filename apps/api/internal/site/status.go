package site

import (
	"context"
	"errors"
)

// InstallStatus answers the one question the setup wizard cannot answer itself:
// does this deployment still have an installed site that the browser's saved
// configuration can point at?
//
// The frontend keeps its install configuration in localStorage, which outlives a
// deleted data directory. Without this check the browser keeps believing it is
// installed, renders an empty site and never offers the wizard again.
type InstallStatus struct {
	// Installed is true when hostname resolves to a site.
	Installed bool
	// Reason explains a false Installed.
	Reason string
	// SiteID identifies the site this hostname resolves to.
	SiteID string
	// SiteName lets the wizard show the site without a second round trip.
	SiteName string
	// HasAdmin reports whether an active administrator exists. A site without one
	// cannot be finished by the wizard, so callers may treat it as unfinished.
	HasAdmin bool
}

// Reasons reported when a hostname does not map to a usable install.
const (
	// InstallReasonNoSite means the deployment has no site for this hostname.
	InstallReasonNoSite = "no_site"
	// InstallReasonDomainUnverified means the site exists but this hostname is not
	// allowed to serve it. Reinstalling does not fix that, so it is kept apart from
	// "no site" and callers must not reset their configuration on it.
	InstallReasonDomainUnverified = "domain_unverified"
)

// InstallStatus reports whether hostname belongs to a usable install.
//
// Resolution failures that mean "this host owns no site" are ordinary answers here,
// not errors: the caller is asking yes or no, and a 404 would only tell it that the
// question was malformed.
func (s *Service) InstallStatus(ctx context.Context, hostname string) (InstallStatus, error) {
	resolved, err := s.Resolve(ctx, hostname)
	switch {
	case errors.Is(err, ErrNotFound):
		return InstallStatus{Reason: InstallReasonNoSite}, nil
	case errors.Is(err, ErrDomainUnverified):
		return InstallStatus{Reason: InstallReasonDomainUnverified}, nil
	case err != nil:
		return InstallStatus{}, err
	}

	admins, err := s.repo.CountAdmins(ctx, resolved.ID)
	if err != nil {
		return InstallStatus{}, err
	}
	return InstallStatus{
		Installed: true,
		SiteID:    resolved.ID,
		SiteName:  resolved.Name,
		HasAdmin:  admins > 0,
	}, nil
}
