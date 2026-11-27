# Migrations

`practacu-press migrate` applies the Ent schema additively. Dropping columns and
dropping indexes are both disabled, so a misconfigured deployment cannot destroy
data.

## Development and first release

```powershell
$env:DATABASE_DRIVER = 'sqlite'
$env:DATABASE_DSN    = 'file:./data/practacu.db?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)'
go run ./cmd/server migrate
```

The command is idempotent: running it twice is safe and is expected by deploy
scripts.

## Production

Production change sets are generated from `internal/ent/schema` with Atlas and
reviewed as SQL before being applied, per dialect. Ent depends on
`ariga.io/atlas`, so no separate CLI install is required to generate them:

1. Generate the SQL for the target dialect into this directory.
2. Review it in the pull request.
3. Apply it as a separate migration step *before* deploying the new binary.

The versioned directories (`sqlite/`, `mysql/`, `postgres/`) hold the reviewed
change sets for each supported database dialect. Apply only the script matching
the deployment database.

### 2026-11-04 media quotas

`20261104000000_media_quotas.up.sql` adds nullable `media_quota_bytes` columns
to `sites` and `site_members`, plus the `media_quota_guards` table used to
serialize concurrent upload reservations. Apply the matching script before
deploying the API. A `NULL` value inherits the deployment default; `0` explicitly
means unlimited; a positive integer is a byte limit. The matching `.down.sql`
file is the reviewed rollback for this additive change.

### 2026-11-07 content revisions

`20261107000000_content_revisions.up.sql` adds the `content_items.revision`
counter used for optimistic concurrency and the `content_revisions` table that
stores the bounded (20 versions) history behind the editor's version panel and
rollback action. The counter defaults to `0` so existing rows keep working; their
next save starts the history at version 1. Apply the matching script before
deploying the API, and use the paired `.down.sql` for rollback.

### 2026-11-08 comment policy

`20261108000000_comment_policy.up.sql` adds `sites.comments_enabled` (default
`TRUE`/`1`) and `sites.comments_require_review` (default `FALSE`/`0`). The API
enforces both on `POST /comments`: a closed site answers `403` with reason
`comments_closed`, and review mode stores new comments as `pending_review` until a
moderator approves or rejects them. Apply the matching script before deploying the
API, and use the paired `.down.sql` for rollback.

### 2026-11-09 account security and audit query

`20261109000000_account_security.up.sql` adds `users.email_verified_at`, the
account level mirror of `user_identities.verified_at`, and backfills it from the
authoritative identity row. The API only ever writes it forward (`NULL` to a
timestamp), so a password reset cannot clear an older proof. The same change set
adds the `audit_logs(action, created_at)` index used by the admin activity page
when it filters by action inside one site and time range. Apply the matching
script before deploying the API and use the paired `.down.sql` for rollback.

### 2026-11-10 reading history

`20261110000000_reading_history.up.sql` adds the `reading_histories` table behind
the signed-in reading history (`GET/POST /me/reading-history`). One row is kept per
`(user_id, target_type, target_id)`: a repeated visit moves `last_viewed_at`
forward and increments `view_count` instead of appending a row per reload. The
page view table is not reused because it stores an anonymous, client supplied
session id that cannot be mapped back to an account. Apply the matching script
before deploying the API and use the paired `.down.sql` for rollback.

### 2026-11-19 permission groups

`20261119000000_permission_groups.up.sql` adds `site_members.group_key` (empty means
"derive the built-in group from the role") and the `permission_groups` table that
stores one row per site and key: the operator visible label, the fixed base role, the
enabled capability list and the dashboard-entry switch. The four built-in rows are
seeded lazily by the API on the first read, so existing sites need no backfill and
every existing membership keeps its current behaviour. The unique index on
`(site_id, key)` is what makes a key stable while its label changes. Apply the
matching script before deploying the API, and use the paired `.down.sql` for rollback.

### 2026-11-20 content trash, SEO, cover and comment risk (Beta 1.2)

`20261120000000_content_trash_seo_risk.up.sql` adds eleven columns to `content_items`:
`deleted_at`, the nullable recycle bin marker, plus the
`contentitem_site_id_deleted_at` index on `(site_id, deleted_at)` that serves the bin
listing and the `deleted_at IS NULL` predicate every other query adds; the per item SEO
overrides `seo_title`, `seo_description`, `seo_keywords`, `canonical_url` and `robots`;
the social card and cover `og_image` and `cover_url`, unbounded text because a cover may
be an inline data URL; and the cover presentation columns `cover_alt`, `cover_position`
and `cover_hidden`. The same change set adds `media_assets.file_name` (the name the
uploader used instead of a storage key fragment) and the server side comment ranking
`comments.risk_score` and `comments.risk_flags`, which used to be computed in the
browser.

Every column has a default, so there is no backfill and an existing deployment keeps its
current behaviour: no item sits in the recycle bin, every SEO field inherits the site
template, no cover is configured, no comment is ranked and no asset loses its name.
Deletes become soft deletes: the row, its revisions, comments and media references stay
resolvable, and readers filter it out through `deleted_at`.

Apply the script that matches the deployment database before deploying the Beta 1.2
binary, and use the paired `.down.sql` for rollback:

```bash
# PostgreSQL
psql "$DATABASE_DSN" -v ON_ERROR_STOP=1 -1 \
  -f internal/migrations/postgres/20261120000000_content_trash_seo_risk.up.sql
# MySQL
mysql --default-character-set=utf8mb4 "$DATABASE_DSN" \
  < internal/migrations/mysql/20261120000000_content_trash_seo_risk.up.sql
# SQLite
sqlite3 data/practacu.db \
  < internal/migrations/sqlite/20261120000000_content_trash_seo_risk.up.sql
```

Only the PostgreSQL script can be re-run: it uses `ADD COLUMN IF NOT EXISTS` and
`CREATE INDEX IF NOT EXISTS`. MySQL and SQLite have neither for a column, so their
scripts are applied exactly once, which is what the separate migration step in
[Production](#production) provides. That step is *not* `practacu-press migrate`: that
command reconciles the Ent model additively and idempotently, so on a development
database it also produces these columns, after which the versioned script would be a
no-op on PostgreSQL and a duplicate-column error on MySQL and SQLite. Run one path per
database: `migrate` for development and the desktop build, the reviewed script for
production.

### 2026-11-21 redirects, subscribers, mail log, mail templates and SMS codes

`20261121000000_redirect_subscriber_email_phone.up.sql` is one cross-dialect change
set that adds five tables and extends the page view ledger:

- `redirects` — one permanent/temporary URL rule per `(site_id, from_path)`. The
  unique `redirect_site_id_from_path` index is what makes resolution an exact match, so
  two rules can never decide the result by order; `redirect_site_id_created_at` serves
  the admin list.
- `subscribers` — one newsletter entry per `(site_id, email)`, with lowercase emails so
  `Alice@Example.com` and `alice@example.com` collide on purpose. Only `token_hash` is
  stored, never the plaintext confirmation/unsubscribe token. The unique
  `subscriber_token_hash` index is the lookup used by both mailed links.
- `email_logs` — one row per outbound message, written before the relay call and
  updated with the outcome. The body is never stored, only the subject and template
  key.
- `email_templates` — one editable override per `(site_id, key)`; a missing row means
  the shipped default, so existing sites need no backfill.
- `phone_codes` — one short lived SMS code. The number is stored as a keyed hash plus a
  masked display value; `phonecode_expires_at` lets the sweeper remove expired rows.
- `page_views` gains `referrer_host`, `source` and `device`, plus
  `pageview_site_id_source_created_at` and `pageview_site_id_device_created_at` for the
  per window source and device breakdowns. The pre-existing surface/session indexes
  are untouched.

Every new column that is not a key, an owner column or an instant has a default that
mirrors the Ent schema (`status_code` 301, redirect `source` `manual`, subscriber
`status` `pending`, email `kind` `system` / `status` `queued`, template `enabled`
`TRUE`/`1`, phone code `purpose` `login`, page view `source`/`device` `unknown`), so a
row written around the ORM still lands on the value the ORM would have written. An
existing deployment keeps its behaviour with no backfill: it simply has no redirects,
no subscribers, no mail log rows, no template overrides and no phone codes yet.

Types follow the per-dialect conventions used by the earlier change sets: booleans are
native `BOOLEAN` on PostgreSQL and `TINYINT(1)`/`INTEGER` 0/1 on MySQL/SQLite,
instants are `TIMESTAMPTZ` on PostgreSQL and `DATETIME(6)`/`DATETIME` on MySQL/SQLite,
and the template bodies are `LONGTEXT`/`TEXT`/`TEXT`. The MySQL `TEXT` defaults use the
8.0.13+ expression form `DEFAULT ('')`, exactly like the Beta 1.2 change set.

Apply the script that matches the deployment database before deploying the binary that
reads these tables, and use the paired `.down.sql` for rollback:

```bash
# PostgreSQL
psql "$DATABASE_DSN" -v ON_ERROR_STOP=1 -1 \
  -f internal/migrations/postgres/20261121000000_redirect_subscriber_email_phone.up.sql
# MySQL
mysql --default-character-set=utf8mb4 "$DATABASE_DSN" \
  < internal/migrations/mysql/20261121000000_redirect_subscriber_email_phone.up.sql
# SQLite
sqlite3 data/practacu.db \
  < internal/migrations/sqlite/20261121000000_redirect_subscriber_email_phone.up.sql
```

Only the PostgreSQL script is genuinely re-runnable: it uses `CREATE TABLE IF NOT
EXISTS`, `CREATE INDEX IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`. The SQLite and
MySQL scripts are applied exactly once, like the earlier change sets: both have no
`ADD COLUMN IF NOT EXISTS`/`ADD COLUMN ... IF NOT EXISTS`, so a second application
would fail on the page_views half. The down script drops the indexes before the tables
and columns they reference — SQLite refuses to drop an indexed column — and the page
view rows themselves survive the rollback.

## Rollback

Every migration must be paired with a reviewed rollback statement in the same
change set. Restore from backup is the fallback for destructive changes, which is
why the additive-only default exists.
