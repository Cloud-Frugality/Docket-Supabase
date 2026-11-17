-- Documents generated from a published template version.
--
-- A document belongs to a team and points at the template version it came
-- from, never the live template. Its sections are copies of the template's with
-- the placeholders filled in. The legal entity details are copied in too, so
-- later edits to an entity don't change a document already written.

-- A short code per category for reference numbers (SOW, MSA).
alter table public.document_categories
  add column code text not null default '' check (code ~ '^[A-Z0-9]{0,10}$');
update public.document_categories set code = case name
  when 'Statement of Work' then 'SOW'
  when 'Master Services Agreement' then 'MSA'
  when 'Order Form' then 'OF'
  when 'Change Request' then 'CR'
  when 'Job Profile' then 'JP'
  when 'Non-Disclosure Agreement' then 'NDA'
  else upper(left(regexp_replace(name, '[^A-Za-z0-9]', '', 'g'), 4))
end;

-- How a team's reference numbers are built. Checked in team-rules.ts.
alter table public.teams
  add column reference_pattern text not null default '{prefix}-{category}-{year}-{seq}'
    check (char_length(reference_pattern) between 1 and 100);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete restrict,
  template_id uuid not null references public.templates(id) on delete restrict,
  template_version_id uuid not null references public.template_versions(id) on delete restrict,
  client_id uuid references public.clients(id) on delete restrict,
  engagement_id uuid references public.engagements(id) on delete restrict,
  document_category_id uuid references public.document_categories(id) on delete set null,
  title text not null check (char_length(title) between 1 and 200),
  reference_number text not null,
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'approved', 'rejected', 'final', 'superseded')),
  currency text not null check (currency in ('ZAR', 'USD', 'GBP', 'EUR', 'KES', 'AED', 'AUD')),
  field_values jsonb not null default '{}'::jsonb check (jsonb_typeof(field_values) = 'object'),
  -- The author's on/off choice for each removable section.
  included_sections jsonb not null default '{}'::jsonb check (jsonb_typeof(included_sections) = 'object'),
  our_entity jsonb,
  client_entity jsonb,
  current_version integer not null default 1,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  finalised_at timestamptz,
  unique (team_id, reference_number),
  check (engagement_id is null or client_id is not null)
);
create index documents_team_idx on public.documents (team_id, created_at desc);
create index documents_client_idx on public.documents (client_id);
create index documents_engagement_idx on public.documents (engagement_id);
create index documents_template_idx on public.documents (template_id);
alter table public.documents enable row level security;

create table public.document_sections (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  template_section_key text not null,
  sort_order integer not null,
  title text not null,
  original_text text not null,
  current_text text not null,
  edit_mode text not null check (edit_mode in ('open', 'ai_only', 'locked', 'removable')),
  is_included boolean not null default true,
  unlocked_by uuid references auth.users(id) on delete set null,
  unlocked_at timestamptz,
  unlock_reason text,
  updated_at timestamptz not null default now(),
  unique (document_id, template_section_key)
);
create index document_sections_document_idx on public.document_sections (document_id, sort_order);
alter table public.document_sections enable row level security;

-- The running number behind each reference. The function picks the scope
-- (category and year only when the team's pattern shows them).
create table public.document_number_sequences (
  team_id uuid not null references public.teams(id) on delete cascade,
  category_code text not null,
  year integer not null,
  last_value integer not null default 0,
  primary key (team_id, category_code, year)
);
alter table public.document_number_sequences enable row level security;

-- Text only changes on a draft, and never on a locked section that nobody
-- unlocked, or on a removable one.
create or replace function public.document_sections_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.current_text is distinct from old.current_text then
    if (select status from public.documents where id = new.document_id) <> 'draft' then
      raise exception 'Only a draft document can be changed.';
    end if;
    if new.edit_mode = 'removable' or (new.edit_mode = 'locked' and new.unlocked_by is null) then
      raise exception 'This section is locked.';
    end if;
  end if;
  return new;
end;
$$;
create trigger document_sections_guard before update on public.document_sections
  for each row execute function public.document_sections_guard();

-- The next running number, counted and returned in one statement so two
-- documents created at once never share one.
create or replace function public.next_document_number(p_team_id uuid, p_category_code text, p_year integer)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into public.document_number_sequences as s (team_id, category_code, year, last_value)
  values (p_team_id, p_category_code, p_year, 1)
  on conflict (team_id, category_code, year) do update set last_value = s.last_value + 1
  returning last_value
$$;

-- The document and its sections in one transaction. The function has already
-- checked everything; this only writes what it's handed.
create or replace function public.create_document(p_document jsonb, p_sections jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.documents (
    organisation_id, team_id, template_id, template_version_id, client_id, engagement_id,
    document_category_id, title, reference_number, currency, field_values, included_sections,
    our_entity, client_entity, created_by, updated_by
  )
  select d.organisation_id, d.team_id, d.template_id, d.template_version_id, d.client_id, d.engagement_id,
         d.document_category_id, d.title, d.reference_number, d.currency, d.field_values, d.included_sections,
         d.our_entity, d.client_entity, d.created_by, d.created_by
    from jsonb_to_record(p_document) as d(
      organisation_id uuid, team_id uuid, template_id uuid, template_version_id uuid, client_id uuid,
      engagement_id uuid, document_category_id uuid, title text, reference_number text, currency text,
      field_values jsonb, included_sections jsonb, our_entity jsonb, client_entity jsonb, created_by uuid)
  returning id into v_id;
  insert into public.document_sections
    (document_id, template_section_key, sort_order, title, original_text, current_text, edit_mode, is_included)
  select v_id, s.template_section_key, s.sort_order, s.title, s.original_text, s.current_text, s.edit_mode, s.is_included
    from jsonb_to_recordset(p_sections) as s(
      template_section_key text, sort_order integer, title text, original_text text, current_text text,
      edit_mode text, is_included boolean);
  return v_id;
end;
$$;

revoke execute on function public.document_sections_guard(), public.next_document_number(uuid, text, integer),
  public.create_document(jsonb, jsonb) from public, anon, authenticated;

-- Read-only second guards behind the Edge Function. All on Documents sees the
-- documents of your teams, Own the ones you created.
create policy "documents readable through the Documents role and teams"
  on public.documents for select to authenticated
  using (private.is_global_admin()
     or (private.my_access_level('Documents', 'read') = 2 and team_id in (select private.my_team_ids()))
     or (private.my_access_level('Documents', 'read') >= 1 and created_by = auth.uid()));
create policy "document sections follow their document"
  on public.document_sections for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id));

do $$
declare
  t text;
begin
  foreach t in array array['documents', 'document_sections'] loop
    execute format(
      'create trigger notify_invalidate after insert or update or delete on public.%I
         for each statement execute function public.notify_invalidate()', t);
  end loop;
end;
$$;
