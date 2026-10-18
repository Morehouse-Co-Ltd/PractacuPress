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

The empty versioned directories (`sqlite/`, `mysql/`, `postgres/`) are the
intended homes for those generated change sets. They are intentionally empty
until the first release is cut.

## Rollback

Every migration must be paired with a reviewed rollback statement in the same
change set. Restore from backup is the fallback for destructive changes, which is
why the additive-only default exists.
