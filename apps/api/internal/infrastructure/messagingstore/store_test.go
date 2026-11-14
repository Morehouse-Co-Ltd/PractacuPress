package messagingstore_test

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/messagingstore"
	"github.com/practacu/practacu-press/apps/api/internal/messaging"
	"github.com/practacu/practacu-press/apps/api/internal/platform/fieldcrypto"
)

const (
	testSiteID         = "site-messaging-1"
	testConversationID = "conversation-1"
	testSenderID       = "user-1"
)

// messageBodyPurpose mirrors the purpose contract the store uses for a sealed body.
// The test spells it out instead of calling an unexported helper so the binding is
// pinned: changing the format in the store must fail these tests.
func messageBodyPurpose(conversationID, messageID string) string {
	return "message.body|" + conversationID + "|" + messageID
}

type harness struct {
	store  *messagingstore.Store
	handle *db.DB
}

// newHarness opens a throwaway SQLite database and an Ent store over it. A nil
// cipher builds the store without encryption, which is the legacy configuration.
func newHarness(t *testing.T, cipher *fieldcrypto.Cipher) *harness {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "messaging.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	store := messagingstore.New(handle.Client)
	if cipher != nil {
		store = messagingstore.New(handle.Client, messagingstore.WithFieldCipher(cipher))
	}
	return &harness{store: store, handle: handle}
}

// newCipher builds a deterministic test key so tests can also build a second,
// unrelated cipher.
func newCipher(t *testing.T, fill byte) *fieldcrypto.Cipher {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = fill
	}
	cipher, err := fieldcrypto.New(key)
	require.NoError(t, err)
	return cipher
}

// createLegacyMessage writes a row the way pre-encryption code did, bypassing the
// store so the body stays plaintext.
func (h *harness) createLegacyMessage(t *testing.T, conversationID, body string, createdAt time.Time) string {
	t.Helper()
	row, err := h.handle.Client.Message.Create().
		SetSiteID(testSiteID).
		SetConversationID(conversationID).
		SetSenderID(testSenderID).
		SetBody(body).
		SetCreatedAt(createdAt).
		Save(context.Background())
	require.NoError(t, err)
	return row.ID
}

func (h *harness) insertMessage(t *testing.T, body string, createdAt time.Time) messaging.Message {
	t.Helper()
	created, err := h.store.InsertMessage(context.Background(), messaging.Message{
		SiteID:         testSiteID,
		ConversationID: testConversationID,
		SenderID:       testSenderID,
		Body:           body,
		CreatedAt:      createdAt,
	})
	require.NoError(t, err)
	return created
}

func TestInsertMessageSealsBodyInDatabase(t *testing.T) {
	ctx := context.Background()
	cipher := newCipher(t, 0x11)
	h := newHarness(t, cipher)
	base := time.Now().UTC()

	const plain = "the private plan"
	created := h.insertMessage(t, plain, base)
	require.NotEmpty(t, created.ID)
	require.Equal(t, plain, created.Body, "the caller still gets plaintext back")

	row, err := h.handle.Client.Message.Get(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, fieldcrypto.IsSealed(row.Body), "the body column must hold an envelope")
	require.NotEqual(t, plain, row.Body)
	require.NotContains(t, row.Body, plain)

	// Randomised sealing: two rows with the same plaintext do not share a ciphertext,
	// so a database dump cannot correlate equal messages.
	second := h.insertMessage(t, plain, base.Add(time.Second))
	secondRow, err := h.handle.Client.Message.Get(ctx, second.ID)
	require.NoError(t, err)
	require.NotEqual(t, row.Body, secondRow.Body)

	list, err := h.store.ListMessages(ctx, testSiteID, testConversationID, 10)
	require.NoError(t, err)
	require.Len(t, list, 2)
	require.Equal(t, created.ID, list[0].ID)
	require.Equal(t, plain, list[0].Body)
	require.Equal(t, second.ID, list[1].ID)
	require.Equal(t, plain, list[1].Body)
}

func TestListMessagesReadsLegacyPlaintext(t *testing.T) {
	ctx := context.Background()
	cipher := newCipher(t, 0x22)
	h := newHarness(t, cipher)
	base := time.Now().UTC()

	const legacyBody = "written before encryption was enabled"
	legacyID := h.createLegacyMessage(t, testConversationID, legacyBody, base)

	// A new encrypted row in the same thread must not break the legacy row's read.
	created := h.insertMessage(t, "new encrypted row", base.Add(time.Second))

	list, err := h.store.ListMessages(ctx, testSiteID, testConversationID, 10)
	require.NoError(t, err)
	require.Len(t, list, 2)
	require.Equal(t, legacyBody, list[0].Body, "an unsealed value passes through unchanged")
	require.Equal(t, "new encrypted row", list[1].Body)

	// Reading does not rewrite legacy rows: migration is the backfill's job.
	row, err := h.handle.Client.Message.Get(ctx, legacyID)
	require.NoError(t, err)
	require.Equal(t, legacyBody, row.Body)
	require.False(t, fieldcrypto.IsSealed(row.Body))
	require.Equal(t, created.ID, list[1].ID)
}

func TestWithoutFieldCipherStoresPlaintext(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, nil)
	base := time.Now().UTC()

	const plain = "dev mode body"
	created := h.insertMessage(t, plain, base)
	require.Equal(t, plain, created.Body)

	row, err := h.handle.Client.Message.Get(ctx, created.ID)
	require.NoError(t, err)
	require.Equal(t, plain, row.Body, "a nil cipher keeps the historical plaintext behaviour")

	list, err := h.store.ListMessages(ctx, testSiteID, testConversationID, 10)
	require.NoError(t, err)
	require.Len(t, list, 1)
	require.Equal(t, plain, list[0].Body)
}

func TestListMessagesRejectsWrongCipherAndMovedCiphertext(t *testing.T) {
	ctx := context.Background()
	cipher := newCipher(t, 0x33)
	h := newHarness(t, cipher)
	base := time.Now().UTC()

	created := h.insertMessage(t, "bound to this row", base)
	row, err := h.handle.Client.Message.Get(ctx, created.ID)
	require.NoError(t, err)
	require.True(t, fieldcrypto.IsSealed(row.Body))

	// A different key cannot authenticate the envelope: the read must fail, not return
	// an empty or garbled body.
	wrongKeyStore := messagingstore.New(h.handle.Client, messagingstore.WithFieldCipher(newCipher(t, 0x44)))
	_, err = wrongKeyStore.ListMessages(ctx, testSiteID, testConversationID, 10)
	require.ErrorIs(t, err, fieldcrypto.ErrInvalidEnvelope)

	// The purpose binds the ciphertext to the message id and the conversation. Copying
	// the envelope into another row of the same conversation must fail.
	movedID := uuid.NewString()
	_, err = h.handle.Client.Message.Create().
		SetID(movedID).
		SetSiteID(testSiteID).
		SetConversationID(testConversationID).
		SetSenderID(testSenderID).
		SetBody(row.Body).
		SetCreatedAt(base.Add(time.Second)).
		Save(ctx)
	require.NoError(t, err)

	_, err = h.store.ListMessages(ctx, testSiteID, testConversationID, 10)
	require.ErrorIs(t, err, fieldcrypto.ErrInvalidEnvelope, "a ciphertext moved between rows must not open")

	// Opening the same envelope with a purpose naming another conversation also fails.
	_, err = cipher.Open(row.Body, messageBodyPurpose("another-conversation", created.ID))
	require.ErrorIs(t, err, fieldcrypto.ErrInvalidEnvelope)
}

func TestBackfillMessageEncryptionSealsLegacyRowsAndIsIdempotent(t *testing.T) {
	ctx := context.Background()
	cipher := newCipher(t, 0x55)
	h := newHarness(t, cipher)
	base := time.Now().UTC().Add(-time.Hour)

	// More rows than one backfill page, so cursor paging across batches is exercised.
	const legacyCount = 202
	for i := 0; i < legacyCount; i++ {
		h.createLegacyMessage(t, testConversationID,
			fmt.Sprintf("legacy body %03d", i),
			base.Add(time.Duration(i)*time.Second))
	}

	// An already sealed row in another conversation must be left untouched by the run
	// and by a rerun.
	preSealedID := uuid.NewString()
	preSealedBody, err := cipher.Seal("already sealed", messageBodyPurpose("conversation-2", preSealedID))
	require.NoError(t, err)
	_, err = h.handle.Client.Message.Create().
		SetID(preSealedID).
		SetSiteID(testSiteID).
		SetConversationID("conversation-2").
		SetSenderID(testSenderID).
		SetBody(preSealedBody).
		SetCreatedAt(base).
		Save(ctx)
	require.NoError(t, err)

	sealed, err := messagingstore.BackfillMessageEncryption(ctx, h.handle.Client, cipher)
	require.NoError(t, err)
	require.Equal(t, legacyCount, sealed, "only plaintext rows are sealed")

	rows, err := h.handle.Client.Message.Query().All(ctx)
	require.NoError(t, err)
	require.Len(t, rows, legacyCount+1)
	for _, row := range rows {
		require.True(t, fieldcrypto.IsSealed(row.Body), "row %s still holds plaintext", row.ID)
	}

	// The already sealed row is byte for byte unchanged.
	preSealedRow, err := h.handle.Client.Message.Get(ctx, preSealedID)
	require.NoError(t, err)
	require.Equal(t, preSealedBody, preSealedRow.Body)

	// Normal reads recover the plaintext of every backfilled row.
	list, err := h.store.ListMessages(ctx, testSiteID, testConversationID, legacyCount+2)
	require.NoError(t, err)
	require.Len(t, list, legacyCount)
	for i, item := range list {
		require.Equal(t, fmt.Sprintf("legacy body %03d", i), item.Body)
	}

	// Rerunning is a no-op: zero rows sealed and no envelope rewritten.
	before := envelopeByID(t, h.handle)
	sealed, err = messagingstore.BackfillMessageEncryption(ctx, h.handle.Client, cipher)
	require.NoError(t, err)
	require.Zero(t, sealed, "backfill is idempotent")
	require.Equal(t, before, envelopeByID(t, h.handle))
}

func TestBackfillMessageEncryptionValidatesArguments(t *testing.T) {
	ctx := context.Background()
	h := newHarness(t, nil)

	_, err := messagingstore.BackfillMessageEncryption(ctx, h.handle.Client, nil)
	require.Error(t, err, "a nil cipher must be rejected, not silently skip encryption")

	_, err = messagingstore.BackfillMessageEncryption(ctx, nil, newCipher(t, 0x66))
	require.Error(t, err)
}

// envelopeByID reads the raw stored body of every message, which is how the test
// proves a rerun did not rewrite already sealed rows.
func envelopeByID(t *testing.T, handle *db.DB) map[string]string {
	t.Helper()
	rows, err := handle.Client.Message.Query().All(context.Background())
	require.NoError(t, err)
	envelopes := make(map[string]string, len(rows))
	for _, row := range rows {
		envelopes[row.ID] = row.Body
	}
	return envelopes
}
