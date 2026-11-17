-- Business units become a list global admins keep in Settings, picked on each
-- team. Cost centre goes.
create table public.business_units (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null
);
create unique index business_units_organisation_name_key on public.business_units (organisation_id, lower(name));
alter table public.business_units enable row level security;

create policy "business units readable by signed-in users"
  on public.business_units for select to authenticated using (true);

create trigger notify_invalidate after insert or update or delete on public.business_units
  for each statement execute function public.notify_invalidate();

-- The units the teams already name become the starting list.
insert into public.business_units (organisation_id, name, sort_order)
select t.organisation_id, min(trim(t.business_unit)), row_number() over (partition by t.organisation_id order by lower(trim(t.business_unit)))
  from public.teams t
 where trim(t.business_unit) <> ''
 group by t.organisation_id, lower(trim(t.business_unit));

alter table public.teams
  add column business_unit_id uuid references public.business_units(id) on delete restrict;
update public.teams t
   set business_unit_id = b.id
  from public.business_units b
 where b.organisation_id = t.organisation_id and lower(b.name) = lower(trim(t.business_unit));

alter table public.teams drop column business_unit, drop column cost_centre;
