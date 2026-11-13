package messaging

import (
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
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

// TestMessageValidationErrorsCarryFieldAndRule pins the machine vocabulary the client
// uses to explain a rejected message: the sentinel stays matchable for the transport,
// while the FieldError names the input and the broken rule.
func TestMessageValidationErrorsCarryFieldAndRule(t *testing.T) {
	tests := []struct {
		name  string
		call  func() error
		field string
		rule  string
	}{
		{
			name: "empty body",
			call: func() error {
				_, err := ValidateMessage(NewMessageInput{ConversationID: "c1", Body: "   "})
				return err
			},
			field: "body", rule: "required",
		},
		{
			name: "over-long body",
			call: func() error {
				_, err := ValidateMessage(NewMessageInput{
					ConversationID: "c1",
					Body:           strings.Repeat("x", MaxBodyLength+1),
				})
				return err
			},
			field: "body", rule: "too_long",
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
