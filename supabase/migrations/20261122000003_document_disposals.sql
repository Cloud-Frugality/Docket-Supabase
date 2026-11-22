-- Disposal at the end of retention. A file whose retention has passed is
-- reviewed, then destroyed with every version, and a line is kept here for
-- good saying what went, why and who signed it off.
create table public.document_disposals (
  id uuid primary key default gen_random_uuid(),
  record text not null check (record in ('client', 'engagement')),
  family_id uuid not null,
  -- Everything is kept as text: the file, its client and the person may all be gone later.
  file_name text not null,
  document_type text not null,
  client_name text not null,
  record_name text not null,
  versions integer not null,
  retained_until date not null,
  reason text not null,
  disposed_by uuid,
  disposed_by_name text not null,
  disposed_at timestamptz not null default now()
);
-- Read and written by the Edge Functions only, so no policies.
alter table public.document_disposals enable row level security;
create index document_disposals_at on public.document_disposals (disposed_at desc);

create trigger notify_invalidate after insert on public.document_disposals
  for each statement execute function public.notify_invalidate();

-- The record is permanent: a line is added and never changed or taken away.
create or replace function public.document_disposals_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'The disposal record cannot be changed.';
end;
$$;
revoke execute on function public.document_disposals_guard() from public, anon, authenticated;

create trigger document_disposals_guard before update or delete on public.document_disposals
  for each row execute function public.document_disposals_guard();

-- Destroys every version of one file and writes its disposal line, in one
-- transaction, so neither happens without the other. The retained_document_guard
-- trigger still refuses a version that is on hold or inside its retention.
-- Returns the stored paths, for the caller to clear from storage.
create or replace function public.dispose_document_family(
  p_record text,
  p_family_id uuid,
  p_file_name text,
  p_document_type text,
  p_client_name text,
  p_record_name text,
  p_retained_until date,
  p_reason text,
  p_by uuid,
  p_by_name text
)
returns text[]
language plpgsql
set search_path = ''
as $$
declare
  paths text[];
begin
  if p_record = 'client' then
    with gone as (delete from public.client_documents where family_id = p_family_id returning storage_path)
    select array_agg(storage_path) into paths from gone;
  else
    with gone as (delete from public.engagement_documents where family_id = p_family_id returning storage_path)
    select array_agg(storage_path) into paths from gone;
  end if;
  if paths is null then
    raise exception 'No such document.';
  end if;

  -- Who could see it no longer matters.
  delete from public.document_access where family_id = p_family_id;
  delete from public.document_shares where family_id = p_family_id;

  insert into public.document_disposals
    (record, family_id, file_name, document_type, client_name, record_name, versions, retained_until, reason, disposed_by, disposed_by_name)
  values
    (p_record, p_family_id, p_file_name, p_document_type, p_client_name, p_record_name, cardinality(paths), p_retained_until, p_reason, p_by, p_by_name);
  return paths;
end;
$$;
revoke execute on function public.dispose_document_family(text, uuid, text, text, text, text, date, text, uuid, text) from public, anon, authenticated;
