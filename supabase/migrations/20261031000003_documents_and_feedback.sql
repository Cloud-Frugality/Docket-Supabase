-- Documents, bug reports and feature requests.

-- ---------------------------------------------------------------- feedback
create sequence public.bug_reports_ref_seq;
create table public.bug_reports (
  id uuid primary key default gen_random_uuid(),
  ref_number bigint not null default nextval('public.bug_reports_ref_seq'),
  reference text unique,
  title text not null,
  location text not null,
  defect_type text not null,
  severity text not null,
  browser text not null,
  status text not null default 'Open',
  description text not null,
  steps_to_reproduce text,
  screenshot_path text,
  route text,
  user_agent text,
  viewport text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid
);
create index bug_reports_status_idx on public.bug_reports (status);
create index bug_reports_created_at_idx on public.bug_reports (created_at desc);
alter table public.bug_reports enable row level security;

create sequence public.feature_requests_ref_seq;
create table public.feature_requests (
  id uuid primary key default gen_random_uuid(),
  ref_number bigint not null default nextval('public.feature_requests_ref_seq'),
  reference text unique,
  title text not null,
  area text not null,
  feature_type text not null,
  impact text,
  description text not null,
  description_original text,
  status text not null default 'Open',
  vote_count integer not null default 0,
  requested_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  updated_by uuid
);
create index feature_requests_status_idx on public.feature_requests (status);
create index feature_requests_votes_idx on public.feature_requests (vote_count desc, created_at desc);
alter table public.feature_requests enable row level security;

create table public.feature_request_votes (
  id uuid primary key default gen_random_uuid(),
  feature_request_id uuid not null references public.feature_requests(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (feature_request_id, user_id)
);
create index feature_request_votes_user_idx on public.feature_request_votes (user_id);
alter table public.feature_request_votes enable row level security;

-- The reference numbers ride the ref sequence. A column default cannot read
-- another column of the same row, so these are set by trigger.
create or replace function public.set_feedback_reference()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.reference := case tg_table_name
    when 'bug_reports' then 'BUG-'
    else 'FR-'
  end || lpad(new.ref_number::text, 4, '0');
  return new;
end;
$$;

create trigger bug_reports_reference before insert on public.bug_reports
  for each row execute function public.set_feedback_reference();
create trigger feature_requests_reference before insert on public.feature_requests
  for each row execute function public.set_feedback_reference();

create or replace function public.sync_feature_request_vote_count()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.feature_requests set vote_count = vote_count + 1 where id = new.feature_request_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.feature_requests set vote_count = greatest(vote_count - 1, 0) where id = old.feature_request_id;
    return old;
  end if;
  return null;
end;
$$;

create trigger feature_request_votes_count
  after insert or delete on public.feature_request_votes
  for each row execute function public.sync_feature_request_vote_count();

-- ---------------------------------------------------------------- documents
-- Three record types carry files, all the same shape: a type, a status, an
-- optional reference and effective window, and versions sharing a family_id.
-- Remove archives; nothing is overwritten.
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      ('client_documents', 'client_id', 'public.clients'),
      ('engagement_documents', 'engagement_id', 'public.engagements'),
      ('feature_request_documents', 'feature_request_id', 'public.feature_requests')
    ) as t(tbl, fk, parent)
  loop
    execute format($f$
      create table public.%1$I (
        id uuid primary key default gen_random_uuid(),
        %2$I uuid not null references %3$s(id) on delete cascade,
        file_name text not null,
        content_type text not null,
        size_bytes bigint not null,
        storage_path text not null unique,
        document_type text not null default 'Other',
        status text not null default 'Final' check (status in ('Draft', 'Final', 'Signed')),
        reference text,
        effective_from date,
        effective_to date,
        note text,
        family_id uuid not null default gen_random_uuid(),
        version integer not null default 1 check (version >= 1),
        archived_at timestamptz,
        archived_by uuid references auth.users(id) on delete set null,
        uploaded_by uuid references auth.users(id) on delete set null,
        created_at timestamptz not null default now(),
        updated_at timestamptz,
        updated_by uuid references auth.users(id) on delete set null,
        check (effective_to is null or effective_from is null or effective_to >= effective_from),
        unique (family_id, version)
      )$f$, spec.tbl, spec.fk, spec.parent);
    execute format('create index %1$I on public.%2$I (%3$I, created_at desc)', spec.tbl || '_parent_idx', spec.tbl, spec.fk);
    execute format('create index %1$I on public.%2$I (family_id, version desc)', spec.tbl || '_family_idx', spec.tbl);
    execute format('alter table public.%I enable row level security', spec.tbl);
  end loop;
end;
$$;

-- Every engagement and client file in one list, for the Documents page.
create view public.document_register
with (security_invoker = true)
as
with files as (
  select 'engagement'::text as record, d.id, d.engagement_id as record_id, e.client_id,
         e.engagement_name as record_name, e.engagement_type::text as work_type,
         e.archived_at as record_archived_at, d.file_name, d.content_type, d.size_bytes,
         d.uploaded_by, d.created_at, d.document_type, d.status, d.reference,
         d.effective_from, d.effective_to, d.note, d.family_id, d.version,
         d.archived_at, d.updated_at, d.updated_by
    from public.engagement_documents d
    join public.engagements e on e.id = d.engagement_id
  union all
  select 'client'::text, d.id, d.client_id, d.client_id, c.company_name, null::text,
         null::timestamptz, d.file_name, d.content_type, d.size_bytes, d.uploaded_by,
         d.created_at, d.document_type, d.status, d.reference, d.effective_from,
         d.effective_to, d.note, d.family_id, d.version, d.archived_at, d.updated_at,
         d.updated_by
    from public.client_documents d
    join public.clients c on c.id = d.client_id
)
select f.*,
       c.company_name as client_name,
       (f.archived_at is null
         and f.version = max(f.version) filter (where f.archived_at is null)
               over (partition by f.record, f.family_id)) as is_latest,
       count(*) filter (where f.archived_at is null)
         over (partition by f.record, f.family_id) as version_count
  from files f
  join public.clients c on c.id = f.client_id;

-- ---------------------------------------------------------------- storage
-- Private buckets; bytes go straight to storage over signed upload URLs, and
-- these limits are the hard wall behind the app's friendly checks.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('client-documents', 'client-documents', false, 20971520, array[
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
  ('engagement-documents', 'engagement-documents', false, 20971520, array[
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
  ('feature-request-documents', 'feature-request-documents', false, 20971520, array[
    'application/pdf', 'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
  ('bug-screenshots', 'bug-screenshots', false, 5242880, array['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
on conflict (id) do nothing;
