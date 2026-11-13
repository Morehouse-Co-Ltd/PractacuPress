package auth

import (
	"context"
	"fmt"
	"strings"
)

// OAuth account resolution (FSD F-04).
//
// OAuthService stops at the provider profile: it proves who the provider says the
// visitor is, and nothing more. This file owns the single decision that turns that
// profile into a local account, and it is the security sensitive half of third
// party login, so it is kept apart from the transport (no database, no session, no
// cookie) and behind a narrow port that a test can fake in memory.
//
// The rule the product needs is small but easy to get wrong:
//
//   - an identity already bound to (provider, subject) wins, so a returning user
//     always lands on the same account even after changing the address at the
//     provider;
//   - a *verified* address that already has an account links the identity to that
//     account, which is what lets a password user also sign in with Google;
//   - anything else creates a fresh account.
//
// The important negative: an unverified address is never used to find, and never
// used to link, an existing account. A provider profile carrying an email is not
// proof of ownership, and treating it as proof would let anyone who can type an
// address into a provider profile take over the local account that already owns
// it. Unverified addresses therefore fall through to account creation.
//
// Two things the rule must not forget, because both are invisible until a real
// visitor hits them:
//
//   - an account only gets a session on a site it is a member of, so resolving the
//     account is not enough; every branch ends by ensuring that membership;
//   - creating an account is registration, so it follows the site's registration
//     switch exactly like the password form does.

// OAuthAccountStore is the persistence port ResolveOAuthAccount needs.
//
// It is deliberately minimal and ent free: a handful of operations, all by
// business key (provider + subject, address, or site + user), never by internal
// row id beyond the one the resolution itself just produced. That keeps the
// decision testable without a database and stops the rule from growing a
// dependency on the schema. A concrete implementation lives next to the ent
// client, not here.
//
// found=false is not an error: "no such identity" and "no such account" are the
// ordinary answers on a first login. A real failure (timeout, constraint
// violation, connection loss) is returned as err so the caller can stop instead
// of creating a duplicate account on top of a lookup that never completed.
//
// A provider login is also a registration path, so two of the operations below
// take the site the login belongs to. They answer ErrRegistrationClosed when the
// site has switched sign-ups off and the account is not a member yet: closing
// registration has to stop a Google login for the same reason it stops the
// password form, otherwise the switch only hides the front door.
type OAuthAccountStore interface {
	// FindIdentity returns the user bound to a provider subject.
	FindIdentity(ctx context.Context, provider, subject string) (userID string, found bool, err error)
	// FindUserByEmail returns the user that owns an address. The address is
	// already normalized by the caller.
	FindUserByEmail(ctx context.Context, email string) (userID string, found bool, err error)
	// CreateUser creates a user on siteID with no password, no verified email and
	// no identity of its own yet, together with its active membership of that
	// site. email may be empty when the provider did not supply a usable address.
	// A site that has closed registration (or does not exist) refuses the write
	// with ErrRegistrationClosed (or ErrSiteMissing) and creates nothing.
	CreateUser(ctx context.Context, siteID, email, displayName, avatarURL string) (userID string, err error)
	// LinkIdentity binds a provider subject to an existing user. email is the
	// address the identity was seen with; it is stored for audit and is not a
	// verification of the owning account.
	LinkIdentity(ctx context.Context, userID, provider, subject, email string) error
	// EnsureMembership makes userID an active member of siteID, creating the row
	// with the site's default role when it is missing and doing nothing when it
	// already exists (of any status: a suspended or invited member is the site's
	// decision, not a login's). A site that has closed registration refuses a new
	// row with ErrRegistrationClosed.
	EnsureMembership(ctx context.Context, siteID, userID string) error
}

// OAuthAccountOutcome says which branch of the rule produced the account.
//
// It is a string type so a caller can log it verbatim and so a test asserts on a
// readable value rather than an integer whose order could silently change.
type OAuthAccountOutcome string

const (
	// OutcomeExistingIdentity means the provider subject was already bound. The
	// account was returned untouched: no write happened at all.
	OutcomeExistingIdentity OAuthAccountOutcome = "existing_identity"
	// OutcomeLinkedExistingUser means the identity was bound to an account that
	// already existed under the same verified address. That account is reused, so
	// its profile, password and history are kept.
	OutcomeLinkedExistingUser OAuthAccountOutcome = "linked_existing_user"
	// OutcomeCreatedUser means a new account was created and the identity bound
	// to it. This covers a first login with a verified address nobody uses, a
	// first login with an unverified address, and a first login with no address at
	// all.
	OutcomeCreatedUser OAuthAccountOutcome = "created_user"
)

// ResolveOAuthAccount maps a provider profile to a local user who can sign in to
// siteID.
//
// provider is the provider id the callback named ("google", "github") and profile
// is what that provider returned; together they form the identity the product
// remembers. siteID is the site the login belongs to — the same site the session
// will be bound to — because an account is only usable on the sites it is a
// member of.
//
// The returned userID always belongs to a committed user, a committed identity
// (except for OutcomeExistingIdentity) and an active membership of siteID: every
// write is checked, so a half finished login reports an error rather than a user
// the next request cannot sign in as.
//
// Rules, in order:
//
//	a) (provider, subject) is bound        -> that user,        OutcomeExistingIdentity.
//	b) not bound, address verified and owned -> link and reuse, OutcomeLinkedExistingUser.
//	c) everything else                      -> create and link, OutcomeCreatedUser.
//
// Rule (c) is a registration, so it is refused with ErrRegistrationClosed when
// the site has closed sign-ups; so is a login that would have to add a membership
// to an existing account. An account that is already a member of the site signs
// in whatever the switch says: closing registration keeps new members out, it
// does not lock the existing ones out.
//
// Errors are always wrapped with the step that failed. A caller cannot tell an
// address lookup failure from a link failure otherwise, and the difference decides
// whether retrying is safe.
func ResolveOAuthAccount(
	ctx context.Context,
	store OAuthAccountStore,
	siteID, provider string,
	profile OAuthProfile,
) (string, OAuthAccountOutcome, error) {
	if store == nil {
		return "", "", fmt.Errorf("auth: resolve oauth account for %q: store is nil", provider)
	}
	// The account is created on a site and its membership is what the session
	// checks, so a login that cannot name its site can neither be resolved nor be
	// allowed to create anything.
	siteID = strings.TrimSpace(siteID)
	if siteID == "" {
		return "", "", fmt.Errorf("%w: site is required to resolve an oauth account", ErrInvalidInput)
	}
	// The subject is the only part of a profile that is stable across the account's
	// lifetime, so a profile without one cannot be resolved: an empty subject would
	// either match nothing on every login (an account per login) or, worse, match an
	// unrelated row that was also stored with an empty subject.
	subject := strings.TrimSpace(profile.Subject)
	if subject == "" {
		return "", "", fmt.Errorf("auth: resolve oauth account for %q: profile has no subject", provider)
	}

	userID, outcome, err := resolveOAuthAccountUser(ctx, store, siteID, provider, subject, profile)
	if err != nil {
		return "", "", err
	}

	// The last step belongs to every branch. An account without a membership of
	// siteID gets no session — the session build refuses it as not_a_member — so the
	// membership is written here, once, instead of being sprinkled through the
	// branches above. A returning member reaches an idempotent no-op.
	if err := store.EnsureMembership(ctx, siteID, userID); err != nil {
		return "", "", fmt.Errorf("auth: ensure oauth user %q is a member of site %q: %w", userID, siteID, err)
	}
	return userID, outcome, nil
}

// resolveOAuthAccountUser applies rules (a)-(c) and reports which one fired.
//
// It is the address/identity half of the decision only: the membership of the
// site is written by the caller, after the account is known.
func resolveOAuthAccountUser(
	ctx context.Context,
	store OAuthAccountStore,
	siteID, provider, subject string,
	profile OAuthProfile,
) (string, OAuthAccountOutcome, error) {
	// Rule (a): the identity is known, so the login is already decided. The account
	// is not touched: a returning user keeps the profile they edited locally, and a
	// provider side address change does not rewrite anything here.
	userID, found, err := store.FindIdentity(ctx, provider, subject)
	if err != nil {
		return "", "", fmt.Errorf("auth: find oauth identity for provider %q: %w", provider, err)
	}
	if found {
		return userID, OutcomeExistingIdentity, nil
	}

	// The address is normalized the same way password accounts are stored
	// (lowercased, trimmed) so a lookup can actually match them; it is not validated
	// for format because a provider profile is not user input this layer can refuse.
	// "No address" stays the empty string rather than an error: GitHub users may
	// hide their address, and a login must still succeed.
	email := normalizeOAuthEmail(profile.Email)
	verified := profile.EmailVerified && email != ""

	// Rule (b): only a verified address may reuse an existing account. An unverified
	// address is skipped entirely, including the lookup, so no attempt is even made
	// to attach this identity to the account that owns it.
	if verified {
		existingID, found, err := store.FindUserByEmail(ctx, email)
		if err != nil {
			return "", "", fmt.Errorf("auth: find user by verified email for provider %q: %w", provider, err)
		}
		if found {
			if err := store.LinkIdentity(ctx, existingID, provider, subject, email); err != nil {
				return "", "", fmt.Errorf("auth: link oauth identity to existing user for provider %q: %w", provider, err)
			}
			return existingID, OutcomeLinkedExistingUser, nil
		}
	}

	// Rule (c): create. This is where an unverified address lands even when an
	// account already owns it: the new user is a separate account, and it carries the
	// address only as the address seen at the provider, never as a verified one. The
	// store is told nothing about verification, so it must not infer it from a
	// non-empty email. The account and its membership of the site are written by the
	// store in one transaction, and a closed site refuses the write before it starts.
	createdID, err := store.CreateUser(ctx, siteID, email, strings.TrimSpace(profile.DisplayName), strings.TrimSpace(profile.AvatarURL))
	if err != nil {
		return "", "", fmt.Errorf("auth: create user for provider %q: %w", provider, err)
	}
	if createdID == "" {
		return "", "", fmt.Errorf("auth: create user for provider %q: store returned an empty user id", provider)
	}
	if err := store.LinkIdentity(ctx, createdID, provider, subject, email); err != nil {
		return "", "", fmt.Errorf("auth: link oauth identity to created user for provider %q: %w", provider, err)
	}
	return createdID, OutcomeCreatedUser, nil
}

// normalizeOAuthEmail folds an address from a provider profile to the stored form.
//
// It does the same case and whitespace folding as NormalizeEmail but deliberately
// performs no format validation: a provider is not a form the user just typed, and
// refusing a login because an upstream profile carries an address this product
// would not accept would leave the visitor unable to sign in at all. An address
// that cannot be used simply stays as it is; the identity, not the address, is
// what the account is found by on the next login.
func normalizeOAuthEmail(raw string) string {
	return strings.ToLower(strings.TrimSpace(raw))
}
