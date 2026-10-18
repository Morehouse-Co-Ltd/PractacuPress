// Package ws serves live event delivery over WebSocket.
//
// Two rules shape this package:
//
//  1. A connection is authorised by a one time ticket, never by the access token in the
//     URL. URLs end up in logs and browser history, and an access token there would leak.
//  2. Live delivery is best effort. The REST catch-up endpoint is authoritative, so a
//     dropped message is recoverable and this package may favour simplicity.
package ws

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

// Sentinel errors for tickets.
var (
	// ErrTicketInvalid means the ticket is unknown, expired or already used.
	ErrTicketInvalid = errors.New("ws: ticket is invalid")
)

// TicketTTL bounds how long a ticket may be redeemed.
const TicketTTL = 60 * time.Second

// Ticket is the identity a connection will act as.
type Ticket struct {
	SiteID string
	UserID string
}

// ticketEntry stores the hash of a live ticket.
type ticketEntry struct {
	ticket  Ticket
	expires time.Time
}

// TicketStore issues and redeems one time connection tickets.
//
// Tickets are kept hashed even though they are short lived: a heap dump or a log line
// should not hand an attacker a usable ticket.
type TicketStore struct {
	mu      sync.Mutex
	entries map[string]ticketEntry
	now     func() time.Time
	ttl     time.Duration
}

// NewTicketStore builds an empty store.
func NewTicketStore(now func() time.Time) *TicketStore {
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &TicketStore{entries: make(map[string]ticketEntry), now: now, ttl: TicketTTL}
}

// Issue creates a ticket for one principal.
func (s *TicketStore) Issue(ticket Ticket) (string, time.Time, error) {
	if ticket.SiteID == "" || ticket.UserID == "" {
		return "", time.Time{}, errors.New("ws: site and user are required")
	}

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", time.Time{}, err
	}
	plain := base64.RawURLEncoding.EncodeToString(raw)
	expires := s.now().Add(s.ttl)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.evictExpiredLocked()
	s.entries[hashTicket(plain)] = ticketEntry{ticket: ticket, expires: expires}

	return plain, expires, nil
}

// Consume redeems a ticket exactly once.
func (s *TicketStore) Consume(plain string) (Ticket, error) {
	if plain == "" {
		return Ticket{}, ErrTicketInvalid
	}

	key := hashTicket(plain)

	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.entries[key]
	if !ok {
		return Ticket{}, ErrTicketInvalid
	}
	// Deleting before the expiry check makes every path single use, including the
	// expired one, so a stale ticket cannot be probed repeatedly.
	delete(s.entries, key)

	if !s.now().Before(entry.expires) {
		return Ticket{}, ErrTicketInvalid
	}
	return entry.ticket, nil
}

// Len reports how many live tickets are held. It exists for tests and metrics.
func (s *TicketStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

func (s *TicketStore) evictExpiredLocked() {
	now := s.now()
	for key, entry := range s.entries {
		if !now.Before(entry.expires) {
			delete(s.entries, key)
		}
	}
}

func hashTicket(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}

// Event is one message delivered to a connection.
type Event struct {
	ID             string         `json:"id"`
	Type           string         `json:"type"`
	OccurredAt     time.Time      `json:"occurred_at"`
	SiteID         string         `json:"site_id"`
	AudienceUserID string         `json:"-"`
	Payload        map[string]any `json:"payload"`
}

// Subscriber receives events for one connection.
type Subscriber struct {
	SiteID string
	UserID string
	Send   func(Event)
}

// Hub fans events out to live connections.
//
// Delivery is filtered by site and audience here as well as in the replay query: a bug
// in one path must not become a leak in the other.
type Hub struct {
	mu          sync.RWMutex
	subscribers map[*Subscriber]struct{}
}

// NewHub builds an empty hub.
func NewHub() *Hub { return &Hub{subscribers: make(map[*Subscriber]struct{})} }

// Subscribe registers a connection and returns its unsubscribe function.
func (h *Hub) Subscribe(siteID, userID string, send func(Event)) func() {
	sub := &Subscriber{SiteID: siteID, UserID: userID, Send: send}

	h.mu.Lock()
	h.subscribers[sub] = struct{}{}
	h.mu.Unlock()

	return func() {
		h.mu.Lock()
		delete(h.subscribers, sub)
		h.mu.Unlock()
	}
}

// Publish delivers an event to every eligible subscriber.
func (h *Hub) Publish(ctx context.Context, event Event) int {
	h.mu.RLock()
	targets := make([]*Subscriber, 0, len(h.subscribers))
	for sub := range h.subscribers {
		if sub.SiteID != event.SiteID {
			continue
		}
		if event.AudienceUserID != "" && event.AudienceUserID != sub.UserID {
			continue
		}
		targets = append(targets, sub)
	}
	h.mu.RUnlock()

	for _, sub := range targets {
		if ctx.Err() != nil {
			break
		}
		sub.Send(event)
	}
	return len(targets)
}

// Count reports the number of live subscribers.
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subscribers)
}
