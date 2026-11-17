-- Reviewing a draft: instructions for the AI, the revisions it proposes,
-- requests to unlock a locked section, and the snapshot taken on submission.
--
-- Revisions keep full text, before and after, so any diff can be drawn again
-- and there's a record of what the AI proposed against what a person kept.

create table public.revision_requests (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  -- Null means the whole document.
  section_id uuid references public.document_sections(id) on delete cascade,
  instruction text not null check (char_length(instruction) between 1 and 4000),
  status text not null default 'pending' check (status in ('pending', 'processing', 'processed', 'failed')),
  error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- When processing began, so a run that died can be picked up again.
  processing_started_at timestamptz,
  processed_at timestamptz
);
create index revision_requests_document_idx on public.revision_requests (document_id, created_at);
alter table public.revision_requests enable row level security;

create table public.revisions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  section_id uuid not null references public.document_sections(id) on delete cascade,
  -- Several instructions on one section are answered by one revision.
  revision_request_ids uuid[] not null,
  instruction text not null,
  original_text text not null,
  proposed_text text not null,
  final_text text,
  status text not null default 'proposed' check (status in ('proposed', 'accepted', 'rejected', 'edited')),
  created_at timestamptz not null default now(),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  model text not null default '',
  prompt_tokens integer,
  completion_tokens integer
);
create index revisions_document_idx on public.revisions (document_id, created_at);
create index revisions_section_idx on public.revisions (section_id, status);
alter table public.revisions enable row level security;

create table public.section_unlock_requests (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  section_id uuid not null references public.document_sections(id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz
);
-- One open request per section at a time.
create unique index section_unlock_requests_pending_idx
  on public.section_unlock_requests (section_id) where status = 'pending';
create index section_unlock_requests_document_idx on public.section_unlock_requests (document_id);
alter table public.section_unlock_requests enable row level security;

-- The document as it stood when it was submitted (and, later, finalised).
create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version integer not null,
  sections jsonb not null,
  field_values jsonb not null,
  reason text not null check (reason in ('submitted', 'finalised')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (document_id, version)
);
alter table public.document_versions enable row level security;

-- Accepting, editing or rejecting a proposal. Accepting writes the text into
-- the section only if the section still reads as it did when the AI was
-- asked; otherwise it returns 'stale' and changes nothing.
create or replace function public.resolve_revision(p_revision_id uuid, p_status text, p_final_text text, p_user uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.revisions%rowtype;
begin
  select * into r from public.revisions where id = p_revision_id for update;
  if not found or r.status <> 'proposed' then
    return 'gone';
  end if;
  if p_status in ('accepted', 'edited') then
    update public.document_sections
       set current_text = coalesce(p_final_text, r.proposed_text), updated_at = now()
     where id = r.section_id and current_text = r.original_text;
    if not found then
      return 'stale';
    end if;
  end if;
  update public.revisions
     set status = p_status,
         final_text = case when p_status = 'edited' then p_final_text else null end,
         resolved_by = p_user,
         resolved_at = now()
   where id = p_revision_id;
  return 'ok';
end;
$$;

-- A removable section switched on or off, on the section and in the
-- document's record of the author's choices.
create or replace function public.set_section_included(p_section_id uuid, p_included boolean, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_document uuid;
  v_key text;
begin
  update public.document_sections set is_included = p_included, updated_at = now()
   where id = p_section_id
  returning document_id, template_section_key into v_document, v_key;
  update public.documents
     set included_sections = included_sections || jsonb_build_object(v_key, p_included),
         updated_by = p_user, updated_at = now()
   where id = v_document;
end;
$$;

-- An unlock granted: the section opens for this document only.
create or replace function public.approve_unlock(p_request_id uuid, p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  u public.section_unlock_requests%rowtype;
begin
  update public.section_unlock_requests
     set status = 'approved', decided_by = p_user, decided_at = now()
   where id = p_request_id and status = 'pending'
  returning * into u;
  if not found then
    return false;
  end if;
  update public.document_sections
     set unlocked_by = p_user, unlocked_at = now(), unlock_reason = u.reason, updated_at = now()
   where id = u.section_id;
  return true;
end;
$$;

-- Submission: the content freezes and a snapshot is kept. Refused while an
-- instruction is waiting or a proposal is unanswered.
create or replace function public.submit_document(p_document_id uuid, p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.documents%rowtype;
  v_version integer;
begin
  select * into d from public.documents where id = p_document_id for update;
  if not found or d.status <> 'draft' then
    raise exception 'Only a draft can be submitted.';
  end if;
  if exists (select 1 from public.revision_requests
              where document_id = p_document_id and status in ('pending', 'processing')) then
    raise exception 'Some instructions have not been processed yet.';
  end if;
  if exists (select 1 from public.revisions where document_id = p_document_id and status = 'proposed') then
    raise exception 'Some proposed changes have not been accepted or rejected.';
  end if;
  select coalesce(max(version), 0) + 1 into v_version from public.document_versions where document_id = p_document_id;
  insert into public.document_versions (document_id, version, sections, field_values, reason, created_by)
  select p_document_id, v_version,
         coalesce(jsonb_agg(jsonb_build_object(
           'key', s.template_section_key, 'title', s.title, 'text', s.current_text, 'edit_mode', s.edit_mode,
           'is_included', s.is_included, 'unlocked_by', s.unlocked_by, 'unlock_reason', s.unlock_reason)
           order by s.sort_order), '[]'::jsonb),
         d.field_values, 'submitted', p_user
    from public.document_sections s where s.document_id = p_document_id;
  update public.documents
     set status = 'in_review', submitted_at = now(), current_version = v_version, updated_by = p_user, updated_at = now()
   where id = p_document_id;
  return v_version;
end;
$$;

revoke execute on function public.resolve_revision(uuid, text, text, uuid), public.set_section_included(uuid, boolean, uuid),
  public.approve_unlock(uuid, uuid), public.submit_document(uuid, uuid) from public, anon, authenticated;

-- Read-only second guards: each follows its document.
create policy "revision requests follow their document"
  on public.revision_requests for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id));
create policy "revisions follow their document"
  on public.revisions for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id));
create policy "unlock requests follow their document"
  on public.section_unlock_requests for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id));
create policy "document versions follow their document"
  on public.document_versions for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id));

do $$
declare
  t text;
begin
  foreach t in array array['revision_requests', 'revisions', 'section_unlock_requests', 'document_versions'] loop
    execute format(
      'create trigger notify_invalidate after insert or update or delete on public.%I
         for each statement execute function public.notify_invalidate()', t);
  end loop;
end;
$$;
