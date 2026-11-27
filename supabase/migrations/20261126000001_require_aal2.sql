-- The Edge Functions all need the authenticator code (aal2), but the read policies
-- did not, so a token from the password alone could read some tables straight from
-- the API. Now every table needs aal2 too. Restrictive, so it narrows what the other
-- policies allow and opens nothing that was closed.
do $$
declare
  t record;
begin
  for t in
    select c.oid::regclass as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    execute format('drop policy if exists "require aal2" on %s', t.name);
    execute format(
      'create policy "require aal2" on %s as restrictive for all to authenticated '
      'using ((select auth.jwt() ->> ''aal'') = ''aal2'') with check ((select auth.jwt() ->> ''aal'') = ''aal2'')',
      t.name);
  end loop;
end;
$$;

-- The cross-user refresh signals, too.
drop policy if exists "require aal2" on realtime.messages;
create policy "require aal2" on realtime.messages as restrictive for select to authenticated
  using ((select auth.jwt() ->> 'aal') = 'aal2');

-- A new table gets RLS and the aal2 policy as it is made, so neither can be forgotten.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  cmd record;
begin
  for cmd in
    select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name = 'public' then
      execute format('alter table if exists %s enable row level security', cmd.object_identity);
      execute format(
        'create policy "require aal2" on %s as restrictive for all to authenticated '
        'using ((select auth.jwt() ->> ''aal'') = ''aal2'') with check ((select auth.jwt() ->> ''aal'') = ''aal2'')',
        cmd.object_identity);
    end if;
  end loop;
end;
$$;
