package backup

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/media"
	"github.com/practacu/practacu-press/apps/api/internal/taxonomy"
)

// Conflict strategies for an imported item whose slug already exists.
const (
	// ConflictRename appends -2, -3, ... until the slug is free.
	ConflictRename = "rename"
	// ConflictSkip leaves the existing item untouched.
	ConflictSkip = "skip"
	// ConflictFail reports the item as failed and imports nothing else for it.
	ConflictFail = "fail"
	// ConflictOverwrite updates the existing item through the normal draft save.
	ConflictOverwrite = "overwrite"
)

// ImportOptions controls conflict handling.
type ImportOptions struct {
	Conflict  string
	RequestID string
}

// ImportItem is the per-file outcome shown to the operator.
type ImportItem struct {
	File           string `json:"file"`
	Title          string `json:"title"`
	Slug           string `json:"slug"`
	Kind           string `json:"kind"`
	OriginalStatus string `json:"original_status,omitempty"`
	Action         string `json:"action"`
	ContentID      string `json:"content_id,omitempty"`
	Status         string `json:"status,omitempty"`
	Reason         string `json:"reason,omitempty"`
}

// ImportReport is the whole import outcome.
type ImportReport struct {
	Format        string       `json:"format"`
	FormatVersion int          `json:"format_version"`
	SiteID        string       `json:"site_id"`
	Imported      int          `json:"imported"`
	Overwritten   int          `json:"overwritten"`
	Skipped       int          `json:"skipped"`
	Failed        int          `json:"failed"`
	MediaImported int          `json:"media_imported"`
	MediaReused   int          `json:"media_reused"`
	Items         []ImportItem `json:"items"`
	Warnings      []string     `json:"warnings,omitempty"`
}

// parsedDocument is one front matter file.
type parsedDocument struct {
	Fields map[string]string
	Tags   []string
	Body   string
}

// ImportSite creates drafts from a site export package.
//
// It is deliberately not all-or-nothing: a package may contain one article that
// no longer validates, and failing the other ninety would be worse than importing
// them and reporting the bad row. Each item is independent; media created for a
// failed item is removed again.
func (s *Service) ImportSite(
	ctx context.Context,
	actor Actor,
	siteID string,
	archive io.ReaderAt,
	size int64,
	opts ImportOptions,
) (ImportReport, error) {
	if err := requireSiteAdmin(actor, siteID); err != nil {
		return ImportReport{}, err
	}
	if s.content == nil || s.media == nil || s.sites == nil {
		return ImportReport{}, fmt.Errorf("%w: import services are not configured", ErrInvalidInput)
	}
	strategy := strings.ToLower(strings.TrimSpace(opts.Conflict))
	if strategy == "" {
		strategy = ConflictRename
	}
	switch strategy {
	case ConflictRename, ConflictSkip, ConflictFail, ConflictOverwrite:
	default:
		return ImportReport{}, fmt.Errorf("%w: unknown conflict strategy %q", ErrInvalidInput, strategy)
	}
	if size <= 0 || size > MaxImportBytes {
		return ImportReport{}, fmt.Errorf("%w: import must be between 1 and %d bytes", ErrInvalidInput, MaxImportBytes)
	}

	reader, err := zip.NewReader(archive, size)
	if err != nil {
		return ImportReport{}, fmt.Errorf("%w: open package: %v", ErrInvalidArchive, err)
	}
	baseManifest, rawManifest, err := verifyArchive(reader)
	if err != nil {
		return ImportReport{}, err
	}
	if err := requireKind(baseManifest, FormatSiteExport); err != nil {
		return ImportReport{}, err
	}
	var manifest ExportManifest
	if err := json.Unmarshal(rawManifest, &manifest); err != nil {
		return ImportReport{}, fmt.Errorf("%w: malformed export manifest: %v", ErrInvalidArchive, err)
	}
	if manifest.Site.ID != "" && manifest.Site.ID != siteID {
		// Importing site A's package into site B is allowed; it is a migration.
		// The target site id is authoritative, so this is a warning rather than a
		// refusal.
		manifest.Warnings = append(manifest.Warnings,
			fmt.Sprintf("package was exported from site %s and is imported into %s", manifest.Site.ID, siteID))
	}

	if _, err := s.sites.Get(ctx, siteID, actor.UserID); err != nil {
		if isSiteNotFound(err) {
			return ImportReport{}, ErrNotFound
		}
		return ImportReport{}, err
	}
	terms, err := s.listTerms(ctx, siteID)
	if err != nil {
		return ImportReport{}, err
	}
	categoryBySlug := make(map[string]taxonomy.Term)
	categoryByName := make(map[string]taxonomy.Term)
	for _, term := range terms {
		if term.Kind == taxonomy.KindCategory {
			categoryBySlug[strings.ToLower(term.Slug)] = term
			categoryByName[strings.ToLower(term.Name)] = term
		}
	}

	existing, err := s.listAllContent(ctx, actor)
	if err != nil {
		return ImportReport{}, err
	}
	existingBySlug := make(map[string]content.Content, len(existing))
	titleCounts := make(map[string]int, len(existing))
	for _, item := range existing {
		if item.SiteID != siteID {
			continue
		}
		if item.Slug != "" {
			existingBySlug[item.Slug] = item
		}
		titleCounts[strings.ToLower(strings.TrimSpace(item.Title))]++
	}
	usedSlugs := make(map[string]bool, len(manifest.Items))

	importer := &mediaImporter{
		service:  s,
		actor:    mediaActor(actor),
		entries:  manifest.Media,
		reader:   reader,
		imported: make(map[string]string),
	}

	report := ImportReport{
		Format:        manifest.Format,
		FormatVersion: manifest.FormatVersion,
		SiteID:        siteID,
		Items:         make([]ImportItem, 0, len(manifest.Items)),
		Warnings:      append([]string(nil), manifest.Warnings...),
	}
	for _, itemRef := range manifest.Items {
		item, itemErr := s.importOne(
			ctx, actor, siteID, reader, importer, itemRef, strategy,
			existingBySlug, usedSlugs, categoryBySlug, categoryByName, titleCounts,
		)
		if itemErr != nil {
			item.Action = "failed"
			item.Reason = cleanError(itemErr)
			report.Failed++
		} else {
			switch item.Action {
			case "imported":
				report.Imported++
			case "overwritten":
				report.Overwritten++
			case "skipped":
				report.Skipped++
			}
		}
		report.Items = append(report.Items, item)
	}
	report.MediaImported = importer.createdCount
	report.MediaReused = importer.reusedCount
	report.Warnings = append(report.Warnings, importer.warnings...)
	sort.SliceStable(report.Items, func(i, j int) bool { return report.Items[i].File < report.Items[j].File })
	return report, nil
}

// importOne processes a single manifest item.
func (s *Service) importOne(
	ctx context.Context,
	actor Actor,
	siteID string,
	reader *zip.Reader,
	importer *mediaImporter,
	ref ExportItem,
	strategy string,
	existingBySlug map[string]content.Content,
	usedSlugs map[string]bool,
	categoryBySlug map[string]taxonomy.Term,
	categoryByName map[string]taxonomy.Term,
	titleCounts map[string]int,
) (ImportItem, error) {
	item := ImportItem{
		File:           ref.Path,
		Kind:           ref.Kind,
		Title:          ref.Title,
		Slug:           ref.Slug,
		OriginalStatus: ref.Status,
	}
	file, ok := findZipFile(reader, ref.Path)
	if !ok {
		return item, fmt.Errorf("%w: content file %q is missing", ErrInvalidArchive, ref.Path)
	}
	raw, err := readZipEntry(file, int64(content.MaxSourceLength*4)+(1<<16))
	if err != nil {
		return item, err
	}
	document, err := parseSiteDocument(raw)
	if err != nil {
		return item, err
	}
	title := firstNonEmpty(document.Fields["title"], ref.Title)
	item.Title = title
	if strings.TrimSpace(title) == "" {
		return item, fmt.Errorf("%w: title is required", ErrInvalidInput)
	}
	kind := content.Kind(firstNonEmpty(document.Fields["kind"], ref.Kind))
	if !kind.Valid() {
		return item, fmt.Errorf("%w: unknown content kind %q", ErrInvalidInput, kind)
	}
	item.Kind = string(kind)

	desiredSlug := normalizeImportedSlug(document.Fields["slug"])
	if desiredSlug == "" {
		desiredSlug = normalizeImportedSlug(content.SlugFromTitle(title))
	}
	if desiredSlug == "" {
		// A non-ASCII title has no ASCII slug. Give the item a stable, readable
		// address instead of leaving an empty one that every later import repeats.
		desiredSlug = "imported-" + shortHash(title)
	}
	item.Slug = desiredSlug

	resolvedSlug, existing, action, resolveErr := resolveSlug(
		strategy, desiredSlug, existingBySlug, usedSlugs,
	)
	if resolveErr != nil {
		return item, resolveErr
	}
	item.Slug = resolvedSlug
	if action == "skipped" {
		item.Action = "skipped"
		item.Reason = "slug already exists"
		return item, nil
	}
	if action == "overwrite" && existing == nil {
		action = "imported"
	}

	body, mediaCreated, mediaErr := importer.prepareBody(
		ctx, document.Body, ref.Path,
	)
	if mediaErr != nil {
		importer.cleanup(mediaCreated)
		return item, mediaErr
	}

	format := content.SourceFormat(firstNonEmpty(document.Fields["source_format"], "markdown"))
	if !format.Valid() {
		format = content.FormatMarkdown
	}
	accessMode := content.AccessMode(firstNonEmpty(document.Fields["access_mode"], string(content.AccessPublic)))
	if !accessMode.Valid() {
		accessMode = content.AccessPublic
	}
	if accessMode == content.AccessPassword {
		accessMode = content.AccessPublic
		reportWarning(importer, "password protected item imported as a public draft; set a new access password in the editor")
	}
	commentPolicy := content.CommentPolicy(firstNonEmpty(document.Fields["comment_policy"], string(content.CommentPolicyInherit)))
	if !commentPolicy.Valid() {
		commentPolicy = content.CommentPolicyInherit
	}
	categoryID := ""
	if slug := strings.ToLower(strings.TrimSpace(document.Fields["category_slug"])); slug != "" {
		if term, ok := categoryBySlug[slug]; ok {
			categoryID = term.ID
		}
	}
	if categoryID == "" {
		if name := strings.ToLower(strings.TrimSpace(document.Fields["category"])); name != "" {
			if term, ok := categoryByName[name]; ok {
				categoryID = term.ID
			}
		}
	}

	draft := content.DraftInput{
		Title:         title,
		Slug:          resolvedSlug,
		Summary:       document.Fields["summary"],
		SourceFormat:  format,
		SourceBody:    body,
		CategoryID:    categoryID,
		Tags:          document.Tags,
		AccessMode:    accessMode,
		CommentPolicy: commentPolicy,
	}

	if titleCounts[strings.ToLower(strings.TrimSpace(title))] > 0 {
		reportWarning(importer, fmt.Sprintf("title %q already exists on this site", title))
	}

	var saved content.Content
	var saveErr error
	if action == "overwrite" && existing != nil {
		saved, saveErr = s.content.UpdateDraft(ctx, siteActor(actor), existing.ID, draft)
		item.Action = "overwritten"
		item.ContentID = existing.ID
		usedSlugs[resolvedSlug] = true
	} else {
		saved, saveErr = s.content.CreateDraft(ctx, siteActor(actor), kind, draft)
		item.Action = "imported"
		usedSlugs[resolvedSlug] = true
	}
	if saveErr != nil {
		if saved.ID == "" {
			importer.cleanup(mediaCreated)
			return item, saveErr
		}
		// The security service can be down while the row is already committed;
		// the content is held for review, which is a successful import with a
		// warning rather than a failed one.
		reportWarning(importer, fmt.Sprintf("%s: saved but held for a security retry: %v", ref.Path, saveErr))
	}
	item.ContentID = saved.ID
	item.Status = string(saved.Status)
	if item.Status == "" {
		item.Status = string(content.StatusPendingSecurityCheck)
	}
	return item, nil
}

// resolveSlug applies the conflict strategy.
func resolveSlug(
	strategy, desired string,
	existing map[string]content.Content,
	used map[string]bool,
) (string, *content.Content, string, error) {
	candidate := desired
	if target, conflict := lookupSlug(existing, used, candidate); conflict {
		switch strategy {
		case ConflictSkip:
			return candidate, nil, "skipped", nil
		case ConflictFail:
			return candidate, nil, "failed", fmt.Errorf(
				"%w: slug %q already exists", ErrInvalidInput, candidate,
			)
		case ConflictOverwrite:
			return candidate, target, "overwrite", nil
		case ConflictRename:
			for suffix := 2; suffix < 1000; suffix++ {
				next := makeSlugVariant(desired, suffix)
				if _, taken := lookupSlug(existing, used, next); !taken {
					return next, nil, "imported", nil
				}
			}
			return makeSlugVariant(desired, int(time.Now().UnixNano()%100000)), nil, "imported", nil
		}
	}
	return candidate, nil, "imported", nil
}

func lookupSlug(existing map[string]content.Content, used map[string]bool, slug string) (*content.Content, bool) {
	if item, ok := existing[slug]; ok {
		copy := item
		return &copy, true
	}
	return nil, used[slug]
}

func makeSlugVariant(base string, suffix int) string {
	tail := fmt.Sprintf("-%d", suffix)
	limit := content.MaxSlugLength - len(tail)
	if len(base) > limit {
		base = strings.TrimRight(base[:limit], "-")
	}
	return base + tail
}

func normalizeImportedSlug(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	lastHyphen := true
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			builder.WriteRune(r)
			lastHyphen = false
		case !lastHyphen:
			builder.WriteRune('-')
			lastHyphen = true
		}
	}
	slug := strings.Trim(builder.String(), "-")
	if len(slug) > content.MaxSlugLength {
		slug = strings.Trim(slug[:content.MaxSlugLength], "-")
	}
	return slug
}

func shortHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:4])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// parseSiteDocument splits the documented front matter subset from the body.
func parseSiteDocument(raw []byte) (parsedDocument, error) {
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	text = strings.TrimPrefix(text, "\ufeff")
	if !strings.HasPrefix(text, "---\n") {
		return parsedDocument{Fields: map[string]string{}, Body: text}, nil
	}
	rest := text[len("---\n"):]
	end := strings.Index(rest, "\n---\n")
	if end < 0 {
		if strings.HasSuffix(rest, "\n---") {
			end = len(rest) - len("\n---")
		} else {
			return parsedDocument{}, fmt.Errorf("%w: unterminated front matter", ErrInvalidArchive)
		}
	}
	header := rest[:end]
	body := ""
	if end+len("\n---\n") <= len(rest) {
		body = rest[end+len("\n---\n"):]
	}

	document := parsedDocument{Fields: make(map[string]string), Body: body}
	for _, line := range strings.Split(header, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		colon := strings.Index(line, ":")
		if colon <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		value := strings.TrimSpace(line[colon+1:])
		if key == "tags" {
			var tags []string
			if err := json.Unmarshal([]byte(value), &tags); err == nil {
				document.Tags = tags
				continue
			}
		}
		if strings.HasPrefix(value, `"`) {
			var decoded string
			if err := json.Unmarshal([]byte(value), &decoded); err == nil {
				document.Fields[key] = decoded
				continue
			}
		}
		document.Fields[key] = value
	}
	return document, nil
}

// mediaImporter creates assets for the images a package references and maps the
// old URL to the new one.
type mediaImporter struct {
	service      *Service
	actor        media.Actor
	entries      []ExportMedia
	reader       *zip.Reader
	imported     map[string]string // sha256 -> asset id
	createdCount int
	reusedCount  int
	warnings     []string
}

// prepareBody rewrites media links in one item's body to the target site's
// assets and returns the assets created for this item so a failed save can clean
// them up.
func (m *mediaImporter) prepareBody(
	ctx context.Context,
	body, sourcePath string,
) (string, []string, error) {
	created := make([]string, 0)
	updated := body
	for _, entry := range m.entries {
		// Longest reference first: replacing "media/x.png" before
		// "../../media/x.png" would leave a stray "../.." in front of the new URL.
		references := []string{
			"../../" + entry.File,
			entry.File,
			"/api/v1/media/" + entry.AssetID,
		}
		referenced := false
		for _, ref := range references {
			if ref != "" && strings.Contains(updated, ref) {
				referenced = true
				break
			}
		}
		if !referenced {
			continue
		}
		assetID, createdNow, err := m.ensure(ctx, entry)
		if err != nil {
			return body, created, err
		}
		if createdNow {
			created = append(created, assetID)
		}
		newURL := "/api/v1/media/" + assetID
		for _, ref := range references {
			if ref != "" {
				updated = strings.ReplaceAll(updated, ref, newURL)
			}
		}
	}
	return updated, created, nil
}

// ensure finds or creates one media asset.
func (m *mediaImporter) ensure(ctx context.Context, entry ExportMedia) (string, bool, error) {
	key := entry.SHA256
	if key != "" {
		if assetID, ok := m.imported[key]; ok {
			m.reusedCount++
			return assetID, false, nil
		}
	}
	// Re-importing into the same site can reuse the original row when the bytes
	// are still readable. This is what makes a repeated import idempotent for
	// images even when the package has no content hash column to consult.
	if entry.AssetID != "" {
		if _, reader, err := m.service.media.OpenAsset(ctx, m.actor, entry.AssetID); err == nil {
			_ = reader.Close()
			if key != "" {
				m.imported[key] = entry.AssetID
			}
			m.reusedCount++
			return entry.AssetID, false, nil
		}
	}

	file, ok := findZipFile(m.reader, entry.File)
	if !ok {
		return "", false, fmt.Errorf("%w: media file %q is missing", ErrInvalidArchive, entry.File)
	}
	hasher := sha256.New()
	stream, err := file.Open()
	if err != nil {
		return "", false, err
	}
	if _, err := io.Copy(hasher, stream); err != nil {
		_ = stream.Close()
		return "", false, err
	}
	if err := stream.Close(); err != nil {
		return "", false, err
	}
	actual := hex.EncodeToString(hasher.Sum(nil))
	if entry.SHA256 != "" && actual != entry.SHA256 {
		return "", false, fmt.Errorf("%w: media %s does not match its manifest hash", ErrChecksumMismatch, entry.File)
	}
	if key == "" {
		key = actual
		if existing, ok := m.imported[key]; ok {
			m.reusedCount++
			return existing, false, nil
		}
	}

	mimeType := strings.ToLower(strings.TrimSpace(entry.MIME))
	if mimeType == "" {
		headStream, headErr := file.Open()
		if headErr != nil {
			return "", false, headErr
		}
		head := make([]byte, 512)
		n, _ := io.ReadFull(headStream, head)
		_ = headStream.Close()
		mimeType = http.DetectContentType(head[:n])
	}
	upload, err := m.service.media.CreateUpload(ctx, m.actor, media.UploadRequest{
		FileName:     path.Base(entry.File),
		DeclaredMIME: mimeType,
		Size:         entry.Size,
		Purpose:      media.PurposeContent,
	})
	if err != nil {
		return "", false, fmt.Errorf("media %s: %w", entry.File, err)
	}
	contentStream, err := file.Open()
	if err != nil {
		return "", false, err
	}
	_, storeErr := m.service.media.StoreContent(ctx, m.actor, upload.ID, contentStream, entry.Size)
	_ = contentStream.Close()
	if storeErr != nil {
		return "", false, fmt.Errorf("media %s: %w", entry.File, storeErr)
	}
	asset, completeErr := m.service.media.CompleteUpload(ctx, m.actor, upload.ID)
	if completeErr != nil {
		return "", false, fmt.Errorf("media %s: %w", entry.File, completeErr)
	}
	if key != "" {
		m.imported[key] = asset.ID
	}
	m.createdCount++
	return asset.ID, true, nil
}

// cleanup removes media created for one failed item.
func (m *mediaImporter) cleanup(assetIDs []string) {
	for _, assetID := range assetIDs {
		if err := m.service.media.DeleteAsset(context.Background(), m.actor, assetID); err != nil {
			m.warnings = append(m.warnings, fmt.Sprintf("could not remove unused media %s: %v", assetID, err))
		} else if m.createdCount > 0 {
			// The asset never reached a successful item, so it is not part of the
			// "images imported" total the operator sees.
			m.createdCount--
		}
		for key, mapped := range m.imported {
			if mapped == assetID {
				delete(m.imported, key)
			}
		}
	}
}

func reportWarning(m *mediaImporter, message string) {
	m.warnings = append(m.warnings, message)
}
