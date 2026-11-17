-- Clients and engagements are optional: an organisation that has neither
-- switches them off. Nothing is deleted; the records are only out of reach
-- until the switch goes back on. An engagement always has a client, so
-- engagements can't be on without clients.
alter table public.organisations
  add column clients_enabled boolean not null default true,
  add column engagements_enabled boolean not null default true,
  add constraint organisations_engagements_need_clients check (clients_enabled or not engagements_enabled);

-- A switched-off entity grants nobody anything, which closes its functions,
-- its policies and its pages in one place.
create or replace function public.caller_permission_levels(p_user uuid, p_entity text)
returns table (read_level integer, write_level integer, delete_level integer)
language sql
stable
set search_path = ''
as $$
  select
    coalesce(max(p.read_level), 0)::int,
    coalesce(max(p.write_level), 0)::int,
    coalesce(max(p.delete_level), 0)::int
  from public.user_access_roles ua
  join public.access_roles r on r.id = ua.role_id and r.enabled
  join public.access_role_permissions p on p.role_id = ua.role_id and p.entity = p_entity
  where ua.user_id = p_user
    and not exists (
      select 1 from public.profiles pr where pr.id = p_user and pr.status = 'disabled'
    )
    and not exists (
      select 1 from public.organisations o
       where (p_entity = 'Clients' and not o.clients_enabled)
          or (p_entity = 'Engagements' and not o.engagements_enabled)
    )
$$;

-- What switching off would put out of reach, for the confirmation.
create or replace function public.organisation_module_drift()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'clients', (select count(*) from public.clients where archived_at is null),
    'engagements', (select count(*) from public.engagements where archived_at is null),
    'clientTemplates', (select count(*) from public.templates where status = 'published' and requires_client),
    'engagementTemplates', (select count(*) from public.templates where status = 'published' and requires_engagement)
  )
$$;
revoke execute on function public.organisation_module_drift() from public, anon, authenticated;
