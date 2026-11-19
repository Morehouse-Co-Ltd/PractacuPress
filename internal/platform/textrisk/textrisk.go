// Package textrisk scores user written text for the moderator queue.
//
// It is the one implementation of the rule based score that both moderation surfaces
// read: comments score a body when it is written (community.AssessRisk delegates here),
// and the content review queue scores a pending article or post when a moderator asks
// for the queue. Sharing the detectors is what keeps the two queues ranked the same
// way - an article and a comment with the same links, the same shouting and the same
// padding get the same number - and what makes the number auditable: the rules live
// next to their weights in one file, not in a browser.
//
// The score is deliberately a heuristic, not a probability: the queue only needs a
// stable order, not a calibrated risk model.
package textrisk

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Risk flags are the reasons behind a score.
//
// They are stable identifiers rather than sentences: the moderator UI owns the
// wording and the reader's language. Adding a flag is a compatible change; renaming
// one invalidates every stored row and every translation, which is why they are
// constants instead of string literals scattered through the detectors.
const (
	// FlagLinks marks a body that carries one or more URLs.
	FlagLinks = "links"
	// FlagVeryShort marks a body too short to be a real comment.
	FlagVeryShort = "very_short"
	// FlagVeryLong marks a body past the long-form threshold for a comment.
	FlagVeryLong = "very_long"
	// FlagRepeatedChars marks a long run of a single repeated character.
	FlagRepeatedChars = "repeated_chars"
	// FlagShouty marks predominantly upper case text.
	FlagShouty = "shouty"
	// FlagNoLetters marks a body that is almost all punctuation, symbols or
	// digits, so it carries no words a reader could reply to.
	FlagNoLetters = "no_letters"
	// FlagRepeatedText marks a body dominated by one repeating sequence, which is
	// what keyword stuffing looks like after the first few words.
	FlagRepeatedText = "repeated_text"
)

// Flags is every flag Assess may emit, in the order the detectors run.
//
// It exists so a caller (a test, an OpenAPI generator, a future detector audit) can
// enumerate the vocabulary without listing the constants a second time.
var Flags = []string{
	FlagLinks,
	FlagVeryShort,
	FlagVeryLong,
	FlagRepeatedChars,
	FlagShouty,
	FlagNoLetters,
	FlagRepeatedText,
}

// Scoring weights and thresholds.
//
// The weights are heuristics, not probabilities: the queue only needs a stable order,
// not a calibrated risk model. They are grouped here so the whole scale can be read
// (and re-tuned) in one place, and so the documented range of each signal lives next
// to the code that applies it.
const (
	// riskAnalysisRunes bounds how much of a body the detectors read.
	//
	// The comment validator caps a comment body, but Assess also sees bodies that never
	// passed validation (a legacy row, an import, a whole article source, a future
	// caller), and the detectors are linear in this window. Truncating at 4000
	// characters keeps a write in the microsecond range even for a megabyte body; the
	// length signal still measures the whole body, so truncation cannot hide an
	// oversized submission.
	riskAnalysisRunes = 4000

	// Link signals: count first, density second. One link is often a citation, three
	// are a link farm, and two links per hundred characters is a body whose only
	// purpose is to carry them.
	riskLinkWeightOne     = 10
	riskLinkWeightTwo     = 25
	riskLinkWeightMany    = 40
	riskLinkDensityWeight = 10
	riskLinkDensityPer100 = 2

	// Length signals.
	riskShortBodyRunes  = 3
	riskShortBodyWeight = 5
	riskLongBodyRunes   = 1200
	riskLongBodyWeight  = 10
	riskFloodBodyRunes  = 2400
	riskFloodBodyWeight = 20

	// Repetition signals. A run of six identical characters is a held key; a three
	// character sequence covering a sixth of the body is keyword stuffing.
	riskRepeatedRunRunes    = 6
	riskRepeatedRunWeight   = 15
	riskRepeatedSeqMinBody  = 24
	riskRepeatedSeqMinCount = 5
	riskRepeatedSeqCoverage = 15
	riskRepeatedSeqWeight   = 20

	// Case and content signals.
	riskShoutyMinLetters      = 12
	riskShoutyRatio           = 60
	riskShoutyWeight          = 15
	riskShoutyExtremeLetters  = 24
	riskShoutyExtremeRatio    = 80
	riskShoutyExtremeWeight   = 25
	riskNoLettersMinRunes     = 3
	riskLetterRatioPercent    = 10
	riskNoLettersDigitWeight  = 30
	riskNoLettersSymbolWeight = 50

	// riskMaxScore is the ceiling of the published scale.
	riskMaxScore = 100
)

// riskLinkPattern matches one URL, including the bare-host forms people paste in
// comment spam. The scheme alternative comes first and the trailing token is consumed
// whole, so "https://www.example.com" is counted once rather than twice.
var riskLinkPattern = regexp.MustCompile(`(?i)(?:https?://|www\.|t\.me/|wa\.me/)\S*`)

// Assess scores a text body for the moderator queue.
//
// The score answers one question for a human reviewer: how urgently does this text
// need a look? It is computed on the server, so the queue ranks the same way on every
// device, survives a browser with JavaScript turned off, and cannot be skipped by
// calling the approve endpoint directly.
//
// The function is pure and total: every input, including "" and a body far longer than
// any accepted submission, returns a score in [0, 100] plus a deterministic flag list.
// The detectors read at most riskAnalysisRunes characters, so a hostile body cannot turn
// a write into a quadratic scan.
func Assess(body string) (score int, flags []string) {
	flags = make([]string, 0, len(Flags))

	text, total := riskAnalysisWindow(body)
	if text == "" {
		// Nothing to judge: an empty or whitespace-only body scores zero instead of
		// tripping the "no letters" rule, which is about content, not about absence.
		return 0, flags
	}
	stats := measureText(text)

	// Links. Counting them is not enough: a 4000 character essay with one source link
	// is a citation, while four links in one sentence is a link farm. Density is
	// measured inside the analysed window so the count and the length it is compared
	// against come from the same slice of text.
	linkCount := len(riskLinkPattern.FindAllStringIndex(text, -1))
	if linkCount > 0 {
		points := riskLinkWeightOne
		switch {
		case linkCount >= 3:
			points = riskLinkWeightMany
		case linkCount == 2:
			points = riskLinkWeightTwo
		}
		if linkCount*100 >= riskLinkDensityPer100*utf8.RuneCountInString(text) {
			points += riskLinkDensityWeight
		}
		score += points
		flags = append(flags, FlagLinks)
	}

	// Length. A three character comment is a placeholder or a bot; a comment past the
	// long-form threshold is a copy-paste flood or a whole article dropped into a reply
	// box. Comments are short by nature, so 1200 characters already deserves a look.
	//
	// The thresholds are not split per surface on purpose: an article body reaches
	// 1200 characters with ordinary prose, so most long articles carry FlagVeryLong and
	// a few points they arguably did not earn. A score that means one thing in the
	// comment queue and another in the article queue would be worse than a conservative
	// score in one of them - the reviewer sees the flag itself and can judge it.
	switch {
	case total < riskShortBodyRunes:
		score += riskShortBodyWeight
		flags = append(flags, FlagVeryShort)
	case total > riskFloodBodyRunes:
		score += riskFloodBodyWeight
		flags = append(flags, FlagVeryLong)
	case total > riskLongBodyRunes:
		score += riskLongBodyWeight
		flags = append(flags, FlagVeryLong)
	}

	// Character runs. "!!!!!!!!" or "aaaaaaa" is a held key or a shout, and it carries
	// nothing a moderator has to read twice.
	if stats.maxRun >= riskRepeatedRunRunes {
		score += riskRepeatedRunWeight
		flags = append(flags, FlagRepeatedChars)
	}

	// Shouty text. Caps alone are weak evidence, so the ratio is measured against the
	// letters only (punctuation and digits cannot dilute it) and needs enough letters
	// to mean something.
	if stats.letters >= riskShoutyMinLetters {
		ratio := stats.upper * 100 / stats.letters
		switch {
		case stats.letters >= riskShoutyExtremeLetters && ratio >= riskShoutyExtremeRatio:
			score += riskShoutyExtremeWeight
			flags = append(flags, FlagShouty)
		case ratio >= riskShoutyRatio:
			score += riskShoutyWeight
			flags = append(flags, FlagShouty)
		}
	}

	// Almost no letters. A body made of punctuation, symbols or a bare number is not
	// something a reader can reply to; a phone number or an account id dropped into a
	// comment is a contact-spam shape. Digits still carry information (a price, an
	// order number), so a digits-only body is scored below a symbols-only one.
	if stats.visible >= riskNoLettersMinRunes && stats.letters*100 < stats.visible*riskLetterRatioPercent {
		points := riskNoLettersDigitWeight
		if stats.digits == 0 {
			points = riskNoLettersSymbolWeight
		}
		score += points
		flags = append(flags, FlagNoLetters)
	}

	// Repeated text. Keyword stuffing repeats a short phrase until it dominates the
	// body; ordinary prose repeats a common word a few times and stays under the
	// coverage bound.
	if repeatedSequenceDominates([]rune(text)) {
		score += riskRepeatedSeqWeight
		flags = append(flags, FlagRepeatedText)
	}

	// Every weight is positive, so the floor is already zero; the ceiling needs an
	// explicit clamp because several signals can fire on the same body.
	if score > riskMaxScore {
		score = riskMaxScore
	}
	return score, flags
}

// riskAnalysisWindow trims the body, measures it and returns the prefix the detectors
// may read, cut on a rune boundary.
//
// Returning both values keeps the two concerns apart: length signals need the real
// size, while the scans must stay bounded. Cutting a UTF-8 string in the middle of a
// rune would produce invalid bytes that skew the letter and symbol ratios, so the cut
// walks the rune offsets instead of slicing at a byte count.
func riskAnalysisWindow(body string) (text string, total int) {
	trimmed := strings.TrimSpace(body)
	total = utf8.RuneCountInString(trimmed)
	if total <= riskAnalysisRunes {
		return trimmed, total
	}
	// Range over the string yields the byte offset of each rune, so counting runes and
	// cutting at the boundary is one allocation free pass.
	runes := 0
	for offset := range trimmed {
		if runes == riskAnalysisRunes {
			return trimmed[:offset], total
		}
		runes++
	}
	return trimmed, total
}

// textStats is the single pass over the analysis window shared by the character level
// signals, so the cost does not grow with the number of rules.
type textStats struct {
	letters int
	upper   int
	digits  int
	visible int
	maxRun  int
}

// measureText counts the character classes and the longest run of one character.
//
// Spaces end a run: indentation in a pasted code block or a table aligned with spaces
// is not the keyboard-repeat signal the detector is looking for.
func measureText(text string) textStats {
	var stats textStats
	var (
		runRune rune
		run     int
	)
	for _, r := range text {
		if unicode.IsSpace(r) {
			runRune, run = 0, 0
			continue
		}
		stats.visible++
		switch {
		case unicode.IsLetter(r):
			stats.letters++
			if unicode.IsUpper(r) {
				stats.upper++
			}
		case unicode.IsDigit(r):
			stats.digits++
		}
		if r == runRune {
			run++
		} else {
			runRune, run = r, 1
		}
		if run > stats.maxRun {
			stats.maxRun = run
		}
	}
	return stats
}

// repeatedSequenceDominates reports whether one three character sequence makes up a
// large share of the window.
//
// Three characters is short enough to catch keyword stuffing in any script and long
// enough that ordinary prose, where a common word repeats a few times, stays under the
// coverage bound. The map is bounded by the window, so the scan stays linearithmic.
func repeatedSequenceDominates(runes []rune) bool {
	if len(runes) < riskRepeatedSeqMinBody {
		return false
	}
	counts := make(map[[3]rune]int, len(runes))
	most := 0
	for i := 0; i+3 <= len(runes); i++ {
		key := [3]rune{runes[i], runes[i+1], runes[i+2]}
		counts[key]++
		if counts[key] > most {
			most = counts[key]
		}
	}
	return most >= riskRepeatedSeqMinCount &&
		most*3*100 >= riskRepeatedSeqCoverage*len(runes)
}

// EncodeFlags renders flags for the JSON text column.
//
// It never returns an empty string: the column defaults to "[]" and a caller that
// decodes the value should not have to special-case a NULL or a blank row.
func EncodeFlags(flags []string) string {
	if len(flags) == 0 {
		return "[]"
	}
	encoded, err := json.Marshal(flags)
	if err != nil {
		// Unreachable for []string, but a stored score must never fail a write.
		return "[]"
	}
	return string(encoded)
}

// DecodeFlags reads the stored JSON back into flags.
//
// Every unreadable value decodes to an empty list rather than an error: the column is
// derived data, and a row written by an older build (or by hand) must still be
// listable in the queue instead of failing the whole page.
func DecodeFlags(raw string) []string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "null" {
		return nil
	}
	var flags []string
	if err := json.Unmarshal([]byte(trimmed), &flags); err != nil {
		return nil
	}
	return flags
}
