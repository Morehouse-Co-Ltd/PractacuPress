# Migrations

`apps/api/cmd/migrate` applies the Ent schema additively. Dropping columns and
dropping indexes are both disabled, so a misconfigured deployment cannot destroy
data.

## Development and first release

```powershell
$env:DATABASE_DRIVER = 'sqlite'
$env:DATABASE_DSN    = 'file:./data/practacu.db?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)'
go run ./apps/api/cmd/migrate
```

The command is idempotent: running it twice is safe and is expected by deploy
scripts.

## Production

Production change sets are generated from `apps/api/ent/schema` with Atlas and
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

## Rollback

Every migration must be paired with a reviewed rollback statement in the same
change set. Restore from backup is the fallback for destructive changes, which is
why the additive-only default exists.
