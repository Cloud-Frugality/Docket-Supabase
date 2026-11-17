-- Approvals: a submitted document goes through two steps. Content first (the
-- team's default approvers), then value (someone authorised to approve, whose
-- limit covers the document's total). Who may decide is checked in the
-- function (_shared/document-approval.ts); this only records it.
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  document_version_id uuid not null references public.document_versions(id) on delete cascade,
  step text not null check (step in ('content', 'value')),
  step_order integer not null check (step_order in (1, 2)),
  decision text not null default 'pending' check (decision in ('pending', 'approved', 'rejected', 'changes_requested')),
  comment text not null default '' check (char_length(comment) <= 2000),
  decided_by uuid references auth.users(id) on delete set null,
  -- The approver a delegate stood in for; null when they decided for themselves.
  acting_for uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index approvals_document_idx on public.approvals (document_id, created_at);
-- One open step per document at a time.
create unique index approvals_one_pending on public.approvals (document_id) where decision = 'pending';
alter table public.approvals enable row level security;

create policy "approvals follow their document"
  on public.approvals for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id));

create trigger notify_invalidate after insert or update or delete on public.approvals
  for each statement execute function public.notify_invalidate();

-- Submitting now also opens the content step for the version it snapshots.
create or replace function public.submit_document(p_document_id uuid, p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.documents%rowtype;
  v_version integer;
  v_version_id uuid;
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
    from public.document_sections s where s.document_id = p_document_id
  returning id into v_version_id;
  insert into public.approvals (document_id, document_version_id, step, step_order)
    values (p_document_id, v_version_id, 'content', 1);
  update public.documents
     set status = 'in_review', submitted_at = now(), current_version = v_version, updated_by = p_user, updated_at = now()
   where id = p_document_id;
  return v_version;
end;
$$;

-- One decision on the open step, in one transaction. Approving content opens
-- the value step; approving value approves the document. Rejecting or asking
-- for changes sends it back to draft. Returns the document's new status.
create or replace function public.decide_approval(
  p_approval_id uuid, p_decision text, p_comment text, p_user uuid, p_acting_for uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.approvals%rowtype;
  v_status text;
begin
  if p_decision not in ('approved', 'rejected', 'changes_requested') then
    raise exception 'Unknown decision.';
  end if;
  select * into a from public.approvals where id = p_approval_id for update;
  if not found or a.decision <> 'pending' then
    raise exception 'This approval has already been decided.';
  end if;
  perform 1 from public.documents where id = a.document_id and status = 'in_review' for update;
  if not found then
    raise exception 'This document is not waiting for approval.';
  end if;
  update public.approvals
     set decision = p_decision, comment = coalesce(p_comment, ''), decided_by = p_user,
         acting_for = p_acting_for, decided_at = now()
   where id = p_approval_id;
  if p_decision = 'approved' and a.step = 'content' then
    insert into public.approvals (document_id, document_version_id, step, step_order)
      values (a.document_id, a.document_version_id, 'value', 2);
    v_status := 'in_review';
  elsif p_decision = 'approved' then
    v_status := 'approved';
  else
    v_status := 'draft';
  end if;
  update public.documents set status = v_status, updated_by = p_user, updated_at = now() where id = a.document_id;
  return v_status;
end;
$$;

revoke execute on function public.submit_document(uuid, uuid), public.decide_approval(uuid, text, text, uuid, uuid)
  from public, anon, authenticated;
