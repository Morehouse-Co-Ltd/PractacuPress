package auth

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"
)

// The resolution rule is tested against an in-memory store: no database and no
// ent, so every assertion is about the decision itself. The fake records each
// write it was asked to perform, which is how the security cases are proven: the
// "must not happen" cases assert on the absence of a create or a link, not just on
// the returned outcome.

// oauthTestSiteID is the site every resolution case signs in to. The account
// decision is site aware, so a fake cannot leave it out.
const oauthTestSiteID = "site-1"

// oauthCreatedUser is one recorded CreateUser call.
type oauthCreatedUser struct {
	SiteID      string
	Email       string
	DisplayName string
	AvatarURL   string
	ID          string
}

// oauthMembership is one recorded EnsureMembership call.
type oauthMembership struct {
	SiteID string
	UserID string
}

// oauthLink is one recorded LinkIdentity call.
type oauthLink struct {
	UserID   string
	Provider string
	Subject  string
	Email    string
}

// oauthFakeAccountStore is an OAuthAccountStore over maps.
//
// The zero value is not usable; oauthNewFakeStore builds one. Every method can be
// made to fail independently, so a test can see which step a wrapped error names.
type oauthFakeAccountStore struct {
	identities map[string]string // provider + "\x00" + subject -> user id
	emails     map[string]string // normalized address -> user id

	identityLookups []struct{ Provider, Subject string }
	emailLookups    []string
	created         []oauthCreatedUser
	links           []oauthLink
	memberships     []oauthMembership

	nextID int

	identityErr   error
	emailErr      error
	createErr     error
	linkErr       error
	membershipErr error
}

func oauthNewFakeStore() *oauthFakeAccountStore {
	return &oauthFakeAccountStore{
		identities: map[string]string{},
		emails:     map[string]string{},
	}
}

// oauthIdentityKey joins the two halves of an identity.
func oauthIdentityKey(provider, subject string) string { return provider + "\x00" + subject }

// bindIdentity pre-seeds an existing (provider, subject) identity.
func (s *oauthFakeAccountStore) bindIdentity(provider, subject, userID string) {
	s.identities[oauthIdentityKey(provider, subject)] = userID
}

// addUser pre-seeds an account that owns an address.
func (s *oauthFakeAccountStore) addUser(userID, email string) {
	s.emails[email] = userID
}

func (s *oauthFakeAccountStore) FindIdentity(_ context.Context, provider, subject string) (string, bool, error) {
	s.identityLookups = append(s.identityLookups, struct{ Provider, Subject string }{provider, subject})
	if s.identityErr != nil {
		return "", false, s.identityErr
	}
	userID, ok := s.identities[oauthIdentityKey(provider, subject)]
	return userID, ok, nil
}

func (s *oauthFakeAccountStore) FindUserByEmail(_ context.Context, email string) (string, bool, error) {
	s.emailLookups = append(s.emailLookups, email)
	if s.emailErr != nil {
		return "", false, s.emailErr
	}
	userID, ok := s.emails[email]
	return userID, ok, nil
}

func (s *oauthFakeAccountStore) CreateUser(_ context.Context, siteID, email, displayName, avatarURL string) (string, error) {
	if s.createErr != nil {
		return "", s.createErr
	}
	s.nextID++
	userID := "user-created-" + strconv.Itoa(s.nextID)
	s.created = append(s.created, oauthCreatedUser{
		SiteID:      siteID,
		Email:       email,
		DisplayName: displayName,
		AvatarURL:   avatarURL,
		ID:          userID,
	})
	if email != "" {
		s.emails[email] = userID
	}
	return userID, nil
}

func (s *oauthFakeAccountStore) EnsureMembership(_ context.Context, siteID, userID string) error {
	if s.membershipErr != nil {
		return s.membershipErr
	}
	s.memberships = append(s.memberships, oauthMembership{SiteID: siteID, UserID: userID})
	return nil
}

func (s *oauthFakeAccountStore) LinkIdentity(_ context.Context, userID, provider, subject, email string) error {
	if s.linkErr != nil {
		return s.linkErr
	}
	s.links = append(s.links, oauthLink{UserID: userID, Provider: provider, Subject: subject, Email: email})
	s.bindIdentity(provider, subject, userID)
	return nil
}

var _ OAuthAccountStore = (*oauthFakeAccountStore)(nil)

// oauthTestProfile is the profile every decision case starts from: a verified
// address at the provider, which is the ordinary case.
func oauthTestProfile() OAuthProfile {
	return OAuthProfile{
		Subject:       "subject-1",
		Email:         "ada@example.com",
		EmailVerified: true,
		DisplayName:   "Ada Lovelace",
		AvatarURL:     "https://cdn.example.com/ada.png",
		Raw:           map[string]any{"sub": "subject-1"},
	}
}

// TestOAuthAccountResolveDecisions covers the three branches of the rule and the
// security case that separates branch (b) from branch (c).
func TestOAuthAccountResolveDecisions(t *testing.T) {
	t.Parallel()

	const (
		provider  = "google"
		subject   = "subject-1"
		address   = "ada@example.com"
		existing  = "user-existing"
		newUserID = "user-created-1"
	)

	tests := []struct {
		name string
		// profile is the provider answer under test.
		profile OAuthProfile
		// seedExisting prepares the store before the call.
		seedExisting func(*oauthFakeAccountStore)
		wantUserID   string
		wantOutcome  OAuthAccountOutcome
		// wantLookups records whether the address was consulted at all. An
		// unverified address must not be.
		wantEmailLookups int
		wantCreated      int
		wantLinks        []oauthLink
	}{
		{
			name:    "existing identity is returned without any write",
			profile: oauthTestProfile(),
			seedExisting: func(s *oauthFakeAccountStore) {
				s.bindIdentity(provider, subject, existing)
			},
			wantUserID:  existing,
			wantOutcome: OutcomeExistingIdentity,
			// The identity lookup short circuits the rule: the address is never
			// read, so a provider side address change cannot fork the account.
			wantEmailLookups: 0,
			wantCreated:      0,
			wantLinks:        nil,
		},
		{
			name:    "verified address that already has an account is linked, not duplicated",
			profile: oauthTestProfile(),
			seedExisting: func(s *oauthFakeAccountStore) {
				s.addUser(existing, address)
			},
			wantUserID:       existing,
			wantOutcome:      OutcomeLinkedExistingUser,
			wantEmailLookups: 1,
			wantCreated:      0,
			wantLinks:        []oauthLink{{UserID: existing, Provider: provider, Subject: subject, Email: address}},
		},
		{
			// The account takeover case: the address exists locally, but the
			// provider never proved the visitor owns it, so it must neither find
			// nor link that account.
			name: "unverified address is not used even when the account exists",
			profile: OAuthProfile{
				Subject:       subject,
				Email:         address,
				EmailVerified: false,
				DisplayName:   "Ada Lovelace",
				AvatarURL:     "https://cdn.example.com/ada.png",
			},
			seedExisting: func(s *oauthFakeAccountStore) {
				s.addUser(existing, address)
			},
			wantUserID:       newUserID,
			wantOutcome:      OutcomeCreatedUser,
			wantEmailLookups: 0,
			wantCreated:      1,
			wantLinks:        []oauthLink{{UserID: newUserID, Provider: provider, Subject: subject, Email: address}},
		},
		{
			name:    "verified address with no account creates one",
			profile: oauthTestProfile(),
			seedExisting: func(s *oauthFakeAccountStore) {
				s.addUser("someone-else", "other@example.com")
			},
			wantUserID:       newUserID,
			wantOutcome:      OutcomeCreatedUser,
			wantEmailLookups: 1,
			wantCreated:      1,
			wantLinks:        []oauthLink{{UserID: newUserID, Provider: provider, Subject: subject, Email: address}},
		},
		{
			name: "no address at all still creates an account",
			profile: OAuthProfile{
				Subject:     subject,
				Email:       "",
				DisplayName: "Ada Lovelace",
			},
			seedExisting:     func(*oauthFakeAccountStore) {},
			wantUserID:       newUserID,
			wantOutcome:      OutcomeCreatedUser,
			wantEmailLookups: 0,
			wantCreated:      1,
			wantLinks:        []oauthLink{{UserID: newUserID, Provider: provider, Subject: subject, Email: ""}},
		},
		{
			// A verified flag with an empty address cannot mean anything: there is
			// no address to match, so the empty address must not be looked up.
			name: "verified flag with empty address does not look up the empty address",
			profile: OAuthProfile{
				Subject:       subject,
				Email:         "   ",
				EmailVerified: true,
			},
			seedExisting: func(s *oauthFakeAccountStore) {
				s.addUser(existing, "")
			},
			wantUserID:       newUserID,
			wantOutcome:      OutcomeCreatedUser,
			wantEmailLookups: 0,
			wantCreated:      1,
			wantLinks:        []oauthLink{{UserID: newUserID, Provider: provider, Subject: subject, Email: ""}},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			store := oauthNewFakeStore()
			tc.seedExisting(store)

			userID, outcome, err := ResolveOAuthAccount(context.Background(), store, oauthTestSiteID, provider, tc.profile)
			require.NoError(t, err)
			require.Equal(t, tc.wantUserID, userID)
			require.Equal(t, tc.wantOutcome, outcome)

			require.Len(t, store.emailLookups, tc.wantEmailLookups, "address lookups: %v", store.emailLookups)
			require.Len(t, store.created, tc.wantCreated, "created users: %+v", store.created)
			require.Equal(t, tc.wantLinks, store.links)
			// Every branch, including the returning identity one, must end with a
			// membership of the login's site or the session would be refused.
			require.Equal(t, []oauthMembership{{SiteID: oauthTestSiteID, UserID: tc.wantUserID}}, store.memberships)
		})
	}
}

// TestOAuthAccountNormalizesProviderAddress proves the address reaches the store
// in the form password accounts are stored in, otherwise a Google login for
// "Ada@Example.com" would miss the account that registered as "ada@example.com"
// and create a second one.
func TestOAuthAccountNormalizesProviderAddress(t *testing.T) {
	t.Parallel()

	store := oauthNewFakeStore()
	store.addUser("user-existing", "ada@example.com")

	profile := oauthTestProfile()
	profile.Email = "  Ada@Example.COM "
	profile.DisplayName = "  Ada Lovelace  "
	profile.AvatarURL = " https://cdn.example.com/ada.png "

	userID, outcome, err := ResolveOAuthAccount(context.Background(), store, oauthTestSiteID, "google", profile)
	require.NoError(t, err)
	require.Equal(t, "user-existing", userID)
	require.Equal(t, OutcomeLinkedExistingUser, outcome)
	require.Equal(t, []string{"ada@example.com"}, store.emailLookups)
	require.Equal(t, "ada@example.com", store.links[0].Email)

	// The creation path trims the profile fields it forwards as well.
	store = oauthNewFakeStore()
	userID, outcome, err = ResolveOAuthAccount(context.Background(), store, oauthTestSiteID, "google", profile)
	require.NoError(t, err)
	require.Equal(t, OutcomeCreatedUser, outcome)
	require.Len(t, store.created, 1)
	require.Equal(t, oauthCreatedUser{
		SiteID:      oauthTestSiteID,
		Email:       "ada@example.com",
		DisplayName: "Ada Lovelace",
		AvatarURL:   "https://cdn.example.com/ada.png",
		ID:          userID,
	}, store.created[0])
}

// TestOAuthAccountErrorPropagation proves every store failure is returned with the
// step that produced it and stays matchable, so the caller can tell a lookup
// failure from a write failure instead of receiving a bare error.
func TestOAuthAccountErrorPropagation(t *testing.T) {
	t.Parallel()

	t.Run("FindIdentity fails", func(t *testing.T) {
		t.Parallel()

		cause := errors.New("identity lookup exploded")
		store := oauthNewFakeStore()
		store.identityErr = cause

		userID, outcome, err := ResolveOAuthAccount(context.Background(), store, oauthTestSiteID, "google", oauthTestProfile())
		require.ErrorIs(t, err, cause)
		require.Contains(t, err.Error(), "find oauth identity")
		require.Empty(t, userID)
		require.Empty(t, outcome)
		// A lookup that failed must not be papered over with an account.
		require.Empty(t, store.created)
		require.Empty(t, store.links)
	})

	t.Run("FindUserByEmail fails", func(t *testing.T) {
		t.Parallel()

		cause := errors.New("address lookup exploded")
		store := oauthNewFakeStore()
		store.emailErr = cause

		userID, outcome, err := ResolveOAuthAccount(context.Background(), store, oauthTestSiteID, "google", oauthTestProfile())
		require.ErrorIs(t, err, cause)
		require.Contains(t, err.Error(), "verified email")
		require.Empty(t, userID)
		require.Empty(t, outcome)
		require.Empty(t, store.created)
	})

	t.Run("LinkIdentity fails on the linking branch", func(t *testing.T) {
		t.Parallel()

		cause := errors.New("link exploded")
		store := oauthNewFakeStore()
		store.addUser("user-existing", "ada@example.com")
		store.linkErr = cause

		userID, outcome, err := ResolveOAuthAccount(context.Background(), store, oauthTestSiteID, "google", oauthTestProfile())
		require.ErrorIs(t, err, cause)
		require.Contains(t, err.Error(), "link oauth identity to existing user")
		require.Empty(t, userID)
		require.Empty(t, outcome)
		// The existing account is not reused when it could not be linked.
		require.Empty(t, store.created)
	})

	t.Run("LinkIdentity fails on the creation branch", func(t *testing.T) {
		t.Parallel()

		cause := errors.New("link exploded")
		store := oauthNewFakeStore()
		store.linkErr = cause

		userID, outcome, err := ResolveOAuthAccount(context.Background(), store, oauthTestSiteID, "google", oauthTestProfile())
		require.ErrorIs(t, err, cause)
		require.Contains(t, err.Error(), "link oauth identity to created user")
		require.Empty(t, userID)
		require.Empty(t, outcome)
	})

	t.Run("CreateUser fails", func(t *testing.T) {
		t.Parallel()

		cause := errors.New("insert exploded")
		store := oauthNewFakeStore()
		store.createErr = cause

		userID, outcome, err := ResolveOAuthAccount(context.Background(), store, oauthTestSiteID, "github", OAuthProfile{Subject: "subject-9"})
		require.ErrorIs(t, err, cause)
		require.Contains(t, err.Error(), "create user")
		require.Empty(t, userID)
		require.Empty(t, outcome)
		// Nothing is linked to a user that was never created.
		require.Empty(t, store.links)
	})

	t.Run("EnsureMembership fails", func(t *testing.T) {
		t.Parallel()

		cause := errors.New("membership write exploded")
		store := oauthNewFakeStore()
		store.membershipErr = cause

		userID, outcome, err := ResolveOAuthAccount(context.Background(), store, oauthTestSiteID, "google", oauthTestProfile())
		require.ErrorIs(t, err, cause)
		require.Contains(t, err.Error(), "is a member of site")
		// An account without a membership cannot sign in, so the login fails even
		// though the account itself was written.
		require.Empty(t, userID)
		require.Empty(t, outcome)
		require.Len(t, store.created, 1)
	})
}

// TestOAuthAccountRejectsIncompleteInput covers the arguments that would make a
// resolution silently resolve to the wrong account.
func TestOAuthAccountRejectsIncompleteInput(t *testing.T) {
	t.Parallel()

	t.Run("nil store", func(t *testing.T) {
		t.Parallel()

		userID, outcome, err := ResolveOAuthAccount(context.Background(), nil, oauthTestSiteID, "google", oauthTestProfile())
		require.Error(t, err)
		require.Empty(t, userID)
		require.Empty(t, outcome)
	})

	// The site is what the account and its membership are created on, so a login
	// that cannot name one must not create anything: there is nothing to join.
	t.Run("empty site", func(t *testing.T) {
		t.Parallel()

		store := oauthNewFakeStore()

		userID, outcome, err := ResolveOAuthAccount(context.Background(), store, "   ", "google", oauthTestProfile())
		require.Error(t, err)
		require.Empty(t, userID)
		require.Empty(t, outcome)
		require.Empty(t, store.identityLookups)
		require.Empty(t, store.created)
		require.Empty(t, store.links)
		require.Empty(t, store.memberships)
	})

	t.Run("empty subject", func(t *testing.T) {
		t.Parallel()

		store := oauthNewFakeStore()
		profile := oauthTestProfile()
		profile.Subject = "   "

		userID, outcome, err := ResolveOAuthAccount(context.Background(), store, oauthTestSiteID, "google", profile)
		require.Error(t, err)
		require.Empty(t, userID)
		require.Empty(t, outcome)
		// An empty subject must not even be looked up: it could match an unrelated
		// row that was also stored without one.
		require.Empty(t, store.identityLookups)
		require.Empty(t, store.created)
	})
}
