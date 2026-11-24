package contentstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/practacu/practacu-press/internal/content"
	entgen "github.com/practacu/practacu-press/internal/ent"
	"github.com/practacu/practacu-press/internal/ent/contentitem"
	"github.com/practacu/practacu-press/internal/platform/page"
)

// searchDialect names the indexed search implementation of one database.
type searchDialect string

const (
	searchSQLite   searchDialect = "sqlite"
	searchMySQL    searchDialect = "mysql"
	searchPostgres searchDialect = "postgres"
)

// cursorPrefixSearch and cursorPrefixLike tag a page boundary with the mode that
// produced it. A boundary from the full text index cannot be applied to the LIKE
// fallback (and vice versa), so a mode switch is a clean 400 instead of a
// silently wrong page.
const (
	cursorPrefixSearch = "s:"
	cursorPrefixLike   = "t:"
)

// searchState memoizes whether this process could create or find the full text
// index. A schema failure or a failed index write degrades search to LIKE for
// the rest of the process: a stale index must never win over correctness, and
// the diagnostics command reports the cause.
type searchState struct {
	mu      sync.Mutex
	ready   bool
	broken  bool
	lastErr error
}

// SearchDialect reports the dialect used for indexed search.
func (s *Store) SearchDialect() string {
	return string(s.searchDialect())
}

func (s *Store) searchDialect() searchDialect {
	switch s.searchDriver {
	case "mysql":
		return searchMySQL
	case "postgres":
		return searchPostgres
	default:
		return searchSQLite
	}
}

// ensureSearch creates the portable table and the dialect specific index when
// they are missing, then memoizes the answer.
//
// Production applies the reviewed migration; this lazy fallback exists because
// `cmd/server migrate` and the integration tests create the Ent schema only, and a
// developer database must still get working search. If the handle or dialect
// cannot provide full text search the caller uses the LIKE path instead.
func (s *Store) ensureSearch(ctx context.Context) bool {
	s.search.mu.Lock()
	defer s.search.mu.Unlock()

	if s.search.ready {
		return true
	}
	if s.search.broken {
		return false
	}
	if s.searchDB == nil {
		s.search.broken = true
		s.search.lastErr = errors.New("contentstore: search requires the raw database handle")
		return false
	}

	for _, statement := range searchSchemaStatements(s.searchDialect()) {
		if _, err := s.searchDB.ExecContext(ctx, statement); err != nil {
			s.search.broken = true
			s.search.lastErr = fmt.Errorf("contentstore: search index schema: %w", err)
			return false
		}
	}
	s.search.ready = true
	s.search.lastErr = nil
	return true
}

// disableSearch stops using the index after a write/query failure.
func (s *Store) disableSearch(err error) {
	s.search.mu.Lock()
	defer s.search.mu.Unlock()
	s.search.ready = false
	s.search.broken = true
	if err != nil {
		s.search.lastErr = err
	}
}

func (s *Store) searchError() error {
	s.search.mu.Lock()
	defer s.search.mu.Unlock()
	return s.search.lastErr
}

// indexContent upserts one item into the full text index.
//
// The write deliberately runs after the item transaction commits, not inside
// it: Ent's generated client hides the transaction driver, and the alternative
// would be reaching into unexported state. The trade-off is a short window in
// which a concurrent search can read the previous indexed text. A failed index
// write flips the process to the LIKE fallback, so search never serves an
// index this process knows to be unreliable. The reviewed migration plus the
// searchindex rebuild command are the repair path.
func (s *Store) indexContent(ctx context.Context, item content.Content) {
	if s.searchDB == nil {
		return
	}
	// Finish the index write even if the request that triggered it is canceled.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()

	if !s.ensureSearch(writeCtx) {
		return
	}

	dialect := s.searchDialect()
	plainBody := content.PlainText(item.RenderedHTML, item.SourceBody, item.SourceFormat)
	rawTitle, rawSummary, rawBody := "", "", ""
	if dialect == searchMySQL {
		// MySQL's ngram parser indexes the readable text directly; the other
		// engines consume the space separated token stream instead.
		rawTitle, rawSummary, rawBody = item.Title, item.Summary, plainBody
	}

	accessMode := string(item.AccessMode)
	if accessMode == "" {
		accessMode = string(content.AccessPublic)
	}

	args := []any{
		item.ID,
		item.SiteID,
		string(item.Kind),
		string(item.Status),
		accessMode,
		item.AuthorID,
		item.CategoryID,
		content.EncodeTags(item.Tags),
		unixNano(item.CreatedAt),
		rawTitle,
		rawSummary,
		rawBody,
		content.SearchTokenizedText(item.Title),
		content.SearchTokenizedText(item.Summary),
		content.SearchTokenizedText(plainBody),
	}

	if _, err := s.searchDB.ExecContext(writeCtx, s.upsertSearchSQL(), args...); err != nil {
		s.disableSearch(fmt.Errorf("contentstore: index content %s: %w", item.ID, err))
		return
	}

	if dialect != searchSQLite {
		return
	}

	// SQLite keeps the base row and the FTS5 virtual table in sync explicitly.
	// Triggers would put the same statements inside the migration files, but a
	// trigger body contains semicolons and the reviewed migration runner splits
	// scripts on semicolons; two statements are simpler and keep the migration
	// files single-statement.
	if _, err := s.searchDB.ExecContext(writeCtx,
		"DELETE FROM content_search_fts WHERE rowid = (SELECT rowid FROM content_search WHERE content_id = ?)",
		item.ID,
	); err != nil {
		s.disableSearch(fmt.Errorf("contentstore: clear search index %s: %w", item.ID, err))
		return
	}
	if _, err := s.searchDB.ExecContext(writeCtx,
		`INSERT INTO content_search_fts (rowid, content_id, tokens_title, tokens_summary, tokens_body)
		 SELECT rowid, content_id, tokens_title, tokens_summary, tokens_body
		 FROM content_search WHERE content_id = ?`,
		item.ID,
	); err != nil {
		s.disableSearch(fmt.Errorf("contentstore: write search index %s: %w", item.ID, err))
	}
}

func unixNano(at time.Time) int64 {
	if at.IsZero() {
		return 0
	}
	return at.UTC().UnixNano()
}

// removeIndexedContent deletes the index rows of one content item.
//
// It is the exact counterpart of indexContent, including the timing: the caller runs
// it after the item transaction commits, because the index is written through the raw
// pool and Ent's transaction does not expose its driver. Both index flavours are
// cleared, since a stale row would either resurrect a purged item (SQLite joins the
// FTS table) or keep it matchable.
func (s *Store) removeIndexedContent(ctx context.Context, contentID string) {
	if s.searchDB == nil || contentID == "" {
		return
	}
	// Finish the cleanup even if the request that triggered it is canceled.
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()

	if !s.ensureSearch(writeCtx) {
		return
	}

	if _, err := s.searchDB.ExecContext(writeCtx,
		"DELETE FROM content_search WHERE content_id = ?", contentID,
	); err != nil {
		s.disableSearch(fmt.Errorf("contentstore: clear search index %s: %w", contentID, err))
		return
	}
	if s.searchDialect() != searchSQLite {
		return
	}
	// The FTS5 table is keyed by rowid, so it is cleared by content id rather than by
	// the base row that no longer exists.
	if _, err := s.searchDB.ExecContext(writeCtx,
		"DELETE FROM content_search_fts WHERE content_id = ?", contentID,
	); err != nil {
		s.disableSearch(fmt.Errorf("contentstore: clear search index %s: %w", contentID, err))
	}
}

// Search returns one relevance ordered page of published public items.
func (s *Store) Search(ctx context.Context, filter content.SearchFilter) (content.SearchPage, error) {
	if filter.Limit <= 0 {
		filter.Limit = content.DefaultSearchLimit
	}
	if !content.SearchHasTokens(filter.Term) {
		return content.SearchPage{Items: []content.Content{}, Total: 0}, nil
	}
	if !s.ensureSearch(ctx) {
		return s.searchLike(ctx, filter)
	}

	result, err := s.searchIndexed(ctx, filter)
	if err == nil {
		return result, nil
	}
	if errors.Is(err, page.ErrInvalidCursor) {
		return content.SearchPage{}, err
	}
	// The index is a derived read model. A failure degrades to the portable
	// LIKE path rather than failing the search endpoint.
	s.disableSearch(err)
	return s.searchLike(ctx, filter)
}

type searchHit struct {
	id   string
	rank float64
}

func (s *Store) searchIndexed(ctx context.Context, filter content.SearchFilter) (content.SearchPage, error) {
	builder := &searchArgs{dialect: s.searchDialect()}
	inner := s.indexedSearchSQL(builder, filter)

	// The count must not carry the cursor or the page limit, so snapshot the
	// arguments before the outer page query adds them.
	countArgs := append([]any(nil), builder.args...)
	total, err := scalarInt(ctx, s.searchDB,
		"SELECT COUNT(*) FROM ("+inner+") AS ranked", countArgs...)
	if err != nil {
		return content.SearchPage{}, err
	}

	// The score alias is not called rank: MySQL reserves that word for the window
	// function, so an unquoted alias would only fail on MySQL 8.
	query := "SELECT content_id, search_score FROM (" + inner + ") AS ranked"
	if !filter.After.IsZero() {
		score, parseErr := decodeSearchCursor(filter.After.Key)
		if parseErr != nil {
			return content.SearchPage{}, parseErr
		}
		query += " WHERE (search_score < " + builder.add(score) +
			" OR (search_score = " + builder.add(score) +
			" AND content_id > " + builder.add(filter.After.ID) + "))"
	}
	query += " ORDER BY search_score DESC, content_id ASC LIMIT " + builder.add(filter.Limit+1)

	rows, err := s.searchDB.QueryContext(ctx, query, builder.args...)
	if err != nil {
		return content.SearchPage{}, err
	}
	hits := make([]searchHit, 0, filter.Limit+1)
	for rows.Next() {
		var hit searchHit
		if err := rows.Scan(&hit.id, &hit.rank); err != nil {
			rows.Close()
			return content.SearchPage{}, err
		}
		hits = append(hits, hit)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return content.SearchPage{}, err
	}
	rows.Close()

	next := ""
	if len(hits) > filter.Limit {
		hits = hits[:filter.Limit]
		last := hits[len(hits)-1]
		next = page.Cursor{Key: encodeSearchCursor(last.rank), ID: last.id}.Encode()
	}

	items, err := s.contentBySearchHits(ctx, filter.SiteID, hits)
	if err != nil {
		return content.SearchPage{}, err
	}
	return content.SearchPage{Items: items, Total: total, NextCursor: next}, nil
}

func scalarInt(ctx context.Context, db *sql.DB, query string, args ...any) (int, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return 0, err
		}
		return 0, nil
	}
	var value int
	if err := rows.Scan(&value); err != nil {
		return 0, err
	}
	return value, rows.Err()
}

func (s *Store) contentBySearchHits(
	ctx context.Context,
	siteID string,
	hits []searchHit,
) ([]content.Content, error) {
	items := make([]content.Content, 0, len(hits))
	if len(hits) == 0 {
		return items, nil
	}

	ids := make([]string, 0, len(hits))
	for _, hit := range hits {
		ids = append(ids, hit.id)
	}
	rows, err := s.client.ContentItem.Query().
		Where(
			contentitem.IDIn(ids...),
			contentitem.SiteIDEQ(siteID),
			// An item trashed between the index read and this reload is dropped here,
			// which closes the window the derived index cannot close.
			contentitem.DeletedAtIsNil(),
		).
		All(ctx)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]content.Content, len(rows))
	for _, row := range rows {
		byID[row.ID] = toContent(row)
	}
	for _, hit := range hits {
		if item, ok := byID[hit.id]; ok {
			items = append(items, item)
		}
	}
	return items, nil
}

// searchArgs builds one statement's placeholders and arguments for the active
// dialect. PostgreSQL numbers placeholders; SQLite and MySQL use `?`.
type searchArgs struct {
	dialect searchDialect
	args    []any
}

func (b *searchArgs) add(value any) string {
	b.args = append(b.args, value)
	if b.dialect == searchPostgres {
		return "$" + strconv.Itoa(len(b.args))
	}
	return "?"
}

func (s *Store) indexedSearchSQL(builder *searchArgs, filter content.SearchFilter) string {
	switch builder.dialect {
	case searchMySQL:
		// ngram is a bigram parser, so a phrase search is expressed by quoting the
		// raw term inside a boolean-mode value: the parser turns it into the same
		// bigrams it indexed. Quoting also makes operators (+, -, *, ") literal.
		phrase := mysqlPhrase(filter.Term)
		score := builder.add(phrase)
		match := builder.add(phrase)
		clauses := []string{
			"MATCH(search_title, search_summary, search_body) AGAINST (" + match + " IN BOOLEAN MODE)",
			"site_id = " + builder.add(filter.SiteID),
			"status = " + builder.add(string(content.StatusPublished)),
			"access_mode = " + builder.add(string(content.AccessPublic)),
			// The index is derived data: a row whose content item was removed out
			// of band must not be counted or returned even before the next rebuild.
			// The same join carries the recycle bin rule, so trashing an item removes
			// it from search without touching the index and a restore puts it back.
			"EXISTS (SELECT 1 FROM content_items ci WHERE ci.id = content_search.content_id AND ci.deleted_at IS NULL)",
		}
		clauses = append(clauses, indexedFilterClauses(builder, "", filter)...)
		return "SELECT content_id, MATCH(search_title, search_summary, search_body) AGAINST (" +
			score + " IN BOOLEAN MODE) AS search_score FROM content_search WHERE " +
			strings.Join(clauses, " AND ")

	case searchPostgres:
		tsQuery := postgresTSQuery(filter.Term)
		score := builder.add(tsQuery)
		match := builder.add(tsQuery)
		clauses := []string{
			"search_vector @@ to_tsquery('simple', " + match + ")",
			"site_id = " + builder.add(filter.SiteID),
			"status = " + builder.add(string(content.StatusPublished)),
			"access_mode = " + builder.add(string(content.AccessPublic)),
			"EXISTS (SELECT 1 FROM content_items ci WHERE ci.id = content_search.content_id AND ci.deleted_at IS NULL)",
		}
		clauses = append(clauses, indexedFilterClauses(builder, "", filter)...)
		return "SELECT content_id, ts_rank_cd(search_vector, to_tsquery('simple', " + score +
			"), 32) AS search_score FROM content_search WHERE " + strings.Join(clauses, " AND ")

	default:
		match := builder.add(sqliteMatchQuery(filter.Term))
		clauses := []string{
			"content_search_fts MATCH " + match,
			"c.site_id = " + builder.add(filter.SiteID),
			"c.status = " + builder.add(string(content.StatusPublished)),
			"c.access_mode = " + builder.add(string(content.AccessPublic)),
			"EXISTS (SELECT 1 FROM content_items ci WHERE ci.id = c.content_id AND ci.deleted_at IS NULL)",
		}
		clauses = append(clauses, indexedFilterClauses(builder, "c.", filter)...)
		return "SELECT c.content_id AS content_id, -bm25(content_search_fts, 6.0, 3.0, 1.0) AS search_score" +
			" FROM content_search_fts JOIN content_search c ON c.rowid = content_search_fts.rowid" +
			" WHERE " + strings.Join(clauses, " AND ")
	}
}

// mysqlPhrase renders a term as one boolean-mode phrase.
//
// Inner double quotes and backslashes are stripped instead of escaped: MySQL's
// boolean parser has no escape for a phrase quote, and a term made of quotes has
// no searchable token anyway (the service answers an empty page for it).
func mysqlPhrase(term string) string {
	cleaned := strings.NewReplacer(`"`, " ", `\`, " ", "'", " ").Replace(term)
	return `"` + strings.Join(strings.Fields(cleaned), " ") + `"`
}

func indexedFilterClauses(
	builder *searchArgs,
	prefix string,
	filter content.SearchFilter,
) []string {
	clauses := make([]string, 0, 6)
	if filter.Kind != "" {
		clauses = append(clauses, prefix+"kind = "+builder.add(string(filter.Kind)))
	}
	if filter.CategoryID != "" {
		clauses = append(clauses, prefix+"category_id = "+builder.add(filter.CategoryID))
	}
	if filter.Tag != "" {
		clauses = append(clauses,
			prefix+`tags LIKE `+builder.add(tagLikePattern(filter.Tag))+` ESCAPE '!'`)
	}
	if filter.AuthorID != "" {
		clauses = append(clauses, prefix+"author_id = "+builder.add(filter.AuthorID))
	}
	if !filter.Since.IsZero() {
		clauses = append(clauses, prefix+"created_at_ns >= "+builder.add(filter.Since.UTC().UnixNano()))
	}
	if !filter.Until.IsZero() {
		clauses = append(clauses, prefix+"created_at_ns <= "+builder.add(filter.Until.UTC().UnixNano()))
	}
	return clauses
}

// tagLikePattern matches the quoted JSON token of a tag exactly, escaped with a
// portable `!` escape so a tag containing % or _ cannot widen its own filter.
func tagLikePattern(tag string) string {
	replacer := strings.NewReplacer("!", "!!", "%", "!%", "_", "!_")
	return `%"` + replacer.Replace(tag) + `"%`
}

// sqliteMatchQuery turns the term into an FTS5 expression. Tokens are produced
// by the content package, so they contain no quote or operator characters.
func sqliteMatchQuery(term string) string {
	phrases := content.SearchPhrases(term)
	parts := make([]string, 0, len(phrases))
	for _, phrase := range phrases {
		parts = append(parts, `"`+strings.Join(phrase, " ")+`"`)
	}
	return strings.Join(parts, " AND ")
}

// postgresTSQuery turns the term into a tsquery expression. CJK runes are
// adjacent lexemes, so they are joined with the phrase operator; separate words
// are ANDed.
func postgresTSQuery(term string) string {
	phrases := content.SearchPhrases(term)
	parts := make([]string, 0, len(phrases))
	for _, phrase := range phrases {
		lexemes := make([]string, 0, len(phrase))
		for _, token := range phrase {
			lexemes = append(lexemes, "'"+token+"'")
		}
		parts = append(parts, strings.Join(lexemes, " <-> "))
	}
	return strings.Join(parts, " & ")
}

func encodeSearchCursor(rank float64) string {
	return cursorPrefixSearch + strconv.FormatFloat(rank, 'g', -1, 64)
}

func decodeSearchCursor(key string) (float64, error) {
	if !strings.HasPrefix(key, cursorPrefixSearch) {
		return 0, page.ErrInvalidCursor
	}
	rank, err := strconv.ParseFloat(strings.TrimPrefix(key, cursorPrefixSearch), 64)
	if err != nil || math.IsNaN(rank) || math.IsInf(rank, 0) {
		return 0, page.ErrInvalidCursor
	}
	return rank, nil
}

// searchLike is the portable fallback used when the full text index cannot be
// created or fails at runtime. It orders by creation time instead of relevance
// and reports Degraded so the client can say so.
func (s *Store) searchLike(ctx context.Context, filter content.SearchFilter) (content.SearchPage, error) {
	query := s.client.ContentItem.Query().Where(
		contentitem.SiteIDEQ(filter.SiteID),
		contentitem.StatusEQ(string(content.StatusPublished)),
		contentitem.AccessModeEQ(string(content.AccessPublic)),
		// Search is a public reader surface, so a trashed item must be invisible even
		// though its status still says published.
		contentitem.DeletedAtIsNil(),
	)
	if filter.Kind != "" {
		query = query.Where(contentitem.KindEQ(string(filter.Kind)))
	}
	if filter.CategoryID != "" {
		query = query.Where(contentitem.CategoryIDEQ(filter.CategoryID))
	}
	if filter.AuthorID != "" {
		query = query.Where(contentitem.AuthorIDEQ(filter.AuthorID))
	}
	if filter.Tag != "" {
		query = query.Where(contentitem.TagsContains(`"` + filter.Tag + `"`))
	}
	if !filter.Since.IsZero() {
		query = query.Where(contentitem.CreatedAtGTE(filter.Since))
	}
	if !filter.Until.IsZero() {
		query = query.Where(contentitem.CreatedAtLTE(filter.Until))
	}
	query = query.Where(contentitem.Or(
		contentitem.TitleContainsFold(filter.Term),
		contentitem.SummaryContainsFold(filter.Term),
		contentitem.SourceBodyContainsFold(filter.Term),
		contentitem.RenderedHTMLContainsFold(filter.Term),
	))

	total, err := query.Clone().Count(ctx)
	if err != nil {
		return content.SearchPage{}, err
	}

	if !filter.After.IsZero() {
		if !strings.HasPrefix(filter.After.Key, cursorPrefixLike) {
			return content.SearchPage{}, page.ErrInvalidCursor
		}
		boundary, parseErr := time.Parse(time.RFC3339Nano, strings.TrimPrefix(filter.After.Key, cursorPrefixLike))
		if parseErr != nil {
			return content.SearchPage{}, page.ErrInvalidCursor
		}
		query = query.Where(contentitem.Or(
			contentitem.CreatedAtLT(boundary),
			contentitem.And(contentitem.CreatedAtEQ(boundary), contentitem.IDLT(filter.After.ID)),
		))
	}

	rows, err := query.
		Order(entgen.Desc(contentitem.FieldCreatedAt), entgen.Desc(contentitem.FieldID)).
		Limit(filter.Limit + 1).
		All(ctx)
	if err != nil {
		return content.SearchPage{}, err
	}

	next := ""
	if len(rows) > filter.Limit {
		rows = rows[:filter.Limit]
		last := rows[len(rows)-1]
		next = page.Cursor{
			Key: cursorPrefixLike + last.CreatedAt.UTC().Format(time.RFC3339Nano),
			ID:  last.ID,
		}.Encode()
	}

	items := make([]content.Content, 0, len(rows))
	for _, row := range rows {
		items = append(items, toContent(row))
	}
	return content.SearchPage{
		Items:      items,
		Total:      total,
		NextCursor: next,
		Degraded:   true,
	}, nil
}

// SearchIndexStatus reports whether the index can be used and how far it has
// drifted from the content table. It backs the searchindex diagnostics command.
type SearchIndexStatus struct {
	Dialect   string
	Available bool
	Indexed   int
	Published int
	Missing   int
	LastError string
}

// EnsureSearchIndex creates the portable table and dialect index when missing.
func (s *Store) EnsureSearchIndex(ctx context.Context) error {
	if s.ensureSearch(ctx) {
		return nil
	}
	if err := s.searchError(); err != nil {
		return err
	}
	return fmt.Errorf("contentstore: full text index is unavailable for %s", s.searchDialect())
}

// SearchIndexStatus reads the current index size and any missing rows.
func (s *Store) SearchIndexStatus(ctx context.Context) (SearchIndexStatus, error) {
	status := SearchIndexStatus{Dialect: string(s.searchDialect())}
	if !s.ensureSearch(ctx) {
		status.LastError = errorString(s.searchError())
		return status, nil
	}
	status.Available = true

	indexed, err := scalarInt(ctx, s.searchDB, "SELECT COUNT(*) FROM content_search")
	if err != nil {
		return status, err
	}
	status.Indexed = indexed

	published, err := s.client.ContentItem.Query().
		Where(
			contentitem.StatusEQ(string(content.StatusPublished)),
			contentitem.AccessModeEQ(string(content.AccessPublic)),
			// Trashed rows stay indexed on purpose (a restore makes them matchable
			// again), but they are not searchable, so they must not be counted as
			// expected index rows here either.
			contentitem.DeletedAtIsNil(),
		).
		Count(ctx)
	if err != nil {
		return status, err
	}
	status.Published = published

	missing, err := scalarInt(ctx, s.searchDB,
		`SELECT COUNT(*) FROM content_items ci
		 WHERE ci.status = 'published' AND ci.access_mode = 'public'
		 AND ci.deleted_at IS NULL
		 AND NOT EXISTS (SELECT 1 FROM content_search cs WHERE cs.content_id = ci.id)`)
	if err != nil {
		return status, err
	}
	status.Missing = missing
	return status, nil
}

// RebuildSearchIndex truncates the index and re-derives it from content_items.
//
// It is the migration backfill: applying the reviewed SQL creates the table but
// cannot index rows that existed before it, so an operator runs this command
// once after the change set.
//
// A rebuild is not transactional, on purpose: holding one transaction over every
// content row would block writers for the length of the table. A search that runs
// while it is in progress can therefore see fewer results than the table holds
// (never more, and never a wrong item), and the last re-indexed row wins. Run it
// in a maintenance window, and run it again after an interruption: it is
// idempotent, so the second pass repairs whatever the first one missed.
func (s *Store) RebuildSearchIndex(ctx context.Context) (SearchIndexStatus, error) {
	if err := s.EnsureSearchIndex(ctx); err != nil {
		return SearchIndexStatus{Dialect: string(s.searchDialect()), LastError: err.Error()}, err
	}

	if s.searchDialect() == searchSQLite {
		if _, err := s.searchDB.ExecContext(ctx, "DELETE FROM content_search_fts"); err != nil {
			s.disableSearch(err)
			return SearchIndexStatus{}, err
		}
	}
	if _, err := s.searchDB.ExecContext(ctx, "DELETE FROM content_search"); err != nil {
		s.disableSearch(err)
		return SearchIndexStatus{}, err
	}

	const batchSize = 200
	lastID := ""
	indexed := 0
	for {
		query := s.client.ContentItem.Query().
			Order(entgen.Asc(contentitem.FieldID)).
			Limit(batchSize)
		if lastID != "" {
			query = query.Where(contentitem.IDGT(lastID))
		}
		rows, err := query.All(ctx)
		if err != nil {
			return SearchIndexStatus{}, err
		}
		if len(rows) == 0 {
			break
		}
		for _, row := range rows {
			s.indexContent(ctx, toContent(row))
			indexed++
		}
		lastID = rows[len(rows)-1].ID
		if len(rows) < batchSize {
			break
		}
	}

	status, err := s.SearchIndexStatus(ctx)
	if err != nil {
		return status, err
	}
	if status.Indexed < indexed {
		status.Indexed = indexed
	}
	return status, nil
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
