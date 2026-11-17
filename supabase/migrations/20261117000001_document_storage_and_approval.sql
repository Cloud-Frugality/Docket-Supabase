-- The app becomes a document store with approval and retention. Templates,
-- documents generated from them, the text assistant and rate cards go, with
-- their data. Uploaded files gain an approval, a hold and a retention date.

-- ---------------------------------------------------------------- what goes
drop table if exists
  public.approvals,
  public.section_unlock_requests,
  public.revisions,
  public.revision_requests,
  public.document_versions,
  public.document_sections,
  public.documents,
  public.document_number_sequences,
  public.template_fields,
  public.template_versions,
  public.templates,
  public.document_category_business_units,
  public.document_category_engagement_types,
  public.document_categories,
  public.rate_card_entries,
  public.rate_cards,
  public.ai_settings
  cascade;

-- Their functions, whatever their arguments.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'approve_unlock', 'create_document', 'decide_approval', 'document_search_vector',
         'document_sections_guard', 'document_sections_search_refresh', 'documents_search_refresh',
         'next_document_number', 'publish_template', 'replace_document_category_links',
         'replace_template_file', 'resolve_revision', 'save_rate_card', 'save_template_draft',
         'set_section_included', 'submit_document', 'template_versions_immutable')
  loop
    execute format('drop function %s cascade', f.signature);
  end loop;
end $$;

delete from public.access_role_permissions where entity in ('Templates', 'Rate Cards');
update public.access_roles set landing_path = null where landing_path in ('/templates', '/rate-cards');

-- Switching clients or engagements off no longer has templates to count.
create or replace function public.organisation_module_drift()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'clients', (select count(*) from public.clients where archived_at is null),
    'engagements', (select count(*) from public.engagements where archived_at is null)
  )
$$;
revoke execute on function public.organisation_module_drift() from public, anon, authenticated;

-- ---------------------------------------------------------------- approval, hold, retention
-- One approval per file version: the uploader submits it, one of the team's
-- approvers approves it or sends it back. Approving starts its retention.
do $$
declare
  t text;
begin
  foreach t in array array['engagement_documents', 'client_documents'] loop
    execute format(
      'alter table public.%I
         add column approval_state text not null default ''none''
           check (approval_state in (''none'', ''pending'', ''approved'', ''sent_back'')),
         add column submitted_by uuid references auth.users(id) on delete set null,
         add column submitted_at timestamptz,
         add column decided_by uuid references auth.users(id) on delete set null,
         add column decided_for uuid references auth.users(id) on delete set null,
         add column decided_at timestamptz,
         add column decision_comment text,
         add column on_hold boolean not null default false,
         add column hold_by uuid references auth.users(id) on delete set null,
         add column hold_at timestamptz,
         add column retain_until date', t);
  end loop;
end $$;

-- How long an approved file of each type is kept. No row means no retention.
create table public.document_retention (
  document_type text primary key,
  years integer not null check (years between 1 and 100),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.document_retention enable row level security;
create trigger notify_invalidate after insert or update or delete on public.document_retention
  for each statement execute function public.notify_invalidate();

-- The last line of defence: a held or retained file's row cannot be deleted,
-- whoever asks and however (a cascade from its client included).
create or replace function public.retained_document_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.on_hold then
    raise exception 'This document is on hold and cannot be deleted.';
  end if;
  if old.retain_until is not null and old.retain_until > public.app_today() then
    raise exception 'This document is retained until % and cannot be deleted.', old.retain_until;
  end if;
  return old;
end;
$$;
revoke execute on function public.retained_document_guard() from public, anon, authenticated;

create trigger retained_document_guard before delete on public.engagement_documents
  for each row execute function public.retained_document_guard();
create trigger retained_document_guard before delete on public.client_documents
  for each row execute function public.retained_document_guard();

-- ---------------------------------------------------------------- document register
-- The same view with the approval, hold and retention columns, and the team
-- an engagement's file belongs to (a client's file has none).
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
         d.decision_comment, d.on_hold, d.retain_until
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
         d.decision_comment, d.on_hold, d.retain_until
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

-- ---------------------------------------------------------------- organisation locale
-- The same two functions without the rate cards they used to count and move.
create or replace function public.organisation_locale_drift(p_country text, p_currency text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'country', (select count(*) from public.clients where country_code <> p_country)
             + (select count(*) from public.engagements where country_code <> p_country)
             + (select count(*) from public.teams where country_code <> p_country)
             + (select count(*) from public.profiles where country_code <> '' and country_code <> p_country)
             + (select count(*) from public.legal_entities where country_code <> '' and country_code <> p_country),
    'currency', (select count(*) from public.teams where default_currency <> '' and default_currency <> p_currency)
  )
$$;

create or replace function public.save_organisation_locale(
  p_country text,
  p_lock_country boolean,
  p_currency text,
  p_lock_currency boolean,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.organisations
     set default_country_code = p_country, lock_country = p_lock_country,
         default_currency = p_currency, lock_currency = p_lock_currency,
         updated_at = now(), updated_by = p_actor
   where true;
  if p_lock_country then
    update public.clients set country_code = p_country where country_code <> p_country;
    update public.engagements set country_code = p_country where country_code <> p_country;
    update public.teams set country_code = p_country where country_code <> p_country;
    update public.profiles set country_code = p_country where country_code <> '' and country_code <> p_country;
    update public.legal_entities set country_code = p_country where country_code <> '' and country_code <> p_country;
  end if;
  if p_lock_currency then
    -- A team's '' already means the organisation's currency.
    update public.teams set default_currency = '' where default_currency <> '';
  end if;
end;
$$;

revoke execute on function public.organisation_locale_drift(text, text), public.save_organisation_locale(text, boolean, text, boolean, uuid)
  from public, anon, authenticated;
