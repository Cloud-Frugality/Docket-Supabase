-- Folders on the Documents page. A folder belongs to one client or one
-- engagement and can sit inside another folder of the same record. A file is
-- in at most one folder; with none it sits directly on its record.

create table public.document_folders (
  id uuid primary key default gen_random_uuid(),
  -- Exactly one of the two says whose folder it is.
  client_id uuid references public.clients(id) on delete cascade,
  engagement_id uuid references public.engagements(id) on delete cascade,
  -- A folder with folders inside is emptied before it is deleted.
  parent_id uuid references public.document_folders(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((client_id is null) <> (engagement_id is null))
);
alter table public.document_folders enable row level security;

-- No two folders of one name side by side.
create unique index document_folders_sibling_name
  on public.document_folders (
    coalesce(client_id, engagement_id),
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(name))
  );
create index document_folders_parent on public.document_folders (parent_id);

-- Deleting a folder leaves its removed files on the record.
alter table public.client_documents
  add column folder_id uuid references public.document_folders(id) on delete set null;
alter table public.engagement_documents
  add column folder_id uuid references public.document_folders(id) on delete set null;
create index client_documents_folder on public.client_documents (folder_id);
create index engagement_documents_folder on public.engagement_documents (folder_id);

create trigger notify_invalidate after insert or update or delete on public.document_folders
  for each statement execute function public.notify_invalidate();

-- The register again, now saying which folder each file is in.
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
         d.archived_at, d.updated_at, d.updated_by,
         d.approval_state, d.submitted_by, d.submitted_at, d.decided_by, d.decided_for, d.decided_at,
         d.decision_comment, d.on_hold, d.retain_until, d.folder_id
    from public.engagement_documents d
    join public.engagements e on e.id = d.engagement_id
    join public.clients c on c.id = e.client_id
    join public.engagement_types t on t.id = e.engagement_type_id
  union all
  select 'client'::text, d.id, d.client_id, d.client_id, c.name, null::text, null::uuid,
         c.archived_at, d.file_name, d.content_type, d.size_bytes, d.uploaded_by,
         d.created_at, d.document_type, d.status, d.reference, d.effective_from,
         d.effective_to, d.note, d.family_id, d.version, d.archived_at, d.updated_at,
         d.updated_by,
         d.approval_state, d.submitted_by, d.submitted_at, d.decided_by, d.decided_for, d.decided_at,
         d.decision_comment, d.on_hold, d.retain_until, d.folder_id
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
