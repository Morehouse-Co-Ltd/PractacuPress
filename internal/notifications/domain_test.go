package notifications

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func validInput() NewInput {
	return NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeComment, ActorID: "u1",
		SubjectID: "c1", Payload: map[string]string{"excerpt": "hi"},
	}
}

func TestValidateAcceptsGoodInput(t *testing.T) {
	got, err := Validate(validInput())
	require.NoError(t, err)
	require.Equal(t, "u2", got.UserID)
}

func TestValidateRejectsBadInput(t *testing.T) {
	in := validInput()
	in.Type = "marketing"
	_, err := Validate(in)
	require.ErrorIs(t, err, ErrInvalidInput)

	in = validInput()
	in.UserID = ""
	_, err = Validate(in)
	require.ErrorIs(t, err, ErrInvalidInput)

	in = validInput()
	in.SiteID = ""
	_, err = Validate(in)
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestValidateRejectsSelfNotification(t *testing.T) {
	in := validInput()
	in.ActorID = in.UserID

	_, err := Validate(in)
	require.ErrorIs(t, err, ErrSelfNotification, "liking your own post must not notify you")
}

func TestValidateBoundsPayload(t *testing.T) {
	in := validInput()
	in.Payload = map[string]string{}
	for i := 0; i < MaxPayloadKeys+1; i++ {
		in.Payload[string(rune('a'+i))] = "x"
	}
	_, err := Validate(in)
	require.ErrorIs(t, err, ErrInvalidInput)

	in = validInput()
	in.Payload = map[string]string{"excerpt": string(make([]rune, MaxPayloadValueLength+1))}
	_, err = Validate(in)
	require.ErrorIs(t, err, ErrInvalidInput)

	in = validInput()
	in.Payload = map[string]string{string(make([]rune, 41)): "x"}
	_, err = Validate(in)
	require.ErrorIs(t, err, ErrInvalidInput)
}

func notification() Notification {
	return Notification{
		ID: "n1", SiteID: "s1", UserID: "u2", Type: TypeComment, ActorID: "u1",
	}
}

func TestOnlyRecipientMarksRead(t *testing.T) {
	n := notification()

	_, _, err := n.MarkRead("u1", "s1", time.Now())
	require.ErrorIs(t, err, ErrPermissionDenied, "the actor cannot mark it read for the recipient")

	_, _, err = n.MarkRead("u2", "s2", time.Now())
	require.ErrorIs(t, err, ErrCrossSite)

	updated, changed, err := n.MarkRead("u2", "s1", time.Now())
	require.NoError(t, err)
	require.True(t, changed)
	require.True(t, updated.IsRead())
}

// TestMarkReadIsIdempotent keeps retries from rewriting the first read timestamp.
func TestMarkReadIsIdempotent(t *testing.T) {
	n := notification()
	first := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)

	read, changed, err := n.MarkRead("u2", "s1", first)
	require.NoError(t, err)
	require.True(t, changed)

	again, changed, err := read.MarkRead("u2", "s1", first.Add(time.Hour))
	require.NoError(t, err)
	require.False(t, changed, "a second read must not write")
	require.Equal(t, first, *again.ReadAt, "the first read timestamp is the one that counts")
}
