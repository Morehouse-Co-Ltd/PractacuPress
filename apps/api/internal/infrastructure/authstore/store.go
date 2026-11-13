// Package authstore implements the authentication persistence port with Ent.
//
// All multi row writes happen in one transaction: an account without its identity,
// or a rotation that records the new token without retiring the old one, would be a
// security or consistency bug rather than a cosmetic one.
package authstore

import (
	"context"
	"strings"
	"time"

	entsql "entgo.io/ent/dialect/sql"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/site"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/recoverycode"
	"github.com/practacu/practacu-press/apps/api/ent/session"
	entsite "github.com/practacu/practacu-press/apps/api/ent/site"
	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
	"github.com/practacu/practacu-press/apps/api/ent/twofactor"
	entuser "github.com/practacu/practacu-press/apps/api/ent/user"
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
	if in.Verified {
		created, err = tx.User.UpdateOneID(created.ID).
			SetEmailVerifiedAt(time.Now().UTC()).
			Save(ctx)
		if err != nil {
			return auth.UserAccount{}, err
		}
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

// FindEmailIdentitiesByDisplayName resolves every email identity whose account
// display name matches, case-insensitively.
//
// Display names are intentionally not unique (two members may share a name), so this
// returns all matches. The authentication service treats zero or multiple matches as
// "no usable identifier" and spends the same dummy hash work, which keeps a failed
// username login indistinguishable from a failed email login.
func (s *Store) FindEmailIdentitiesByDisplayName(
	ctx context.Context,
	displayName string,
) ([]auth.Identity, error) {
	name := strings.TrimSpace(displayName)
	if name == "" {
		return nil, nil
	}
	users, err := s.client.User.Query().Where(entuser.DisplayNameEQ(name)).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(users) == 0 {
		// Ent generates no case-folding predicate for this (non unique) column, so fold
		// on the database: LOWER() behaves the same on SQLite, MySQL and PostgreSQL.
		users, err = s.client.User.Query().
			Where(func(selector *entsql.Selector) {
				selector.Where(entsql.ExprP("LOWER(display_name) = LOWER(?)", name))
			}).
			All(ctx)
		if err != nil {
			return nil, err
		}
	}
	if len(users) == 0 {
		return nil, nil
	}
	userIDs := make([]string, 0, len(users))
	for _, user := range users {
		userIDs = append(userIDs, user.ID)
	}
	rows, err := s.client.UserIdentity.Query().
		Where(useridentity.UserIDIn(userIDs...), useridentity.ProviderEQ(ProviderEmail)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	identities := make([]auth.Identity, 0, len(rows))
	for _, row := range rows {
		identities = append(identities, toIdentity(row))
	}
	return identities, nil
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

// UpdateProfile writes a partial profile update and returns the refreshed account.
//
// Setting a nullable column to an empty string clears it (ClearBio/ClearAvatarMediaID),
// which is how the client removes an avatar without inventing a sentinel id.
func (s *Store) UpdateProfile(
	ctx context.Context,
	userID string,
	update auth.ProfileUpdate,
) (auth.UserAccount, error) {
	builder := s.client.User.UpdateOneID(userID)
	if update.DisplayName != nil {
		builder.SetDisplayName(*update.DisplayName)
	}
	if update.Bio != nil {
		if *update.Bio == "" {
			builder.ClearBio()
		} else {
			builder.SetBio(*update.Bio)
		}
	}
	if update.AvatarMediaID != nil {
		if *update.AvatarMediaID == "" {
			builder.ClearAvatarMediaID()
		} else {
			builder.SetAvatarMediaID(*update.AvatarMediaID)
		}
	}

	row, err := builder.Save(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return auth.UserAccount{}, auth.ErrAccountNotFound
		}
		return auth.UserAccount{}, err
	}
	return toAccount(row), nil
}

// MarkEmailVerified proves the email identity and its account level mirror.
//
// Both writes are conditional on the stored value being NULL: a verification can
// only move forward, so a later request cannot rewrite an older proof. The two
// rows are updated in one transaction because a half written state would make the
// profile badge and the login gate disagree.
func (s *Store) MarkEmailVerified(
	ctx context.Context,
	identityID, userID string,
	at time.Time,
) error {
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

	if _, err := tx.UserIdentity.Update().
		Where(useridentity.IDEQ(identityID), useridentity.VerifiedAtIsNil()).
		SetVerifiedAt(at).
		Save(ctx); err != nil {
		return err
	}
	if _, err := tx.User.Update().
		Where(entuser.IDEQ(userID), entuser.EmailVerifiedAtIsNil()).
		SetEmailVerifiedAt(at).
		Save(ctx); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
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

// RevokeOtherUserSessions revokes every live session except the named one.
//
// An empty keepSessionID revokes all of them, which is the correct fallback when
// the caller's refresh token is missing or already unknown: the password change
// still has to invalidate whatever an attacker may hold.
func (s *Store) RevokeOtherUserSessions(
	ctx context.Context,
	userID, keepSessionID, reason string,
	at time.Time,
) error {
	builder := s.client.Session.Update().
		Where(session.UserIDEQ(userID), session.RevokedAtIsNil())
	if keepSessionID != "" {
		builder.Where(session.IDNEQ(keepSessionID))
	}
	_, err := builder.
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

// SaveTwoFactorEnrollment stores or re-seeds the pending enrollment of an account.
//
// A previous enrollment's recovery codes are retired in the same transaction: a
// half replaced enrollment would leave codes that no longer match the secret (or a
// secret without codes) behind.
func (s *Store) SaveTwoFactorEnrollment(
	ctx context.Context,
	userID, sealedSecret string,
	at time.Time,
) error {
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

	existing, err := tx.TwoFactor.Query().
		Where(twofactor.UserIDEQ(userID)).
		Only(ctx)
	switch {
	case err == nil:
		if _, err := tx.TwoFactor.UpdateOneID(existing.ID).
			SetSecret(sealedSecret).
			SetEnabled(false).
			ClearConfirmedAt().
			SetLastUsedStep(0).
			SetUpdatedAt(at).
			Save(ctx); err != nil {
			return err
		}
	case entgen.IsNotFound(err):
		if _, err := tx.TwoFactor.Create().
			SetUserID(userID).
			SetSecret(sealedSecret).
			SetEnabled(false).
			SetLastUsedStep(0).
			SetCreatedAt(at).
			SetUpdatedAt(at).
			Save(ctx); err != nil {
			return err
		}
	default:
		return err
	}

	if _, err := tx.RecoveryCode.Delete().
		Where(recoverycode.UserIDEQ(userID)).
		Exec(ctx); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// FindTwoFactor loads the enrollment row of one account.
func (s *Store) FindTwoFactor(ctx context.Context, userID string) (auth.TwoFactorRecord, error) {
	row, err := s.client.TwoFactor.Query().
		Where(twofactor.UserIDEQ(userID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return auth.TwoFactorRecord{}, auth.ErrTwoFactorNotFound
		}
		return auth.TwoFactorRecord{}, err
	}
	return auth.TwoFactorRecord{
		UserID:       row.UserID,
		Secret:       row.Secret,
		Enabled:      row.Enabled,
		ConfirmedAt:  row.ConfirmedAt,
		LastUsedStep: row.LastUsedStep,
	}, nil
}

// EnableTwoFactor confirms the enrollment and replaces the recovery codes.
func (s *Store) EnableTwoFactor(
	ctx context.Context,
	userID string,
	confirmedAt time.Time,
	recoveryCodeHashes []string,
) error {
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

	updated, err := tx.TwoFactor.Update().
		Where(twofactor.UserIDEQ(userID)).
		SetEnabled(true).
		SetConfirmedAt(confirmedAt).
		SetUpdatedAt(confirmedAt).
		Save(ctx)
	if err != nil {
		return err
	}
	if updated == 0 {
		return auth.ErrTwoFactorNotFound
	}

	if _, err := tx.RecoveryCode.Delete().
		Where(recoverycode.UserIDEQ(userID)).
		Exec(ctx); err != nil {
		return err
	}
	builders := make([]*entgen.RecoveryCodeCreate, 0, len(recoveryCodeHashes))
	for _, hash := range recoveryCodeHashes {
		builders = append(builders, tx.RecoveryCode.Create().
			SetUserID(userID).
			SetCodeHash(hash).
			SetCreatedAt(confirmedAt))
	}
	if len(builders) > 0 {
		if err := tx.RecoveryCode.CreateBulk(builders...).Exec(ctx); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// ClearTwoFactor deletes the enrollment and every recovery code of an account.
func (s *Store) ClearTwoFactor(ctx context.Context, userID string) error {
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

	if _, err := tx.TwoFactor.Delete().
		Where(twofactor.UserIDEQ(userID)).
		Exec(ctx); err != nil {
		return err
	}
	if _, err := tx.RecoveryCode.Delete().
		Where(recoverycode.UserIDEQ(userID)).
		Exec(ctx); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// ConsumeTwoFactorStep advances the replay guard.
//
// The update is conditional on the stored step being strictly older, so two
// concurrent requests for the same 30 second code cannot both succeed.
func (s *Store) ConsumeTwoFactorStep(ctx context.Context, userID string, step int64) (bool, error) {
	updated, err := s.client.TwoFactor.Update().
		Where(
			twofactor.UserIDEQ(userID),
			twofactor.LastUsedStepLT(step),
		).
		SetLastUsedStep(step).
		Save(ctx)
	if err != nil {
		return false, err
	}
	return updated > 0, nil
}

// ReplaceRecoveryCodes retires the current codes and stores a fresh set.
func (s *Store) ReplaceRecoveryCodes(
	ctx context.Context,
	userID string,
	recoveryCodeHashes []string,
	at time.Time,
) error {
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

	if _, err := tx.RecoveryCode.Delete().
		Where(recoverycode.UserIDEQ(userID)).
		Exec(ctx); err != nil {
		return err
	}
	builders := make([]*entgen.RecoveryCodeCreate, 0, len(recoveryCodeHashes))
	for _, hash := range recoveryCodeHashes {
		builders = append(builders, tx.RecoveryCode.Create().
			SetUserID(userID).
			SetCodeHash(hash).
			SetCreatedAt(at))
	}
	if len(builders) > 0 {
		if err := tx.RecoveryCode.CreateBulk(builders...).Exec(ctx); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// ConsumeRecoveryCode marks one recovery code used.
//
// The update is conditional on used_at still being NULL, so a code is single use
// even under a race.
func (s *Store) ConsumeRecoveryCode(
	ctx context.Context,
	userID, codeHash string,
	at time.Time,
) (bool, error) {
	updated, err := s.client.RecoveryCode.Update().
		Where(
			recoverycode.UserIDEQ(userID),
			recoverycode.CodeHashEQ(codeHash),
			recoverycode.UsedAtIsNil(),
		).
		SetUsedAt(at).
		Save(ctx)
	if err != nil {
		return false, err
	}
	return updated > 0, nil
}

// CountUnusedRecoveryCodes returns how many recovery codes remain.
func (s *Store) CountUnusedRecoveryCodes(ctx context.Context, userID string) (int, error) {
	return s.client.RecoveryCode.Query().
		Where(recoverycode.UserIDEQ(userID), recoverycode.UsedAtIsNil()).
		Count(ctx)
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
	account := auth.UserAccount{
		ID:              row.ID,
		DisplayName:     row.DisplayName,
		EmailVerifiedAt: row.EmailVerifiedAt,
		Status:          row.Status,
		Locale:          row.Locale,
		CreatedAt:       row.CreatedAt,
	}
	if row.Bio != nil {
		account.Bio = *row.Bio
	}
	if row.AvatarMediaID != nil {
		account.AvatarMediaID = *row.AvatarMediaID
	}
	return account
}
