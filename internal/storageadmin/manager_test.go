package storageadmin

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/media"
	"github.com/practacu/practacu-press/internal/platform/config"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func localRequest(allocations map[string]AllocationInput, global string, strategies ...StrategyInput) UpdateRequest {
	return UpdateRequest{
		GlobalStrategyID: global,
		Strategies:       strategies,
		Scopes:           map[string]string{},
		Allocations:      allocations,
	}
}

func singleInput(id string) AllocationInput {
	return AllocationInput{Mode: ModeSingle, Entries: []AllocationEntryInput{{StrategyID: id}}, Overflow: OverflowSwitch}
}

func TestManagerAppliesQuotaAllocationImmediately(t *testing.T) {
	base := t.TempDir()
	aDir, bDir := filepath.Join(base, "a"), filepath.Join(base, "b")
	first, second := newFakeStore("first"), newFakeStore("second")
	first.usage = 1_500_000_000

	stores := map[string]media.Storage{aDir: first, bDir: second}
	build := func(_ context.Context, target Target) (media.Storage, error) {
		store, ok := stores[target.LocalDir]
		if !ok {
			return nil, os.ErrNotExist
		}
		return store, nil
	}
	manager, err := NewManager(Config{
		Env:     config.Config{StorageDriver: config.StorageDriverLocal, StorageDir: aDir},
		DataDir: base,
		Logger:  testLogger(),
		Build:   build,
		Measure: func(_ context.Context, store media.Storage) (int64, error) {
			return store.(*fakeStore).Usage(context.Background())
		},
	})
	require.NoError(t, err)

	request := localRequest(map[string]AllocationInput{
		config.StorageScopeContent: {
			Mode: ModeQuota,
			Entries: []AllocationEntryInput{
				{StrategyID: "a", QuotaGB: 1},
				{StrategyID: "b", QuotaGB: 0},
			},
			Overflow: OverflowSwitch,
		},
		config.StorageScopeSite:       singleInput("b"),
		config.StorageScopeAvatar:     singleInput("b"),
		config.StorageScopeAttachment: singleInput("b"),
	}, "b",
		StrategyInput{ID: "a", Name: "A", Driver: "local", LocalDir: aDir},
		StrategyInput{ID: "b", Name: "B", Driver: "local", LocalDir: bDir},
	)
	maxContentChars := 420_000
	request.MaxContentChars = &maxContentChars

	status, err := manager.Apply(context.Background(), request)
	require.NoError(t, err)
	require.Equal(t, maxContentChars, status.MaxContentChars)
	require.Equal(t, maxContentChars, manager.MaxContentChars())
	require.True(t, status.Live)
	require.Equal(t, SourceSaved, status.Source)
	require.NotNil(t, status.UpdatedAt)
	content := status.Allocations[config.StorageScopeContent]
	require.Equal(t, ModeQuota, content.Mode)
	require.Len(t, content.Entries, 2)
	require.Equal(t, int64(1_500_000_000), content.Entries[0].UsedBytes)
	require.False(t, content.Entries[0].Current)
	require.True(t, content.Entries[1].Current)

	// The next upload must land on the second entry because the first is over quota.
	storage := manager.StorageFor(media.PurposeContent)
	require.NoError(t, storage.Put(context.Background(), "after-switch", bytes.NewReader([]byte("1234")), 4))
	require.True(t, second.has("after-switch"))
	require.False(t, first.has("after-switch"))

	// A single-strategy allocation ignores the retained quota.
	single := localRequest(map[string]AllocationInput{
		config.StorageScopeContent:    {Mode: ModeSingle, Entries: []AllocationEntryInput{{StrategyID: "a", QuotaGB: 1}}, Overflow: OverflowSwitch},
		config.StorageScopeSite:       singleInput("a"),
		config.StorageScopeAvatar:     singleInput("a"),
		config.StorageScopeAttachment: singleInput("a"),
	}, "a",
		StrategyInput{ID: "a", Name: "A", Driver: "local", LocalDir: aDir},
	)
	_, err = manager.Apply(context.Background(), single)
	require.NoError(t, err)
	require.Equal(t, maxContentChars, manager.MaxContentChars(), "older clients keep the current limit")
	require.NoError(t, manager.StorageFor(media.PurposeContent).Put(context.Background(), "single", bytes.NewReader([]byte("12345")), 5))
	require.True(t, first.has("single"))
}

func TestManagerPersistsSecretButNeverServesIt(t *testing.T) {
	base := t.TempDir()
	localDir := filepath.Join(base, "media")
	local := newFakeStore("local")
	cloud := newFakeStore("cloud")
	build := func(_ context.Context, target Target) (media.Storage, error) {
		if target.Driver == config.StorageDriverS3 {
			return cloud, nil
		}
		return local, nil
	}
	manager, err := NewManager(Config{
		Env:     config.Config{StorageDriver: config.StorageDriverLocal, StorageDir: localDir},
		DataDir: base,
		Logger:  testLogger(),
		Build:   build,
	})
	require.NoError(t, err)

	request := localRequest(map[string]AllocationInput{
		config.StorageScopeContent:    singleInput("cloud"),
		config.StorageScopeSite:       singleInput("cloud"),
		config.StorageScopeAvatar:     singleInput("cloud"),
		config.StorageScopeAttachment: singleInput("cloud"),
	}, "local",
		StrategyInput{ID: "local", Name: "Local", Driver: "local", LocalDir: localDir},
		StrategyInput{
			ID: "cloud", Name: "Cloud", Driver: "s3", S3Bucket: "press-media",
			S3Endpoint: "https://minio.example.com", S3Region: "eu-west-1",
			S3AccessKey: "AKIDEXAMPLE", S3SecretKey: "TOP-SECRET",
		},
	)
	maxContentChars := 765_432
	request.MaxContentChars = &maxContentChars
	status, err := manager.Apply(context.Background(), request)
	require.NoError(t, err)
	require.Equal(t, maxContentChars, status.MaxContentChars)

	raw, err := json.Marshal(status)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "TOP-SECRET")
	require.NotContains(t, string(raw), "AKIDEXAMPLE")
	require.Contains(t, string(raw), "has_secret")

	settingsPath := filepath.Join(base, SettingsFilename)
	settingsRaw, err := os.ReadFile(settingsPath)
	require.NoError(t, err)
	require.Contains(t, string(settingsRaw), "TOP-SECRET")

	reloaded, err := NewManager(Config{
		Env:     config.Config{StorageDriver: config.StorageDriverLocal, StorageDir: localDir},
		DataDir: base,
		Logger:  testLogger(),
		Build:   build,
	})
	require.NoError(t, err)
	reloadedStatus := reloaded.Status()
	require.Equal(t, SourceSaved, reloadedStatus.Source)
	require.Len(t, reloadedStatus.Strategies, 2)
	require.Equal(t, "cloud", reloadedStatus.Scopes[config.StorageScopeContent])
	require.Equal(t, maxContentChars, reloadedStatus.MaxContentChars)
	require.True(t, reloadedStatus.Strategies[1].HasSecret)
}

func TestManagerDefaultsLegacyContentLimit(t *testing.T) {
	base := t.TempDir()
	localDir := filepath.Join(base, "media")
	build := func(context.Context, Target) (media.Storage, error) { return newFakeStore("local"), nil }
	manager, err := NewManager(Config{
		Env: config.Config{
			StorageDriver:              config.StorageDriverLocal,
			StorageDir:                 localDir,
			MediaDefaultUserQuotaBytes: 12345,
		},
		DataDir: base,
		Logger:  testLogger(),
		Build:   build,
	})
	require.NoError(t, err)
	_, err = manager.Apply(context.Background(), localRequest(map[string]AllocationInput{
		config.StorageScopeContent:    singleInput("local"),
		config.StorageScopeSite:       singleInput("local"),
		config.StorageScopeAvatar:     singleInput("local"),
		config.StorageScopeAttachment: singleInput("local"),
	}, "local", StrategyInput{ID: "local", Name: "Local", Driver: "local", LocalDir: localDir}))
	require.NoError(t, err)

	settingsPath := filepath.Join(base, SettingsFilename)
	raw, err := os.ReadFile(settingsPath)
	require.NoError(t, err)
	var legacy map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw, &legacy))
	delete(legacy, "max_content_chars")
	delete(legacy, "media_user_quota_bytes")
	delete(legacy, "media_user_upload_bytes")
	delete(legacy, "media_user_article_bytes")
	raw, err = json.Marshal(legacy)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(settingsPath, raw, 0o600))

	reloaded, err := NewManager(Config{
		Env: config.Config{
			StorageDriver:              config.StorageDriverLocal,
			StorageDir:                 localDir,
			MediaDefaultUserQuotaBytes: 12345,
		},
		DataDir: base,
		Logger:  testLogger(),
		Build:   build,
	})
	require.NoError(t, err)
	require.Equal(t, config.DefaultMaxContentSourceChars, reloaded.MaxContentChars())
	// Old documents inherit the deployment media default instead of becoming
	// unlimited, and the two new ceilings stay at zero (unlimited).
	userQuota, _ := reloaded.MediaQuotaDefaults()
	require.EqualValues(t, 12345, userQuota)
	require.Zero(t, reloaded.MediaUploadLimitBytes())
	require.Zero(t, reloaded.MediaArticleLimitBytes())
}

func TestManagerRejectsInvalidDocuments(t *testing.T) {
	base := t.TempDir()
	manager, err := NewManager(Config{
		Env:     config.Config{StorageDriver: config.StorageDriverLocal, StorageDir: filepath.Join(base, "media")},
		DataDir: base,
		Logger:  testLogger(),
		Build: func(context.Context, Target) (media.Storage, error) {
			return newFakeStore("x"), nil
		},
	})
	require.NoError(t, err)

	strategies := []StrategyInput{
		{ID: "a", Name: "A", Driver: "local", LocalDir: filepath.Join(base, "a")},
		{ID: "b", Name: "B", Driver: "local", LocalDir: filepath.Join(base, "b")},
	}
	duplicate := localRequest(map[string]AllocationInput{
		config.StorageScopeContent: {
			Mode: ModeQuota,
			Entries: []AllocationEntryInput{
				{StrategyID: "a"}, {StrategyID: "a"},
			},
			Overflow: OverflowSwitch,
		},
	}, "a", strategies...)
	_, err = manager.Apply(context.Background(), duplicate)
	var validation *ValidationError
	require.ErrorAs(t, err, &validation)
	require.Equal(t, "allocations.content.entries[1].strategy_id", validation.Field)

	for _, value := range []int{0, config.DefaultMaxContentSourceChars + 1} {
		invalidLimit := localRequest(nil, "a", strategies...)
		invalidLimit.MaxContentChars = &value
		_, err = manager.Apply(context.Background(), invalidLimit)
		require.ErrorAs(t, err, &validation)
		require.Equal(t, "max_content_chars", validation.Field)
	}

	missingSecret := localRequest(map[string]AllocationInput{
		config.StorageScopeContent: singleInput("cloud"),
	}, "cloud", StrategyInput{
		ID: "cloud", Name: "Cloud", Driver: "s3", S3Bucket: "bucket",
		S3AccessKey: "AK", S3SecretKey: "",
	})
	_, err = manager.Apply(context.Background(), missingSecret)
	require.ErrorAs(t, err, &validation)
	require.Contains(t, validation.Field, "s3_secret_key")
}

func TestManagerMediaRootsFollowAllocations(t *testing.T) {
	base := t.TempDir()
	aDir, bDir := filepath.Join(base, "a"), filepath.Join(base, "b")
	build := func(context.Context, Target) (media.Storage, error) { return newFakeStore("x"), nil }
	manager, err := NewManager(Config{
		Env:     config.Config{StorageDriver: config.StorageDriverLocal, StorageDir: aDir},
		DataDir: base,
		Logger:  testLogger(),
		Build:   build,
	})
	require.NoError(t, err)

	_, err = manager.Apply(context.Background(), localRequest(map[string]AllocationInput{
		config.StorageScopeContent: {
			Mode: ModeQuota,
			Entries: []AllocationEntryInput{
				{StrategyID: "a"}, {StrategyID: "b"},
			},
			Overflow: OverflowSwitch,
		},
	}, "a",
		StrategyInput{ID: "a", Name: "A", Driver: "local", LocalDir: aDir},
		StrategyInput{ID: "b", Name: "B", Driver: "local", LocalDir: bDir},
	))
	require.NoError(t, err)
	roots := manager.MediaRoots()
	require.Len(t, roots, 2)
	require.True(t, strings.HasSuffix(roots[0].Dir, "a") || strings.HasSuffix(roots[1].Dir, "a"))
}

func TestManagerKeepsStoredCloudCredentialsWhenOmitted(t *testing.T) {
	base := t.TempDir()
	localDir := filepath.Join(base, "media")
	build := func(_ context.Context, target Target) (media.Storage, error) {
		if target.Driver == config.StorageDriverS3 {
			return newFakeStore("cloud"), nil
		}
		return newFakeStore("local"), nil
	}
	manager, err := NewManager(Config{
		Env:     config.Config{StorageDriver: config.StorageDriverLocal, StorageDir: localDir},
		DataDir: base,
		Logger:  testLogger(),
		Build:   build,
	})
	require.NoError(t, err)

	cloudAlloc := map[string]AllocationInput{
		config.StorageScopeContent:    singleInput("cloud"),
		config.StorageScopeSite:       singleInput("cloud"),
		config.StorageScopeAvatar:     singleInput("cloud"),
		config.StorageScopeAttachment: singleInput("cloud"),
	}
	cloud := func(access, secret string) StrategyInput {
		return StrategyInput{
			ID: "cloud", Name: "Cloud", Driver: "s3", S3Bucket: "press-media",
			S3Endpoint: "https://minio.example.com", S3Region: "eu-west-1",
			S3AccessKey: access, S3SecretKey: secret,
		}
	}

	_, err = manager.Apply(context.Background(), localRequest(cloudAlloc, "cloud", cloud("AKIDEXAMPLE", "TOP-SECRET")))
	require.NoError(t, err)

	// A client that never saw the stored credentials sends both fields empty.
	// The server must carry both forward instead of rejecting the document.
	status, err := manager.Apply(context.Background(), localRequest(cloudAlloc, "cloud", cloud("", "")))
	require.NoError(t, err)
	require.True(t, status.Strategies[0].HasAccessKey)
	require.True(t, status.Strategies[0].HasSecret)

	// Rotating only the secret keeps the saved access key.
	status, err = manager.Apply(context.Background(), localRequest(cloudAlloc, "cloud", cloud("", "NEW-SECRET")))
	require.NoError(t, err)
	require.True(t, status.Strategies[0].HasAccessKey)
	require.True(t, status.Strategies[0].HasSecret)

	// Switching the same id to local clears the cloud credentials instead of
	// carrying them onto a local strategy (and persisting a secret unnecessarily).
	localAlloc := map[string]AllocationInput{
		config.StorageScopeContent:    singleInput("cloud"),
		config.StorageScopeSite:       singleInput("cloud"),
		config.StorageScopeAvatar:     singleInput("cloud"),
		config.StorageScopeAttachment: singleInput("cloud"),
	}
	status, err = manager.Apply(context.Background(), localRequest(localAlloc, "cloud",
		StrategyInput{ID: "cloud", Name: "Local", Driver: "local", LocalDir: localDir}))
	require.NoError(t, err)
	require.False(t, status.Strategies[0].HasAccessKey)
	require.False(t, status.Strategies[0].HasSecret)
}

func TestManagerAppliesMediaUserLimits(t *testing.T) {
	base := t.TempDir()
	localDir := filepath.Join(base, "media")
	manager, err := NewManager(Config{
		Env:     config.Config{StorageDriver: config.StorageDriverLocal, StorageDir: localDir},
		DataDir: base,
		Logger:  testLogger(),
		Build:   func(context.Context, Target) (media.Storage, error) { return newFakeStore("local"), nil },
	})
	require.NoError(t, err)

	quota, upload, article := int64(2048), int64(1024), int64(4096)
	request := localRequest(map[string]AllocationInput{
		config.StorageScopeContent:    singleInput("local"),
		config.StorageScopeSite:       singleInput("local"),
		config.StorageScopeAvatar:     singleInput("local"),
		config.StorageScopeAttachment: singleInput("local"),
	}, "local", StrategyInput{ID: "local", Name: "Local", Driver: "local", LocalDir: localDir})
	request.MediaUserQuotaBytes = &quota
	request.MediaUserUploadBytes = &upload
	request.MediaUserArticleBytes = &article

	status, err := manager.Apply(context.Background(), request)
	require.NoError(t, err)
	require.EqualValues(t, quota, status.MediaUserQuotaBytes)
	require.EqualValues(t, upload, status.MediaUserUploadBytes)
	require.EqualValues(t, article, status.MediaUserArticleBytes)
	userQuota, _ := manager.MediaQuotaDefaults()
	require.EqualValues(t, quota, userQuota)
	require.EqualValues(t, upload, manager.MediaUploadLimitBytes())
	require.EqualValues(t, article, manager.MediaArticleLimitBytes())
}
