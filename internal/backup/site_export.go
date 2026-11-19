package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/taxonomy"
)

// ExportResult is one generated site export.
type ExportResult struct {
	Path          string   `json:"-"`
	FileName      string   `json:"file_name"`
	Size          int64    `json:"size"`
	ContentCount  int      `json:"content_count"`
	MediaCount    int      `json:"media_count"`
	PublishedOnly bool     `json:"published_only"`
	Warnings      []string `json:"warnings,omitempty"`
}

// mediaURLPattern matches a media API URL, optionally absolute. Group 1 is the
// asset id. The same pattern works on Markdown source and raw design JSON.
var mediaURLPattern = regexp.MustCompile(`(?i)(?:https?://[^\s"'()<>]+)?/api/v1/media/([A-Za-z0-9_-]+)`)

// mediaExtensions maps the MIME types the media module accepts to a file suffix.
var mediaExtensions = map[string]string{
	"image/jpeg":      ".jpg",
	"image/png":       ".png",
	"image/gif":       ".gif",
	"image/webp":      ".webp",
	"image/avif":      ".avif",
	"image/svg+xml":   ".svg",
	"application/pdf": ".pdf",
}

// extensionFor picks a stable file suffix for one asset.
func extensionFor(assetMIME, storageKey string) string {
	if ext, ok := mediaExtensions[strings.ToLower(assetMIME)]; ok {
		return ext
	}
	if ext := strings.ToLower(filepath.Ext(storageKey)); ext != "" && len(ext) <= 10 {
		return ext
	}
	return ".bin"
}

// collectMediaIDs returns unique asset ids referenced from the supplied text.
func collectMediaIDs(texts ...string) []string {
	seen := make(map[string]struct{})
	ids := make([]string, 0)
	for _, text := range texts {
		for _, match := range mediaURLPattern.FindAllStringSubmatch(text, -1) {
			id := match[1]
			if _, exists := seen[id]; exists {
				continue
			}
			seen[id] = struct{}{}
			ids = append(ids, id)
		}
	}
	return ids
}

// rewriteMediaURLs replaces exported media URLs with a relative path inside the
// package. A URL left alone (because the asset could not be read) stays as it
// was and is reported as a warning by the caller.
func rewriteMediaURLs(text string, replacements map[string]string) string {
	if len(replacements) == 0 {
		return text
	}
	return mediaURLPattern.ReplaceAllStringFunc(text, func(match string) string {
		slash := strings.LastIndex(match, "/")
		if slash < 0 {
			return match
		}
		id := match[slash+1:]
		if replacement, ok := replacements[id]; ok {
			return replacement
		}
		return match
	})
}

// exportTerm is the portable taxonomy row written into site.json.
type exportTerm struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	Description string `json:"description,omitempty"`
	Color       string `json:"color,omitempty"`
}

// exportSiteFile is the human and machine readable site descriptor.
type exportSiteFile struct {
	Site       exportSiteMeta `json:"site"`
	Categories []exportTerm   `json:"categories"`
	Tags       []exportTerm   `json:"tags"`
}

type exportSiteMeta struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Slug           string `json:"slug"`
	Domain         string `json:"domain,omitempty"`
	Description    string `json:"description,omitempty"`
	VisibilityMode string `json:"visibility_mode"`
	PublishMode    string `json:"publish_mode"`
	Language       string `json:"language,omitempty"`
}

// ExportSite writes a portable zip: Markdown with front matter, media files,
// site.json, design.json and pages.json.
func (s *Service) ExportSite(
	ctx context.Context,
	actor Actor,
	siteID string,
	publishedOnly bool,
) (ExportResult, error) {
	if err := requireSiteAdmin(actor, siteID); err != nil {
		return ExportResult{}, err
	}
	if s.sites == nil || s.content == nil || s.media == nil {
		return ExportResult{}, fmt.Errorf("%w: export services are not configured", ErrInvalidInput)
	}

	targetSite, err := s.sites.Get(ctx, siteID, actor.UserID)
	if err != nil {
		if isSiteNotFound(err) {
			return ExportResult{}, ErrNotFound
		}
		return ExportResult{}, err
	}
	if targetSite.ID != siteID {
		return ExportResult{}, ErrNotFound
	}

	customization, err := s.sites.Customization(ctx, siteID)
	if err != nil && !isCustomizationNotFound(err) {
		return ExportResult{}, err
	}
	terms, err := s.listTerms(ctx, siteID)
	if err != nil {
		return ExportResult{}, err
	}
	items, err := s.listAllContent(ctx, actor)
	if err != nil {
		return ExportResult{}, err
	}

	exported := make([]content.Content, 0, len(items))
	for _, item := range items {
		if item.SiteID != siteID {
			continue
		}
		if publishedOnly && item.Status != content.StatusPublished {
			continue
		}
		exported = append(exported, item)
	}

	createdAt := s.now().UTC()
	// Exports live under the backup directory rather than the OS temp directory:
	// a restore/export can be large, and the configured data directory is the one
	// the process is known to be allowed to write and clean up.
	file, err := os.CreateTemp(s.backupDir, ".export-*.zip")
	if err != nil {
		return ExportResult{}, err
	}
	path := file.Name()
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(path)
		}
	}()
	builder := newZipBuilder(file, createdAt)

	// Site descriptor, design and pages first: they are small and make the
	// package useful even when only a subset of the Markdown is opened.
	siteDescriptor := exportSiteFile{
		Site: exportSiteMeta{
			ID:             targetSite.ID,
			Name:           targetSite.Name,
			Slug:           targetSite.Slug,
			Domain:         targetSite.Domain,
			Description:    targetSite.Description,
			VisibilityMode: string(targetSite.VisibilityMode),
			PublishMode:    string(targetSite.PublishMode),
		},
		Categories: make([]exportTerm, 0),
		Tags:       make([]exportTerm, 0),
	}
	for _, term := range terms {
		row := exportTerm{
			ID: term.ID, Kind: string(term.Kind), Name: term.Name,
			Slug: term.Slug, Description: term.Description, Color: term.Color,
		}
		if term.Kind == taxonomy.KindCategory {
			siteDescriptor.Categories = append(siteDescriptor.Categories, row)
		} else {
			siteDescriptor.Tags = append(siteDescriptor.Tags, row)
		}
	}
	siteJSON, err := encodeJSON(siteDescriptor)
	if err != nil {
		return ExportResult{}, err
	}
	if _, err := builder.addBytes("site.json", createdAt, siteJSON); err != nil {
		return ExportResult{}, err
	}

	designDocument := customization.Document
	if len(designDocument) > 0 {
		if _, err := builder.addBytes("design.json", createdAt, designDocument); err != nil {
			return ExportResult{}, err
		}
		if pages := designPages(designDocument); pages != nil {
			if _, err := builder.addBytes("pages.json", createdAt, pages); err != nil {
				return ExportResult{}, err
			}
		}
	}

	// Collect every referenced asset before writing content, so the relative
	// rewrite and the media files agree even when several articles share one image.
	var texts []string
	for _, item := range exported {
		texts = append(texts, item.SourceBody)
	}
	if len(designDocument) > 0 {
		texts = append(texts, string(designDocument))
	}
	assetIDs := collectMediaIDs(texts...)

	replacements := make(map[string]string, len(assetIDs))
	mediaRows := make([]ExportMedia, 0, len(assetIDs))
	warnings := make([]string, 0)
	for _, assetID := range assetIDs {
		asset, reader, openErr := s.media.OpenAsset(ctx, mediaActor(actor), assetID)
		if openErr != nil {
			warnings = append(warnings,
				fmt.Sprintf("media %s could not be read and was left as an external URL", assetID))
			continue
		}
		extension := extensionFor(asset.MIME, asset.StorageKey)
		archivePath := "media/" + assetID + extension
		entry, addErr := builder.addReader(archivePath, createdAt, reader)
		_ = reader.Close()
		if addErr != nil {
			return ExportResult{}, fmt.Errorf("backup: add media %s: %w", assetID, addErr)
		}
		mediaRows = append(mediaRows, ExportMedia{
			AssetID: assetID,
			File:    archivePath,
			MIME:    asset.MIME,
			Size:    entry.Size,
			SHA256:  entry.SHA256,
		})
		replacements[assetID] = "../../" + archivePath
	}

	itemRows := make([]ExportItem, 0, len(exported))
	usedNames := make(map[string]int, len(exported))
	for _, item := range exported {
		categoryName, categorySlug := "", ""
		for _, term := range terms {
			if term.ID == item.CategoryID {
				categoryName, categorySlug = term.Name, term.Slug
				break
			}
		}
		body := rewriteMediaURLs(item.SourceBody, replacements)
		frontMatter := frontMatter(item, categoryName, categorySlug)
		extension := ".md"
		folder := "articles"
		if item.Kind == content.KindPost {
			folder = "posts"
		}
		switch item.SourceFormat {
		case content.FormatHTML:
			extension = ".html"
		case content.FormatPlain:
			extension = ".txt"
		}
		base := "content/" + folder + "/" + slugForFile(item)
		if usedNames[base+extension] > 0 {
			usedNames[base+extension]++
			base = fmt.Sprintf("%s-%d", base, usedNames[base+extension])
		} else {
			usedNames[base+extension] = 1
		}
		entryPath := base + extension
		entry, addErr := builder.addBytes(entryPath, createdAt, []byte(frontMatter+body))
		if addErr != nil {
			return ExportResult{}, fmt.Errorf("backup: add content %s: %w", item.ID, addErr)
		}
		_ = entry
		itemRows = append(itemRows, ExportItem{
			Path: entryPath, Kind: string(item.Kind), ContentID: item.ID,
			Title: item.Title, Slug: item.Slug, Status: string(item.Status),
		})
	}

	entries := append([]Entry(nil), builder.entries...)
	fileName := fmt.Sprintf(
		"practacu-site-%s-%s.zip",
		sanitizeFileName(targetSite.Slug),
		createdAt.Format("20060102-150405"),
	)
	manifest := ExportManifest{
		Format:        FormatSiteExport,
		FormatVersion: FormatVersion,
		Kind:          "site_export",
		AppVersion:    s.appVersion,
		SchemaVersion: s.schemaVersion,
		CreatedAt:     createdAt,
		Site: ExportSiteInfo{
			ID: targetSite.ID, Name: targetSite.Name, Slug: targetSite.Slug,
			Domain: targetSite.Domain,
		},
		PublishedOnly:   publishedOnly,
		ContentCount:    len(itemRows),
		Items:           itemRows,
		Media:           mediaRows,
		Entries:         entries,
		ContentChecksum: entryChecksum(entries),
		Warnings:        warnings,
	}
	if err := builder.addManifest(manifest); err != nil {
		return ExportResult{}, err
	}
	if err := builder.close(); err != nil {
		return ExportResult{}, err
	}
	if err := file.Sync(); err != nil {
		return ExportResult{}, err
	}
	if err := file.Close(); err != nil {
		return ExportResult{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return ExportResult{}, err
	}
	committed = true
	return ExportResult{
		Path:          path,
		FileName:      fileName,
		Size:          info.Size(),
		ContentCount:  len(itemRows),
		MediaCount:    len(mediaRows),
		PublishedOnly: publishedOnly,
		Warnings:      warnings,
	}, nil
}

// listTerms loads categories and tags, tolerating a deployment without taxonomy.
func (s *Service) listTerms(ctx context.Context, siteID string) ([]taxonomy.Term, error) {
	if s.taxonomy == nil {
		return nil, nil
	}
	return s.taxonomy.List(ctx, siteID)
}

// designPages extracts the pages array from the design document, or nil when the
// document has no pages key.
func designPages(document []byte) []byte {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(document, &root); err != nil {
		return nil
	}
	raw, ok := root["pages"]
	if !ok || len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var probe []json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil
	}
	pretty, err := encodeJSON(probe)
	if err != nil {
		return nil
	}
	return pretty
}

// sanitizeFileName keeps a generated filename free of separators and spaces.
func sanitizeFileName(value string) string {
	value = strings.TrimSpace(value)
	cleaned := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return '-'
		}
	}, value)
	cleaned = strings.Trim(cleaned, "-")
	if cleaned == "" {
		return "site"
	}
	return cleaned
}

// frontMatter renders the documented YAML subset the importer understands.
//
// Values are JSON quoted, which is a valid YAML double-quoted scalar; arrays are
// JSON flow arrays, also valid YAML. Keeping the writer and parser in one package
// avoids a full YAML dependency for the six fields this artifact needs.
func frontMatter(item content.Content, categoryName, categorySlug string) string {
	var builder strings.Builder
	builder.WriteString("---\n")
	writeFrontMatterString(&builder, "title", item.Title)
	writeFrontMatterString(&builder, "slug", item.Slug)
	writeFrontMatterString(&builder, "kind", string(item.Kind))
	writeFrontMatterString(&builder, "status", string(item.Status))
	writeFrontMatterString(&builder, "summary", item.Summary)
	writeFrontMatterString(&builder, "source_format", string(item.SourceFormat))
	writeFrontMatterString(&builder, "access_mode", string(item.AccessMode))
	writeFrontMatterString(&builder, "comment_policy", string(item.CommentPolicy))
	writeFrontMatterString(&builder, "author_id", item.AuthorID)
	writeFrontMatterString(&builder, "source_id", item.ID)
	if categoryName != "" || categorySlug != "" {
		writeFrontMatterString(&builder, "category", categoryName)
		writeFrontMatterString(&builder, "category_slug", categorySlug)
	}
	tags := item.Tags
	if tags == nil {
		tags = []string{}
	}
	rawTags, _ := json.Marshal(tags)
	builder.WriteString("tags: ")
	builder.Write(rawTags)
	builder.WriteString("\n")
	publishedAt := ""
	if item.PublishedAt != nil {
		publishedAt = item.PublishedAt.UTC().Format(time.RFC3339)
	}
	// Keep the key even for a draft: a consumer of the Markdown bundle can rely on
	// the published_at field existing, and the empty value says "never published".
	writeFrontMatterString(&builder, "published_at", publishedAt)
	writeFrontMatterString(&builder, "created_at", item.CreatedAt.UTC().Format(time.RFC3339))
	writeFrontMatterString(&builder, "updated_at", item.UpdatedAt.UTC().Format(time.RFC3339))
	builder.WriteString("---\n")
	return builder.String()
}

func writeFrontMatterString(builder *strings.Builder, key, value string) {
	raw, _ := json.Marshal(value)
	builder.WriteString(key)
	builder.WriteString(": ")
	builder.Write(raw)
	builder.WriteString("\n")
}
