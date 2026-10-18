package messaging

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

type fakeRepo struct {
	conversations map[string]Conversation
	messages      []Message
	seq           int
	cursors       map[string]string
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		conversations: map[string]Conversation{},
		cursors:       map[string]string{},
	}
}

func (f *fakeRepo) InsertConversation(_ context.Context, item Conversation) (Conversation, error) {
	f.seq++
	item.ID = "c" + string(rune('0'+f.seq))
	f.conversations[item.ID] = item
	return item, nil
}

func (f *fakeRepo) FindConversation(_ context.Context, siteID, id string) (Conversation, error) {
	item, ok := f.conversations[id]
	if !ok || item.SiteID != siteID {
		return Conversation{}, ErrNotFound
	}
	return item, nil
}

func (f *fakeRepo) ListForUser(_ context.Context, siteID, userID string, limit int) ([]Conversation, error) {
	out := make([]Conversation, 0)
	for _, item := range f.conversations {
		if item.SiteID == siteID && item.HasMember(userID) {
			out = append(out, item)
		}
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (f *fakeRepo) InsertMessage(_ context.Context, item Message) (Message, error) {
	f.seq++
	item.ID = "m" + string(rune('0'+f.seq))
	f.messages = append(f.messages, item)
	return item, nil
}

func (f *fakeRepo) ListMessages(_ context.Context, _, conversationID string, limit int) ([]Message, error) {
	out := make([]Message, 0)
	for _, item := range f.messages {
		if item.ConversationID == conversationID {
			out = append(out, item)
		}
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (f *fakeRepo) AdvanceReadCursor(_ context.Context, _, conversationID, userID, messageID string) (bool, error) {
	key := conversationID + "/" + userID
	if f.cursors[key] == messageID {
		return false, nil
	}
	f.cursors[key] = messageID
	return true, nil
}

func newService(t *testing.T, repo Repository) *Service {
	t.Helper()
	service, err := NewService(repo)
	require.NoError(t, err)
	service.now = func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) }
	return service
}

func memberActor(userID string) Actor {
	return Actor{UserID: userID, SiteID: "s1", Role: site.RoleMember}
}

func TestNewServiceRequiresRepository(t *testing.T) {
	_, err := NewService(nil)
	require.Error(t, err)
}

func TestStartDirectConversationIncludesCaller(t *testing.T) {
	service := newService(t, newFakeRepo())

	created, err := service.StartConversation(context.Background(), memberActor("u1"), KindDirect, []string{"u2"})
	require.NoError(t, err)
	require.True(t, created.HasMember("u1"), "the creator is always a member")
	require.Len(t, created.Members, 2)
}

func TestDirectConversationRequiresExactlyOneOther(t *testing.T) {
	service := newService(t, newFakeRepo())

	_, err := service.StartConversation(context.Background(), memberActor("u1"), KindDirect, nil)
	require.ErrorIs(t, err, ErrInvalidInput)

	_, err = service.StartConversation(context.Background(), memberActor("u1"), KindDirect, []string{"u2", "u3"})
	require.ErrorIs(t, err, ErrInvalidInput)
}

// TestNonMemberCannotRead is the reason this package exists.
func TestNonMemberCannotRead(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()

	created, err := service.StartConversation(ctx, memberActor("u1"), KindDirect, []string{"u2"})
	require.NoError(t, err)

	_, err = service.Messages(ctx, memberActor("u1"), created.ID, 10)
	require.NoError(t, err)

	_, err = service.Messages(ctx, memberActor("u3"), created.ID, 10)
	require.ErrorIs(t, err, ErrNotFound, "a non member must not learn the conversation exists")
}

func TestSendStoresAndAdvancesSenderCursor(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()

	created, err := service.StartConversation(ctx, memberActor("u1"), KindDirect, []string{"u2"})
	require.NoError(t, err)

	sent, err := service.Send(ctx, memberActor("u1"), NewMessageInput{ConversationID: created.ID, Body: " hello "})
	require.NoError(t, err)
	require.Equal(t, "hello", sent.Body)
	require.Equal(t, sent.ID, repo.cursors[created.ID+"/u1"], "sending implies reading")

	messages, err := service.Messages(ctx, memberActor("u2"), created.ID, 10)
	require.NoError(t, err)
	require.Len(t, messages, 1)
}

func TestSendRejectsOutsider(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()

	created, err := service.StartConversation(ctx, memberActor("u1"), KindDirect, []string{"u2"})
	require.NoError(t, err)

	_, err = service.Send(ctx, memberActor("u3"), NewMessageInput{ConversationID: created.ID, Body: "x"})
	require.ErrorIs(t, err, ErrNotFound)
}

func TestListReturnsOnlyMembership(t *testing.T) {
	service := newService(t, newFakeRepo())
	ctx := context.Background()

	_, err := service.StartConversation(ctx, memberActor("u1"), KindDirect, []string{"u2"})
	require.NoError(t, err)

	mine, err := service.List(ctx, memberActor("u2"), 10)
	require.NoError(t, err)
	require.Len(t, mine, 1)

	theirs, err := service.List(ctx, memberActor("u9"), 10)
	require.NoError(t, err)
	require.Empty(t, theirs)
}