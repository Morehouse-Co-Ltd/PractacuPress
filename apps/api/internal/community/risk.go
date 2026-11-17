package community

import (
	"github.com/practacu/practacu-press/apps/api/internal/platform/textrisk"
)

// Risk flags are the reasons behind a score.
//
// They are stable identifiers rather than sentences: the moderator UI owns the
// wording and the reader's language. Adding a flag is a compatible change; renaming
// one invalidates every stored row and every translation, which is why they are
// constants instead of string literals scattered through the detectors.
//
// The identifiers themselves live in platform/textrisk, because the content review
// queue scores articles with the same detectors. The names stay here so the comment
// API (and its stored rows) keeps one vocabulary of its own: a rename or a removal in
// the community package is meant to be a breaking change, not a silent alias update.
const (
	// RiskFlagLinks marks a body that carries one or more URLs.
	RiskFlagLinks = textrisk.FlagLinks
	// RiskFlagVeryShort marks a body too short to be a real comment.
	RiskFlagVeryShort = textrisk.FlagVeryShort
	// RiskFlagVeryLong marks a body past the long-form threshold for a comment.
	RiskFlagVeryLong = textrisk.FlagVeryLong
	// RiskFlagRepeatedChars marks a long run of a single repeated character.
	RiskFlagRepeatedChars = textrisk.FlagRepeatedChars
	// RiskFlagShouty marks predominantly upper case text.
	RiskFlagShouty = textrisk.FlagShouty
	// RiskFlagNoLetters marks a body that is almost all punctuation, symbols or
	// digits, so it carries no words a reader could reply to.
	RiskFlagNoLetters = textrisk.FlagNoLetters
	// RiskFlagRepeatedText marks a body dominated by one repeating sequence, which is
	// what keyword stuffing looks like after the first few words.
	RiskFlagRepeatedText = textrisk.FlagRepeatedText
)

// AssessRisk scores a comment body for the moderator queue.
//
// The score answers one question for a human reviewer: how urgently does this text
// need a look? It is computed on the server when the comment is written, so the queue
// ranks the same way on every device, survives a browser with JavaScript turned off,
// and cannot be skipped by calling the approve endpoint directly.
//
// The detectors - the signals, their weights, the 4000 character analysis window and
// the flag vocabulary - are the shared ones in platform/textrisk. This function is the
// comment shaped name for them, and it delegates unchanged, so a comment and a pending
// article are ranked by exactly the same rules: the review queue in the dashboard
// reads one number from one implementation.
func AssessRisk(body string) (score int, flags []string) {
	return textrisk.Assess(body)
}

// EncodeRiskFlags renders flags for the JSON text column.
//
// It never returns an empty string: the column defaults to "[]" and a caller that
// decodes the value should not have to special-case a NULL or a blank row.
func EncodeRiskFlags(flags []string) string {
	return textrisk.EncodeFlags(flags)
}

// DecodeRiskFlags reads the stored JSON back into flags.
//
// Every unreadable value decodes to an empty list rather than an error: the column is
// derived data, and a row written by an older build (or by hand) must still be
// listable in the queue instead of failing the whole page.
func DecodeRiskFlags(raw string) []string {
	return textrisk.DecodeFlags(raw)
}
