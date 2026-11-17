package textdiff

import (
	"fmt"
	"math/rand"
	"testing"

	"github.com/stretchr/testify/require"
)

// apply reconstructs both sides from the hunks and asserts the documented line number
// convention along the way. It is the property every diff test relies on: a valid diff
// replays the source document and the target document exactly.
func apply(t *testing.T, hunks []Hunk, from, to []string) {
	t.Helper()

	source, target := 0, 0
	for _, hunk := range hunks {
		switch hunk.Op {
		case OpEqual:
			require.Less(t, source, len(from), "equal hunk reads past the source")
			require.Less(t, target, len(to), "equal hunk reads past the target")
			require.Equal(t, from[source], hunk.Text)
			require.Equal(t, to[target], hunk.Text)
			require.Equal(t, source+1, hunk.FromLine)
			require.Equal(t, target+1, hunk.ToLine)
			source++
			target++
		case OpInsert:
			require.Less(t, target, len(to), "insert hunk reads past the target")
			require.Equal(t, to[target], hunk.Text)
			require.Equal(t, source, hunk.FromLine, "insert reports the last consumed source line")
			require.Equal(t, target+1, hunk.ToLine)
			target++
		case OpDelete:
			require.Less(t, source, len(from), "delete hunk reads past the source")
			require.Equal(t, from[source], hunk.Text)
			require.Equal(t, source+1, hunk.FromLine)
			require.Equal(t, target, hunk.ToLine, "delete reports the last consumed target line")
			source++
		default:
			t.Fatalf("unknown op %q", hunk.Op)
		}
	}
	require.Equal(t, len(from), source, "every source line must be consumed")
	require.Equal(t, len(to), target, "every target line must be consumed")
}

func countOps(hunks []Hunk) (added, removed int) {
	for _, hunk := range hunks {
		switch hunk.Op {
		case OpInsert:
			added++
		case OpDelete:
			removed++
		}
	}
	return added, removed
}

func TestDiffEmptyInputs(t *testing.T) {
	require.Empty(t, Diff(nil, nil))
	require.Empty(t, Diff([]string{}, []string{}))
}

func TestDiffIdenticalDocuments(t *testing.T) {
	lines := []string{"第一行", "second", "third"}

	hunks := Diff(lines, lines)
	require.Len(t, hunks, 3)
	for i, hunk := range hunks {
		require.Equal(t, OpEqual, hunk.Op)
		require.Equal(t, i+1, hunk.FromLine)
		require.Equal(t, i+1, hunk.ToLine)
	}
	apply(t, hunks, lines, lines)
}

func TestDiffInsertAtHead(t *testing.T) {
	from := []string{"a"}
	to := []string{"x", "a"}

	hunks := Diff(from, to)
	apply(t, hunks, from, to)
	require.Equal(t, []Op{OpInsert, OpEqual}, ops(hunks))
	// An insertion before the first source line reports the last consumed source line
	// as 0, which is the documented convention for "before line 1".
	require.Equal(t, 0, hunks[0].FromLine)
	require.Equal(t, 1, hunks[0].ToLine)
}

func TestDiffInsertInMiddle(t *testing.T) {
	from := []string{"a", "c"}
	to := []string{"a", "b", "c"}

	hunks := Diff(from, to)
	apply(t, hunks, from, to)
	require.Equal(t, []Op{OpEqual, OpInsert, OpEqual}, ops(hunks))
	require.Equal(t, 1, hunks[1].FromLine)
	require.Equal(t, 2, hunks[1].ToLine)
}

func TestDiffDeleteInMiddle(t *testing.T) {
	from := []string{"a", "b", "c"}
	to := []string{"a", "c"}

	hunks := Diff(from, to)
	apply(t, hunks, from, to)
	require.Equal(t, []Op{OpEqual, OpDelete, OpEqual}, ops(hunks))
	require.Equal(t, 2, hunks[1].FromLine)
	require.Equal(t, 1, hunks[1].ToLine)
}

func TestDiffReplaceIsDeleteThenInsert(t *testing.T) {
	from := []string{"a", "b", "c"}
	to := []string{"a", "x", "c"}

	hunks := Diff(from, to)
	apply(t, hunks, from, to)
	require.Equal(t, []Op{OpEqual, OpDelete, OpInsert, OpEqual}, ops(hunks))
	added, removed := countOps(hunks)
	require.Equal(t, 1, added)
	require.Equal(t, 1, removed)
}

func TestDiffAllNewDocument(t *testing.T) {
	from := []string{"a", "b"}
	to := []string{"x", "y", "z"}

	hunks := Diff(from, to)
	apply(t, hunks, from, to)
	added, removed := countOps(hunks)
	require.Equal(t, 3, added)
	require.Equal(t, 2, removed)
}

func TestDiffTrailingEmptyLinesAreRealLines(t *testing.T) {
	hunks := Diff([]string{"a"}, []string{"a", ""})
	apply(t, hunks, []string{"a"}, []string{"a", ""})
	require.Equal(t, []Op{OpEqual, OpInsert}, ops(hunks))
	require.Equal(t, "", hunks[1].Text)
}

func TestSplitLines(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want []string
	}{
		{name: "empty", in: "", want: nil},
		{name: "single line", in: "hello", want: []string{"hello"}},
		{name: "trailing newline terminates", in: "a\nb\n", want: []string{"a", "b"}},
		{name: "blank trailing line is kept", in: "a\nb\n\n", want: []string{"a", "b", ""}},
		{name: "crlf normalized", in: "a\r\nb\r\n", want: []string{"a", "b"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, SplitLines(tc.in))
		})
	}
}

func TestDiffTruncatesToMaxLines(t *testing.T) {
	from := make([]string, MaxLines+10)
	to := make([]string, MaxLines+10)
	for i := range from {
		from[i] = fmt.Sprintf("line %d", i)
		to[i] = from[i]
	}
	// The first MaxLines lines are equal; everything past the budget is ignored.
	to[MaxLines+5] = "not compared"

	require.True(t, TruncatedLines(from, to))
	hunks := Diff(from, to)
	require.Len(t, hunks, MaxLines, "only the head of the document is compared")
	for _, hunk := range hunks {
		require.Equal(t, OpEqual, hunk.Op)
	}
	require.False(t, TruncatedLines(from[:MaxLines], to[:MaxLines]))
}

func TestDiffFullRewriteStaysBounded(t *testing.T) {
	// Two completely different large documents exceed the edit distance budget, so the
	// coarse fallback answers with one delete block and one insert block. The test also
	// guards the runtime cost: the bounded search must not walk the full O(ND) space.
	from := make([]string, 5000)
	to := make([]string, 5000)
	for i := range from {
		from[i] = fmt.Sprintf("old %d", i)
		to[i] = fmt.Sprintf("new %d", i)
	}

	hunks := Diff(from, to)
	apply(t, hunks, from, to)
	added, removed := countOps(hunks)
	require.Equal(t, len(to), added)
	require.Equal(t, len(from), removed)
}

func TestDiffRandomDocumentsReplayBothSides(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	alphabet := []string{"a", "b", "c", "", "d"}

	for iteration := 0; iteration < 400; iteration++ {
		from := randomDocument(rng, alphabet)
		to := randomDocument(rng, alphabet)

		hunks := Diff(from, to)
		apply(t, hunks, from, to)

		added, removed := countOps(hunks)
		require.LessOrEqual(t, added, len(to))
		require.LessOrEqual(t, removed, len(from))
	}
}

// TestDiffManyEditsExercisesBacktracking covers a larger edit distance than the small
// random documents do, which is where the trace backtracking actually walks several
// steps back through the diagonals.
func TestDiffManyEditsExercisesBacktracking(t *testing.T) {
	from := make([]string, 400)
	to := make([]string, 400)
	for i := range from {
		from[i] = fmt.Sprintf("line %d", i)
		to[i] = from[i]
	}
	for i := 0; i < 400; i += 3 {
		to[i] = fmt.Sprintf("changed %d", i)
	}
	to = append(to, "appended")

	hunks := Diff(from, to)
	apply(t, hunks, from, to)
	added, removed := countOps(hunks)
	// 134 changed lines are one delete plus one insert each, and the extra line is one
	// more insert.
	require.Equal(t, 134, removed)
	require.Equal(t, 135, added)
}

func randomDocument(rng *rand.Rand, alphabet []string) []string {
	length := rng.Intn(12)
	lines := make([]string, length)
	for i := range lines {
		lines[i] = alphabet[rng.Intn(len(alphabet))]
	}
	return lines
}

func ops(hunks []Hunk) []Op {
	out := make([]Op, 0, len(hunks))
	for _, hunk := range hunks {
		out = append(out, hunk.Op)
	}
	return out
}
