// Package contentstore implements the content persistence port with Ent.
package contentstore

import (
	"context"
	"database/sql"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/site"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/contentitem"
	"github.com/practacu/practacu-press/apps/api/ent/contentrevision"
	"github.com/practacu/practacu-press/apps/api/ent/user"
)

// Store is the Ent backed implementation of content.Repository.
type Store struct {
	client *entgen.Client
	// searchDB is the raw handle used by the index DDL and by the index
	// statements. Ent's generated client does not expose its driver, and the
	// index is maintained after the item transaction commits, so the pool is
	// the portable way to reach it.
	searchDB *sql.DB
	// searchDriver is the canonical driver name (sqlite, mysql, postgres).
	searchDriver string
	// search holds the process-local full text index state.
	search searchState
}

// SearchDB is the raw database capability search needs.
//
// It is a narrow optional port: *db.DB implements it, and a caller that omits
// it (unit tests of unrelated features) still gets a working repository whose
// search answers from the LIKE fallback.
type SearchDB interface {
	SQL() *sql.DB
	Driver() string
}

// New returns a Store over the given Ent client.
//
// Passing the database handle enables the full text index. Without it the
// store stays correct but search always uses the portable LIKE path.
func New(client *entgen.Client, databases ...SearchDB) *Store {
	store := &Store{client: client}
	if len(databases) > 0 && databases[0] != nil && databases[0].SQL() != nil {
		store.searchDB = databases[0].SQL()
		store.searchDriver = databases[0].Driver()
	}
	return store
}

var _ content.Repository = (*Store)(nil)

// Insert stores a new item, its first revision snapshot and its audit entry in one
// transaction.
func (s *Store) Insert(ctx context.Context, item content.Content, audit site.AuditEntry) (content.Content, error) {
	item.Revision = 1

	tx, err := s.client.Tx(ctx)
	if err != nil {
		return content.Content{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	builder := tx.ContentItem.Create().
		SetSiteID(item.SiteID).
		SetAuthorID(item.AuthorID).
		SetKind(string(item.Kind)).
		SetStatus(string(item.Status)).
		SetTitle(item.Title).
		SetSlug(item.Slug).
		SetSummary(item.Summary).
		SetSourceFormat(string(item.SourceFormat)).
		SetSourceBody(item.SourceBody).
		SetRenderedHTML(item.RenderedHTML).
		SetPolicyVersion(item.PolicyVersion).
		SetTags(content.EncodeTags(item.Tags)).
		SetRevision(item.Revision).
		SetAccessMode(string(item.AccessMode)).
		SetCommentPolicy(string(item.CommentPolicy)).
		SetPublishAttempts(item.PublishAttempts).
		SetCreatedAt(item.CreatedAt).
		SetUpdatedAt(item.UpdatedAt)
	if item.AccessPasswordHash != "" {
		builder.SetAccessPasswordHash(item.AccessPasswordHash)
	}
	if item.CategoryID != "" {
		builder.SetCategoryID(item.CategoryID)
	}
	if item.PublishedAt != nil {
		builder.SetPublishedAt(*item.PublishedAt)
	}
	if item.PublishAt != nil {
		builder.SetPublishAt(*item.PublishAt)
	}
	if item.ArchivedAt != nil {
		builder.SetArchivedAt(*item.ArchivedAt)
	}

	created, err := builder.Save(ctx)
	if err != nil {
		return content.Content{}, err
	}

	stored := toContent(created)
	if err := insertRevision(ctx, tx.Client(), stored.Snapshot(
		stored.Revision, stored.AuthorID, content.RevisionCreated, stored.CreatedAt,
	)); err != nil {
		return content.Content{}, err
	}
	if err := insertAudit(ctx, tx.Client(), audit, item.Kind, created.ID); err != nil {
		return content.Content{}, err
	}
	if err := tx.Commit(); err != nil {
		return content.Content{}, err
	}
	committed = true
	s.indexContent(ctx, stored)

	return stored, nil
}

// SaveDraft updates an editable item, appends its revision snapshot and writes the
// audit entry in one transaction.
//
// The update is conditional on the revision the caller read. A concurrent save
// advances the revision, so the stale writer sees ErrConflict instead of silently
// overwriting the newer text.
func (s *Store) SaveDraft(ctx context.Context, item content.Content, audit site.AuditEntry) (content.Content, error) {
	fromRevision := item.Revision

	tx, err := s.client.Tx(ctx)
	if err != nil {
		return content.Content{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	update := tx.ContentItem.Update().
		Where(
			contentitem.IDEQ(item.ID),
			contentitem.SiteIDEQ(item.SiteID),
			contentitem.RevisionEQ(fromRevision),
		).
		SetTitle(item.Title).
		SetSlug(item.Slug).
		SetSummary(item.Summary).
		SetSourceFormat(string(item.SourceFormat)).
		SetSourceBody(item.SourceBody).
		SetRenderedHTML(item.RenderedHTML).
		SetPolicyVersion(item.PolicyVersion).
		SetTags(content.EncodeTags(item.Tags)).
		SetStatus(string(item.Status)).
		SetRevision(fromRevision + 1).
		SetAccessMode(string(item.AccessMode)).
		SetCommentPolicy(string(item.CommentPolicy)).
		SetPublishAttempts(item.PublishAttempts).
		SetUpdatedAt(item.UpdatedAt)
	if item.AccessPasswordHash != "" {
		update.SetAccessPasswordHash(item.AccessPasswordHash)
	} else {
		update.ClearAccessPasswordHash()
	}
	if item.PublishAt != nil {
		update.SetPublishAt(*item.PublishAt)
	} else {
		update.ClearPublishAt()
	}
	if item.CategoryID != "" {
		update.SetCategoryID(item.CategoryID)
	} else {
		update.ClearCategoryID()
	}

	affected, err := update.Save(ctx)
	if err != nil {
		return content.Content{}, err
	}
	if affected == 0 {
		return content.Content{}, writeFailure(ctx, tx.Client(), item.SiteID, item.ID)
	}

	stored := item
	stored.Revision = fromRevision + 1
	if err := insertRevision(ctx, tx.Client(), stored.Snapshot(
		stored.Revision, audit.ActorID, content.RevisionUpdated, item.UpdatedAt,
	)); err != nil {
		return content.Content{}, err
	}

	if err := insertAudit(ctx, tx.Client(), audit, item.Kind, item.ID); err != nil {
		return content.Content{}, err
	}
	if err := tx.Commit(); err != nil {
		return content.Content{}, err
	}
	committed = true
	s.indexContent(ctx, stored)

	updated, err := s.client.ContentItem.Get(ctx, item.ID)
	if err != nil {
		return content.Content{}, err
	}
	return toContent(updated), nil
}

// FindByID loads an item inside a site scope.
func (s *Store) FindByID(ctx context.Context, siteID, contentID string) (content.Content, error) {
	row, err := s.client.ContentItem.Query().
		Where(contentitem.IDEQ(contentID), contentitem.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return content.Content{}, content.ErrNotFound
		}
		return content.Content{}, err
	}
	return toContent(row), nil
}

// List returns items of a site filtered by status, author and the caller's narrowing.
func (s *Store) List(ctx context.Context, filter content.ListFilter) ([]content.Content, error) {
	query := s.client.ContentItem.Query().
		Where(contentitem.SiteIDEQ(filter.SiteID))

	if filter.Kind != "" {
		query = query.Where(contentitem.KindEQ(string(filter.Kind)))
	}
	if filter.AuthorID != "" {
		query = query.Where(contentitem.AuthorIDEQ(filter.AuthorID))
	}
	if filter.CategoryID != "" {
		query = query.Where(contentitem.CategoryIDEQ(filter.CategoryID))
	}
	if filter.Tag != "" {
		// tags is a JSON array of names stored as text, with no join table, so the tag
		// filter is a quoted token match: `"Go"` matches the element "Go" but never the
		// element "GoLang". NormalizeTag rejects `"` and `\`, so the value cannot escape
		// the token. Contains compiles to LIKE, the only operator SQLite, MySQL and
		// PostgreSQL agree on for this column; JSON path syntax would not be portable.
		query = query.Where(contentitem.TagsContains(`"` + filter.Tag + `"`))
	}
	if !filter.Since.IsZero() {
		query = query.Where(contentitem.CreatedAtGTE(filter.Since))
	}
	if len(filter.Statuses) > 0 {
		statuses := make([]string, 0, len(filter.Statuses))
		for _, status := range filter.Statuses {
			statuses = append(statuses, string(status))
		}
		query = query.Where(contentitem.StatusIn(statuses...))
	}
	if len(filter.AccessModes) > 0 {
		modes := make([]string, 0, len(filter.AccessModes))
		for _, mode := range filter.AccessModes {
			modes = append(modes, string(mode))
		}
		query = query.Where(contentitem.AccessModeIn(modes...))
	}

	// Newest first is the default; "oldest" is the same listing read backwards. The
	// page boundary has to follow the ordering, otherwise the second page of an
	// ascending listing would jump back to the items the caller already has.
	descending := filter.Sort != content.SortOldest

	if !filter.After.IsZero() {
		boundary, parseErr := time.Parse(time.RFC3339Nano, filter.After.Key)
		if parseErr != nil {
			return nil, content.ErrInvalidInput
		}
		if descending {
			query = query.Where(contentitem.Or(
				contentitem.CreatedAtLT(boundary),
				contentitem.And(contentitem.CreatedAtEQ(boundary), contentitem.IDLT(filter.After.ID)),
			))
		} else {
			query = query.Where(contentitem.Or(
				contentitem.CreatedAtGT(boundary),
				contentitem.And(contentitem.CreatedAtEQ(boundary), contentitem.IDGT(filter.After.ID)),
			))
		}
	}

	order := []contentitem.OrderOption{
		entgen.Desc(contentitem.FieldCreatedAt),
		entgen.Desc(contentitem.FieldID),
	}
	if !descending {
		order = []contentitem.OrderOption{
			entgen.Asc(contentitem.FieldCreatedAt),
			entgen.Asc(contentitem.FieldID),
		}
	}

	rows, err := query.
		Order(order...).
		Limit(filter.Limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	items := make([]content.Content, 0, len(rows))
	for _, row := range rows {
		items = append(items, toContent(row))
	}
	return items, nil
}

// Transition applies a status change only when the stored status still matches from.
//
// The conditional update is the concurrency guard: two moderators acting on stale
// reads cannot both win, and the loser sees ErrInvalidTransition rather than silently
// overwriting the other decision.
func (s *Store) Transition(
	ctx context.Context,
	item content.Content,
	from content.Status,
	audit site.AuditEntry,
) (content.Content, error) {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return content.Content{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	update := tx.ContentItem.Update().
		Where(
			contentitem.IDEQ(item.ID),
			contentitem.SiteIDEQ(item.SiteID),
			contentitem.StatusEQ(string(from)),
			contentitem.RevisionEQ(item.Revision),
		).
		SetStatus(string(item.Status)).
		SetUpdatedAt(item.UpdatedAt)

	if item.PublishedAt != nil {
		update.SetPublishedAt(*item.PublishedAt)
	} else {
		update.ClearPublishedAt()
	}
	if item.ArchivedAt != nil {
		update.SetArchivedAt(*item.ArchivedAt)
	} else {
		update.ClearArchivedAt()
	}
	if item.PublishAt != nil {
		update.SetPublishAt(*item.PublishAt)
	} else {
		update.ClearPublishAt()
	}
	update.SetPublishAttempts(item.PublishAttempts)

	affected, err := update.Save(ctx)
	if err != nil {
		return content.Content{}, err
	}
	if affected == 0 {
		return content.Content{}, content.ErrInvalidTransition
	}

	if err := insertAudit(ctx, tx.Client(), audit, item.Kind, item.ID); err != nil {
		return content.Content{}, err
	}
	if err := tx.Commit(); err != nil {
		return content.Content{}, err
	}
	committed = true
	s.indexContent(ctx, item)

	updated, err := s.client.ContentItem.Get(ctx, item.ID)
	if err != nil {
		return content.Content{}, err
	}
	return toContent(updated), nil
}

// ListRevisions returns the newest snapshots of one item, newest first.
//
// The history is bounded by the service's retention, so the limit is applied at
// the query instead of reading every row ever written.
func (s *Store) ListRevisions(ctx context.Context, siteID, contentID string, limit int) ([]content.Revision, error) {
	rows, err := s.client.ContentRevision.Query().
		Where(
			contentrevision.SiteIDEQ(siteID),
			contentrevision.ContentIDEQ(contentID),
		).
		Order(entgen.Desc(contentrevision.FieldVersion)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	revisions := make([]content.Revision, 0, len(rows))
	for _, row := range rows {
		revisions = append(revisions, toRevision(row))
	}
	if err := s.attachEditorNames(ctx, revisions); err != nil {
		return nil, err
	}
	return revisions, nil
}

// FindRevision loads one snapshot inside a site and content scope.
func (s *Store) FindRevision(ctx context.Context, siteID, contentID, revisionID string) (content.Revision, error) {
	row, err := s.client.ContentRevision.Query().
		Where(
			contentrevision.IDEQ(revisionID),
			contentrevision.SiteIDEQ(siteID),
			contentrevision.ContentIDEQ(contentID),
		).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return content.Revision{}, content.ErrNotFound
		}
		return content.Revision{}, err
	}
	revision := toRevision(row)
	names, err := s.editorNames(ctx, []string{revision.EditorID})
	if err != nil {
		return content.Revision{}, err
	}
	revision.EditorName = names[revision.EditorID]
	return revision, nil
}

// RestoreRevision rolls an item back to target content.
//
// The current state is written as a rollback_backup snapshot before the update, so
// the rollback itself can be undone. The restored state then becomes the newest
// snapshot. The conditional update on the read revision and the unique
// (content_id, version) index are the two guards against two editors restoring
// over each other.
func (s *Store) RestoreRevision(
	ctx context.Context,
	item content.Content,
	backup content.Revision,
	audit site.AuditEntry,
) (content.Content, error) {
	fromRevision := item.Revision

	tx, err := s.client.Tx(ctx)
	if err != nil {
		return content.Content{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	update := tx.ContentItem.Update().
		Where(
			contentitem.IDEQ(item.ID),
			contentitem.SiteIDEQ(item.SiteID),
			contentitem.RevisionEQ(fromRevision),
		).
		SetTitle(item.Title).
		SetSlug(item.Slug).
		SetSummary(item.Summary).
		SetSourceFormat(string(item.SourceFormat)).
		SetSourceBody(item.SourceBody).
		SetRenderedHTML(item.RenderedHTML).
		SetPolicyVersion(item.PolicyVersion).
		SetTags(content.EncodeTags(item.Tags)).
		SetStatus(string(item.Status)).
		SetRevision(fromRevision + 2).
		SetUpdatedAt(item.UpdatedAt)
	if item.CategoryID != "" {
		update.SetCategoryID(item.CategoryID)
	} else {
		update.ClearCategoryID()
	}

	affected, err := update.Save(ctx)
	if err != nil {
		return content.Content{}, err
	}
	if affected == 0 {
		return content.Content{}, writeFailure(ctx, tx.Client(), item.SiteID, item.ID)
	}

	// The backup is the pre-restore state; the restored row is the post-restore
	// state. Both are written in the same transaction as the item update.
	backup.Version = fromRevision + 1
	if err := insertRevision(ctx, tx.Client(), backup); err != nil {
		return content.Content{}, err
	}
	stored := item
	stored.Revision = fromRevision + 2
	if err := insertRevision(ctx, tx.Client(), stored.Snapshot(
		stored.Revision, audit.ActorID, content.RevisionRollback, item.UpdatedAt,
	)); err != nil {
		return content.Content{}, err
	}

	if err := insertAudit(ctx, tx.Client(), audit, item.Kind, item.ID); err != nil {
		return content.Content{}, err
	}
	if err := tx.Commit(); err != nil {
		return content.Content{}, err
	}
	committed = true
	s.indexContent(ctx, stored)

	updated, err := s.client.ContentItem.Get(ctx, item.ID)
	if err != nil {
		return content.Content{}, err
	}
	return toContent(updated), nil
}

// writeFailure distinguishes a missing item from a revision conflict after a
// conditional write affected no rows.
//
// The check must run on the transaction's client: on SQLite a second connection
// would block behind the write lock the failed update still holds.
func writeFailure(ctx context.Context, client *entgen.Client, siteID, contentID string) error {
	exists, err := client.ContentItem.Query().
		Where(contentitem.IDEQ(contentID), contentitem.SiteIDEQ(siteID)).
		Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return content.ErrNotFound
	}
	return content.ErrConflict
}

// attachEditorNames fills the display names of the snapshot editors in one query.
func (s *Store) attachEditorNames(ctx context.Context, revisions []content.Revision) error {
	if len(revisions) == 0 {
		return nil
	}
	ids := make([]string, 0, len(revisions))
	seen := make(map[string]struct{}, len(revisions))
	for _, revision := range revisions {
		if revision.EditorID == "" {
			continue
		}
		if _, ok := seen[revision.EditorID]; ok {
			continue
		}
		seen[revision.EditorID] = struct{}{}
		ids = append(ids, revision.EditorID)
	}
	names, err := s.editorNames(ctx, ids)
	if err != nil {
		return err
	}
	for i := range revisions {
		revisions[i].EditorName = names[revisions[i].EditorID]
	}
	return nil
}

// editorNames resolves the display name of each editor, ignoring accounts that no
// longer exist: history must stay readable after an editor is removed.
func (s *Store) editorNames(ctx context.Context, ids []string) (map[string]string, error) {
	names := make(map[string]string, len(ids))
	if len(ids) == 0 {
		return names, nil
	}
	rows, err := s.client.User.Query().Where(user.IDIn(ids...)).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		names[row.ID] = row.DisplayName
	}
	return names, nil
}

// Active draft states: every state before publication counts against the author's
// quota, including rejected and security-checked rows, otherwise a client could park
// storage in a state the quota does not count.
var activeDraftStatuses = []string{
	string(content.StatusDraft),
	string(content.StatusPendingReview),
	string(content.StatusRejected),
	string(content.StatusPendingSecurityCheck),
}

// CountActiveDraftsByAuthor counts the items of one author that have not been
// published or archived. It backs the per-account draft quota.
func (s *Store) CountActiveDraftsByAuthor(ctx context.Context, siteID, authorID string) (int, error) {
	if siteID == "" || authorID == "" {
		return 0, nil
	}
	return s.client.ContentItem.Query().
		Where(
			contentitem.SiteIDEQ(siteID),
			contentitem.AuthorIDEQ(authorID),
			contentitem.StatusIn(activeDraftStatuses...),
		).
		Count(ctx)
}

// SumActiveDraftBytesByAuthor sums len(source_body) over the same rows.
//
// The limit is about stored bytes, not runes, so len() is the right measure here even
// though the per-item cap counts runes.
func (s *Store) SumActiveDraftBytesByAuthor(ctx context.Context, siteID, authorID string) (int64, error) {
	if siteID == "" || authorID == "" {
		return 0, nil
	}
	rows, err := s.client.ContentItem.Query().
		Where(
			contentitem.SiteIDEQ(siteID),
			contentitem.AuthorIDEQ(authorID),
			contentitem.StatusIn(activeDraftStatuses...),
		).
		Select(contentitem.FieldSourceBody).
		All(ctx)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, row := range rows {
		total += int64(len(row.SourceBody))
	}
	return total, nil
}

// PublishedAssetReference reports whether any published item of the site mentions the
// asset id in its source or rendered HTML.
//
// Media uses it to decide whether an anonymous reader may fetch a content asset: an
// image from a draft must stay private, while the same image in a published article is
// part of the public page. The match is a substring on the stored bodies, which is safe
// for asset ids (opaque ULIDs, no LIKE wildcards) and cheap enough because the media
// read path only calls it for non-owners.
func (s *Store) PublishedAssetReference(ctx context.Context, siteID, assetID string) (bool, error) {
	if siteID == "" || assetID == "" {
		return false, nil
	}
	return s.client.ContentItem.Query().
		Where(
			contentitem.SiteIDEQ(siteID),
			contentitem.StatusEQ(string(content.StatusPublished)),
			// An image referenced only by a password or members-only item is not a
			// public asset either.
			contentitem.AccessModeEQ(string(content.AccessPublic)),
			contentitem.Or(
				contentitem.RenderedHTMLContains(assetID),
				contentitem.SourceBodyContains(assetID),
			),
		).
		Exist(ctx)
}

// DueSchedules returns drafts whose publish_at is due, oldest first.//
// The scheduler promotes them with a conditional transition, so a second replica
// that reads the same rows cannot publish them again.
func (s *Store) DueSchedules(ctx context.Context, now time.Time, limit int) ([]content.Content, error) {
	if limit <= 0 {
		return nil, nil
	}
	rows, err := s.client.ContentItem.Query().
		Where(
			contentitem.StatusEQ(string(content.StatusDraft)),
			contentitem.PublishAtNotNil(),
			contentitem.PublishAtLTE(now),
		).
		Order(entgen.Asc(contentitem.FieldPublishAt)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]content.Content, 0, len(rows))
	for _, row := range rows {
		items = append(items, toContent(row))
	}
	return items, nil
}

// RecordScheduleFailure stores the failed attempt count of a scheduled draft and,
// when cancel is set, clears the schedule so the item stops being retried.
func (s *Store) RecordScheduleFailure(
	ctx context.Context,
	siteID, contentID string,
	attempts int,
	cancel bool,
	audit site.AuditEntry,
) error {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	update := tx.ContentItem.Update().
		Where(
			contentitem.IDEQ(contentID),
			contentitem.SiteIDEQ(siteID),
			contentitem.StatusEQ(string(content.StatusDraft)),
		).
		SetPublishAttempts(attempts)
	if cancel {
		update.ClearPublishAt()
	}
	if _, err := update.Save(ctx); err != nil {
		return err
	}
	row, err := tx.ContentItem.Query().
		Where(contentitem.IDEQ(contentID), contentitem.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		return err
	}
	if err := insertAudit(ctx, tx.Client(), audit, content.Kind(row.Kind), contentID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// IncrementViewCount adds one to the read counter of a published item.
//
// It is a single incrementing UPDATE scoped by site, id and status: no row is read
// first, so two concurrent readers cannot lose each other's increment and a reader
// can never overwrite an editor's save with a stale copy of the row. The status guard
// keeps a direct link to a draft or archived item from inflating the public number.
func (s *Store) IncrementViewCount(ctx context.Context, siteID, contentID string) error {
	if siteID == "" || contentID == "" {
		return nil
	}
	return s.client.ContentItem.Update().
		Where(
			contentitem.IDEQ(contentID),
			contentitem.SiteIDEQ(siteID),
			contentitem.StatusEQ(string(content.StatusPublished)),
		).
		AddViewCount(1).
		Exec(ctx)
}

// Popular returns leaderboard candidates ordered by raw view count.
//
// The visibility rule is fixed here instead of being taken from the caller: only
// published public items compete, because a password or members-only item on a
// leaderboard would be the exact disclosure C-18 exists to prevent. The time decay
// is applied by the service to this short list, so the query stays a portable
// ORDER BY on a column and needs no per-dialect arithmetic.
func (s *Store) Popular(ctx context.Context, filter content.PopularFilter) ([]content.Content, error) {
	if filter.Limit <= 0 {
		return nil, nil
	}

	query := s.client.ContentItem.Query().Where(
		contentitem.SiteIDEQ(filter.SiteID),
		contentitem.StatusEQ(string(content.StatusPublished)),
		contentitem.AccessModeEQ(string(content.AccessPublic)),
	)
	if filter.Kind != "" {
		query = query.Where(contentitem.KindEQ(string(filter.Kind)))
	}
	if filter.CategoryID != "" {
		query = query.Where(contentitem.CategoryIDEQ(filter.CategoryID))
	}
	if filter.Tag != "" {
		// Same quoted token match as the listing: the column is a JSON array of
		// names, and NormalizeTag keeps the value from escaping the token.
		query = query.Where(contentitem.TagsContains(`"` + filter.Tag + `"`))
	}
	if !filter.PublishedSince.IsZero() {
		query = query.Where(contentitem.PublishedAtGTE(filter.PublishedSince))
	}

	rows, err := query.
		Order(
			entgen.Desc(contentitem.FieldViewCount),
			entgen.Desc(contentitem.FieldPublishedAt),
			entgen.Asc(contentitem.FieldID),
		).
		Limit(filter.Limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	items := make([]content.Content, 0, len(rows))
	for _, row := range rows {
		items = append(items, toContent(row))
	}
	return items, nil
}

// insertRevision appends one snapshot and trims the history to the retention bound.
func insertRevision(ctx context.Context, client *entgen.Client, revision content.Revision) error {
	at := revision.CreatedAt
	if at.IsZero() {
		at = time.Now().UTC()
	}

	builder := client.ContentRevision.Create().
		SetSiteID(revision.SiteID).
		SetContentID(revision.ContentID).
		SetVersion(revision.Version).
		SetEditorID(revision.EditorID).
		SetAction(string(revision.Action)).
		SetStatus(string(revision.Status)).
		SetTitle(revision.Title).
		SetSlug(revision.Slug).
		SetSummary(revision.Summary).
		SetSourceFormat(string(revision.SourceFormat)).
		SetSourceBody(revision.SourceBody).
		SetRenderedHTML(revision.RenderedHTML).
		SetPolicyVersion(revision.PolicyVersion).
		SetTags(content.EncodeTags(revision.Tags)).
		SetCreatedAt(at)
	if revision.CategoryID != "" {
		builder.SetCategoryID(revision.CategoryID)
	}

	if _, err := builder.Save(ctx); err != nil {
		return err
	}
	return trimRevisions(ctx, client, revision.ContentID)
}

// trimRevisions keeps only the newest content.RevisionRetention snapshots.
//
// The rows are read by version and the surplus is deleted by id: an OFFSET only
// query is not portable across the three supported dialects.
func trimRevisions(ctx context.Context, client *entgen.Client, contentID string) error {
	ids, err := client.ContentRevision.Query().
		Where(contentrevision.ContentIDEQ(contentID)).
		Order(entgen.Desc(contentrevision.FieldVersion)).
		IDs(ctx)
	if err != nil {
		return err
	}
	if len(ids) <= content.RevisionRetention {
		return nil
	}
	_, err = client.ContentRevision.Delete().
		Where(contentrevision.IDIn(ids[content.RevisionRetention:]...)).
		Exec(ctx)
	return err
}

func insertAudit(ctx context.Context, client *entgen.Client, entry site.AuditEntry, kind content.Kind, contentID string) error {
	at := entry.At
	if at.IsZero() {
		at = time.Now().UTC()
	}

	builder := client.AuditLog.Create().
		SetAction(entry.Action).
		SetTargetType(string(kind)).
		SetTargetID(contentID).
		SetCreatedAt(at)

	if entry.SiteID != "" {
		builder.SetSiteID(entry.SiteID)
	}
	if entry.ActorID != "" {
		builder.SetActorID(entry.ActorID)
	}
	if entry.RequestID != "" {
		builder.SetRequestID(entry.RequestID)
	}
	if entry.Detail != nil {
		builder.SetDetail(entry.Detail)
	}

	_, err := builder.Save(ctx)
	return err
}

func toContent(row *entgen.ContentItem) content.Content {
	item := content.Content{
		ID:              row.ID,
		SiteID:          row.SiteID,
		AuthorID:        row.AuthorID,
		Kind:            content.Kind(row.Kind),
		Status:          content.Status(row.Status),
		Title:           row.Title,
		Slug:            row.Slug,
		Summary:         row.Summary,
		SourceFormat:    content.SourceFormat(row.SourceFormat),
		SourceBody:      row.SourceBody,
		RenderedHTML:    row.RenderedHTML,
		PolicyVersion:   row.PolicyVersion,
		Tags:            content.DecodeTags(row.Tags),
		PublishedAt:     row.PublishedAt,
		ArchivedAt:      row.ArchivedAt,
		PublishAt:       row.PublishAt,
		AccessMode:      content.AccessMode(row.AccessMode),
		CommentPolicy:   content.CommentPolicy(row.CommentPolicy),
		ViewCount:       row.ViewCount,
		CreatedAt:       row.CreatedAt,
		UpdatedAt:       row.UpdatedAt,
		Revision:        row.Revision,
		PublishAttempts: row.PublishAttempts,
	}
	if row.CategoryID != nil {
		item.CategoryID = *row.CategoryID
	}
	if row.AccessPasswordHash != nil {
		item.AccessPasswordHash = *row.AccessPasswordHash
	}
	return item
}

func toRevision(row *entgen.ContentRevision) content.Revision {
	revision := content.Revision{
		ID:            row.ID,
		SiteID:        row.SiteID,
		ContentID:     row.ContentID,
		Version:       row.Version,
		EditorID:      row.EditorID,
		Action:        content.RevisionAction(row.Action),
		Status:        content.Status(row.Status),
		Title:         row.Title,
		Slug:          row.Slug,
		Summary:       row.Summary,
		SourceFormat:  content.SourceFormat(row.SourceFormat),
		SourceBody:    row.SourceBody,
		RenderedHTML:  row.RenderedHTML,
		PolicyVersion: row.PolicyVersion,
		Tags:          content.DecodeTags(row.Tags),
		CreatedAt:     row.CreatedAt,
	}
	if row.CategoryID != nil {
		revision.CategoryID = *row.CategoryID
	}
	return revision
}
