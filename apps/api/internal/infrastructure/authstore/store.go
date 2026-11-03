// Package authstore implements the authentication persistence port with Ent.
//
// All multi row writes happen in one transaction: an account without its identity,
// or a rotation that records the new token without retiring the old one, would be a
// security or consistency bug rather than a cosmetic one.
package authstore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/site"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/session"
	entsite "github.com/practacu/practacu-press/apps/api/ent/site"
	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
	"github.com/practacu/practacu-press/apps/api/ent/useridentity"
	"github.com/practacu/practacu-press/apps/api/ent/verificationtoken"
)

// ProviderEmail is the identity provider used by email and password accounts.
const ProviderEmail = "email"

// Store is the Ent backed implementation of auth.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ auth.Repository = (*Store)(nil)

// CreateAccountWithEmail creates the account, its email identity and the site
// membership atomically.
func (s *Store) CreateAccountWithEmail(ctx context.Context, in auth.CreateAccountInput) (auth.UserAccount, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return auth.UserAccount{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	siteExists, err := tx.Site.Query().Where(entsite.IDEQ(in.SiteID)).Exist(ctx)
	if err != nil {
		return auth.UserAccount{}, err
	}
	if !siteExists {
		return auth.UserAccount{}, auth.ErrSiteMissing
	}

	if _, err := tx.UserIdentity.Query().
		Where(useridentity.ProviderEQ(ProviderEmail), useridentity.ProviderSubjectEQ(in.Email)).
		Only(ctx); err == nil {
		return auth.UserAccount{}, auth.ErrIdentityExists
	} else if !entgen.IsNotFound(err) {
		return auth.UserAccount{}, err
	}

	created, err := tx.User.Create().
		SetDisplayName(in.DisplayName).
		Save(ctx)
	if err != nil {
		return auth.UserAccount{}, err
	}

	identity := tx.UserIdentity.Create().
		SetUserID(created.ID).
		SetProvider(ProviderEmail).
		SetProviderSubject(in.Email).
		SetEmail(in.Email).
		SetPasswordHash(in.PasswordHash)
	if in.Verified {
		identity.SetVerifiedAt(time.Now().UTC())
	}
	if _, err := identity.Save(ctx); err != nil {
		return auth.UserAccount{}, err
	}

	role := in.Role
	if role == "" {
		role = string(site.RoleMember)
	}
	if _, err := tx.SiteMember.Create().
		SetSiteID(in.SiteID).
		SetUserID(created.ID).
		SetRole(role).
		Save(ctx); err != nil {
		return auth.UserAccount{}, err
	}

	if err := tx.Commit(); err != nil {
		return auth.UserAccount{}, err
	}
	committed = true

	return toAccount(created), nil
}

// FindEmailIdentity resolves a normalised email to its identity.
func (s *Store) FindEmailIdentity(ctx context.Context, email string) (auth.Identity, error) {
	row, err := s.client.UserIdentity.Query().
		Where(useridentity.ProviderEQ(ProviderEmail), useridentity.ProviderSubjectEQ(email)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return auth.Identity{}, auth.ErrAccountNotFound
		}
		return auth.Identity{}, err
	}
	return toIdentity(row), nil
}

// FindEmailIdentityByUser resolves the email identity of one account.
func (s *Store) FindEmailIdentityByUser(ctx context.Context, userID string) (auth.Identity, error) {
	row, err := s.client.UserIdentity.Query().
		Where(useridentity.UserIDEQ(userID), useridentity.ProviderEQ(ProviderEmail)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return auth.Identity{}, auth.ErrAccountNotFound
		}
		return auth.Identity{}, err
	}
	return toIdentity(row), nil
}

// UpdatePasswordHash replaces the stored hash and optionally proves the address.
//
// The verification timestamp is only written when it is currently NULL: a password
// reset proves ownership today, it must not be able to rewrite an older proof.
func (s *Store) UpdatePasswordHash(
	ctx context.Context,
	identityID, passwordHash string,
	verifiedAt *time.Time,
) error {
	updated, err := s.client.UserIdentity.Update().
		Where(useridentity.IDEQ(identityID)).
		SetPasswordHash(passwordHash).
		Save(ctx)
	if err != nil {
		return err
	}
	if updated == 0 {
		return auth.ErrAccountNotFound
	}
	if verifiedAt == nil {
		return nil
	}
	_, err = s.client.UserIdentity.Update().
		Where(useridentity.IDEQ(identityID), useridentity.VerifiedAtIsNil()).
		SetVerifiedAt(*verifiedAt).
		Save(ctx)
	return err
}

// FindUser loads an account by id.
func (s *Store) FindUser(ctx context.Context, userID string) (auth.UserAccount, error) {
	row, err := s.client.User.Get(ctx, userID)
	if err != nil {
		if entgen.IsNotFound(err) {
			return auth.UserAccount{}, auth.ErrAccountNotFound
		}
		return auth.UserAccount{}, err
	}
	return toAccount(row), nil
}

// FindMembershipRole returns the current role of an active member.
func (s *Store) FindMembershipRole(ctx context.Context, siteID, userID string) (site.Role, error) {
	row, err := s.client.SiteMember.Query().
		Where(
			sitemember.SiteIDEQ(siteID),
			sitemember.UserIDEQ(userID),
			sitemember.StatusEQ("active"),
		).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return "", auth.ErrAccountNotFound
		}
		return "", err
	}
	return site.Role(row.Role), nil
}

// CountSiteMembers returns how many accounts belong to a site.
//
// Disabled members still count: the question is whether the install already has an
// owner, not whether that owner is currently able to log in.
func (s *Store) CountSiteMembers(ctx context.Context, siteID string) (int, error) {
	return s.client.SiteMember.Query().
		Where(sitemember.SiteIDEQ(siteID)).
		Count(ctx)
}

// CreateSession persists a new refresh session.
func (s *Store) CreateSession(ctx context.Context, record auth.SessionRecord) error {
	builder := s.client.Session.Create().
		SetID(record.ID).
		SetUserID(record.UserID).
		SetSiteID(record.SiteID).
		SetTokenHash(record.TokenHash).
		SetFamilyID(record.FamilyID).
		SetExpiresAt(record.ExpiresAt)

	if record.ParentID != "" {
		builder.SetParentID(record.ParentID)
	}
	if record.UserAgent != "" {
		builder.SetUserAgent(record.UserAgent)
	}
	if record.IPAddress != "" {
		builder.SetIPAddress(record.IPAddress)
	}

	_, err := builder.Save(ctx)
	return err
}

// FindSessionByHash loads a session by the hash of its refresh token.
func (s *Store) FindSessionByHash(ctx context.Context, tokenHash string) (auth.SessionRecord, error) {
	row, err := s.client.Session.Query().
		Where(session.TokenHashEQ(tokenHash)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return auth.SessionRecord{}, auth.ErrSessionNotFound
		}
		return auth.SessionRecord{}, err
	}

	record := auth.SessionRecord{
		ID:        row.ID,
		UserID:    row.UserID,
		SiteID:    row.SiteID,
		TokenHash: row.TokenHash,
		FamilyID:  row.FamilyID,
		ExpiresAt: row.ExpiresAt,
		RotatedAt: row.RotatedAt,
		RevokedAt: row.RevokedAt,
	}
	if row.ParentID != nil {
		record.ParentID = *row.ParentID
	}
	if row.UserAgent != nil {
		record.UserAgent = *row.UserAgent
	}
	if row.IPAddress != nil {
		record.IPAddress = *row.IPAddress
	}
	return record, nil
}

// RotateSession retires the old session and inserts its successor atomically.
//
// The update is conditional on the old row still being unrotated, so two concurrent
// refreshes cannot both succeed: the loser gets ErrSessionNotFound and the caller
// treats it as a revoked session.
func (s *Store) RotateSession(ctx context.Context, oldID string, rotatedAt time.Time, next auth.SessionRecord) error {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	updated, err := tx.Session.Update().
		Where(
			session.IDEQ(oldID),
			session.RotatedAtIsNil(),
			session.RevokedAtIsNil(),
		).
		SetRotatedAt(rotatedAt).
		Save(ctx)
	if err != nil {
		return err
	}
	if updated == 0 {
		return auth.ErrSessionNotFound
	}

	builder := tx.Session.Create().
		SetID(next.ID).
		SetUserID(next.UserID).
		SetSiteID(next.SiteID).
		SetTokenHash(next.TokenHash).
		SetFamilyID(next.FamilyID).
		SetExpiresAt(next.ExpiresAt)
	if next.ParentID != "" {
		builder.SetParentID(next.ParentID)
	}
	if next.UserAgent != "" {
		builder.SetUserAgent(next.UserAgent)
	}
	if next.IPAddress != "" {
		builder.SetIPAddress(next.IPAddress)
	}
	if _, err := builder.Save(ctx); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// FamilyCreatedAt returns the creation time of the oldest row of a lineage.
//
// The first row of a family is written when the session is created (login,
// registration or a provider sign-in) and every rotation inserts a new row instead of
// updating it, so the minimum created_at is the lineage's birth time.
func (s *Store) FamilyCreatedAt(ctx context.Context, familyID string) (time.Time, error) {
	row, err := s.client.Session.Query().
		Where(session.FamilyIDEQ(familyID)).
		Order(entgen.Asc(session.FieldCreatedAt)).
		First(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return time.Time{}, auth.ErrSessionNotFound
		}
		return time.Time{}, err
	}
	return row.CreatedAt, nil
}

// RevokeFamily revokes every live session in a family.
func (s *Store) RevokeFamily(ctx context.Context, familyID, reason string, at time.Time) error {
	_, err := s.client.Session.Update().
		Where(session.FamilyIDEQ(familyID), session.RevokedAtIsNil()).
		SetRevokedAt(at).
		SetRevokedReason(reason).
		Save(ctx)
	return err
}

// RevokeSession revokes one session. Revoking twice is a no-op.
func (s *Store) RevokeSession(ctx context.Context, sessionID, reason string, at time.Time) error {
	_, err := s.client.Session.Update().
		Where(session.IDEQ(sessionID), session.RevokedAtIsNil()).
		SetRevokedAt(at).
		SetRevokedReason(reason).
		Save(ctx)
	return err
}

// RevokeUserSessions revokes every live session of one account.
func (s *Store) RevokeUserSessions(ctx context.Context, userID, reason string, at time.Time) error {
	_, err := s.client.Session.Update().
		Where(session.UserIDEQ(userID), session.RevokedAtIsNil()).
		SetRevokedAt(at).
		SetRevokedReason(reason).
		Save(ctx)
	return err
}

// CreateVerificationToken stores a new single use token.
func (s *Store) CreateVerificationToken(ctx context.Context, token auth.VerificationToken) error {
	builder := s.client.VerificationToken.Create().
		SetID(token.ID).
		SetUserID(token.UserID).
		SetKind(token.Kind).
		SetTokenHash(token.TokenHash).
		SetExpiresAt(token.ExpiresAt)
	if !token.CreatedAt.IsZero() {
		builder.SetCreatedAt(token.CreatedAt)
	}
	_, err := builder.Save(ctx)
	return err
}

// FindVerificationToken resolves the hash of a token.
func (s *Store) FindVerificationToken(ctx context.Context, tokenHash string) (auth.VerificationToken, error) {
	row, err := s.client.VerificationToken.Query().
		Where(verificationtoken.TokenHashEQ(tokenHash)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return auth.VerificationToken{}, auth.ErrVerificationTokenNotFound
		}
		return auth.VerificationToken{}, err
	}
	return toVerificationToken(row), nil
}

// LatestLiveVerificationToken returns the newest redeemable token of a kind.
func (s *Store) LatestLiveVerificationToken(
	ctx context.Context,
	userID, kind string,
	now time.Time,
) (auth.VerificationToken, error) {
	row, err := s.client.VerificationToken.Query().
		Where(
			verificationtoken.UserIDEQ(userID),
			verificationtoken.KindEQ(kind),
			verificationtoken.ConsumedAtIsNil(),
			verificationtoken.ExpiresAtGT(now),
		).
		Order(entgen.Desc(verificationtoken.FieldCreatedAt)).
		First(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return auth.VerificationToken{}, auth.ErrVerificationTokenNotFound
		}
		return auth.VerificationToken{}, err
	}
	return toVerificationToken(row), nil
}

// ConsumeVerificationToken marks a token redeemed.
//
// The update is conditional on consumed_at still being NULL, so two concurrent
// redemptions cannot both succeed.
func (s *Store) ConsumeVerificationToken(ctx context.Context, id string, at time.Time) (bool, error) {
	updated, err := s.client.VerificationToken.Update().
		Where(verificationtoken.IDEQ(id), verificationtoken.ConsumedAtIsNil()).
		SetConsumedAt(at).
		Save(ctx)
	if err != nil {
		return false, err
	}
	return updated > 0, nil
}

// InvalidateVerificationTokens retires every live token of a kind.
func (s *Store) InvalidateVerificationTokens(ctx context.Context, userID, kind string, at time.Time) error {
	_, err := s.client.VerificationToken.Update().
		Where(
			verificationtoken.UserIDEQ(userID),
			verificationtoken.KindEQ(kind),
			verificationtoken.ConsumedAtIsNil(),
		).
		SetConsumedAt(at).
		Save(ctx)
	return err
}

func toIdentity(row *entgen.UserIdentity) auth.Identity {
	identity := auth.Identity{
		ID:         row.ID,
		UserID:     row.UserID,
		Provider:   row.Provider,
		Subject:    row.ProviderSubject,
		VerifiedAt: row.VerifiedAt,
	}
	if row.Email != nil {
		identity.Email = *row.Email
	}
	if row.PasswordHash != nil {
		identity.PasswordHash = *row.PasswordHash
	}
	return identity
}

func toVerificationToken(row *entgen.VerificationToken) auth.VerificationToken {
	return auth.VerificationToken{
		ID:         row.ID,
		UserID:     row.UserID,
		Kind:       row.Kind,
		TokenHash:  row.TokenHash,
		ExpiresAt:  row.ExpiresAt,
		CreatedAt:  row.CreatedAt,
		ConsumedAt: row.ConsumedAt,
	}
}

func toAccount(row *entgen.User) auth.UserAccount {
	return auth.UserAccount{
		ID:          row.ID,
		DisplayName: row.DisplayName,
		Status:      row.Status,
		Locale:      row.Locale,
		CreatedAt:   row.CreatedAt,
	}
}
