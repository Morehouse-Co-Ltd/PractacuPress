package ws

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func fixedClock() (func() time.Time, *time.Time) {
	at := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	return func() time.Time { return at }, &at
}

func TestTicketIsSingleUse(t *testing.T) {
	clock, _ := fixedClock()
	store := NewTicketStore(clock)

	plain, expires, err := store.Issue(Ticket{SiteID: "s1", UserID: "u1"})
	require.NoError(t, err)
	require.NotEmpty(t, plain)
	require.True(t, expires.After(clock()))

	got, err := store.Consume(plain)
	require.NoError(t, err)
	require.Equal(t, Ticket{SiteID: "s1", UserID: "u1"}, got)

	_, err = store.Consume(plain)
	require.ErrorIs(t, err, ErrTicketInvalid, "a ticket is redeemed exactly once")
}

func TestTicketExpires(t *testing.T) {
	clock, at := fixedClock()
	store := NewTicketStore(clock)

	plain, _, err := store.Issue(Ticket{SiteID: "s1", UserID: "u1"})
	require.NoError(t, err)

	*at = at.Add(TicketTTL + time.Second)

	_, err = store.Consume(plain)
	require.ErrorIs(t, err, ErrTicketInvalid)
}

func TestTicketRejectsEmptyAndUnknown(t *testing.T) {
	store := NewTicketStore(nil)

	_, err := store.Consume("")
	require.ErrorIs(t, err, ErrTicketInvalid)

	_, err = store.Consume("not-a-ticket")
	require.ErrorIs(t, err, ErrTicketInvalid)

	_, _, err = store.Issue(Ticket{})
	require.Error(t, err)
}

func TestTicketsAreUnique(t *testing.T) {
	store := NewTicketStore(nil)
	seen := make(map[string]struct{}, 100)

	for i := 0; i < 100; i++ {
		plain, _, err := store.Issue(Ticket{SiteID: "s1", UserID: "u1"})
		require.NoError(t, err)
		_, dup := seen[plain]
		require.False(t, dup)
		seen[plain] = struct{}{}
	}
}

func TestHubDeliversOnlyToTheSite(t *testing.T) {
	hub := NewHub()

	var here, other int
	hub.Subscribe("s1", "u1", func(Event) { here++ })
	hub.Subscribe("s2", "u2", func(Event) { other++ })

	delivered := hub.Publish(context.Background(), Event{ID: "e1", SiteID: "s1"})

	require.Equal(t, 1, delivered)
	require.Equal(t, 1, here)
	require.Zero(t, other, "a subscriber on another site must not receive the event")
}

// TestHubRespectsAudience is the live counterpart of the replay test: an event addressed
// to one user never reaches another user of the same site.
func TestHubRespectsAudience(t *testing.T) {
	hub := NewHub()

	var mine, theirs int
	hub.Subscribe("s1", "u1", func(Event) { mine++ })
	hub.Subscribe("s1", "u2", func(Event) { theirs++ })

	delivered := hub.Publish(context.Background(), Event{
		ID: "e1", SiteID: "s1", AudienceUserID: "u2",
	})

	require.Equal(t, 1, delivered)
	require.Zero(t, mine)
	require.Equal(t, 1, theirs)
}

func TestHubUnsubscribeStopsDelivery(t *testing.T) {
	hub := NewHub()

	var count int
	unsubscribe := hub.Subscribe("s1", "u1", func(Event) { count++ })
	require.Equal(t, 1, hub.Count())

	unsubscribe()
	require.Zero(t, hub.Count())

	hub.Publish(context.Background(), Event{SiteID: "s1"})
	require.Zero(t, count, "an unsubscribed connection receives nothing")
}

func TestHubPublishStopsWhenContextIsCancelled(t *testing.T) {
	hub := NewHub()

	var count int
	hub.Subscribe("s1", "u1", func(Event) { count++ })

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	hub.Publish(ctx, Event{SiteID: "s1"})
	require.Zero(t, count)
}
