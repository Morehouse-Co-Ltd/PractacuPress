package authstore

import (
	"context"
	"fmt"
	"strings"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/platform/fieldcrypto"
	"github.com/practacu/practacu-press/apps/api/internal/platform/identitycrypto"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/useridentity"
)

// ProviderPhone is the identity provider used by phone code login.
const ProviderPhone = "phone"

// Option customises a Store without changing every call site.
type Option func(*Store)

// WithFieldCipher seals the identity address columns at rest.
//
// A nil cipher keeps the historical plaintext behaviour, which is what unit tests
// and development installs without a key use. Production wiring must pass one.
func WithFieldCipher(cipher *fieldcrypto.Cipher) Option {
	return func(s *Store) { s.identity = identitycrypto.New(cipher) }
}

// findIdentityWith resolves one provider subject, tolerating rows written before
// the column was sealed.
//
// A sealed match is tried first; a legacy plaintext row is then matched with the
// same comparison the pre-encryption code used (case-insensitive for an email).
// A legacy hit is upgraded in place, so the next boot has nothing left to migrate.
// found=false is an ordinary answer, not an error.
func (s *Store) findIdentityWith(
	ctx context.Context,
	client *entgen.UserIdentityClient,
	provider, subject string,
) (*entgen.UserIdentity, bool, error) {
	provider = strings.TrimSpace(provider)
	if provider == "" || strings.TrimSpace(subject) == "" {
		return nil, false, nil
	}

	sealed, err := s.identity.SealSubject(provider, subject)
	if err != nil {
		return nil, false, err
	}
	row, err := client.Query().
		Where(useridentity.ProviderEQ(provider), useridentity.ProviderSubjectEQ(sealed)).
		Only(ctx)
	if err == nil {
		return row, true, nil
	}
	if !entgen.IsNotFound(err) {
		return nil, false, err
	}

	var legacy *entgen.UserIdentity
	switch provider {
	case ProviderEmail:
		legacy, err = client.Query().
			Where(
				useridentity.ProviderEQ(provider),
				useridentity.ProviderSubjectEqualFold(identitycrypto.NormalizeAddress(subject)),
			).
			Order(entgen.Asc(useridentity.FieldCreatedAt)).
			First(ctx)
	case ProviderPhone:
		legacy, err = client.Query().
			Where(
				useridentity.ProviderEQ(provider),
				useridentity.ProviderSubjectEQ(strings.TrimSpace(subject)),
			).
			First(ctx)
	default:
		return nil, false, nil
	}
	if err != nil {
		if entgen.IsNotFound(err) {
			return nil, false, nil
		}
		return nil, false, err
	}

	// Best effort upgrade: a failure here must not turn a successful login into an
	// outage, and the next boot retries it. The mirrored email column is migrated
	// too, or the row would keep a plaintext copy of the address it just sealed.
	update := client.UpdateOneID(legacy.ID)
	changed := false
	if sealed != legacy.ProviderSubject {
		update.SetProviderSubject(sealed)
		changed = true
	}
	if legacy.Email != nil && *legacy.Email != "" && !identitycrypto.IsSealed(*legacy.Email) {
		if sealedEmail, sealErr := s.identity.SealEmail(*legacy.Email); sealErr == nil {
			update.SetEmail(sealedEmail)
			changed = true
		}
	}
	if changed {
		if updated, updateErr := update.Save(ctx); updateErr == nil {
			legacy = updated
		}
	}
	return legacy, true, nil
}

// findIdentityBySubject is findIdentityWith against the live client.
func (s *Store) findIdentityBySubject(
	ctx context.Context,
	provider, subject string,
) (*entgen.UserIdentity, bool, error) {
	return s.findIdentityWith(ctx, s.client.UserIdentity, provider, subject)
}

// openIdentity converts a row to the domain identity, decrypting the sealed
// columns on the way.
//
// A sealed value that fails to open is an error, not a fallback: showing the
// envelope to a client would leak ciphertext and hide a rotated key.
func (s *Store) openIdentity(row *entgen.UserIdentity) (auth.Identity, error) {
	subject, err := s.identity.OpenSubject(row.Provider, row.ProviderSubject)
	if err != nil {
		return auth.Identity{}, fmt.Errorf("authstore: open identity subject: %w", err)
	}
	identity := auth.Identity{
		ID:         row.ID,
		UserID:     row.UserID,
		Provider:   row.Provider,
		Subject:    subject,
		VerifiedAt: row.VerifiedAt,
	}
	if row.Email != nil && *row.Email != "" {
		address, err := s.identity.OpenEmail(*row.Email)
		if err != nil {
			return auth.Identity{}, fmt.Errorf("authstore: open identity email: %w", err)
		}
		identity.Email = address
	}
	if row.PasswordHash != nil {
		identity.PasswordHash = *row.PasswordHash
	}
	return identity, nil
}

// IdentityBackfillResult reports what the startup migration changed.
type IdentityBackfillResult struct {
	Scanned  int
	Sealed   int
	Warnings []string
}

// BackfillIdentityEncryption seals identity rows written before the column was
// encrypted.
//
// It is idempotent: an already sealed value is left byte for byte unchanged, so
// running it on every boot costs one paged scan and nothing else. A row that
// collides with an existing sealed address (two plaintext rows for the same email
// on a database that predates normalisation) is reported as a warning instead of
// aborting startup.
func BackfillIdentityEncryption(
	ctx context.Context,
	client *entgen.Client,
	cipher *fieldcrypto.Cipher,
) (IdentityBackfillResult, error) {
	if client == nil {
		return IdentityBackfillResult{}, fmt.Errorf("authstore: backfill identity encryption: client is nil")
	}
	if cipher == nil {
		return IdentityBackfillResult{}, fmt.Errorf("authstore: backfill identity encryption: cipher is nil")
	}
	store := &Store{client: client, identity: identitycrypto.New(cipher)}

	const batchSize = 200
	result := IdentityBackfillResult{}
	lastID := ""
	for {
		query := client.UserIdentity.Query().
			Order(entgen.Asc(useridentity.FieldID)).
			Limit(batchSize)
		if lastID != "" {
			query = query.Where(useridentity.IDGT(lastID))
		}
		rows, err := query.All(ctx)
		if err != nil {
			return result, fmt.Errorf("authstore: backfill identity encryption: %w", err)
		}
		if len(rows) == 0 {
			return result, nil
		}
		for _, row := range rows {
			lastID = row.ID
			result.Scanned++

			update := client.UserIdentity.UpdateOneID(row.ID)
			changed := false

			if !identitycrypto.IsSealed(row.ProviderSubject) {
				sealed, err := store.identity.SealSubject(row.Provider, row.ProviderSubject)
				if err != nil {
					result.Warnings = append(result.Warnings, fmt.Sprintf("%s: %v", row.ID, err))
					continue
				}
				if sealed != row.ProviderSubject {
					update.SetProviderSubject(sealed)
					changed = true
				}
			}
			if row.Email != nil && *row.Email != "" && !identitycrypto.IsSealed(*row.Email) {
				sealed, err := store.identity.SealEmail(*row.Email)
				if err != nil {
					result.Warnings = append(result.Warnings, fmt.Sprintf("%s: %v", row.ID, err))
					continue
				}
				update.SetEmail(sealed)
				changed = true
			}
			if row.Phone != nil && *row.Phone != "" && !identitycrypto.IsSealed(*row.Phone) {
				sealed, err := store.identity.SealPhone(*row.Phone)
				if err != nil {
					result.Warnings = append(result.Warnings, fmt.Sprintf("%s: %v", row.ID, err))
					continue
				}
				update.SetPhone(sealed)
				changed = true
			}
			if !changed {
				continue
			}
			if err := update.Exec(ctx); err != nil {
				result.Warnings = append(result.Warnings,
					fmt.Sprintf("%s: sealing failed: %v", row.ID, err))
				continue
			}
			result.Sealed++
		}
	}
}
