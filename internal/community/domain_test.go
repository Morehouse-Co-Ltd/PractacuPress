package community

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
)

func member(id string) Actor {
	return Actor{UserID: id, SiteID: "s1", Role: site.RoleMember}
}

func editor(id string) Actor {
	return Actor{UserID: id, SiteID: "s1", Role: site.RoleEditor}
}

func TestValidateComment(t *testing.T) {
	valid := NewCommentInput{TargetType: TargetArticle, TargetID: "a1", Body: "  hello  "}
	got, err := ValidateComment(valid)
	require.NoError(t, err)
	require.Equal(t, "hello", got.Body, "body is trimmed")

	_, err = ValidateComment(NewCommentInput{TargetType: "video", TargetID: "x", Body: "y"})
	require.Error(t, err, "unknown target type")

	_, err = ValidateComment(NewCommentInput{TargetType: TargetArticle, Body: "y"})
	require.Error(t, err, "target id is required")

	_, err = ValidateComment(NewCommentInput{TargetType: TargetArticle, TargetID: "a1", Body: "   "})
	require.Error(t, err, "empty body is rejected")

	long := make([]rune, MaxCommentLength+1)
	for i := range long {
		long[i] = 'x'
	}
	_, err = ValidateComment(NewCommentInput{TargetType: TargetArticle, TargetID: "a1", Body: string(long)})
	require.Error(t, err, "body length is bounded")

	_, err = ValidateComment(NewCommentInput{TargetType: TargetComment, Body: "y"})
	require.Error(t, err, "a reply needs its parent target id")
}

// TestCommentValidationErrorsCarryFieldAndRule pins the machine vocabulary the client
// uses to explain a rejected comment: the sentinel stays matchable for the transport,
// while the FieldError names the input and the broken rule.
func TestCommentValidationErrorsCarryFieldAndRule(t *testing.T) {
	tests := []struct {
		name  string
		call  func() error
		field string
		rule  string
	}{
		{
			name: "empty body",
			call: func() error {
				_, err := ValidateComment(NewCommentInput{
					TargetType: TargetArticle, TargetID: "a1", Body: "   ",
				})
				return err
			},
			field: "body", rule: "required",
		},
		{
			name: "over-long body",
			call: func() error {
				_, err := ValidateComment(NewCommentInput{
					TargetType: TargetArticle,
					TargetID:   "a1",
					Body:       strings.Repeat("x", MaxCommentLength+1),
				})
				return err
			},
			field: "body", rule: "too_long",
		},
		{
			name: "empty reply target",
			call: func() error {
				_, err := ValidateComment(NewCommentInput{
					TargetType: TargetComment, TargetID: "c1", Body: "y",
				})
				return err
			},
			field: "target", rule: "required",
		},
		{
			name: "unknown target type",
			call: func() error {
				_, err := ValidateComment(NewCommentInput{
					TargetType: "video", TargetID: "a1", Body: "y",
				})
				return err
			},
			field: "target", rule: "unknown",
		},
		{
			name: "reply too deep",
			call: func() error {
				_, err := NextDepth(&Comment{Depth: MaxReplyDepth})
				return err
			},
			field: "depth", rule: "out_of_range",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.call()
			require.ErrorIs(t, err, ErrInvalidInput, "the transport still matches the sentinel")

			var fieldErr *apperr.FieldError
			require.ErrorAs(t, err, &fieldErr, "the error names the failing field")
			require.Equal(t, tt.field, fieldErr.Field)
			require.Equal(t, tt.rule, fieldErr.Rule)
			require.NotEmpty(t, fieldErr.Reason, "operators keep the english reason")
		})
	}
}

func TestNextDepthBoundsNesting(t *testing.T) {
	depth, err := NextDepth(nil)
	require.NoError(t, err)
	require.Zero(t, depth, "a top level comment is depth 0")

	parent := &Comment{Depth: 0}
	depth, err = NextDepth(parent)
	require.NoError(t, err)
	require.Equal(t, 1, depth)

	deepest := &Comment{Depth: MaxReplyDepth - 1}
	depth, err = NextDepth(deepest)
	require.NoError(t, err)
	require.Equal(t, MaxReplyDepth, depth)

	tooDeep := &Comment{Depth: MaxReplyDepth}
	_, err = NextDepth(tooDeep)
	require.ErrorIs(t, err, ErrDepthExceeded)
}

func TestCommentEditAndDeleteRules(t *testing.T) {
	visible := Comment{AuthorID: "a", Status: CommentStatusVisible}
	hidden := Comment{AuthorID: "a", Status: CommentStatusHidden}

	require.True(t, visible.CanEdit(member("a")))
	require.False(t, visible.CanEdit(member("b")), "only the author may edit")
	require.False(t, hidden.CanEdit(member("a")), "a hidden comment must not be rewritten")

	require.True(t, visible.CanDelete(member("a")))
	require.True(t, visible.CanDelete(editor("mod")), "moderators may delete")
	require.False(t, visible.CanDelete(member("b")))

	deleted := Comment{AuthorID: "a", Status: CommentStatusDeleted}
	require.False(t, deleted.CanDelete(member("a")), "deleting twice is a no-op, not an error")
	require.False(t, deleted.CanDelete(editor("mod")))
}

func TestCanModerate(t *testing.T) {
	require.False(t, CanModerate(member("a")))
	require.True(t, CanModerate(editor("a")))
	require.True(t, CanModerate(Actor{Role: site.RoleSiteAdmin}))
}

// TestToggleIsIdempotentWithExplicitIntent is the property that makes retries safe:
// asking for "like" twice writes once, so the notification fires once.
func TestToggleIsIdempotentWithExplicitIntent(t *testing.T) {
	wantTrue := true
	wantFalse := false

	decision := Toggle(false, &wantTrue)
	require.True(t, decision.Active)
	require.True(t, decision.Changed)

	decision = Toggle(true, &wantTrue)
	require.True(t, decision.Active)
	require.False(t, decision.Changed, "repeating the same intent must not write")

	decision = Toggle(true, &wantFalse)
	require.False(t, decision.Active)
	require.True(t, decision.Changed)
}

func TestToggleWithoutIntentFlips(t *testing.T) {
	decision := Toggle(false, nil)
	require.True(t, decision.Active)
	require.True(t, decision.Changed)

	decision = Toggle(true, nil)
	require.False(t, decision.Active)
	require.True(t, decision.Changed)
}

func TestValidateFollowRejectsSelfFollow(t *testing.T) {
	require.NoError(t, ValidateFollow("a", "b"))
	require.ErrorIs(t, ValidateFollow("a", "a"), ErrSelfTarget)
	require.ErrorIs(t, ValidateFollow("", "b"), ErrInvalidInput)
}

func TestValidateReactionKind(t *testing.T) {
	kind, err := ValidateReactionKind("  LIKE ")
	require.NoError(t, err)
	require.Equal(t, "like", kind)

	_, err = ValidateReactionKind("clap")
	require.ErrorIs(t, err, ErrInvalidInput)
}
