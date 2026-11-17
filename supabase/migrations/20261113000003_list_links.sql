-- Which business units an engagement type is offered to, and which engagement
-- types and business units a document category is offered to. Nothing listed
-- means all of them, so an organisation that sets none sees no difference.
-- These replace a team picking its own categories.
create table public.engagement_type_business_units (
  engagement_type_id uuid not null references public.engagement_types(id) on delete cascade,
  business_unit_id uuid not null references public.business_units(id) on delete cascade,
  primary key (engagement_type_id, business_unit_id)
);
create index engagement_type_business_units_unit_idx on public.engagement_type_business_units (business_unit_id);

create table public.document_category_engagement_types (
  category_id uuid not null references public.document_categories(id) on delete cascade,
  engagement_type_id uuid not null references public.engagement_types(id) on delete cascade,
  primary key (category_id, engagement_type_id)
);
create index document_category_engagement_types_type_idx on public.document_category_engagement_types (engagement_type_id);

create table public.document_category_business_units (
  category_id uuid not null references public.document_categories(id) on delete cascade,
  business_unit_id uuid not null references public.business_units(id) on delete cascade,
  primary key (category_id, business_unit_id)
);
create index document_category_business_units_unit_idx on public.document_category_business_units (business_unit_id);

do $$
declare
  t text;
begin
  foreach t in array array['engagement_type_business_units', 'document_category_engagement_types', 'document_category_business_units'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "readable by signed-in users" on public.%I for select to authenticated using (true)', t);
    execute format(
      'create trigger notify_invalidate after insert or update or delete on public.%I
         for each statement execute function public.notify_invalidate()', t);
  end loop;
end;
$$;

-- An engagement type's business units, replaced in one transaction.
create or replace function public.replace_engagement_type_units(p_type_id uuid, p_unit_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.engagement_type_business_units where engagement_type_id = p_type_id;
  insert into public.engagement_type_business_units (engagement_type_id, business_unit_id)
  select distinct p_type_id, u from unnest(coalesce(p_unit_ids, '{}')) as u;
$$;

-- A document category's engagement types and business units, replaced together.
create or replace function public.replace_document_category_links(p_category_id uuid, p_type_ids uuid[], p_unit_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.document_category_engagement_types where category_id = p_category_id;
  insert into public.document_category_engagement_types (category_id, engagement_type_id)
  select distinct p_category_id, t from unnest(coalesce(p_type_ids, '{}')) as t;
  delete from public.document_category_business_units where category_id = p_category_id;
  insert into public.document_category_business_units (category_id, business_unit_id)
  select distinct p_category_id, u from unnest(coalesce(p_unit_ids, '{}')) as u;
$$;

revoke execute on function public.replace_engagement_type_units(uuid, uuid[]),
  public.replace_document_category_links(uuid, uuid[], uuid[]) from public, anon, authenticated;

-- Teams no longer pick their own categories: the business unit decides.
drop function public.save_team_settings(uuid, uuid, text, uuid[], uuid[], uuid);
drop table public.team_document_categories;

create or replace function public.save_team_settings(
  p_team_id uuid,
  p_default_entity_id uuid,
  p_email text,
  p_approver_ids uuid[],
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.teams
     set default_entity_id = p_default_entity_id, email = coalesce(p_email, ''), updated_at = now(), updated_by = p_actor
   where id = p_team_id;
  if not found then
    raise exception 'Team not found.';
  end if;
  delete from public.team_approvers where team_id = p_team_id;
  insert into public.team_approvers (team_id, profile_id, created_by)
  select distinct p_team_id, a, p_actor from unnest(coalesce(p_approver_ids, '{}')) as a;
end;
$$;
revoke execute on function public.save_team_settings(uuid, uuid, text, uuid[], uuid) from public, anon, authenticated;
