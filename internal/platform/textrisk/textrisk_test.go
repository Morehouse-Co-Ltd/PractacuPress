package textrisk_test

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/textrisk"
)

// TestAssessCleanTextScoresLow pins the calibration the moderator queues rely on:
// ordinary conversation and ordinary prose, in any script, must not be ranked by the
// detectors. The Chinese case matters because its characters are letters, not symbols.
func TestAssessCleanTextScoresLow(t *testing.T) {
	bodies := []string{
		"Thanks for the write-up. The second example finally made the caching rule click.",
		"Small nit: the quote in paragraph three is attributed to the wrong author.",
		"写得很好，第二段关于缓存的解释终于让我明白了。",
		"I tried this on Windows and it worked, but the installer still needs the old runtime.",
	}

	for _, body := range bodies {
		score, flags := textrisk.Assess(body)
		require.Less(t, score, 20, "ordinary text stays low risk: %q", body)
		require.Empty(t, flags, "ordinary text produces no flag: %q", body)
	}
}

// TestAssessManyLinksScoresHigh is the signal both queues score first: one link is
// often a citation, a body that exists to carry links is spam.
func TestAssessManyLinksScoresHigh(t *testing.T) {
	single, flags := textrisk.Assess("Source for the numbers: https://example.com/report")
	require.Contains(t, flags, textrisk.FlagLinks)
	require.Less(t, single, 25, "one cited link is not spam on its own")

	body := "Cheap tools here https://a.example/x www.b.example https://c.example/y " +
		"and https://d.example/z - order today"
	score, flags := textrisk.Assess(body)
	require.Contains(t, flags, textrisk.FlagLinks)
	require.GreaterOrEqual(t, score, 50, "four links in one sentence is a link farm")
}

// TestAssessSymbolsOnlyScoresHigh covers the body that is not text at all: it has no
// words a reader can answer, which is exactly what a moderation queue sorts out.
func TestAssessSymbolsOnlyScoresHigh(t *testing.T) {
	score, flags := textrisk.Assess("!!!!!!!!????????@@@@@@@@########$$$$%%%%")
	require.Contains(t, flags, textrisk.FlagNoLetters)
	require.Contains(t, flags, textrisk.FlagRepeatedChars)
	require.GreaterOrEqual(t, score, 50)
}

// TestAssessShoutyAndRepetition covers the two text level signals separately from the
// symbol rules, so a strict upper case keyword dump is caught while a reader can still
// see ordinary prose with a single emphasised word.
func TestAssessShoutyAndRepetition(t *testing.T) {
	shouty, flags := textrisk.Assess("THIS CONCLUSION IS WRONG ON EVERY SINGLE PLATFORM")
	require.Contains(t, flags, textrisk.FlagShouty)
	require.GreaterOrEqual(t, shouty, 15)

	stuffed, flags := textrisk.Assess("buy now buy now buy now buy now buy now buy now")
	require.Contains(t, flags, textrisk.FlagRepeatedText)
	require.NotContains(t, flags, textrisk.FlagShouty, "lower case stuffing is repetition, not shouting")
	require.GreaterOrEqual(t, stuffed, 20)
}

// TestAssessLengthFlags covers both ends of the length rule: the placeholder that is
// too short to answer and the body that is not a comment but an article.
func TestAssessLengthFlags(t *testing.T) {
	short, flags := textrisk.Assess("ok")
	require.Equal(t, 5, short, "the short body weight is the only signal that fires")
	require.Equal(t, []string{textrisk.FlagVeryShort}, flags)

	long := strings.Repeat("a paragraph of explanation that keeps going. ", 60)
	over, flags := textrisk.Assess(long)
	require.Contains(t, flags, textrisk.FlagVeryLong)
	require.Greater(t, over, short)
}

// TestAssessEmptyBodyIsZero keeps the empty input out of the "no letters" rule: an
// absent body is a validation problem, not a risky submission.
func TestAssessEmptyBodyIsZero(t *testing.T) {
	for _, body := range []string{"", " ", "\n\t \r\n", "   \u00a0  "} {
		score, flags := textrisk.Assess(body)
		require.Zero(t, score, "body %q", body)
		require.Empty(t, flags, "body %q", body)
	}
}

// TestAssessHugeBodyStaysFast is the denial of service guard: the detectors only read a
// bounded prefix, so a megabyte body cannot make a write or a queue read expensive.
func TestAssessHugeBodyStaysFast(t *testing.T) {
	huge := strings.Repeat("buy now at https://example.com/x or www.example.com ", 2000)
	require.Greater(t, len(huge), 100_000)

	started := time.Now()
	score, flags := textrisk.Assess(huge)
	elapsed := time.Since(started)

	require.GreaterOrEqual(t, score, 0)
	require.LessOrEqual(t, score, 100)
	require.NotEmpty(t, flags)
	require.Less(t, elapsed, 250*time.Millisecond, "a bounded window keeps the scan cheap")
}

// TestAssessScoreStaysInRange is the published contract: a score is always an integer
// in 0..100 whatever the body looks like, and every emitted flag is a stable
// identifier from the package vocabulary.
func TestAssessScoreStaysInRange(t *testing.T) {
	bodies := []string{
		"",
		"x",
		"你好",
		"😀😀😀😀😀😀😀😀",
		"1234567890",
		"WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW",
		strings.Repeat("!!", 500),
		"https://a.example https://b.example https://c.example https://d.example",
		"Mixed 中文 and ASCII text that repeats the same phrase over and over again.",
	}

	for _, body := range bodies {
		score, flags := textrisk.Assess(body)
		require.GreaterOrEqual(t, score, 0, "body %q", body)
		require.LessOrEqual(t, score, 100, "body %q", body)
		for _, flag := range flags {
			require.Regexp(t, `^[a-z_]+$`, flag, "flags are stable identifiers the UI translates")
			require.Contains(t, textrisk.Flags, flag)
		}
	}
}

// TestAssessFlagsFollowVocabularyOrder documents the one ordering guarantee callers
// can rely on: flags come out in detector order, so two runs - and two call sites -
// serialise the same way.
func TestAssessFlagsFollowVocabularyOrder(t *testing.T) {
	// A held key made of punctuation: the character-run detector and the "no letters"
	// detector both fire, and they sit apart in the vocabulary, so the assertion below
	// can actually see the ordering.
	body := "!!!!!!!!???"
	_, flags := textrisk.Assess(body)
	require.GreaterOrEqual(t, len(flags), 2, "the body trips more than one detector: %v", flags)

	position := make(map[string]int, len(textrisk.Flags))
	for index, flag := range textrisk.Flags {
		position[flag] = index
	}
	for i := 1; i < len(flags); i++ {
		require.Less(t, position[flags[i-1]], position[flags[i]],
			"flags keep the vocabulary order: %v", flags)
	}
}

// TestFlagsVocabularyIsStable is the storage contract: the identifiers are written to
// the database and translated by the client, so the list is part of the schema.
func TestFlagsVocabularyIsStable(t *testing.T) {
	require.Equal(t, []string{
		"links",
		"very_short",
		"very_long",
		"repeated_chars",
		"shouty",
		"no_letters",
		"repeated_text",
	}, textrisk.Flags)

	matchable := regexp.MustCompile(`^[a-z][a-z_]*$`)
	for _, flag := range textrisk.Flags {
		require.Regexp(t, matchable, flag)
	}
}

// TestFlagsEncoding pins the storage format: the column defaults to "[]" and every
// unreadable value decodes to an empty list instead of failing a read.
func TestFlagsEncoding(t *testing.T) {
	require.Equal(t, "[]", textrisk.EncodeFlags(nil))
	require.Equal(t, "[]", textrisk.EncodeFlags([]string{}))

	flags := []string{textrisk.FlagLinks, textrisk.FlagShouty}
	encoded := textrisk.EncodeFlags(flags)
	require.JSONEq(t, `["links","shouty"]`, encoded)
	require.Equal(t, flags, textrisk.DecodeFlags(encoded))

	for _, raw := range []string{"", "  ", "null", "not json", "[1,2]"} {
		require.Empty(t, textrisk.DecodeFlags(raw), "raw value %q", raw)
	}
}
