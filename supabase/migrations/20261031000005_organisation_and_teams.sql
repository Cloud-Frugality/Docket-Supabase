-- Organisation, teams and team membership.
--
-- Access roles decide what a person may do; teams decide which team-owned
-- records (templates, documents) they see. A global admin is anyone with
-- Users & Access Roles write, so there's no second flag to keep in step. Team
-- admin is per team, on the membership row.

-- ---------------------------------------------------------------- organisation
-- Single-tenant for now; organisation_id is on the major tables so a second
-- tenant doesn't need a rewrite.
create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.organisations enable row level security;
insert into public.organisations (name) values ('NTT');

-- ---------------------------------------------------------------- teams
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '' check (char_length(description) <= 1000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null
);
create unique index teams_organisation_name_key on public.teams (organisation_id, lower(name));
alter table public.teams enable row level security;

create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'team_admin')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  unique (team_id, user_id)
);
create index team_members_user_idx on public.team_members (user_id);
alter table public.team_members enable row level security;

-- ---------------------------------------------------------------- helpers
-- RLS helpers about the current user (auth.uid()). The Edge Functions run as
-- the service role and ask the same questions in TypeScript; these guard the
-- policies below and the team-owned tables that follow.
create or replace function public.is_global_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select write_level > 0 from public.caller_permission_levels(auth.uid(), 'Users & Access Roles')), false)
$$;

create or replace function public.my_team_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$ select team_id from public.team_members where user_id = auth.uid() $$;

create or replace function public.is_team_admin(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_global_admin()
      or exists (
        select 1 from public.team_members
        where team_id = p_team_id and user_id = auth.uid() and role = 'team_admin'
      )
$$;

-- A team's membership is replaced in one transaction.
create or replace function public.replace_team_members(p_team_id uuid, p_rows jsonb, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.team_members where team_id = p_team_id;
  insert into public.team_members (team_id, user_id, role, created_by)
  select p_team_id, r.user_id, r.role, p_actor
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(user_id uuid, role text);
end;
$$;

-- New functions are executable by PUBLIC by default, and the earlier revoke
-- only covered what existed then. The browser may call the three helpers (the
-- policies run them as the signed-in user), never the replace.
revoke execute on function public.is_global_admin(), public.my_team_ids(), public.is_team_admin(uuid),
  public.replace_team_members(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.is_global_admin(), public.my_team_ids(), public.is_team_admin(uuid) to authenticated;

-- ---------------------------------------------------------------- policies
-- A second guard behind the Edge Functions. Read only: every write still goes
-- through team_administration.
create policy "organisation readable by signed-in users"
  on public.organisations for select to authenticated using (true);
create policy "teams readable by members and global admins"
  on public.teams for select to authenticated
  using (public.is_global_admin() or id in (select public.my_team_ids()));
create policy "team members readable by fellow members and global admins"
  on public.team_members for select to authenticated
  using (public.is_global_admin() or team_id in (select public.my_team_ids()));

-- ---------------------------------------------------------------- realtime
do $$
declare
  t text;
begin
  foreach t in array array['organisations', 'teams', 'team_members'] loop
    execute format(
      'create trigger notify_invalidate after insert or update or delete on public.%I
         for each statement execute function public.notify_invalidate()', t);
  end loop;
end;
$$;
