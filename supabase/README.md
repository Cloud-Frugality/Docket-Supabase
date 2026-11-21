# Supabase: Edge Functions and migrations

The browser never touches tables. Every table has RLS on with no client policies; the Edge Functions use the service key and check RBAC themselves (`_shared/permissions.ts`).

## Edge Functions

Each function is one domain. `GET` routes on a `?action=` query param (none = the default listing); mutations are a `POST` whose JSON body names an `action`, dispatched through one `MUTATIONS` table that binds each action to its permission. Every function starts with `withAuthorizedCaller` (`_shared/serve.ts`).

| Function | Covers |
|---|---|
| `people_administration` | People (one `profiles` row per login): invite, edit, roles, expiry, disable, delete, MFA reset |
| `access_role_administration` | Access roles and their permission matrix; the caller's own access (`?resource=me`) |
| `client_administration` | Clients and their files |
| `engagement_administration` | Engagements, their administrators and their files |
| `document_administration` | The Documents page: every engagement and client file |
| `bug_administration`, `feature_request_administration` | In-app defect log and feature board |
| `preference_administration` | View preferences that follow the user |

## Function secrets

Set in the Supabase dashboard (not the frontend `.env`):

- `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`), `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`)
- `ALLOWED_ORIGINS`: comma-separated browser origins
- `CRON_SECRET`: lets the database's nightly job call `bin_sweep`. Any long random value.

## The nightly recycle bin job

`bin_sweep` deletes for good what has been in the recycle bin longer than the organisation keeps it. The database calls it every night (`cron.schedule('recycle-bin-sweep', ...)`, 01:15 UTC). It has no signed-in caller, so it is the one function deployed with `--no-verify-jwt`, and it lets in only a call carrying `CRON_SECRET` in the `x-cron-secret` header.

Set once per project, in the SQL editor, never in a migration:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<the same value as CRON_SECRET>', 'cron_secret');
```

Deploy with `SUPABASE_PROJECT_REF=<ref> node scripts/deploy-fn.mjs bin_sweep --no-verify-jwt`. To see how the runs went: `select * from cron.job_run_details order by start_time desc limit 5;` and `select status_code, content from net._http_response order by created desc limit 5;`.

## Migrations

`migrations/` starts fresh (2026-10-31) and builds only the kept schema. `docs/reference-schema.sql` records what the old project held, for reference only.
