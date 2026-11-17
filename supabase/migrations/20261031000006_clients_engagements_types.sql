-- Clients, engagements and engagement types.
--
--   * client owners go; Own follows teams instead (Own on Engagements means
--     engagements a team of mine owns; Own on Clients, clients I created);
--   * clients lose Active/Inactive and archive instead, keeping their documents;
--   * engagements keep archiving and lose disabling;
--   * engagement administrators go: the owning team's admins run it;
--   * statuses map Pipeline -> prospective, Active and On-hold -> active,
--     Inactive and Cancelled -> closed;
--   * engagement types become a list global admins maintain.

-- The view reads columns this migration renames and drops; rebuilt below.
drop view if exists public.document_register;

-- ---------------------------------------------------------------- engagement types
create table public.engagement_types (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '' check (char_length(description) <= 1000),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null
);
create unique index engagement_types_organisation_name_key on public.engagement_types (organisation_id, lower(name));
alter table public.engagement_types enable row level security;

insert into public.engagement_types (organisation_id, name, sort_order)
select o.id, t.name, t.sort_order
  from (select id from public.organisations order by created_at limit 1) o,
       (values ('Professional Services', 1), ('Managed Services', 2), ('Time and Materials', 3),
               ('Proof of Concept', 4), ('Proof of Value', 5)) as t(name, sort_order);

-- ---------------------------------------------------------------- clients
alter table public.clients rename column company_name to name;
alter table public.clients
  add column organisation_id uuid references public.organisations(id) on delete cascade,
  add column short_name text not null default '' check (char_length(short_name) <= 50),
  add column registration_number text not null default '' check (char_length(registration_number) <= 100),
  add column primary_contact_name text not null default '' check (char_length(primary_contact_name) <= 200),
  add column primary_contact_email text not null default '' check (char_length(primary_contact_email) <= 200),
  add column notes text not null default '' check (char_length(notes) <= 1000),
  add column updated_at timestamptz,
  add column updated_by uuid references auth.users(id) on delete set null,
  -- Archived clients leave every list; their documents stay.
  add column archived_at timestamptz,
  add column archived_by uuid references auth.users(id) on delete set null;
update public.clients set organisation_id = (select id from public.organisations order by created_at limit 1);
alter table public.clients alter column organisation_id set not null;
alter table public.clients
  drop column relationship_owner_id,
  drop column technical_owner_id,
  drop column status;
create index clients_created_by_idx on public.clients (created_by);

-- ---------------------------------------------------------------- engagements
alter table public.engagements rename column engagement_name to name;
alter table public.engagements
  add column organisation_id uuid references public.organisations(id) on delete cascade,
  -- Restrict: a team that owns engagements cannot be deleted out from under them.
  add column team_id uuid references public.teams(id) on delete restrict,
  add column engagement_type_id uuid references public.engagement_types(id) on delete restrict,
  add column reference text not null default '' check (char_length(reference) <= 100),
  add column description text not null default '' check (char_length(description) <= 1000),
  add column updated_at timestamptz,
  add column updated_by uuid references auth.users(id) on delete set null;

update public.engagements e
   set organisation_id = (select id from public.organisations order by created_at limit 1),
       engagement_type_id = (select t.id from public.engagement_types t where t.name = e.engagement_type::text),
       -- Existing rows had no team; the oldest team takes them until reassigned.
       team_id = (select id from public.teams order by created_at limit 1);

alter table public.engagements drop constraint if exists engagements_status_check;
update public.engagements set status = case status
  when 'Pipeline' then 'prospective'
  when 'Active' then 'active'
  when 'On-hold' then 'active'
  else 'closed'
end;
alter table public.engagements
  alter column status set default 'prospective',
  add constraint engagements_status_check check (status in ('prospective', 'active', 'closed')),
  alter column organisation_id set not null,
  alter column team_id set not null,
  alter column engagement_type_id set not null;
alter table public.engagements
  drop column engagement_type,
  drop column is_disabled,
  drop column cascade_disabled;
create index engagements_team_idx on public.engagements (team_id);
create index engagements_type_idx on public.engagements (engagement_type_id);

drop table public.engagement_administrators;
drop function public.replace_engagement_administrators(uuid, uuid[], uuid);

-- ---------------------------------------------------------------- rate cards
-- A card's scope stays the pair (client, engagement type), now by type id.
alter table public.rate_cards add column engagement_type_id uuid references public.engagement_types(id) on delete restrict;
update public.rate_cards r
   set engagement_type_id = (select t.id from public.engagement_types t where t.name = r.engagement_type);
alter table public.rate_cards drop constraint rate_cards_coalesce_daterange_excl;
alter table public.rate_cards drop column engagement_type;
alter table public.rate_cards add constraint rate_cards_standard_overlap_excl exclude using gist (
  coalesce(engagement_type_id::text, '') with =,
  daterange(effective_from, effective_to, '[]') with &&
) where (status = 'Active' and client_id is null);
create index rate_cards_type_idx on public.rate_cards (engagement_type_id);

create or replace function public.save_rate_card(
  p_rate_card_id uuid,
  p_effective_from date,
  p_effective_to date,
  p_client_id uuid,
  p_engagement_type_id uuid,
  p_status text,
  p_entries jsonb,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card_id uuid := p_rate_card_id;
  v_created boolean := false;
begin
  if jsonb_array_length(coalesce(p_entries, '[]'::jsonb)) = 0 then
    raise exception 'A rate card needs at least one row.';
  end if;

  if v_card_id is not null then
    update public.rate_cards
      set effective_from = p_effective_from,
          effective_to = p_effective_to,
          client_id = p_client_id,
          engagement_type_id = p_engagement_type_id,
          status = p_status,
          updated_at = now()
      where id = v_card_id;
    if not found then
      raise exception 'Rate card not found.';
    end if;
  else
    insert into public.rate_cards (effective_from, effective_to, client_id, engagement_type_id, status, created_by)
      values (p_effective_from, p_effective_to, p_client_id, p_engagement_type_id, p_status, p_actor)
      returning id into v_card_id;
    v_created := true;
  end if;

  delete from public.rate_card_entries where rate_card_id = v_card_id;
  insert into public.rate_card_entries (rate_card_id, resource_role, resource_level, cost_rate, sell_rate)
  select v_card_id, e->>'resource_role', e->>'resource_level', (e->>'cost_rate')::numeric, (e->>'sell_rate')::numeric
    from jsonb_array_elements(p_entries) e;

  return jsonb_build_object('rateCardId', v_card_id, 'created', v_created);
end;
$$;
-- The old signature (text engagement type) goes.
drop function public.save_rate_card(uuid, date, date, uuid, text, text, jsonb, uuid);

drop type public.engagement_type;

-- ---------------------------------------------------------------- document register
-- An archived client's files stay listed (dimmed, like an archived
-- engagement's): archiving a client keeps its documents.
create view public.document_register
with (security_invoker = true)
as
with files as (
  select 'engagement'::text as record, d.id, d.engagement_id as record_id, e.client_id,
         e.name as record_name, t.name as work_type,
         coalesce(e.archived_at, c.archived_at) as record_archived_at, d.file_name, d.content_type, d.size_bytes,
         d.uploaded_by, d.created_at, d.document_type, d.status, d.reference,
         d.effective_from, d.effective_to, d.note, d.family_id, d.version,
         d.archived_at, d.updated_at, d.updated_by
    from public.engagement_documents d
    join public.engagements e on e.id = d.engagement_id
    join public.clients c on c.id = e.client_id
    join public.engagement_types t on t.id = e.engagement_type_id
  union all
  select 'client'::text, d.id, d.client_id, d.client_id, c.name, null::text,
         c.archived_at, d.file_name, d.content_type, d.size_bytes, d.uploaded_by,
         d.created_at, d.document_type, d.status, d.reference, d.effective_from,
         d.effective_to, d.note, d.family_id, d.version, d.archived_at, d.updated_at,
         d.updated_by
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

-- ---------------------------------------------------------------- helpers and policies
-- The caller's level (0 None, 1 Own, 2 All) for one entity and action, for
-- the policies below. Read-only second guards behind the Edge Functions, with
-- the access role required: a policy that ignored it would let any signed-in
-- user read around their role.
create or replace function public.my_access_level(p_entity text, p_action text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case p_action
    when 'read' then l.read_level
    when 'write' then l.write_level
    when 'delete' then l.delete_level
    else 0
  end
  from public.caller_permission_levels(auth.uid(), p_entity) l
$$;
revoke execute on function public.my_access_level(text, text), public.save_rate_card(uuid, date, date, uuid, uuid, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.my_access_level(text, text) to authenticated;

create policy "engagement types readable by signed-in users"
  on public.engagement_types for select to authenticated using (true);
create policy "clients readable through the Clients role"
  on public.clients for select to authenticated
  using (public.my_access_level('Clients', 'read') = 2
      or (public.my_access_level('Clients', 'read') = 1 and created_by = auth.uid()));
create policy "engagements readable through the Engagements role"
  on public.engagements for select to authenticated
  using (public.my_access_level('Engagements', 'read') = 2
      or (public.my_access_level('Engagements', 'read') = 1 and team_id in (select public.my_team_ids())));

create trigger notify_invalidate after insert or update or delete on public.engagement_types
  for each statement execute function public.notify_invalidate();
