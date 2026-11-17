package newsletter_test

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/newsletter"
)

var tokenPattern = regexp.MustCompile(`(?:confirm|unsubscribe)\?token=([A-Za-z0-9_-]+)`)

// confirmToken extracts the first confirmation token from a captured mail.
func confirmToken(t *testing.T, body string) string {
	t.Helper()
	matches := tokenPattern.FindAllStringSubmatch(body, -1)
	require.NotEmpty(t, matches, "mail body carries no token link: %s", body)
	return matches[0][1]
}

func subscribe(t *testing.T, service *newsletter.Service, email string) newsletter.SubscribeResult {
	t.Helper()
	result, err := service.Subscribe(context.Background(), newsletter.SubscribeInput{
		Site:        testSite(),
		Email:       email,
		RequestBase: "https://request.example.com",
		IPHash:      "ip-hash",
	})
	require.NoError(t, err)
	return result
}

func TestSubscribeNormalisesEmailAndStoresOnlyTheTokenHash(t *testing.T) {
	repo := newFakeRepo()
	gateway := newFakeGateway(repo, true)
	service := serviceWith(t, repo, gateway)

	result := subscribe(t, service, "  Reader@Example.COM ")
	require.Equal(t, newsletter.StatusPending, result.Status)

	require.Len(t, repo.subscribers, 1)
	stored := repo.subscribers[0]
	require.Equal(t, "reader@example.com", stored.Email)
	require.Equal(t, newsletter.StatusPending, stored.Status)
	require.Equal(t, newsletter.SourceSite, stored.Source)
	require.NotEmpty(t, stored.TokenHash)

	require.Len(t, gateway.sends, 1)
	sent := gateway.sends[0]
	require.Equal(t, "reader@example.com", sent.To)
	require.Equal(t, newsletter.KeySubscriberConfirm, sent.TemplateKey)
	require.NotContains(t, sent.Text, stored.TokenHash, "the plaintext token is mailed, never the hash")

	token := confirmToken(t, sent.Text)
	require.NotEqual(t, token, stored.TokenHash, "the database must not keep the plaintext token")
	require.Equal(t, newsletter.HashToken(token), stored.TokenHash)
	require.Contains(t, sent.Text, "https://press.example.com/newsletter/confirm?token="+token,
		"the pinned PUBLIC_BASE_URL wins over the request origin")
}

func TestConfirmAndUnsubscribeFlow(t *testing.T) {
	repo := newFakeRepo()
	gateway := newFakeGateway(repo, true)
	service := serviceWith(t, repo, gateway)
	ctx := context.Background()

	subscribe(t, service, "reader@example.com")
	token := confirmToken(t, gateway.sends[0].Text)

	status, err := service.Confirm(ctx, token)
	require.NoError(t, err)
	require.Equal(t, newsletter.StatusConfirmed, status)
	require.Equal(t, newsletter.StatusConfirmed, repo.subscribers[0].Status)
	require.NotNil(t, repo.subscribers[0].ConfirmedAt)

	// A mail client prefetching the link or a double click must not fail.
	status, err = service.Confirm(ctx, token)
	require.NoError(t, err)
	require.Equal(t, newsletter.StatusConfirmed, status)

	status, err = service.Unsubscribe(ctx, token)
	require.NoError(t, err)
	require.Equal(t, newsletter.StatusUnsubscribed, status)
	require.Equal(t, newsletter.StatusUnsubscribed, repo.subscribers[0].Status)
	require.NotNil(t, repo.subscribers[0].UnsubscribedAt)

	// Unsubscribing twice is idempotent.
	status, err = service.Unsubscribe(ctx, token)
	require.NoError(t, err)
	require.Equal(t, newsletter.StatusUnsubscribed, status)

	// A stale confirmation link must not silently resubscribe the address.
	_, err = service.Confirm(ctx, token)
	require.ErrorIs(t, err, newsletter.ErrInvalidToken)
}

func TestUnknownTokensAreRejected(t *testing.T) {
	repo := newFakeRepo()
	service := serviceWith(t, repo, newFakeGateway(repo, true))

	_, err := service.Confirm(context.Background(), "not-a-token")
	require.ErrorIs(t, err, newsletter.ErrInvalidToken)

	_, err = service.Unsubscribe(context.Background(), "")
	require.ErrorIs(t, err, newsletter.ErrInvalidToken)
}

func TestRepeatedSubscribeIsIdempotent(t *testing.T) {
	repo := newFakeRepo()
	gateway := newFakeGateway(repo, true)
	service := serviceWith(t, repo, gateway)
	ctx := context.Background()

	require.Equal(t, newsletter.StatusPending, subscribe(t, service, "reader@example.com").Status)
	require.Equal(t, newsletter.StatusPending, subscribe(t, service, "reader@example.com").Status)
	require.Len(t, repo.subscribers, 1)
	require.Len(t, gateway.sends, 1, "a pending address must not be mailed twice")

	token := confirmToken(t, gateway.sends[0].Text)
	_, err := service.Confirm(ctx, token)
	require.NoError(t, err)

	require.Equal(t, newsletter.StatusConfirmed, subscribe(t, service, "reader@example.com").Status)
	require.Len(t, repo.subscribers, 1)
	require.Len(t, gateway.sends, 1, "a confirmed address must not be mailed again")
}

func TestUnsubscribedAddressRestartsTheOptIn(t *testing.T) {
	repo := newFakeRepo()
	gateway := newFakeGateway(repo, true)
	service := serviceWith(t, repo, gateway)
	ctx := context.Background()

	subscribe(t, service, "reader@example.com")
	firstToken := confirmToken(t, gateway.sends[0].Text)
	_, err := service.Confirm(ctx, firstToken)
	require.NoError(t, err)
	_, err = service.Unsubscribe(ctx, firstToken)
	require.NoError(t, err)

	result := subscribe(t, service, "reader@example.com")
	require.Equal(t, newsletter.StatusPending, result.Status)
	require.Len(t, gateway.sends, 2)
	secondToken := confirmToken(t, gateway.sends[1].Text)
	require.NotEqual(t, firstToken, secondToken, "the opt in restarts with a fresh token")

	_, err = service.Confirm(ctx, firstToken)
	require.ErrorIs(t, err, newsletter.ErrInvalidToken, "the retired token stops working")
	_, err = service.Confirm(ctx, secondToken)
	require.NoError(t, err)
}

func TestInvalidEmailIsRejected(t *testing.T) {
	repo := newFakeRepo()
	service := serviceWith(t, repo, newFakeGateway(repo, true))

	for _, email := range []string{"", "not-an-email", "a@b@c", strings.Repeat("a", 400) + "@example.com"} {
		_, err := service.Subscribe(context.Background(), newsletter.SubscribeInput{
			Site:   testSite(),
			Email:  email,
			IPHash: "ip-hash",
		})
		require.ErrorIs(t, err, newsletter.ErrInvalidEmail, "email %q", email)
	}
}

func TestSubscribeIsRateLimitedPerHashedAddress(t *testing.T) {
	repo := newFakeRepo()
	gateway := newFakeGateway(repo, true)
	clock := func() time.Time { return time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC) }
	service := serviceWith(t, repo, gateway, func(cfg *newsletter.ServiceConfig) {
		cfg.Limiter = newsletter.NewLimiter(2, time.Hour, clock)
	})
	ctx := context.Background()

	for index := 0; index < 2; index++ {
		_, err := service.Subscribe(ctx, newsletter.SubscribeInput{
			Site:        testSite(),
			Email:       "reader" + itoa(index) + "@example.com",
			RequestBase: "https://request.example.com",
			IPHash:      newsletter.HashIP("203.0.113.5"),
		})
		require.NoError(t, err)
	}

	_, err := service.Subscribe(ctx, newsletter.SubscribeInput{
		Site:        testSite(),
		Email:       "reader3@example.com",
		RequestBase: "https://request.example.com",
		IPHash:      newsletter.HashIP("203.0.113.5"),
	})
	require.ErrorIs(t, err, newsletter.ErrRateLimited)

	// A different address is a different bucket.
	_, err = service.Subscribe(ctx, newsletter.SubscribeInput{
		Site:        testSite(),
		Email:       "reader4@example.com",
		RequestBase: "https://request.example.com",
		IPHash:      newsletter.HashIP("203.0.113.6"),
	})
	require.NoError(t, err)
}

func TestHashIPDoesNotKeepThePlainAddress(t *testing.T) {
	hashed := newsletter.HashIP("203.0.113.5")
	require.NotContains(t, hashed, "203.0.113.5")
	require.Equal(t, hashed, newsletter.HashIP(" 203.0.113.5 "))
	require.NotEqual(t, hashed, newsletter.HashIP("203.0.113.6"))
	require.Len(t, hashed, 64)
}

func TestAccountPreferenceRoundTrip(t *testing.T) {
	repo := newFakeRepo()
	gateway := newFakeGateway(repo, true)
	service := serviceWith(t, repo, gateway, func(cfg *newsletter.ServiceConfig) {
		cfg.AccountEmail = func(context.Context, string) (string, error) {
			return "Reader@Example.com", nil
		}
	})
	ctx := context.Background()

	preference, err := service.MyPreference(ctx, testSite().ID, "user-1")
	require.NoError(t, err)
	require.False(t, preference.Subscribed)
	require.Equal(t, "reader@example.com", preference.Email)

	preference, err = service.SetMyPreference(ctx, testSite(), "user-1", "https://request.example.com", true)
	require.NoError(t, err)
	require.False(t, preference.Subscribed, "subscribing still requires the confirmation mail")
	require.Equal(t, newsletter.StatusPending, preference.Status)
	require.Len(t, repo.subscribers, 1)
	require.Equal(t, newsletter.SourceAccount, repo.subscribers[0].Source)
	require.Equal(t, "user-1", repo.subscribers[0].UserID)
	require.Len(t, gateway.sends, 1)

	token := confirmToken(t, gateway.sends[0].Text)
	_, err = service.Confirm(ctx, token)
	require.NoError(t, err)

	preference, err = service.MyPreference(ctx, testSite().ID, "user-1")
	require.NoError(t, err)
	require.True(t, preference.Subscribed)
	require.Equal(t, newsletter.StatusConfirmed, preference.Status)

	preference, err = service.SetMyPreference(ctx, testSite(), "user-1", "https://request.example.com", false)
	require.NoError(t, err)
	require.False(t, preference.Subscribed)
	require.Equal(t, newsletter.StatusUnsubscribed, preference.Status)
	require.Equal(t, newsletter.StatusUnsubscribed, repo.subscribers[0].Status)
}

func TestAccountWithoutEmailCannotSubscribe(t *testing.T) {
	repo := newFakeRepo()
	service := serviceWith(t, repo, newFakeGateway(repo, true), func(cfg *newsletter.ServiceConfig) {
		cfg.AccountEmail = func(context.Context, string) (string, error) { return "", nil }
	})

	preference, err := service.MyPreference(context.Background(), testSite().ID, "user-1")
	require.NoError(t, err)
	require.False(t, preference.Subscribed)
	require.Empty(t, preference.Email)

	_, err = service.SetMyPreference(context.Background(), testSite(), "user-1", "", true)
	require.ErrorIs(t, err, newsletter.ErrAccountEmailMissing)
}

func TestSubscribeSurvivesDeliveryFailure(t *testing.T) {
	repo := newFakeRepo()
	gateway := newFakeGateway(repo, true)
	gateway.sendErr = errors.New("smtp: relay down")
	service := serviceWith(t, repo, gateway)

	// The row exists and the failure is in the mail log; the visitor must still see
	// the accepted response instead of an error that would make them retry.
	result := subscribe(t, service, "reader@example.com")
	require.Equal(t, newsletter.StatusPending, result.Status)
	require.Len(t, repo.subscribers, 1)
}
