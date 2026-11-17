-- Team profile and settings.
--
-- Global admins keep a team's place in the organisation: business unit,
-- region, cost centre, document reference prefix, default currency. Its team
-- admins keep how it works: email, default approvers and the document
-- categories it uses (none listed means all).

alter table public.teams
  add column business_unit text not null default '' check (char_length(business_unit) <= 100),
  add column region text not null default ''
    check (region in ('', 'Africa', 'Americas', 'Asia Pacific', 'Europe', 'Middle East')),
  add column cost_centre text not null default '' check (char_length(cost_centre) <= 50),
  -- Numbers this team's documents, e.g. CXD-SOW-0042.
  add column reference_prefix text check (reference_prefix ~ '^[A-Z0-9]{2,6}$'),
  -- '' means the organisation's (ZAR).
  add column default_currency text not null default ''
    check (default_currency in ('', 'ZAR', 'USD', 'GBP', 'EUR', 'KES', 'AED', 'AUD')),
  add column email text not null default '' check (char_length(email) <= 200);
create unique index teams_reference_prefix_key on public.teams (organisation_id, reference_prefix) where reference_prefix is not null;

-- Who signs off this team's documents unless told otherwise. Anyone active,
-- not only members: legal or finance may approve.
create table public.team_approvers (
  team_id uuid not null references public.teams(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  primary key (team_id, profile_id)
);
create index team_approvers_profile_idx on public.team_approvers (profile_id);
alter table public.team_approvers enable row level security;

-- The document categories this team works in; none listed means all.
create table public.team_document_categories (
  team_id uuid not null references public.teams(id) on delete cascade,
  category_id uuid not null references public.document_categories(id) on delete cascade,
  primary key (team_id, category_id)
);
create index team_document_categories_category_idx on public.team_document_categories (category_id);
alter table public.team_document_categories enable row level security;

-- A team admin's settings in one transaction (default entity, email,
-- approvers and categories), so a failure leaves none half saved.
create or replace function public.save_team_settings(
  p_team_id uuid,
  p_default_entity_id uuid,
  p_email text,
  p_approver_ids uuid[],
  p_category_ids uuid[],
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
  delete from public.team_document_categories where team_id = p_team_id;
  insert into public.team_document_categories (team_id, category_id)
  select distinct p_team_id, c from unnest(coalesce(p_category_ids, '{}')) as c;
end;
$$;
revoke execute on function public.save_team_settings(uuid, uuid, text, uuid[], uuid[], uuid) from public, anon, authenticated;

-- Read policies: a team's approvers and categories follow the team.
create policy "team approvers follow their team"
  on public.team_approvers for select to authenticated
  using (exists (select 1 from public.teams t where t.id = team_id));
create policy "team categories follow their team"
  on public.team_document_categories for select to authenticated
  using (exists (select 1 from public.teams t where t.id = team_id));

do $$
declare
  t text;
begin
  foreach t in array array['team_approvers', 'team_document_categories'] loop
    execute format(
      'create trigger notify_invalidate after insert or update or delete on public.%I
         for each statement execute function public.notify_invalidate()', t);
  end loop;
end;
$$;
