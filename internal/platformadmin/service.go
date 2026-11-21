package platformadmin

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/practacu/practacu-press/internal/audit"
	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/site"
)

// Service implements the platform site console.
type Service struct {
	repo      Repository
	accounts  AccountProvisioner
	sessions  SessionIssuer
	tokens    SwitchTokenIssuer
	domains   DomainVerifier
	metrics   MetricsRepository
	directory DirectoryRepository
	trail     AuditRepository
	recorder  audit.Recorder
	now       func() time.Time
}

// ServiceConfig configures a Service.
type ServiceConfig struct {
	Repository Repository
	// Accounts creates the first administrator account of a new site.
	Accounts AccountProvisioner
	// Sessions mints the target-site session after a handoff token is redeemed.
	Sessions SessionIssuer
	// Tokens signs the handoff between the console's site and the target site.
	Tokens SwitchTokenIssuer
	// Domains redeems a new site's DNS challenge, which is what makes it reachable.
	Domains DomainVerifier
	// Metrics feeds the cross-site overview. Required: without it the console cannot
	// answer the one question an operator opens it for.
	Metrics MetricsRepository
	// Directory feeds the account directory across sites.
	Directory DirectoryRepository
	// Trail reads the audit rows of every site at once.
	Trail AuditRepository
	// Recorder writes the audit row of a cross-site audit query. It is the same
	// recorder every module uses, so the query shows up in the trail it just read.
	Recorder audit.Recorder
	// Now defaults to time.Now().UTC.
	Now func() time.Time
}

// NewService validates its dependencies and returns a Service.
func NewService(cfg ServiceConfig) (*Service, error) {
	switch {
	case cfg.Repository == nil:
		return nil, errors.New("platform: repository is required")
	case cfg.Accounts == nil:
		return nil, errors.New("platform: account provisioner is required")
	case cfg.Sessions == nil:
		return nil, errors.New("platform: session issuer is required")
	case cfg.Tokens == nil:
		return nil, errors.New("platform: switch token issuer is required")
	case cfg.Domains == nil:
		return nil, errors.New("platform: domain verifier is required")
	case cfg.Metrics == nil:
		return nil, errors.New("platform: metrics repository is required")
	case cfg.Directory == nil:
		return nil, errors.New("platform: account directory is required")
	case cfg.Trail == nil:
		return nil, errors.New("platform: audit repository is required")
	case cfg.Recorder == nil:
		return nil, errors.New("platform: audit recorder is required")
	}
	service := &Service{
		repo:      cfg.Repository,
		accounts:  cfg.Accounts,
		sessions:  cfg.Sessions,
		tokens:    cfg.Tokens,
		domains:   cfg.Domains,
		metrics:   cfg.Metrics,
		directory: cfg.Directory,
		trail:     cfg.Trail,
		recorder:  cfg.Recorder,
		now:       cfg.Now,
	}
	if service.now == nil {
		service.now = func() time.Time { return time.Now().UTC() }
	}
	return service, nil
}

// ListSites returns every site of the install to a platform administrator.
//
// The caller must be a platform administrator of the site its token was issued for:
// that is the deployment owner seat. A site administrator, even of several sites, only
// manages its own site and never sees the install wide list.
func (s *Service) ListSites(ctx context.Context, actorSiteID, actorUserID string) ([]SiteSummary, error) {
	if _, err := s.platformMember(ctx, actorSiteID, actorUserID); err != nil {
		return nil, err
	}

	rows, err := s.repo.ListSites(ctx, MaxListedSites)
	if err != nil {
		return nil, err
	}

	summaries := make([]SiteSummary, 0, len(rows))
	for _, row := range rows {
		summary, err := s.summary(ctx, row)
		if err != nil {
			return nil, err
		}
		summaries = append(summaries, summary)
	}
	return summaries, nil
}

// CreateSite creates a site, its default design document and its first administrator.
//
// The site row is created first so the administrator membership has a target; if
// provisioning the account fails (a duplicate email is the common case) the site and
// its design are removed again. A half created site that nobody can administer would
// otherwise be indistinguishable from a finished one in the console.
func (s *Service) CreateSite(
	ctx context.Context,
	actorSiteID, actorUserID string,
	in CreateSiteInput,
) (SiteSummary, auth.UserView, error) {
	actor, err := s.platformMember(ctx, actorSiteID, actorUserID)
	if err != nil {
		return SiteSummary{}, auth.UserView{}, err
	}

	// A second site ends the domain-less single-site fallback. If the console's own
	// site has no verified hostname yet, creating another site would make the console
	// unreachable the moment the request completes, so require the prerequisite
	// instead of letting the operator lock themselves out.
	console, err := s.repo.FindSite(ctx, actorSiteID)
	if err != nil {
		return SiteSummary{}, auth.UserView{}, err
	}
	if console.Domain == "" || console.DomainVerifiedAt == nil {
		return SiteSummary{}, auth.UserView{}, ErrConsoleSiteNeedsDomain
	}

	normalized, err := normalizeCreate(in)
	if err != nil {
		return SiteSummary{}, auth.UserView{}, err
	}

	taken, err := s.repo.SlugTaken(ctx, normalized.Slug)
	if err != nil {
		return SiteSummary{}, auth.UserView{}, err
	}
	if taken {
		return SiteSummary{}, auth.UserView{}, ErrSlugTaken
	}
	taken, err = s.repo.DomainTaken(ctx, normalized.Domain)
	if err != nil {
		return SiteSummary{}, auth.UserView{}, err
	}
	if taken {
		return SiteSummary{}, auth.UserView{}, ErrDomainTaken
	}

	// A declared domain is a pending challenge, exactly like one set through site
	// settings: the hostname only starts serving after the owner publishes the DNS TXT
	// record and verifies it.
	token, err := site.NewDomainVerificationToken()
	if err != nil {
		return SiteSummary{}, auth.UserView{}, err
	}

	created, err := s.repo.CreateSite(ctx, SiteRecord{
		Name:                  normalized.Name,
		Slug:                  normalized.Slug,
		Description:           normalized.Description,
		Domain:                normalized.Domain,
		DomainToken:           token,
		VisibilityMode:        normalized.VisibilityMode,
		PublishMode:           normalized.PublishMode,
		RegistrationOpen:      true,
		CommentsEnabled:       true,
		CommentsRequireReview: false,
		DesignDocument:        []byte(DefaultDesignDocument),
	})
	if err != nil {
		return SiteSummary{}, auth.UserView{}, err
	}

	owner, err := s.accounts.ProvisionSiteOwner(ctx, created.ID, auth.CreateMemberInput{
		Email:               normalized.Owner.Email,
		DisplayName:         normalized.Owner.DisplayName,
		Password:            normalized.Owner.Password,
		ConfirmWeakPassword: normalized.Owner.ConfirmWeakPassword,
		Role:                site.RoleSiteAdmin,
	})
	if err != nil {
		if cleanupErr := s.repo.DeleteSite(ctx, created.ID); cleanupErr != nil {
			return SiteSummary{}, auth.UserView{}, fmt.Errorf(
				"platform: provision owner failed (%v) and cleanup failed (%w)", err, cleanupErr)
		}
		return SiteSummary{}, auth.UserView{}, err
	}

	// The creation itself is audited on the new site: that is where an operator looks
	// for "who opened this site". The actor belongs to another site, which is exactly
	// what a deployment level action looks like.
	if err := s.repo.RecordAudit(ctx, site.AuditEntry{
		SiteID:  created.ID,
		ActorID: actor.UserID,
		Action:  "platform.site.created",
		Target:  created.ID,
		Detail: map[string]any{
			"slug":   created.Slug,
			"domain": created.Domain,
			"owner":  owner.ID,
		},
		At: s.now(),
	}); err != nil {
		return SiteSummary{}, auth.UserView{}, err
	}

	refreshSite, err := s.repo.FindSite(ctx, created.ID)
	if err != nil {
		return SiteSummary{}, auth.UserView{}, err
	}
	summary, err := s.summary(ctx, refreshSite)
	if err != nil {
		return SiteSummary{}, auth.UserView{}, err
	}
	return summary, owner, nil
}

// GetSite returns one site to a platform administrator or to that site's own
// administrator.
func (s *Service) GetSite(
	ctx context.Context,
	actorSiteID, actorUserID, targetSiteID string,
) (SiteDetail, error) {
	target, role, err := s.authorizeSite(ctx, actorSiteID, actorUserID, targetSiteID)
	if err != nil {
		return SiteDetail{}, err
	}
	summary, err := s.summary(ctx, target)
	if err != nil {
		return SiteDetail{}, err
	}
	return SiteDetail{
		Site:   summary,
		Role:   role,
		Domain: site.DomainStatusOf(target),
	}, nil
}

// VerifyDomain redeems a site's pending DNS TXT challenge.
//
// It exists because a newly created site cannot be reached on its hostname until the
// challenge succeeds, and the site's own admin UI is only reachable after that: the
// console is the bootstrap path. A platform administrator or the target site's own
// administrator may run it.
func (s *Service) VerifyDomain(
	ctx context.Context,
	actorSiteID, actorUserID, targetSiteID string,
) (site.DomainStatus, error) {
	target, _, err := s.authorizeSite(ctx, actorSiteID, actorUserID, targetSiteID)
	if err != nil {
		return site.DomainStatus{}, err
	}
	return s.domains.VerifyDomainForPlatform(ctx, target.ID, actorUserID)
}

// EnterSite authorises a handoff into targetSiteID and mints the token the target
// origin redeems for a session.
//
// A platform administrator is granted an active platform_admin membership on the target
// site if it does not have one: the design makes the platform administrator the
// deployment operator, and every site endpoint re-reads a live membership. A site
// administrator enters only the site it already administers.
func (s *Service) EnterSite(
	ctx context.Context,
	actorSiteID, actorUserID, targetSiteID string,
) (Entry, error) {
	target, role, err := s.authorizeSite(ctx, actorSiteID, actorUserID, targetSiteID)
	if err != nil {
		return Entry{}, err
	}

	// A platform administrator acting on another site needs a live membership there:
	// the site guards read it on every request, and a token alone is not authority.
	if role == site.RolePlatformAdmin {
		member, findErr := s.repo.FindMember(ctx, target.ID, actorUserID)
		if findErr != nil {
			if !errors.Is(findErr, site.ErrMemberNotFound) {
				return Entry{}, findErr
			}
			if err := s.repo.EnsureMember(ctx, target.ID, actorUserID, site.RolePlatformAdmin, site.AuditEntry{
				SiteID:  target.ID,
				ActorID: actorUserID,
				Action:  "platform.site.entered",
				Target:  target.ID,
				At:      s.now(),
			}); err != nil {
				return Entry{}, err
			}
		} else if !member.IsActive() || member.Role != site.RolePlatformAdmin {
			if err := s.repo.EnsureMember(ctx, target.ID, actorUserID, site.RolePlatformAdmin, site.AuditEntry{
				SiteID:  target.ID,
				ActorID: actorUserID,
				Action:  "platform.site.entered",
				Target:  target.ID,
				At:      s.now(),
			}); err != nil {
				return Entry{}, err
			}
		}
	}

	summary, err := s.summary(ctx, target)
	if err != nil {
		return Entry{}, err
	}
	entry := Entry{Site: summary, Role: role}

	// Staying on the current site needs no handoff: the browser already holds a token
	// for it.
	if target.ID == actorSiteID {
		entry.Switchable = true
		return entry, nil
	}
	switch {
	case target.Disabled:
		entry.Reason = EntryReasonDisabled
		return entry, nil
	case target.Domain == "":
		entry.Reason = EntryReasonDomainMissing
		return entry, nil
	case target.DomainVerifiedAt == nil:
		entry.Reason = EntryReasonDomainUnverified
		return entry, nil
	}

	token, expiresAt, err := s.tokens.IssueSiteSwitch(actorUserID, target.ID)
	if err != nil {
		return Entry{}, err
	}
	entry.Switchable = true
	entry.SwitchToken = token
	entry.ExpiresAt = expiresAt
	return entry, nil
}

// ClaimSwitch redeems a handoff token on the target site's own origin.
//
// The resolved site must be the site the token was minted for: a token for site B
// cannot be redeemed on site A's hostname, which keeps the handoff from becoming a
// cross-tenant session oracle. The account must still hold an active membership.
func (s *Service) ClaimSwitch(
	ctx context.Context,
	resolvedSiteID, token string,
	meta auth.ClientMeta,
) (auth.Session, site.Site, error) {
	if token == "" {
		return auth.Session{}, site.Site{}, ErrSwitchTokenInvalid
	}
	userID, siteID, err := s.tokens.VerifySiteSwitch(token)
	if err != nil {
		return auth.Session{}, site.Site{}, ErrSwitchTokenInvalid
	}
	if siteID == "" || siteID != resolvedSiteID {
		return auth.Session{}, site.Site{}, ErrPermissionDenied
	}

	member, err := s.repo.FindMember(ctx, siteID, userID)
	if err != nil {
		if errors.Is(err, site.ErrMemberNotFound) {
			return auth.Session{}, site.Site{}, ErrPermissionDenied
		}
		return auth.Session{}, site.Site{}, err
	}
	if !member.IsActive() {
		return auth.Session{}, site.Site{}, ErrPermissionDenied
	}

	found, err := s.repo.FindSite(ctx, siteID)
	if err != nil {
		return auth.Session{}, site.Site{}, err
	}

	session, err := s.sessions.IssueSwitchSession(ctx, siteID, userID, meta)
	if err != nil {
		return auth.Session{}, site.Site{}, err
	}
	return session, found, nil
}

// platformMember requires an active platform administrator membership of siteID.
func (s *Service) platformMember(ctx context.Context, siteID, userID string) (site.Member, error) {
	member, err := s.repo.FindMember(ctx, siteID, userID)
	if err != nil {
		if errors.Is(err, site.ErrMemberNotFound) {
			return site.Member{}, ErrPermissionDenied
		}
		return site.Member{}, err
	}
	if !member.IsActive() || member.Role != site.RolePlatformAdmin {
		return site.Member{}, ErrPermissionDenied
	}
	return member, nil
}

// authorizeSite resolves targetSiteID and checks that the caller may manage it.
//
// Two seats are accepted: a platform administrator of the site the caller is connected
// to, or an administrator of the target site itself. Anything lower, including an
// editor of the target site, is refused.
func (s *Service) authorizeSite(
	ctx context.Context,
	actorSiteID, actorUserID, targetSiteID string,
) (site.Site, site.Role, error) {
	target, err := s.repo.FindSite(ctx, targetSiteID)
	if err != nil {
		if errors.Is(err, site.ErrNotFound) {
			return site.Site{}, "", ErrSiteNotFound
		}
		return site.Site{}, "", err
	}

	actor, err := s.repo.FindMember(ctx, actorSiteID, actorUserID)
	if err != nil {
		if errors.Is(err, site.ErrMemberNotFound) {
			return site.Site{}, "", ErrPermissionDenied
		}
		return site.Site{}, "", err
	}
	if actor.IsActive() && actor.Role == site.RolePlatformAdmin {
		return target, actor.Role, nil
	}

	targetMember, err := s.repo.FindMember(ctx, target.ID, actorUserID)
	if err != nil {
		if errors.Is(err, site.ErrMemberNotFound) {
			return site.Site{}, "", ErrPermissionDenied
		}
		return site.Site{}, "", err
	}
	if !targetMember.IsActive() || !targetMember.Role.AtLeast(site.RoleSiteAdmin) {
		return site.Site{}, "", ErrPermissionDenied
	}
	return target, targetMember.Role, nil
}

// summary attaches the member counts the console shows to one site.
func (s *Service) summary(ctx context.Context, found site.Site) (SiteSummary, error) {
	members, err := s.repo.CountMembers(ctx, found.ID)
	if err != nil {
		return SiteSummary{}, err
	}
	admins, err := s.repo.CountAdmins(ctx, found.ID)
	if err != nil {
		return SiteSummary{}, err
	}
	return SiteSummary{Site: found, MemberCount: members, AdminCount: admins}, nil
}
