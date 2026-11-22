-- Three things the document library was missing: a history of what happened
-- to each file, fields of its own for each document category, and folders and
-- files that only named people and teams can see.

-- ---------------------------------------------------------------- history
-- One row for each thing done to a file. It outlives the file, so the name is
-- kept on the row. No actor means the nightly clean-up did it.
create table public.document_events (
  id uuid primary key default gen_random_uuid(),
  record text not null check (record in ('client', 'engagement')),
  document_id uuid not null,
  family_id uuid not null,
  file_name text not null,
  action text not null,
  actor uuid references public.profiles(id) on delete set null,
  detail text,
  created_at timestamptz not null default now()
);
-- Read and written by the Edge Functions only, so no policies.
alter table public.document_events enable row level security;
create index document_events_family on public.document_events (family_id, created_at desc);

create trigger notify_invalidate after insert on public.document_events
  for each statement execute function public.notify_invalidate();

-- ---------------------------------------------------------------- custom fields
-- The fields a category asks for, and what each file answered.
alter table public.document_categories add column fields jsonb not null default '[]'::jsonb;
alter table public.client_documents add column custom jsonb not null default '{}'::jsonb;
alter table public.engagement_documents add column custom jsonb not null default '{}'::jsonb;

-- ---------------------------------------------------------------- restricted access
-- A restricted folder or file is seen only by the people and teams named for
-- it, and by global admins. A restricted folder covers everything inside it.
alter table public.document_folders add column restricted boolean not null default false;
alter table public.client_documents add column restricted boolean not null default false;
alter table public.engagement_documents add column restricted boolean not null default false;

create table public.document_access (
  id uuid primary key default gen_random_uuid(),
  -- A folder, or a file by its family so every version is covered.
  folder_id uuid references public.document_folders(id) on delete cascade,
  family_id uuid,
  -- A person, or everyone in a team.
  profile_id uuid references public.profiles(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  check ((folder_id is null) <> (family_id is null)),
  check ((profile_id is null) <> (team_id is null))
);
-- Read and written by the Edge Functions only, so no policies.
alter table public.document_access enable row level security;
create index document_access_folder on public.document_access (folder_id);
create index document_access_family on public.document_access (family_id);
create index document_access_profile on public.document_access (profile_id);
create index document_access_team on public.document_access (team_id);

create trigger notify_invalidate after insert or update or delete on public.document_access
  for each statement execute function public.notify_invalidate();

-- A new version of a restricted file is restricted too, whoever uploads it.
create or replace function public.inherit_document_restriction()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  already boolean;
begin
  execute format('select exists (select 1 from public.%I where family_id = $1 and restricted)', tg_table_name)
    into already using new.family_id;
  if already then
    new.restricted := true;
  end if;
  return new;
end;
$$;
revoke execute on function public.inherit_document_restriction() from public, anon, authenticated;

create trigger inherit_document_restriction before insert on public.client_documents
  for each row execute function public.inherit_document_restriction();
create trigger inherit_document_restriction before insert on public.engagement_documents
  for each row execute function public.inherit_document_restriction();

-- Who may see one folder or file, replaced whole in one transaction.
create or replace function public.replace_document_access(
  p_folder_id uuid,
  p_record text,
  p_family_id uuid,
  p_restricted boolean,
  p_profile_ids uuid[],
  p_team_ids uuid[]
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_folder_id is not null then
    update public.document_folders set restricted = p_restricted where id = p_folder_id;
    delete from public.document_access where folder_id = p_folder_id;
  elsif p_record = 'client' then
    update public.client_documents set restricted = p_restricted where family_id = p_family_id;
    delete from public.document_access where family_id = p_family_id;
  else
    update public.engagement_documents set restricted = p_restricted where family_id = p_family_id;
    delete from public.document_access where family_id = p_family_id;
  end if;

  if p_restricted then
    insert into public.document_access (folder_id, family_id, profile_id)
      select p_folder_id, case when p_folder_id is null then p_family_id end, person
        from unnest(p_profile_ids) as person;
    insert into public.document_access (folder_id, family_id, team_id)
      select p_folder_id, case when p_folder_id is null then p_family_id end, team
        from unnest(p_team_ids) as team;
  end if;
end;
$$;
revoke execute on function public.replace_document_access(uuid, text, uuid, boolean, uuid[], uuid[]) from public, anon, authenticated;

-- ---------------------------------------------------------------- document register
-- The register again, now with each file's own fields and whether it is restricted.
drop view if exists public.document_register;
create view public.document_register
with (security_invoker = true)
as
with files as (
  select 'engagement'::text as record, d.id, d.engagement_id as record_id, e.client_id,
         e.name as record_name, t.name as work_type, e.team_id,
         coalesce(e.archived_at, c.archived_at) as record_archived_at, d.file_name, d.content_type, d.size_bytes,
         d.uploaded_by, d.created_at, d.document_type, d.status, d.reference,
         d.effective_from, d.effective_to, d.note, d.family_id, d.version,
         d.archived_at, d.archived_by, d.updated_at, d.updated_by,
         d.approval_state, d.submitted_by, d.submitted_at, d.decided_by, d.decided_for, d.decided_at,
         d.decision_comment, d.on_hold, d.retain_until, d.folder_id, d.custom, d.restricted
    from public.engagement_documents d
    join public.engagements e on e.id = d.engagement_id
    join public.clients c on c.id = e.client_id
    join public.engagement_types t on t.id = e.engagement_type_id
  union all
  select 'client'::text, d.id, d.client_id, d.client_id, c.name, null::text, null::uuid,
         c.archived_at, d.file_name, d.content_type, d.size_bytes, d.uploaded_by,
         d.created_at, d.document_type, d.status, d.reference, d.effective_from,
         d.effective_to, d.note, d.family_id, d.version, d.archived_at, d.archived_by, d.updated_at,
         d.updated_by,
         d.approval_state, d.submitted_by, d.submitted_at, d.decided_by, d.decided_for, d.decided_at,
         d.decision_comment, d.on_hold, d.retain_until, d.folder_id, d.custom, d.restricted
    from public.client_documents d
    join public.clients c on c.id = d.client_id
)
select f.*,
       c.name as client_name,
       (f.archived_at is null
         and f.version = max(f.version) filter (where f.archived_at is null)
               over (partition by f.record, f.family_id)) as is_latest,
       count(*) filter (where f.archived_at is null)
         over (partition by f.record, f.family_id) as version_count
  from files f
  join public.clients c on c.id = f.client_id;
