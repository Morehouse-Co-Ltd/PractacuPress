package messaging

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

func member(id string) Actor {
	return Actor{UserID: id, SiteID: "s1", Role: site.RoleMember}
}

func direct() Conversation {
	return Conversation{
		ID: "c1", SiteID: "s1", Kind: KindDirect, CreatedBy: "u1",
		Members: []Member{
			{UserID: "u1", JoinedAt: time.Now()},
			{UserID: "u2", JoinedAt: time.Now()},
		},
	}
}

func TestValidateMessage(t *testing.T) {
	got, err := ValidateMessage(NewMessageInput{ConversationID: " c1 ", Body: "  hi  "})
	require.NoError(t, err)
	require.Equal(t, "hi", got.Body)
	require.Equal(t, "c1", got.ConversationID)

	_, err = ValidateMessage(NewMessageInput{Body: "hi"})
	require.ErrorIs(t, err, ErrInvalidInput)

	_, err = ValidateMessage(NewMessageInput{ConversationID: "c1", Body: "   "})
	require.ErrorIs(t, err, ErrInvalidInput)

	long := make([]rune, MaxBodyLength+1)
	for i := range long {
		long[i] = 'x'
	}
	_, err = ValidateMessage(NewMessageInput{ConversationID: "c1", Body: string(long)})
	require.ErrorIs(t, err, ErrInvalidInput)
}

// TestAuthorizeRejectsOutsiders is the property the whole package exists for.
func TestAuthorizeRejectsOutsiders(t *testing.T) {
	conversation := direct()

	require.NoError(t, conversation.Authorize(member("u1")))
	require.NoError(t, conversation.Authorize(member("u2")))

	require.ErrorIs(t, conversation.Authorize(member("u3")), ErrNotMember)
}

func TestAuthorizeRejectsCrossSite(t *testing.T) {
	conversation := direct()
	outsider := Actor{UserID: "u1", SiteID: "s2", Role: site.RolePlatformAdmin}

	require.ErrorIs(t, conversation.Authorize(outsider), ErrCrossSite,
		"site isolation is checked before membership")
}

func TestValidateDirectMembers(t *testing.T) {
	require.NoError(t, ValidateDirectMembers([]string{"u1", "u2"}))
	require.ErrorIs(t, ValidateDirectMembers([]string{"u1"}), ErrInvalidInput)
	require.ErrorIs(t, ValidateDirectMembers([]string{"u1", "u1"}), ErrInvalidInput)
	require.ErrorIs(t, ValidateDirectMembers([]string{"u1", ""}), ErrInvalidInput)
}

func TestValidateGroupMembers(t *testing.T) {
	require.NoError(t, ValidateGroupMembers([]string{"u1", "u2", "u3"}))
	require.ErrorIs(t, ValidateGroupMembers([]string{"u1"}), ErrInvalidInput)
	require.ErrorIs(t, ValidateGroupMembers([]string{"u1", "u1"}), ErrInvalidInput)
}

func TestAdvanceReadCursor(t *testing.T) {
	conversation := direct()

	updated, err := conversation.AdvanceReadCursor("u1", "m5")
	require.NoError(t, err)
	require.Equal(t, "m5", updated.Members[0].LastReadMessageID)
	require.Empty(t, conversation.Members[0].LastReadMessageID, "the original is not mutated")

	_, err = updated.AdvanceReadCursor("u3", "m6")
	require.ErrorIs(t, err, ErrNotMember)
}