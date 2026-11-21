-- The recycle bin is emptied on a schedule: every night the database calls the
-- bin_sweep function, which deletes for good what has been in the bin longer
-- than the organisation keeps it.
--
-- The call needs two secrets in the Vault, set once per project and never in
-- a migration: 'project_url' (https://<ref>.supabase.co) and 'cron_secret'
-- (the same value as the function's CRON_SECRET). Without them the job runs
-- and fails, and nothing is deleted.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Scheduling under the same name replaces the job, so this can run again.
select cron.schedule(
  'recycle-bin-sweep',
  '15 1 * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/bin_sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $job$
);
