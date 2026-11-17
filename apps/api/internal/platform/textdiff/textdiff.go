// Package textdiff computes a line level difference between two versions of a
// document.
//
// It is a pure algorithm package: the content module splits an author's source text
// into lines, hands both sides over, and stores the result in the revision diff
// response. Nothing here touches storage, time or the network, which is what makes the
// diff deterministic and cheap to unit test.
//
// The algorithm is Myers' O(ND) shortest edit script. Two bounds keep a pathological
// input from becoming a denial of service:
//
//   - each side is truncated to MaxLines lines before the diff starts, matching the
//     product promise that a very long body is compared up to that budget;
//   - the search stops after maxEditDistance edit steps and falls back to a coarse
//     "delete the changed region, insert the new one" hunk. A body that needs more
//     than a thousand edits to turn into the other version is a rewrite, not a
//     revision, and the coarse answer is both correct and bounded.
package textdiff

import "strings"

// Op is the operation one hunk performs.
type Op string

// The three operations a line diff can contain.
const (
	// OpEqual marks a line present in both versions.
	OpEqual Op = "equal"
	// OpInsert marks a line present only in the target version.
	OpInsert Op = "insert"
	// OpDelete marks a line present only in the source version.
	OpDelete Op = "delete"
)

// MaxLines is the largest number of lines compared on each side.
//
// A longer document is compared up to this line count and the caller reports
// truncated; the bound exists so the quadratic worst case of a full rewrite stays
// bounded in memory and time.
const MaxLines = 20000

// maxEditDistance bounds the Myers search.
//
// The trace below stores one vector snapshot per edit step, so memory grows with the
// square of the distance: a thousand steps is a few megabytes for a single, author
// only request, and a larger gap is a rewrite the coarse fallback handles better
// anyway.
const maxEditDistance = 1024

// Hunk is one line level operation.
//
// The line numbers follow the wire contract:
//   - equal: FromLine and ToLine are the 1 based positions of the line in each side;
//   - insert: FromLine is the last consumed source line (0 before the first line) and
//     ToLine is the inserted line's position;
//   - delete: FromLine is the deleted line's position and ToLine is the last consumed
//     target line (0 before the first line).
type Hunk struct {
	Op       Op     `json:"op"`
	FromLine int    `json:"from_line"`
	ToLine   int    `json:"to_line"`
	Text     string `json:"text"`
}

// SplitLines splits a document into lines.
//
// CRLF is normalized so a diff between a Windows authored body and an editor save
// compares content, not line endings. One trailing newline terminates the last line
// rather than producing a phantom empty line; any further trailing newlines are real
// empty lines and are kept.
func SplitLines(text string) []string {
	if text == "" {
		return nil
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	lines := strings.Split(text, "\n")
	if last := len(lines) - 1; last >= 0 && lines[last] == "" {
		lines = lines[:last]
	}
	return lines
}

// Diff compares two documents line by line and returns one hunk per line.
//
// Each side is truncated to MaxLines before comparison; the caller reports that
// truncation through its own response field, so a caller that cares uses
// TruncatedLines.
func Diff(from, to []string) []Hunk {
	if len(from) > MaxLines {
		from = from[:MaxLines]
	}
	if len(to) > MaxLines {
		to = to[:MaxLines]
	}
	return toHunks(diffSteps(from, to))
}

// TruncatedLines reports whether the diff of these two sides would have to drop
// lines to fit the budget.
func TruncatedLines(from, to []string) bool {
	return len(from) > MaxLines || len(to) > MaxLines
}

// step is the internal representation of one line operation before positions are
// assigned.
type step struct {
	op   Op
	text string
}

// diffSteps produces the operation sequence for two line slices.
//
// A common prefix and suffix are stripped first. That is what keeps a normal edit -
// a paragraph changed in the middle of a long article - away from the edit distance
// bound: only the changed region reaches Myers.
func diffSteps(from, to []string) []step {
	steps := make([]step, 0, len(from)+len(to))

	start := 0
	for start < len(from) && start < len(to) && from[start] == to[start] {
		steps = append(steps, step{op: OpEqual, text: from[start]})
		start++
	}

	endFrom, endTo := len(from), len(to)
	for endFrom > start && endTo > start && from[endFrom-1] == to[endTo-1] {
		endFrom--
		endTo--
	}

	middle, ok := myersSteps(from[start:endFrom], to[start:endTo])
	if !ok {
		// The two sides are too different for a bounded search: report the changed
		// region as one block of deletions followed by one block of insertions. The
		// result still reconstructs both documents, which is the contract.
		for _, line := range from[start:endFrom] {
			steps = append(steps, step{op: OpDelete, text: line})
		}
		for _, line := range to[start:endTo] {
			steps = append(steps, step{op: OpInsert, text: line})
		}
	} else {
		steps = append(steps, middle...)
	}

	// The suffix is common to both sides; walking it from the shared start adds the
	// equal tail in document order.
	for i := endFrom; i < len(from); i++ {
		steps = append(steps, step{op: OpEqual, text: from[i]})
	}
	return steps
}

// myersSteps runs Myers' shortest edit script on two line slices.
//
// It reports false instead of an answer when the edit distance exceeds
// maxEditDistance: the caller then emits the coarse fallback.
func myersSteps(from, to []string) ([]step, bool) {
	if len(from) == 0 {
		steps := make([]step, 0, len(to))
		for _, line := range to {
			steps = append(steps, step{op: OpInsert, text: line})
		}
		return steps, true
	}
	if len(to) == 0 {
		steps := make([]step, 0, len(from))
		for _, line := range from {
			steps = append(steps, step{op: OpDelete, text: line})
		}
		return steps, true
	}

	n, m := len(from), len(to)
	offset := n + m + 1
	// v[k] is the farthest x reached on diagonal k; the offset shifts the signed
	// diagonal index into the slice.
	v := make([]int, 2*(n+m)+3)
	v[offset+1] = 0

	// trace[d] snapshots the diagonals before processing edit distance d, so the
	// backtrack below can retrace the winning path. Only the band that can be
	// reached at that depth is copied, which keeps the total memory at O(D^2)
	// rather than O((N+M)*D).
	trace := make([][]int, 0, maxEditDistance+1)
	distance := -1

search:
	for d := 0; d <= n+m; d++ {
		if d > maxEditDistance {
			return nil, false
		}
		snapshot := make([]int, 2*d+3)
		copy(snapshot, v[offset-d-1:offset+d+2])
		trace = append(trace, snapshot)

		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[offset+k-1] < v[offset+k+1]) {
				x = v[offset+k+1]
			} else {
				x = v[offset+k-1] + 1
			}
			y := x - k
			for x < n && y < m && from[x] == to[y] {
				x++
				y++
			}
			v[offset+k] = x
			if x >= n && y >= m {
				distance = d
				break search
			}
		}
	}
	if distance < 0 {
		return nil, false
	}

	// Walk the trace backwards from the end, emitting the edit and the equal run
	// that precedes it. The steps are collected in reverse document order.
	reversed := make([]step, 0, n+m)
	x, y := n, m
	for d := distance; d > 0; d-- {
		previous := trace[d]
		k := x - y
		var previousK int
		// The snapshot was copied with a one element padding on each side, so the
		// value of diagonal j lives at index j+d+1.
		if k == -d || (k != d && previous[k-1+d+1] < previous[k+1+d+1]) {
			previousK = k + 1
		} else {
			previousK = k - 1
		}
		previousX := previous[previousK+d+1]
		previousY := previousX - previousK
		for x > previousX && y > previousY {
			x--
			y--
			reversed = append(reversed, step{op: OpEqual, text: from[x]})
		}
		if x == previousX {
			y--
			reversed = append(reversed, step{op: OpInsert, text: to[y]})
		} else {
			x--
			reversed = append(reversed, step{op: OpDelete, text: from[x]})
		}
	}
	// d == 0: the remaining head is the common prefix of the two slices.
	for x > 0 && y > 0 {
		x--
		y--
		reversed = append(reversed, step{op: OpEqual, text: from[x]})
	}

	for i, j := 0, len(reversed)-1; i < j; i, j = i+1, j-1 {
		reversed[i], reversed[j] = reversed[j], reversed[i]
	}
	return reversed, true
}

// toHunks assigns the 1 based line positions to a step sequence.
func toHunks(steps []step) []Hunk {
	hunks := make([]Hunk, 0, len(steps))
	fromLine, toLine := 0, 0
	for _, s := range steps {
		switch s.op {
		case OpEqual:
			fromLine++
			toLine++
			hunks = append(hunks, Hunk{
				Op: OpEqual, FromLine: fromLine, ToLine: toLine, Text: s.text,
			})
		case OpInsert:
			toLine++
			hunks = append(hunks, Hunk{
				Op: OpInsert, FromLine: fromLine, ToLine: toLine, Text: s.text,
			})
		case OpDelete:
			fromLine++
			hunks = append(hunks, Hunk{
				Op: OpDelete, FromLine: fromLine, ToLine: toLine, Text: s.text,
			})
		}
	}
	return hunks
}
