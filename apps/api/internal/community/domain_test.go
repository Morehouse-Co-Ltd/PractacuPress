package community

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/site"
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
