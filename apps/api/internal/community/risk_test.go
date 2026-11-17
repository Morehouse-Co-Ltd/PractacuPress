package community

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestAssessRiskCleanCommentsScoreLow pins the calibration the moderator queue relies
// on: ordinary conversation, in any script, must not be ranked by the detector. The
// Chinese case matters because its characters are letters, not symbols.
func TestAssessRiskCleanCommentsScoreLow(t *testing.T) {
	bodies := []string{
		"Thanks for the write-up. The second example finally made the caching rule click.",
		"Small nit: the quote in paragraph three is attributed to the wrong author.",
		"写得很好，第二段关于缓存的解释终于让我明白了。",
		"I tried this on Windows and it worked, but the installer still needs the old runtime.",
	}

	for _, body := range bodies {
		score, flags := AssessRisk(body)
		require.Less(t, score, 20, "a normal comment stays low risk: %q", body)
		require.Empty(t, flags, "a normal comment produces no flag: %q", body)
	}
}

// TestAssessRiskManyLinksScoresHigh is the signal the old browser side scored first:
// one link is often a citation, a body that exists to carry links is spam.
func TestAssessRiskManyLinksScoresHigh(t *testing.T) {
	single, flags := AssessRisk("Source for the numbers: https://example.com/report")
	require.Contains(t, flags, RiskFlagLinks)
	require.Less(t, single, 25, "one cited link is not spam on its own")

	body := "Cheap tools here https://a.example/x www.b.example https://c.example/y " +
		"and https://d.example/z - order today"
	score, flags := AssessRisk(body)
	require.Contains(t, flags, RiskFlagLinks)
	require.GreaterOrEqual(t, score, 50, "four links in one sentence is a link farm")
}

// TestAssessRiskSymbolsOnlyScoresHigh covers the body that is not text at all: it has
// no words a reader can answer, which is exactly what the queue is asked to sort out.
func TestAssessRiskSymbolsOnlyScoresHigh(t *testing.T) {
	score, flags := AssessRisk("!!!!!!!!????????@@@@@@@@########$$$$%%%%")
	require.Contains(t, flags, RiskFlagNoLetters)
	require.Contains(t, flags, RiskFlagRepeatedChars)
	require.GreaterOrEqual(t, score, 50)
}

// TestAssessRiskShoutyAndRepetition covers the two text level signals separately from
// the symbol rules, so a strict upper case keyword dump is caught while a reader can
// still see ordinary prose with a single emphasised word.
func TestAssessRiskShoutyAndRepetition(t *testing.T) {
	shouty, flags := AssessRisk("THIS CONCLUSION IS WRONG ON EVERY SINGLE PLATFORM")
	require.Contains(t, flags, RiskFlagShouty)
	require.GreaterOrEqual(t, shouty, 15)

	stuffed, flags := AssessRisk("buy now buy now buy now buy now buy now buy now")
	require.Contains(t, flags, RiskFlagRepeatedText)
	require.NotContains(t, flags, RiskFlagShouty, "lower case stuffing is repetition, not shouting")
	require.GreaterOrEqual(t, stuffed, 20)
}

// TestAssessRiskLengthFlags covers both ends of the length rule: the placeholder that
// is too short to answer and the body that is not a comment but an article.
func TestAssessRiskLengthFlags(t *testing.T) {
	short, flags := AssessRisk("ok")
	require.Contains(t, flags, RiskFlagVeryShort)

	long := strings.Repeat("a paragraph of explanation that keeps going. ", 60)
	over, flags := AssessRisk(long)
	require.Contains(t, flags, RiskFlagVeryLong)
	require.Greater(t, over, short)
}

// TestAssessRiskEmptyBodyIsZero keeps the empty input out of the "no letters" rule: an
// absent body is a validation problem, not a risky comment.
func TestAssessRiskEmptyBodyIsZero(t *testing.T) {
	for _, body := range []string{"", " ", "\n\t \r\n", "   \u00a0  "} {
		score, flags := AssessRisk(body)
		require.Zero(t, score, "body %q", body)
		require.Empty(t, flags, "body %q", body)
	}
}

// TestAssessRiskHugeBodyStaysFast is the denial of service guard: the detectors only
// read a bounded prefix, so a megabyte body cannot make a comment write expensive.
func TestAssessRiskHugeBodyStaysFast(t *testing.T) {
	huge := strings.Repeat("buy now at https://example.com/x or www.example.com ", 2000)
	require.Greater(t, len(huge), 100_000)

	started := time.Now()
	score, flags := AssessRisk(huge)
	elapsed := time.Since(started)

	require.GreaterOrEqual(t, score, 0)
	require.LessOrEqual(t, score, 100)
	require.NotEmpty(t, flags)
	require.Less(t, elapsed, 250*time.Millisecond, "a bounded window keeps the scan cheap")
}

// TestAssessRiskScoreStaysInRange is the published contract: a score is always an
// integer in 0..100 whatever the body looks like.
func TestAssessRiskScoreStaysInRange(t *testing.T) {
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
		score, flags := AssessRisk(body)
		require.GreaterOrEqual(t, score, 0, "body %q", body)
		require.LessOrEqual(t, score, 100, "body %q", body)
		for _, flag := range flags {
			require.Regexp(t, `^[a-z_]+$`, flag, "flags are stable identifiers the UI translates")
			require.Contains(t, riskFlagVocabulary, flag)
		}
	}
}

// riskFlagVocabulary is every flag AssessRisk may emit. It exists so a new detector
// cannot ship a flag the moderator UI has no translation for.
var riskFlagVocabulary = []string{
	RiskFlagLinks,
	RiskFlagVeryShort,
	RiskFlagVeryLong,
	RiskFlagRepeatedChars,
	RiskFlagShouty,
	RiskFlagNoLetters,
	RiskFlagRepeatedText,
}

// TestRiskFlagsEncoding pins the storage format: the column defaults to "[]" and every
// unreadable value decodes to an empty list instead of failing a read.
func TestRiskFlagsEncoding(t *testing.T) {
	require.Equal(t, "[]", EncodeRiskFlags(nil))

	flags := []string{RiskFlagLinks, RiskFlagShouty}
	encoded := EncodeRiskFlags(flags)
	require.JSONEq(t, `["links","shouty"]`, encoded)
	require.Equal(t, flags, DecodeRiskFlags(encoded))

	for _, raw := range []string{"", "  ", "null", "not json", "[1,2]"} {
		require.Empty(t, DecodeRiskFlags(raw), "raw value %q", raw)
	}
}
