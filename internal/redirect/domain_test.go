package redirect

import (
	"errors"
	"strings"
	"testing"

	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/stretchr/testify/require"
)

func TestNormalizePath(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{name: "keeps the root", input: "/", want: "/"},
		{name: "plain path", input: "/a/foo", want: "/a/foo"},
		{name: "leading spaces", input: "  /a/foo  ", want: "/a/foo"},
		{name: "trailing slash", input: "/a/foo/", want: "/a/foo"},
		{name: "many trailing slashes", input: "/a/foo///", want: "/a/foo"},
		{name: "query string", input: "/a/foo?x=1", want: "/a/foo"},
		{name: "fragment", input: "/a/foo#section", want: "/a/foo"},
		{name: "query and fragment", input: "/a/foo?x=1#section", want: "/a/foo"},
		{name: "missing leading slash", input: "a/foo", want: "/a/foo"},
		{name: "all slashes is the root", input: "///", want: "/"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizePath(tc.input)
			require.NoError(t, err)
			require.Equal(t, tc.want, got)
		})
	}
}

func TestNormalizePathRejectsUnusableInput(t *testing.T) {
	for _, input := range []string{"", "   ", "/a\x00b"} {
		_, err := NormalizePath(input)
		require.ErrorIs(t, err, ErrInvalidInput, "input %q", input)
	}

	_, err := NormalizePath("/" + strings.Repeat("a", MaxPathLength))
	require.ErrorIs(t, err, ErrInvalidInput)

	var fieldErr *apperr.FieldError
	require.ErrorAs(t, err, &fieldErr)
	require.Equal(t, "path", fieldErr.Field)
	require.Equal(t, "too_long", fieldErr.Rule)
}

func TestValidateNormalizesAndDefaults(t *testing.T) {
	got, err := Validate(Input{FromPath: "/a/old/?x=1", ToPath: "  /a/new  "})
	require.NoError(t, err)
	require.Equal(t, "/a/old", got.FromPath)
	require.Equal(t, "/a/new", got.ToPath)
	require.Equal(t, DefaultStatusCode, got.StatusCode)
}

func TestValidateKeepsTargetVerbatim(t *testing.T) {
	// A destination may be an absolute URL or carry a query string; rewriting it would
	// change where the visitor lands, so only surrounding whitespace is trimmed.
	for _, target := range []string{
		"https://elsewhere.example/foo?a=1",
		"/search?q=go",
		"/a/new#section",
	} {
		got, err := Validate(Input{FromPath: "/a/old", ToPath: target})
		require.NoError(t, err)
		require.Equal(t, target, got.ToPath)
	}
}

func TestValidateRejectsBadFields(t *testing.T) {
	cases := []struct {
		name  string
		input Input
		field string
		rule  string
	}{
		{
			name:  "empty from path",
			input: Input{FromPath: "", ToPath: "/a/new"},
			field: "from_path",
			rule:  "required",
		},
		{
			name:  "empty to path",
			input: Input{FromPath: "/a/old", ToPath: "  "},
			field: "to_path",
			rule:  "required",
		},
		{
			name:  "unsupported status",
			input: Input{FromPath: "/a/old", ToPath: "/a/new", StatusCode: 307},
			field: "status_code",
			rule:  "malformed",
		},
		{
			name:  "too long target",
			input: Input{FromPath: "/a/old", ToPath: "/" + strings.Repeat("a", MaxPathLength)},
			field: "to_path",
			rule:  "too_long",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Validate(tc.input)
			require.ErrorIs(t, err, ErrInvalidInput)

			var fieldErr *apperr.FieldError
			require.ErrorAs(t, err, &fieldErr)
			require.Equal(t, tc.field, fieldErr.Field)
			require.Equal(t, tc.rule, fieldErr.Rule)
		})
	}
}

func TestValidateAcceptsEveryDocumentedStatusCode(t *testing.T) {
	for _, code := range []int{301, 302, 308} {
		got, err := Validate(Input{FromPath: "/a/old", ToPath: "/a/new", StatusCode: code})
		require.NoError(t, err)
		require.Equal(t, code, got.StatusCode)
	}
}

func TestPatchInputApply(t *testing.T) {
	current := Redirect{
		ID:         "r1",
		SiteID:     "s1",
		FromPath:   "/a/old",
		ToPath:     "/a/new",
		StatusCode: 301,
		Source:     SourceManual,
	}

	// An empty patch changes nothing.
	unchanged, err := PatchInput{}.Apply(current)
	require.NoError(t, err)
	require.Equal(t, current, unchanged)

	// A partial patch moves the target and keeps the source and status.
	toPath := "/a/newer"
	status := 308
	updated, err := PatchInput{ToPath: &toPath, StatusCode: &status}.Apply(current)
	require.NoError(t, err)
	require.Equal(t, "/a/newer", updated.ToPath)
	require.Equal(t, 308, updated.StatusCode)
	require.Equal(t, SourceManual, updated.Source)

	// A patch that would make the rule invalid is rejected.
	empty := ""
	_, err = PatchInput{ToPath: &empty}.Apply(current)
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestSplitContentPath(t *testing.T) {
	kind, key, ok := splitContentPath("/a/hello-world")
	require.True(t, ok)
	require.Equal(t, LocateKindArticle, kind)
	require.Equal(t, "hello-world", key)

	kind, key, ok = splitContentPath("/p/42")
	require.True(t, ok)
	require.Equal(t, LocateKindPost, kind)
	require.Equal(t, "42", key)

	for _, path := range []string{"/", "/about", "/a/", "/p/", "/a/foo/bar", "/articles/foo"} {
		_, _, ok = splitContentPath(path)
		require.False(t, ok, "path %q is not a content permalink", path)
	}
}

func TestSourceAndResolveKindValid(t *testing.T) {
	for _, source := range []Source{SourceManual, SourceSlugChange, SourceImport} {
		require.True(t, source.Valid())
	}
	require.False(t, Source("crawler").Valid())

	for _, kind := range []ResolveKind{KindContent, KindRedirect, KindMissing} {
		require.True(t, kind.Valid())
	}
	require.False(t, ResolveKind("broken").Valid())
}

func TestNormalizeQuery(t *testing.T) {
	query, err := NormalizeQuery("  /a/old  ")
	require.NoError(t, err)
	require.Equal(t, "/a/old", query)

	_, err = NormalizeQuery(strings.Repeat("a", MaxQueryLength+1))
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestMapErrorKeepsFieldDetails(t *testing.T) {
	_, err := NormalizePath("")
	require.Error(t, err)

	problem := mapError(err)
	require.Equal(t, apperr.CodeValidationFailed, problem.Code)
	require.Equal(t, "path", problem.Details["field"])

	require.True(t, errors.Is(err, ErrInvalidInput))
}
