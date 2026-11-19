package authstore

import (
	"context"
	"strings"
	"time"

	"entgo.io/ent/dialect/sql/sqlgraph"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/site"

	entgen "github.com/practacu/practacu-press/internal/ent"
	"github.com/practacu/practacu-press/internal/ent/phonecode"
)

// Phone code login persistence (contract A).
//
// phone_codes rows are read and written only here. The auth module owns the rules
// (expiry, attempts, rate limits); this file owns the SQL shaped consequences and
// keeps the hashing contract intact: it never sees a plain phone number except in
// the two identity operations, where the field cipher seals it before storage.

// phoneCodeRecord converts an entity to the domain record.
func toPhoneCodeRecord(row *entgen.PhoneCode) auth.PhoneCodeRecord {
	return auth.PhoneCodeRecord{
		ID:            row.ID,
		SiteID:        row.SiteID,
		PhoneHash:     row.PhoneHash,
		PhoneMasked:   row.PhoneMasked,
		Purpose:       row.Purpose,
		CodeHash:      row.CodeHash,
		Attempts:      row.Attempts,
		RequestIPHash: row.RequestIPHash,
		ExpiresAt:     row.ExpiresAt,
		ConsumedAt:    row.ConsumedAt,
		CreatedAt:     row.CreatedAt,
	}
}

// CreatePhoneCode stores one verification code.
func (s *Store) CreatePhoneCode(ctx context.Context, record auth.PhoneCodeRecord) error {
	builder := s.client.PhoneCode.Create().
		SetSiteID(record.SiteID).
		SetPhoneHash(record.PhoneHash).
		SetPhoneMasked(record.PhoneMasked).
		SetPurpose(record.Purpose).
		SetCodeHash(record.CodeHash).
		SetAttempts(record.Attempts).
		SetRequestIPHash(record.RequestIPHash).
		SetExpiresAt(record.ExpiresAt).
		SetCreatedAt(record.CreatedAt)
	if record.ID != "" {
		builder.SetID(record.ID)
	}
	_, err := builder.Save(ctx)
	return err
}

// LatestLivePhoneCode returns the newest unconsumed, unexpired code of a number.
//
// Purpose is deliberately not part of the filter: a client that requested a
// register code and then signs in to an existing account still proves the same
// thing (possession of the number), and refusing it would only confuse the visitor.
func (s *Store) LatestLivePhoneCode(
	ctx context.Context,
	siteID, phoneHash string,
	now time.Time,
) (auth.PhoneCodeRecord, error) {
	row, err := s.client.PhoneCode.Query().
		Where(
			phonecode.SiteIDEQ(siteID),
			phonecode.PhoneHashEQ(phoneHash),
			phonecode.ConsumedAtIsNil(),
			phonecode.ExpiresAtGT(now),
		).
		Order(entgen.Desc(phonecode.FieldCreatedAt)).
		First(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return auth.PhoneCodeRecord{}, auth.ErrPhoneCodeNotFound
		}
		return auth.PhoneCodeRecord{}, err
	}
	return toPhoneCodeRecord(row), nil
}

// CountPhoneCodesSince counts the codes requested for one number inside the window.
func (s *Store) CountPhoneCodesSince(
	ctx context.Context,
	siteID, phoneHash string,
	since time.Time,
) (int, error) {
	return s.client.PhoneCode.Query().
		Where(
			phonecode.SiteIDEQ(siteID),
			phonecode.PhoneHashEQ(phoneHash),
			phonecode.CreatedAtGTE(since),
		).
		Count(ctx)
}

// CountPhoneCodesByIPSince counts the codes requested from one hashed address.
//
// An empty hash is answered with zero instead of a query: rows written before the
// column existed (or by a caller that did not pass the address) share the empty
// value, and counting them would charge every caller an identical budget.
func (s *Store) CountPhoneCodesByIPSince(
	ctx context.Context,
	siteID, ipHash string,
	since time.Time,
) (int, error) {
	if ipHash == "" {
		return 0, nil
	}
	return s.client.PhoneCode.Query().
		Where(
			phonecode.SiteIDEQ(siteID),
			phonecode.RequestIPHashEQ(ipHash),
			phonecode.CreatedAtGTE(since),
		).
		Count(ctx)
}

// IncrementPhoneCodeAttempts records one wrong guess and returns the new total.
func (s *Store) IncrementPhoneCodeAttempts(ctx context.Context, id string) (int, error) {
	row, err := s.client.PhoneCode.UpdateOneID(id).
		AddAttempts(1).
		Save(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return 0, auth.ErrPhoneCodeNotFound
		}
		return 0, err
	}
	return row.Attempts, nil
}

// ConsumePhoneCode stamps consumed_at exactly once.
//
// The update is conditional on the column still being NULL, so two concurrent
// redemptions cannot both win; the loser answers invalid_code.
func (s *Store) ConsumePhoneCode(ctx context.Context, id string, at time.Time) (bool, error) {
	if strings.TrimSpace(id) == "" {
		return false, auth.ErrPhoneCodeNotFound
	}
	updated, err := s.client.PhoneCode.Update().
		Where(phonecode.IDEQ(id), phonecode.ConsumedAtIsNil()).
		SetConsumedAt(at).
		Save(ctx)
	if err != nil {
		return false, err
	}
	return updated > 0, nil
}

// FindPhoneIdentity resolves a normalized phone number to its identity.
//
// The provider subject is sealed with the deterministic phone envelope, so equal
// numbers match without a plaintext copy; findIdentityBySubject also upgrades a row
// written before encryption was enabled.
func (s *Store) FindPhoneIdentity(ctx context.Context, phone string) (auth.Identity, error) {
	normalized := strings.TrimSpace(phone)
	if normalized == "" {
		return auth.Identity{}, auth.ErrAccountNotFound
	}
	row, found, err := s.findIdentityBySubject(ctx, ProviderPhone, normalized)
	if err != nil {
		return auth.Identity{}, err
	}
	if !found {
		return auth.Identity{}, auth.ErrAccountNotFound
	}
	return s.openIdentity(row)
}

// phoneDisplayNameMax is the users.display_name byte limit.
const phoneDisplayNameMax = 120

// phonePlaceholderDisplayName is the last resort for a generated name.
const phonePlaceholderDisplayName = "用户"

// CreateAccountWithPhone creates the account, its phone identity and the site
// membership in one transaction.
//
// A phone sign-in is a registration, so the site's registration switch is read
// inside the same transaction (createActiveMembership) and a closed site writes
// nothing. The identity's verified_at is stamped because the SMS code just proved
// ownership of the number; users.email_verified_at stays NULL, it is an email fact.
func (s *Store) CreateAccountWithPhone(
	ctx context.Context,
	in auth.CreatePhoneAccountInput,
) (auth.UserAccount, error) {
	phone := strings.TrimSpace(in.Phone)
	if phone == "" || strings.TrimSpace(in.SiteID) == "" {
		return auth.UserAccount{}, auth.ErrInvalidInput
	}

	name := truncateToSchemaLen(strings.TrimSpace(in.DisplayName), phoneDisplayNameMax)
	if name == "" {
		name = phonePlaceholderDisplayName
	}
	role := in.Role
	if role == "" {
		role = string(site.RoleMember)
	}

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

	// The lookup happens before the insert so a duplicate sign-in reports the domain
	// error instead of a raw unique violation; the unique index stays the real arbiter
	// for a concurrent race.
	if _, found, findErr := s.findIdentityWith(ctx, tx.UserIdentity, ProviderPhone, phone); findErr != nil {
		return auth.UserAccount{}, findErr
	} else if found {
		return auth.UserAccount{}, auth.ErrIdentityExists
	}

	created, err := tx.User.Create().
		SetDisplayName(name).
		Save(ctx)
	if err != nil {
		return auth.UserAccount{}, err
	}

	sealedSubject, err := s.identity.SealSubject(ProviderPhone, phone)
	if err != nil {
		return auth.UserAccount{}, err
	}
	sealedPhone, err := s.identity.SealPhone(phone)
	if err != nil {
		return auth.UserAccount{}, err
	}
	provenAt := time.Now().UTC()
	builder := tx.UserIdentity.Create().
		SetUserID(created.ID).
		SetProvider(ProviderPhone).
		SetProviderSubject(sealedSubject).
		SetVerifiedAt(provenAt)
	if sealedPhone != "" {
		builder.SetPhone(sealedPhone)
	}
	if _, err := builder.Save(ctx); err != nil {
		if sqlgraph.IsUniqueConstraintError(err) {
			return auth.UserAccount{}, auth.ErrIdentityExists
		}
		return auth.UserAccount{}, err
	}

	// The policy and the membership insert share this transaction, so a closed site
	// leaves neither a user nor an identity behind.
	if err := createActiveMembership(ctx, tx.Site, tx.SiteMember, in.SiteID, created.ID); err != nil {
		return auth.UserAccount{}, err
	}
	if err := tx.Commit(); err != nil {
		return auth.UserAccount{}, err
	}
	committed = true

	account := toAccount(created)
	account.EmailVerifiedAt = nil
	return account, nil
}

var _ auth.PhoneRepository = (*Store)(nil)
