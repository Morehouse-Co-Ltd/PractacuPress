package notifications

import (
	"context"
	"errors"
	"time"
)

// Category groups notification types the reader can mute as a unit.
//
// Four categories are enough to express what people actually want to switch off
// (a like is not the same as a review decision) without turning the settings page
// into one toggle per event name.
type Category string

// Supported notification categories.
const (
	CategoryComments   Category = "comments"
	CategoryReactions  Category = "reactions"
	CategoryFollows    Category = "follows"
	CategoryModeration Category = "moderation"
)

// Categories is the stable order used by the API and the settings UI.
var Categories = []Category{
	CategoryComments,
	CategoryReactions,
	CategoryFollows,
	CategoryModeration,
}

// Valid reports whether the category is defined.
func (c Category) Valid() bool {
	switch c {
	case CategoryComments, CategoryReactions, CategoryFollows, CategoryModeration:
		return true
	default:
		return false
	}
}

// CategoryOf maps an event type to the switch that controls it.
//
// Message and contact rows are operational traffic addressed to staff, so they
// share the moderation bucket instead of inventing a fifth switch nobody visits.
func CategoryOf(t Type) Category {
	switch t {
	case TypeComment:
		return CategoryComments
	case TypeReaction:
		return CategoryReactions
	case TypeFollow:
		return CategoryFollows
	default:
		return CategoryModeration
	}
}

// Channel is one delivery path.
type Channel string

// Supported channels.
const (
	ChannelInApp Channel = "in_app"
	ChannelEmail Channel = "email"
)

// ChannelPreferences is the master switch plus the per-category switches of one
// channel.
//
// The master switch exists so "turn email off" is one click, while the category
// switches keep a later re-enable from re-subscribing someone to everything.
type ChannelPreferences struct {
	Enabled    bool
	Comments   bool
	Reactions  bool
	Follows    bool
	Moderation bool
}

// Allows reports whether one event type may be delivered on this channel.
func (c ChannelPreferences) Allows(t Type) bool {
	if !c.Enabled {
		return false
	}
	switch CategoryOf(t) {
	case CategoryComments:
		return c.Comments
	case CategoryReactions:
		return c.Reactions
	case CategoryFollows:
		return c.Follows
	case CategoryModeration:
		return c.Moderation
	default:
		return false
	}
}

// Preferences is one member's notification settings on one site.
type Preferences struct {
	InApp ChannelPreferences
	Email ChannelPreferences
}

// DefaultPreferences is what an account that never opened the settings page gets:
// the in-app inbox on for everything, email off.
//
// Email defaults off because the server must not start mailing people just
// because an operator configured SMTP; sending is opt-in per recipient.
func DefaultPreferences() Preferences {
	return Preferences{
		InApp: ChannelPreferences{
			Enabled:    true,
			Comments:   true,
			Reactions:  true,
			Follows:    true,
			Moderation: true,
		},
		Email: ChannelPreferences{
			Enabled:    false,
			Comments:   true,
			Reactions:  true,
			Follows:    true,
			Moderation: true,
		},
	}
}

// Allows reports whether this preference set delivers one type on one channel.
func (p Preferences) Allows(channel Channel, t Type) bool {
	switch channel {
	case ChannelInApp:
		return p.InApp.Allows(t)
	case ChannelEmail:
		return p.Email.Allows(t)
	default:
		return false
	}
}

// PreferenceRepository persists per-member choices.
//
// It is optional on Repository, like the other read ports in this codebase, so a
// test fake written before the settings existed keeps compiling. A store that does
// not implement it means the deployment cannot persist choices, not that they were
// rejected: reads fall back to DefaultPreferences.
type PreferenceRepository interface {
	LoadPreferences(ctx context.Context, siteID, userID string) (Preferences, error)
	SavePreferences(ctx context.Context, siteID, userID string, preferences Preferences) error
}

// DedupeChecker suppresses a repeat of the same interaction inside a short window.
type DedupeChecker interface {
	ExistsRecent(ctx context.Context, siteID, userID, dedupeKey string, since time.Time) (bool, error)
}

// ProfileLookup resolves the public name of an actor, so the inbox and the email
// can say who did it without every producer having to join the user table.
type ProfileLookup interface {
	DisplayName(ctx context.Context, userID string) (string, error)
}

// EmailLookup resolves the address a notification mail is sent to.
type EmailLookup interface {
	Email(ctx context.Context, userID string) (string, error)
}

// DedupeWindow is how long a repeated interaction stays collapsed.
const DedupeWindow = 24 * time.Hour

// Sentinel errors for the settings endpoints.
var (
	// ErrPreferencesUnavailable means the configured store cannot persist choices.
	ErrPreferencesUnavailable = errors.New("notifications: preferences are not available")
)
