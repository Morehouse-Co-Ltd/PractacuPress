package backup

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/media"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/taxonomy"
)

type fakeSiteReader struct {
	site  site.Site
	desig site.Customization
	err   error
}

func (f *fakeSiteReader) Get(_ context.Context, siteID, _ string) (site.Site, error) {
	if f.err != nil {
		return site.Site{}, f.err
	}
	if siteID != f.site.ID {
		return site.Site{}, site.ErrNotFound
	}
	return f.site, nil
}

func (f *fakeSiteReader) Customization(context.Context, string) (site.Customization, error) {
	if len(f.desig.Document) == 0 {
		return site.Customization{}, site.ErrCustomizationNotFound
	}
	return f.desig, nil
}

type fakeContentStore struct {
	items   []content.Content
	created []content.DraftInput
	updated []content.DraftInput
	nextID  int
}

func (f *fakeContentStore) ListAfterFilter(
	_ context.Context,
	actor content.Actor,
	kind content.Kind,
	_ int,
	_ page.Cursor,
	_ content.ListFilter,
) ([]content.Content, string, error) {
	out := make([]content.Content, 0)
	for _, item := range f.items {
		if item.SiteID != actor.SiteID {
			continue
		}
		if kind != "" && item.Kind != kind {
			continue
		}
		out = append(out, item)
	}
	return out, "", nil
}

func (f *fakeContentStore) CreateDraft(
	_ context.Context,
	actor content.Actor,
	kind content.Kind,
	in content.DraftInput,
) (content.Content, error) {
	f.nextID++
	f.created = append(f.created, in)
	item := content.Content{
		ID: fmt.Sprintf("new_%d", f.nextID), SiteID: actor.SiteID, AuthorID: actor.UserID,
		Kind: kind, Status: content.StatusDraft, Title: in.Title, Slug: in.Slug,
		Summary: in.Summary, SourceFormat: in.SourceFormat, SourceBody: in.SourceBody,
		Tags: in.Tags, AccessMode: in.AccessMode, CommentPolicy: in.CommentPolicy,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	f.items = append(f.items, item)
	return item, nil
}

func (f *fakeContentStore) UpdateDraft(
	_ context.Context,
	actor content.Actor,
	contentID string,
	in content.DraftInput,
) (content.Content, error) {
	f.updated = append(f.updated, in)
	for index, item := range f.items {
		if item.ID != contentID {
			continue
		}
		item.Title = in.Title
		item.Slug = in.Slug
		item.Summary = in.Summary
		item.SourceFormat = in.SourceFormat
		item.SourceBody = in.SourceBody
		item.Tags = in.Tags
		item.AccessMode = in.AccessMode
		item.CommentPolicy = in.CommentPolicy
		item.UpdatedAt = time.Now().UTC()
		f.items[index] = item
		return item, nil
	}
	return content.Content{}, content.ErrNotFound
}

type fakeTaxonomy struct {
	terms []taxonomy.Term
}

func (f *fakeTaxonomy) List(context.Context, string) ([]taxonomy.Term, error) {
	return f.terms, nil
}

type fakeMediaAsset struct {
	data []byte
	mime string
	key  string
}

type fakeMediaStore struct {
	assets  map[string]fakeMediaAsset
	bytes   map[string][]byte
	nextID  int
	deleted []string
}

func newFakeMediaStore() *fakeMediaStore {
	return &fakeMediaStore{assets: map[string]fakeMediaAsset{}, bytes: map[string][]byte{}}
}

func (f *fakeMediaStore) ListAssets(
	context.Context,
	media.Actor,
	media.AssetFilter,
	int,
	page.Cursor,
) ([]media.Asset, string, error) {
	return nil, "", nil
}

func (f *fakeMediaStore) OpenAsset(
	_ context.Context,
	_ media.Actor,
	assetID string,
) (media.Asset, io.ReadCloser, error) {
	asset, ok := f.assets[assetID]
	if !ok {
		return media.Asset{}, nil, media.ErrNotFound
	}
	return media.Asset{
		ID: assetID, StorageKey: asset.key, MIME: asset.mime, Size: int64(len(asset.data)),
		ScanStatus: media.ScanClean, Purpose: media.PurposeContent,
	}, io.NopCloser(bytes.NewReader(asset.data)), nil
}

func (f *fakeMediaStore) CreateUpload(
	_ context.Context,
	actor media.Actor,
	req media.UploadRequest,
) (media.Upload, error) {
	f.nextID++
	return media.Upload{
		ID: fmt.Sprintf("up_%d", f.nextID), SiteID: actor.SiteID, OwnerID: actor.UserID,
		FileName: req.FileName, DeclaredMIME: req.DeclaredMIME, Size: req.Size,
		Purpose: req.Purpose,
	}, nil
}

func (f *fakeMediaStore) StoreContent(
	_ context.Context,
	_ media.Actor,
	uploadID string,
	body io.Reader,
	size int64,
) (media.Upload, error) {
	data, err := io.ReadAll(body)
	if err != nil {
		return media.Upload{}, err
	}
	if int64(len(data)) != size {
		return media.Upload{}, media.ErrInvalidInput
	}
	f.bytes[uploadID] = data
	return media.Upload{ID: uploadID, Size: size}, nil
}

func (f *fakeMediaStore) CompleteUpload(
	_ context.Context,
	_ media.Actor,
	uploadID string,
) (media.Asset, error) {
	f.nextID++
	assetID := fmt.Sprintf("ast_new_%d", f.nextID)
	data := f.bytes[uploadID]
	f.assets[assetID] = fakeMediaAsset{data: data, mime: "image/png", key: "ab/" + assetID + ".png"}
	return media.Asset{
		ID: assetID, StorageKey: "ab/" + assetID + ".png", MIME: "image/png",
		Size: int64(len(data)), ScanStatus: media.ScanClean, Purpose: media.PurposeContent,
	}, nil
}

func (f *fakeMediaStore) DeleteAsset(_ context.Context, _ media.Actor, assetID string) error {
	f.deleted = append(f.deleted, assetID)
	delete(f.assets, assetID)
	return nil
}

func newTransferService(t *testing.T) (*Service, *fakeContentStore, *fakeMediaStore, *fakeSiteReader, *fakeTaxonomy) {
	t.Helper()
	contentStore := &fakeContentStore{}
	mediaStore := newFakeMediaStore()
	mediaStore.assets["ast_1"] = fakeMediaAsset{data: []byte("png-bytes"), mime: "image/png", key: "ab/one.png"}
	sites := &fakeSiteReader{
		site: site.Site{
			ID: "site_1", Slug: "alpha", Name: "Alpha", Domain: "alpha.example",
			VisibilityMode: site.VisibilityPublic, PublishMode: site.PublishModeReview,
		},
		desig: site.Customization{
			Document:  []byte(`{"pages":[{"id":"p1","title":"About","blocks":[]}],"theme":{}}`),
			Revision:  3,
			UpdatedAt: time.Now().UTC(),
		},
	}
	taxonomyStore := &fakeTaxonomy{terms: []taxonomy.Term{
		{ID: "cat_1", Kind: taxonomy.KindCategory, Name: "Notes", Slug: "notes"},
	}}
	service, err := NewService(Config{
		BackupDir: t.TempDir(),
		Sites:     sites,
		Content:   contentStore,
		Taxonomy:  taxonomyStore,
		Media:     mediaStore,
	})
	require.NoError(t, err)
	return service, contentStore, mediaStore, sites, taxonomyStore
}

func TestExportThenImportRoundtrip(t *testing.T) {
	ctx := context.Background()
	service, contentStore, mediaStore, _, _ := newTransferService(t)
	contentStore.items = []content.Content{{
		ID: "content_1", SiteID: "site_1", AuthorID: "user_1",
		Kind: content.KindArticle, Status: content.StatusPublished,
		Title: "Hello world", Slug: "hello", Summary: "A note",
		SourceFormat: content.FormatMarkdown,
		SourceBody:   "![cover](/api/v1/media/ast_1)\n\nBody text",
		CategoryID:   "cat_1", Tags: []string{"Go", "Notes"},
		AccessMode: content.AccessPublic, CommentPolicy: content.CommentPolicyInherit,
		CreatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
		UpdatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
	}}
	actor := Actor{UserID: "admin_1", SiteID: "site_1", Role: site.RoleSiteAdmin}

	exported, err := service.ExportSite(ctx, actor, "site_1", false)
	require.NoError(t, err)
	require.FileExists(t, exported.Path)
	require.Equal(t, 1, exported.ContentCount)
	require.Equal(t, 1, exported.MediaCount)
	defer os.Remove(exported.Path)

	reader, err := zip.OpenReader(exported.Path)
	require.NoError(t, err)
	files := map[string]*zip.File{}
	for _, file := range reader.File {
		files[file.Name] = file
	}
	require.Contains(t, files, "site.json")
	require.Contains(t, files, "design.json")
	require.Contains(t, files, "pages.json")
	require.Contains(t, files, "media/ast_1.png")
	contentFile, ok := files["content/articles/hello.md"]
	require.True(t, ok)
	stream, err := contentFile.Open()
	require.NoError(t, err)
	raw, err := io.ReadAll(stream)
	require.NoError(t, err)
	_ = stream.Close()
	text := string(raw)
	require.Contains(t, text, `title: "Hello world"`)
	require.Contains(t, text, `slug: "hello"`)
	require.Contains(t, text, `status: "published"`)
	require.Contains(t, text, `tags: ["Go","Notes"]`)
	require.Contains(t, text, "../../media/ast_1.png")
	require.NotContains(t, text, "/api/v1/media/ast_1")
	require.NoError(t, reader.Close())

	// Import into the same site with an existing "hello" slug: rename it. The
	// target has no matching asset, so the image must be uploaded again.
	delete(mediaStore.assets, "ast_1")
	contentStore.items = append(contentStore.items, content.Content{
		ID: "existing_1", SiteID: "site_1", AuthorID: "user_1",
		Kind: content.KindArticle, Status: content.StatusDraft,
		Title: "Existing", Slug: "hello", SourceBody: "existing", SourceFormat: content.FormatMarkdown,
	})
	archive, err := os.ReadFile(exported.Path)
	require.NoError(t, err)
	report, err := service.ImportSite(
		ctx, actor, "site_1", bytes.NewReader(archive), int64(len(archive)),
		ImportOptions{Conflict: ConflictRename},
	)
	require.NoError(t, err)
	require.Equal(t, 1, report.Imported)
	require.Equal(t, 0, report.Failed)
	require.Equal(t, 1, report.MediaImported)
	require.Len(t, report.Items, 1)
	require.Equal(t, "hello-2", report.Items[0].Slug)
	require.Len(t, contentStore.created, 1)
	require.Contains(t, contentStore.created[0].SourceBody, "/api/v1/media/ast_new_")
	require.NotContains(t, contentStore.created[0].SourceBody, "../../media/")
	require.NotContains(t, contentStore.created[0].SourceBody, "../..")

	// Second run with skip leaves the item alone.
	report, err = service.ImportSite(
		ctx, actor, "site_1", bytes.NewReader(archive), int64(len(archive)),
		ImportOptions{Conflict: ConflictSkip},
	)
	require.NoError(t, err)
	require.Equal(t, 1, report.Skipped)
	require.Equal(t, 0, report.Imported)

	// fail reports the conflict without writing.
	report, err = service.ImportSite(
		ctx, actor, "site_1", bytes.NewReader(archive), int64(len(archive)),
		ImportOptions{Conflict: ConflictFail},
	)
	require.NoError(t, err)
	require.Equal(t, 1, report.Failed)
	require.Contains(t, report.Items[0].Reason, "already exists")

	// overwrite updates the existing item through UpdateDraft.
	report, err = service.ImportSite(
		ctx, actor, "site_1", bytes.NewReader(archive), int64(len(archive)),
		ImportOptions{Conflict: ConflictOverwrite},
	)
	require.NoError(t, err)
	require.Equal(t, 1, report.Overwritten)
	require.Equal(t, "existing_1", report.Items[0].ContentID)
	require.Len(t, contentStore.updated, 1)
	require.Equal(t, "hello", contentStore.updated[0].Slug)
	require.NotEmpty(t, mediaStore.assets)
}

func TestImportRejectsWrongFormatAndUnsafePaths(t *testing.T) {
	ctx := context.Background()
	service, _, _, _, _ := newTransferService(t)
	actor := Actor{UserID: "admin_1", SiteID: "site_1", Role: site.RoleSiteAdmin}

	// A plain file is not a zip.
	_, err := service.ImportSite(ctx, actor, "site_1", bytes.NewReader([]byte("nope")), 4, ImportOptions{})
	require.ErrorIs(t, err, ErrInvalidArchive)

	// A zip with a traversal entry is rejected before any handler runs.
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	entry, err := writer.Create("../escape.txt")
	require.NoError(t, err)
	_, err = entry.Write([]byte("x"))
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	_, err = service.ImportSite(
		ctx, actor, "site_1", bytes.NewReader(buffer.Bytes()), int64(buffer.Len()), ImportOptions{},
	)
	require.ErrorIs(t, err, ErrInvalidArchive)
}

func TestParseSiteDocument(t *testing.T) {
	raw := []byte("---\n" +
		"title: \"A \\\"quoted\\\" title\"\n" +
		"tags: [\"Go\",\"Web\"]\n" +
		"status: draft\n" +
		"---\n" +
		"Body\n")
	document, err := parseSiteDocument(raw)
	require.NoError(t, err)
	require.Equal(t, `A "quoted" title`, document.Fields["title"])
	require.Equal(t, []string{"Go", "Web"}, document.Tags)
	require.Equal(t, "Body\n", document.Body)

	noFrontMatter, err := parseSiteDocument([]byte("plain body"))
	require.NoError(t, err)
	require.Equal(t, "plain body", noFrontMatter.Body)
}

func TestNormalizeImportedSlugKeepsOnlyAllowedCharacters(t *testing.T) {
	require.Equal(t, "hello-world-2", normalizeImportedSlug("Hello World 2"))
	require.Equal(t, "note", normalizeImportedSlug("Note!"))
	require.Empty(t, normalizeImportedSlug("涓枃鏍囬"))
	require.True(t, strings.HasPrefix(makeSlugVariant("hello", 2), "hello-"))
}
