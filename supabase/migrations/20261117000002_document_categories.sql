-- Document categories come back as the list a stored file's type is picked
-- from. Global admins keep it; each category says who it is offered to, how
-- long an approved file of it is kept, and whether it carries a reference and
-- effective dates. It replaces the fixed type lists and document_retention.

create table public.document_categories (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  code text not null default '' check (code ~ '^[A-Z0-9]{0,10}$'),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  -- Binding paper (a contract, a purchase order) also takes a reference and dates.
  is_binding boolean not null default false,
  -- Years an approved file is kept; null for none.
  retention_years integer check (retention_years between 1 and 100),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null
);
create unique index document_categories_organisation_name_key on public.document_categories (organisation_id, lower(name));
alter table public.document_categories enable row level security;
create policy "document categories readable by signed-in users"
  on public.document_categories for select to authenticated using (true);

-- Who a category is offered to. Nothing listed means everyone.
create table public.document_category_engagement_types (
  category_id uuid not null references public.document_categories(id) on delete cascade,
  engagement_type_id uuid not null references public.engagement_types(id) on delete cascade,
  primary key (category_id, engagement_type_id)
);
create index document_category_engagement_types_type_idx on public.document_category_engagement_types (engagement_type_id);
alter table public.document_category_engagement_types enable row level security;

create table public.document_category_business_units (
  category_id uuid not null references public.document_categories(id) on delete cascade,
  business_unit_id uuid not null references public.business_units(id) on delete cascade,
  primary key (category_id, business_unit_id)
);
create index document_category_business_units_unit_idx on public.document_category_business_units (business_unit_id);
alter table public.document_category_business_units enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['document_categories', 'document_category_engagement_types', 'document_category_business_units'] loop
    execute format(
      'create trigger notify_invalidate after insert or update or delete on public.%I
         for each statement execute function public.notify_invalidate()', t);
  end loop;
end $$;

-- The types files could be until now, so nothing already stored loses its type.
insert into public.document_categories (organisation_id, name, sort_order, is_binding, retention_years)
select o.id, c.name, c.sort_order, c.is_binding, r.years
  from (select id from public.organisations order by created_at limit 1) o
 cross join (values
   ('RFP', 1, false), ('Proposal', 2, false), ('Proposal Content', 3, false), ('Solution Design', 4, false),
   ('Pricing Model', 5, false), ('Statement of Work', 6, true), ('Contract', 7, true),
   ('Service Level Agreement', 8, true), ('Purchase Order', 9, true), ('Change Request', 10, false),
   ('Change Variance Order', 11, true), ('Renewal', 12, true), ('Project Plan', 13, false),
   ('Status Report', 14, false), ('Meeting Minutes', 15, false), ('Acceptance Sign-off', 16, false),
   ('Handover Document', 17, false), ('Invoice', 18, false), ('Non-Disclosure Agreement', 19, true),
   ('Master Services Agreement', 20, true), ('Termination Notice', 21, false),
   ('Company Registration', 22, false), ('Other', 23, false)
 ) as c(name, sort_order, is_binding)
  left join public.document_retention r on r.document_type = c.name;

drop table public.document_retention;

-- A category's engagement types and business units, replaced together.
create or replace function public.replace_document_category_links(p_category_id uuid, p_type_ids uuid[], p_unit_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.document_category_engagement_types where category_id = p_category_id;
  insert into public.document_category_engagement_types (category_id, engagement_type_id)
  select distinct p_category_id, t from unnest(coalesce(p_type_ids, '{}')) as t;
  delete from public.document_category_business_units where category_id = p_category_id;
  insert into public.document_category_business_units (category_id, business_unit_id)
  select distinct p_category_id, u from unnest(coalesce(p_unit_ids, '{}')) as u;
end;
$$;

-- Change a category. A file stores its type by name, so a rename follows
-- through to every file of that type in the same transaction.
create or replace function public.update_document_category(
  p_category_id uuid,
  p_name text,
  p_code text,
  p_is_active boolean,
  p_is_binding boolean,
  p_actor uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  select name into v_old from public.document_categories where id = p_category_id for update;
  if not found then
    return false;
  end if;
  update public.document_categories
     set name = p_name, code = p_code, is_active = p_is_active, is_binding = p_is_binding,
         updated_at = now(), updated_by = p_actor
   where id = p_category_id;
  if v_old <> p_name then
    update public.engagement_documents set document_type = p_name where document_type = v_old;
    update public.client_documents set document_type = p_name where document_type = v_old;
  end if;
  return true;
end;
$$;

revoke execute on function
  public.replace_document_category_links(uuid, uuid[], uuid[]),
  public.update_document_category(uuid, text, text, boolean, boolean, uuid)
  from public, anon, authenticated;
