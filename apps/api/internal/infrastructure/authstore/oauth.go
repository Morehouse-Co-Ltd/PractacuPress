package authstore

// Third party login persistence (FSD F-04).
//
// The two ports below are the database side of the OAuth flow. The decisions that
// make the flow safe (which provider profile may claim which account, whether a
// state may still be redeemed) stay in internal/auth; this file only writes rows
// and reports what it found, so the rules remain testable without a database.
//
// The account half is Ent, like the rest of this package: users and
// user_identities have entities, so the methods belong on Store and reuse the
// same client as login, sessions and two-factor.
//
// The state half is the exception. oauth_states has no Ent entity: it is a short
// lived queue that is written once, read by primary key once, and swept by
// expiry, so an entity would buy nothing but generated code. It is written with
// the raw pool instead, the same way contentstore reaches the database for its
// search index, with the dialect specific placeholder syntax confined to one
// helper.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"entgo.io/ent/dialect/sql/sqlgraph"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/site"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	entsite "github.com/practacu/practacu-press/apps/api/ent/site"
	"github.com/practacu/practacu-press/apps/api/ent/sitemember"
	entuser "github.com/practacu/practacu-press/apps/api/ent/user"
	"github.com/practacu/practacu-press/apps/api/ent/useridentity"
)

var _ auth.OAuthAccountStore = (*Store)(nil)

// oauthDisplayNameMax is the users.display_name limit. A provider profile is not
// input this layer can refuse, so a longer name is truncated instead of turning a
// login into a validation error.
const oauthDisplayNameMax = 120

// oauthPlaceholderDisplayName is the last resort for an account the provider gave
// no usable name for. It is Chinese because users.locale defaults to zh-CN.
const oauthPlaceholderDisplayName = "用户"

// FindIdentity returns the user a provider subject is bound to.
//
// "Not found" is an ordinary answer on a first login and is reported as
// found=false rather than as an error: the caller creates the account then. An
// empty provider or subject is answered the same way without touching the
// database, because both columns are non-empty, so such a key can never match a
// row and querying it would only hide a caller bug behind a round trip.
func (s *Store) FindIdentity(ctx context.Context, provider, subject string) (string, bool, error) {
	provider = strings.TrimSpace(provider)
	subject = strings.TrimSpace(subject)
	if provider == "" || subject == "" {
		return "", false, nil
	}

	row, err := s.client.UserIdentity.Query().
		Where(
			useridentity.ProviderEQ(provider),
			useridentity.ProviderSubjectEQ(subject),
		).
		Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return "", false, nil
		}
		return "", false, err
	}
	return row.UserID, true, nil
}

// FindUserByEmail returns the account that owns an address as its login address.
//
// Only an email identity counts, which is the row that login itself resolves:
// that address was chosen by the account owner when the account was created or
// the address was changed, so it identifies an account rather than describing
// one.
//
// A provider identity's email column is deliberately not consulted. It records
// the address a profile was *seen* with and, as its own comment says, is not a
// verification of anything: matching it would let whoever can type an address
// into a provider profile park an identity on it, and a later, genuinely verified
// sign-in with the same address would then be linked into that stranger's account.
// The cost of not matching it is a second account for someone who first signed in
// through a provider and later through another one with the same verified
// address, which is a nuisance the product can fix by binding the address to the
// account explicitly; the cost of matching it is an account takeover.
//
// The comparison folds case so a row written before normalisation, or by an
// address change that kept the user's casing, still resolves. Two rows may only
// differ in case when they were written by a path that skipped normalisation
// (the unique index is byte exact), so the oldest one wins and the answer stays
// deterministic.
func (s *Store) FindUserByEmail(ctx context.Context, email string) (string, bool, error) {
	address := strings.TrimSpace(email)
	if address == "" {
		return "", false, nil
	}

	row, err := s.client.UserIdentity.Query().
		Where(
			useridentity.ProviderEQ(ProviderEmail),
			useridentity.ProviderSubjectEqualFold(address),
		).
		Order(entgen.Asc(useridentity.FieldCreatedAt)).
		First(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return "", false, nil
		}
		return "", false, err
	}
	return row.UserID, true, nil
}

// CreateUser creates a bare account for a first provider sign-in, together with
// the site membership that makes it usable.
//
// The account starts unverified (users.email_verified_at stays NULL) and without
// any identity: the caller binds the provider subject with LinkIdentity, so an
// account and its login method are never written by one statement that could
// half succeed. Nothing here records the address either, because users has no
// email column at all; the address reaches the database through the identity
// LinkIdentity writes, where it is audit data.
//
// display_name is required by the schema, so an empty provider name falls back to
// the local part of the address and finally to a neutral placeholder; a name
// longer than the column is truncated. Both keep a profile with an odd name from
// failing the login, and both are deterministic, so a retried login creates the
// same row.
//
// avatarURL is accepted for the port's symmetry and is not stored: users has only
// avatar_media_id, an id of a media asset this install owns, and a provider's
// remote URL is not one. Importing the image is a media concern that runs after
// the account exists; until then the account simply has no avatar.
//
// The membership is written in the same transaction, because an account without
// one cannot sign in: the session build resolves the member's role and refuses a
// non-member as not_a_member, which is how a first provider login used to fail
// with a 403 on a site that had done nothing wrong. Creating an account is
// registration, so the site's registration switch is read first and a closed site
// answers auth.ErrRegistrationClosed without writing anything at all — the same
// rule the password registration form follows. An unknown or empty site is
// auth.ErrSiteMissing, not a silently orphaned row.
func (s *Store) CreateUser(ctx context.Context, siteID, email, displayName, avatarURL string) (string, error) {
	name := truncateToSchemaLen(strings.TrimSpace(displayName), oauthDisplayNameMax)
	if name == "" {
		name = displayNameFromEmail(email)
	}

	tx, err := s.client.Tx(ctx)
	if err != nil {
		return "", err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	created, err := tx.User.Create().
		SetDisplayName(name).
		Save(ctx)
	if err != nil {
		return "", err
	}

	// The policy is read inside this transaction and before the membership insert,
	// so a closed site leaves neither a user nor a member row behind.
	if err := createActiveMembership(ctx, tx.Site, tx.SiteMember, siteID, created.ID); err != nil {
		return "", err
	}

	if err := tx.Commit(); err != nil {
		return "", err
	}
	committed = true
	return created.ID, nil
}

// EnsureMembership makes userID an active member of siteID, if it is not one
// already.
//
// It is the idempotent half of the same rule CreateUser applies: a login that
// resolved an existing account still has to end with a membership of the site the
// session is bound to. An existing row — of any status — is left exactly as it is,
// because suspending or inviting a member is a decision of the site, not something
// a login may undo.
//
// When no row exists the site's registration switch decides: an open site adds the
// member with the default role, a closed one answers auth.ErrRegistrationClosed.
// That keeps a closed site closed even for someone who registered elsewhere and
// then arrives through a provider.
//
// The unique index on (site_id, user_id) is the arbiter for two logins racing each
// other: the loser sees a uniqueness violation and reports success, because the row
// it wanted to create now exists.
func (s *Store) EnsureMembership(ctx context.Context, siteID, userID string) error {
	siteID = strings.TrimSpace(siteID)
	userID = strings.TrimSpace(userID)
	if siteID == "" || userID == "" {
		return errors.New("authstore: ensure site membership: site id and user id are required")
	}

	exists, err := s.client.SiteMember.Query().
		Where(sitemember.SiteIDEQ(siteID), sitemember.UserIDEQ(userID)).
		Exist(ctx)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}

	err = createActiveMembership(ctx, s.client.Site, s.client.SiteMember, siteID, userID)
	if err != nil && sqlgraph.IsUniqueConstraintError(err) {
		return nil
	}
	return err
}

// createActiveMembership inserts the member row of a user on a site that accepts
// new members.
//
// The policy check and the insert are deliberately one operation: a caller cannot
// forget to ask first, and a site that has closed registration refuses before any
// row is written. Both the Ent client and a transaction expose the two query roots
// this needs, which is why they are passed in rather than reached through a store
// receiver.
func createActiveMembership(
	ctx context.Context,
	sites *entgen.SiteClient,
	members *entgen.SiteMemberClient,
	siteID, userID string,
) error {
	siteID = strings.TrimSpace(siteID)
	if siteID == "" {
		return auth.ErrSiteMissing
	}

	row, err := sites.Query().Where(entsite.IDEQ(siteID)).Only(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			return fmt.Errorf("%w: site %q", auth.ErrSiteMissing, siteID)
		}
		return err
	}
	if !row.RegistrationOpen {
		return fmt.Errorf("%w: site %q has closed registration", auth.ErrRegistrationClosed, siteID)
	}

	_, err = members.Create().
		SetSiteID(siteID).
		SetUserID(userID).
		// The schema default; set explicitly so the role a new provider account gets
		// is decided here, next to the rule, and not by a default in a schema file.
		SetRole(string(site.RoleMember)).
		Save(ctx)
	return err
}


// LinkIdentity binds a provider subject to an account.
//
// The unique index on (provider, provider_subject) is the arbiter: a second
// binding of the same subject by a concurrent request fails there instead of
// silently producing two rows, and that failure is reported as
// auth.ErrIdentityExists so a caller can tell "already bound" from a real
// database failure. Only a uniqueness violation is translated; a foreign key or
// connection error must not look like a duplicate login.
//
// The account is confirmed to exist first. user_identities.user_id is a plain
// column without a foreign key (the model keeps relations out of the schema), so
// without this check a link to a user id that was never committed would succeed
// and leave an identity nobody can sign in with.
func (s *Store) LinkIdentity(ctx context.Context, userID, provider, subject, email string) error {
	userID = strings.TrimSpace(userID)
	provider = strings.TrimSpace(provider)
	subject = strings.TrimSpace(subject)
	if userID == "" || provider == "" || subject == "" {
		return errors.New("authstore: link oauth identity: user id, provider and subject are required")
	}

	exists, err := s.client.User.Query().Where(entuser.IDEQ(userID)).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%w: oauth link target %q", auth.ErrAccountNotFound, userID)
	}

	builder := s.client.UserIdentity.Create().
		SetUserID(userID).
		SetProvider(provider).
		SetProviderSubject(subject)
	// The address stays NULL when the provider did not supply one, so an absent
	// address is never stored as an empty string that a lookup would have to
	// know to ignore.
	if address := strings.TrimSpace(email); address != "" {
		builder.SetEmail(address)
	}

	if _, err := builder.Save(ctx); err != nil {
		if sqlgraph.IsUniqueConstraintError(err) {
			return fmt.Errorf("%w: provider %q subject %q is already bound", auth.ErrIdentityExists, provider, subject)
		}
		return err
	}
	return nil
}

// displayNameFromEmail derives a display name from an address.
//
// It is only a fallback for a provider that returned no name at all; the local
// part is the closest thing to a human name the profile still carries.
func displayNameFromEmail(email string) string {
	address := strings.TrimSpace(email)
	if at := strings.IndexByte(address, '@'); at > 0 {
		address = address[:at]
	}
	address = strings.TrimSpace(address)
	if address == "" {
		return oauthPlaceholderDisplayName
	}
	return truncateToSchemaLen(address, oauthDisplayNameMax)
}

// truncateToSchemaLen shortens s to the byte length the column's MaxLen validator
// accepts, without splitting a UTF-8 rune.
//
// Ent's MaxLen counts bytes, not runes, so a name in a non Latin script is cut
// much earlier than its character count suggests; cutting on a rune boundary keeps
// the stored value valid UTF-8 instead of producing a broken tail.
func truncateToSchemaLen(s string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// SQLDB is the raw database capability the state table needs.
//
// The Ent client does not expose its driver, and oauth_states has no entity to
// reach it through, so the pool has to be handed in. *db.DB implements this and
// is the only implementation production uses; it is a narrow port rather than a
// *sql.DB parameter so the store also receives the canonical driver name, which
// is what decides the placeholder syntax below.
type SQLDB interface {
	SQL() *sql.DB
	Driver() string
}

// errOAuthStateStoreUnavailable is reported when the store was built without a
// database handle. It is a wiring bug, not a request outcome, so it is returned
// instead of being disguised as an invalid state.
var errOAuthStateStoreUnavailable = errors.New("authstore: oauth state store has no database handle")

// oauthDialect is the placeholder syntax of the active database.
type oauthDialect string

const (
	oauthSQLite   oauthDialect = "sqlite"
	oauthMySQL    oauthDialect = "mysql"
	oauthPostgres oauthDialect = "postgres"
)

// OAuthStateStore is the SQL backed implementation of auth.OAuthStateStore.
//
// Every timestamp is written and compared in UTC. SQLite stores the driver's
// rendering of a time as text and compares those texts, so a value written in a
// local zone would order against a UTC bound by its offset instead of by its
// instant; normalising on the way in keeps the comparison meaningful on all three
// supported engines.
type OAuthStateStore struct {
	db      *sql.DB
	dialect oauthDialect
}

// NewOAuthStateStore returns a state store over the given database.
func NewOAuthStateStore(database SQLDB) *OAuthStateStore {
	store := &OAuthStateStore{dialect: oauthSQLite}
	if database == nil {
		return store
	}
	store.db = database.SQL()
	switch database.Driver() {
	case "mysql":
		store.dialect = oauthMySQL
	case "postgres":
		store.dialect = oauthPostgres
	}
	return store
}

var _ auth.OAuthStateStore = (*OAuthStateStore)(nil)

// The statements below use "?" placeholders and are rendered per dialect by
// query, so one copy of each query serves every engine.

const (
	oauthStateInsertSQL = `INSERT INTO oauth_states
	(state, site_id, provider, redirect_target, code_verifier, created_at, expires_at, consumed_at)
	VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`

	// The update is the whole of Consume's safety: existence, expiry and the
	// single-use mark are decided by one statement, so two callbacks holding the
	// same state cannot both see consumed_at as NULL and both win.
	oauthStateConsumeSQL = `UPDATE oauth_states
	SET consumed_at = ?
	WHERE state = ? AND consumed_at IS NULL AND expires_at > ?`

	oauthStateSelectSQL = `SELECT state, site_id, provider, redirect_target, code_verifier, created_at, expires_at, consumed_at
	FROM oauth_states WHERE state = ?`

	oauthStateDeleteExpiredSQL = `DELETE FROM oauth_states WHERE expires_at <= ?`
)

// Create stores one pending authorization request.
//
// A state that already exists is refused with auth.ErrOAuthStateInvalid, matching
// the in-memory store: overwriting a live row would let a second flow take over
// the first one's callback. A caller supplied duplicate state is a programming
// error, but it is reported as the same opaque failure the callback sees so the
// distinction does not leak into an attack surface.
func (s *OAuthStateStore) Create(ctx context.Context, st auth.OAuthState) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	state := strings.TrimSpace(st.State)
	if state == "" {
		return auth.ErrOAuthStateInvalid
	}
	db, err := s.handle()
	if err != nil {
		return err
	}

	_, err = db.ExecContext(ctx, s.query(oauthStateInsertSQL),
		state,
		st.SiteID,
		st.Provider,
		nullableText(st.RedirectTarget),
		nullableText(st.CodeVerifier),
		st.CreatedAt.UTC(),
		st.ExpiresAt.UTC(),
	)
	if err != nil {
		if sqlgraph.IsUniqueConstraintError(err) {
			return fmt.Errorf("%w: state already exists", auth.ErrOAuthStateInvalid)
		}
		return err
	}
	return nil
}

// Consume redeems a state exactly once and returns the stored attempt.
//
// The mark and the read share one transaction: the conditional update decides the
// winner, and the read returns the row it just claimed, including the PKCE
// verifier the token exchange needs. Zero updated rows means the state was
// unknown, already used or expired, and all three are reported as
// auth.ErrOAuthStateInvalid so a caller cannot probe which one it was.
func (s *OAuthStateStore) Consume(ctx context.Context, state string) (auth.OAuthState, error) {
	if err := ctx.Err(); err != nil {
		return auth.OAuthState{}, err
	}
	key := strings.TrimSpace(state)
	if key == "" {
		return auth.OAuthState{}, auth.ErrOAuthStateInvalid
	}
	db, err := s.handle()
	if err != nil {
		return auth.OAuthState{}, err
	}

	now := time.Now().UTC()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return auth.OAuthState{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	result, err := tx.ExecContext(ctx, s.query(oauthStateConsumeSQL), now, key, now)
	if err != nil {
		return auth.OAuthState{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return auth.OAuthState{}, err
	}
	if affected == 0 {
		return auth.OAuthState{}, auth.ErrOAuthStateInvalid
	}

	stored, err := scanOAuthState(tx.QueryRowContext(ctx, s.query(oauthStateSelectSQL), key))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// Only a concurrent sweep could remove a row this transaction just
			// claimed; report the same opaque failure rather than a driver error.
			return auth.OAuthState{}, auth.ErrOAuthStateInvalid
		}
		return auth.OAuthState{}, err
	}

	if err := tx.Commit(); err != nil {
		return auth.OAuthState{}, err
	}
	committed = true
	return stored, nil
}

// DeleteExpired removes every attempt that expired at or before now.
//
// Consumed rows are kept until they expire as well, so a replayed callback is
// recognised as a used state instead of looking unknown; the expiry bound is what
// keeps the table from growing with history.
func (s *OAuthStateStore) DeleteExpired(ctx context.Context, now time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	db, err := s.handle()
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, s.query(oauthStateDeleteExpiredSQL), now.UTC())
	return err
}

// handle returns the pool or the wiring error.
func (s *OAuthStateStore) handle() (*sql.DB, error) {
	if s == nil || s.db == nil {
		return nil, errOAuthStateStoreUnavailable
	}
	return s.db, nil
}

// query renders the portable statement for the active dialect.
//
// The statements here never embed a "?" inside a string literal, so a plain scan
// is enough; it keeps the SQL readable in one form while still being accepted by
// PostgreSQL, which only understands numbered placeholders.
func (s *OAuthStateStore) query(statement string) string {
	if s.dialect != oauthPostgres {
		return statement
	}
	var builder strings.Builder
	builder.Grow(len(statement) + 8)
	index := 0
	for _, char := range statement {
		if char != '?' {
			builder.WriteRune(char)
			continue
		}
		index++
		builder.WriteByte('$')
		builder.WriteString(strconv.Itoa(index))
	}
	return builder.String()
}

// rowScanner is the one capability scanning a state row needs, which both
// *sql.Row and *sql.Rows provide.
type rowScanner interface {
	Scan(dest ...any) error
}

// scanOAuthState reads one oauth_states row.
func scanOAuthState(row rowScanner) (auth.OAuthState, error) {
	var (
		stored         auth.OAuthState
		redirectTarget sql.NullString
		codeVerifier   sql.NullString
		consumedAt     sql.NullTime
	)
	if err := row.Scan(
		&stored.State,
		&stored.SiteID,
		&stored.Provider,
		&redirectTarget,
		&codeVerifier,
		&stored.CreatedAt,
		&stored.ExpiresAt,
		&consumedAt,
	); err != nil {
		return auth.OAuthState{}, err
	}
	stored.RedirectTarget = redirectTarget.String
	stored.CodeVerifier = codeVerifier.String
	if consumedAt.Valid {
		at := consumedAt.Time
		stored.ConsumedAt = &at
	}
	return stored, nil
}

// nullableText writes an empty string as SQL NULL.
//
// The two optional columns are nullable on purpose, so "the flow did not ask for
// a redirect" and "there is no PKCE verifier" stay distinguishable from a value
// that happens to be blank.
func nullableText(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
