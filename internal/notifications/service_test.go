package notifications

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type fakeRepo struct {
	items  map[string]Notification
	seq    int
	marked []string
}

func newFakeRepo() *fakeRepo { return &fakeRepo{items: map[string]Notification{}} }

func (f *fakeRepo) Insert(_ context.Context, item Notification) (Notification, error) {
	f.seq++
	item.ID = "n" + string(rune('0'+f.seq))
	f.items[item.ID] = item
	return item, nil
}

func (f *fakeRepo) List(_ context.Context, siteID, userID string, limit int) ([]Notification, error) {
	out := make([]Notification, 0, len(f.items))
	for _, item := range f.items {
		if item.SiteID == siteID && item.UserID == userID {
			out = append(out, item)
		}
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (f *fakeRepo) Find(_ context.Context, siteID, userID, id string) (Notification, error) {
	item, ok := f.items[id]
	if !ok || item.SiteID != siteID || item.UserID != userID {
		return Notification{}, ErrNotFound
	}
	return item, nil
}

func (f *fakeRepo) MarkRead(_ context.Context, id string, at time.Time) error {
	item, ok := f.items[id]
	if !ok {
		return ErrNotFound
	}
	stamp := at
	item.ReadAt = &stamp
	f.items[id] = item
	f.marked = append(f.marked, id)
	return nil
}

func (f *fakeRepo) MarkAllRead(_ context.Context, siteID, userID string, at time.Time) (int, error) {
	updated := 0
	for id, item := range f.items {
		if item.SiteID == siteID && item.UserID == userID && item.ReadAt == nil {
			stamp := at
			item.ReadAt = &stamp
			f.items[id] = item
			updated++
		}
	}
	return updated, nil
}

func newService(t *testing.T, repo Repository) *Service {
	t.Helper()
	service, err := NewService(repo)
	require.NoError(t, err)
	service.now = func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) }
	return service
}

func recipient() Actor { return Actor{UserID: "u2", SiteID: "s1"} }

func TestNewServiceRequiresRepository(t *testing.T) {
	_, err := NewService(nil)
	require.Error(t, err)
}

func TestNotifyAndInbox(t *testing.T) {
	service := newService(t, newFakeRepo())
	ctx := context.Background()

	_, err := service.Notify(ctx, NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeComment, ActorID: "u1", Payload: map[string]string{"excerpt": "hi"},
	})
	require.NoError(t, err)

	inbox, err := service.Inbox(ctx, recipient(), 0)
	require.NoError(t, err)
	require.Len(t, inbox, 1)
	require.False(t, inbox[0].IsRead())
}

func TestNotifyRejectsSelfNotification(t *testing.T) {
	service := newService(t, newFakeRepo())

	_, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u1", Type: TypeComment, ActorID: "u1",
	})
	require.ErrorIs(t, err, ErrSelfNotification)
}

func TestMarkReadTwiceWritesOnce(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()

	created, err := service.Notify(ctx, NewInput{SiteID: "s1", UserID: "u2", Type: TypeFollow})
	require.NoError(t, err)

	first, err := service.MarkRead(ctx, recipient(), created.ID)
	require.NoError(t, err)
	require.True(t, first.IsRead())
	require.Len(t, repo.marked, 1)

	_, err = service.MarkRead(ctx, recipient(), created.ID)
	require.NoError(t, err)
	require.Len(t, repo.marked, 1, "a second read must not write")
}

func TestMarkReadRejectsOtherRecipient(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)

	created, err := service.Notify(context.Background(), NewInput{SiteID: "s1", UserID: "u2", Type: TypeFollow})
	require.NoError(t, err)

	other := Actor{UserID: "u3", SiteID: "s1"}
	_, err = service.MarkRead(context.Background(), other, created.ID)
	require.ErrorIs(t, err, ErrNotFound, "another user's notification is not even visible")
}

func TestMarkAllRead(t *testing.T) {
	service := newService(t, newFakeRepo())
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		_, err := service.Notify(ctx, NewInput{SiteID: "s1", UserID: "u2", Type: TypeFollow})
		require.NoError(t, err)
	}

	updated, err := service.MarkAllRead(ctx, recipient())
	require.NoError(t, err)
	require.Equal(t, 3, updated)

	again, err := service.MarkAllRead(ctx, recipient())
	require.NoError(t, err)
	require.Zero(t, again)
}

func TestInboxRequiresIdentity(t *testing.T) {
	service := newService(t, newFakeRepo())

	_, err := service.Inbox(context.Background(), Actor{}, 0)
	require.ErrorIs(t, err, ErrInvalidInput)
}
