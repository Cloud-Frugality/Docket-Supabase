-- Base schema, written from docs/reference-schema.sql.
--
-- A person and their login are one row: profiles is keyed by auth.users.id and
-- created by the sign-up trigger when an administrator invites someone.

create extension if not exists btree_gist with schema extensions;
create extension if not exists pg_cron;

-- RLS on every new public table, so a forgotten `enable row level security`
-- can never leave a table open to the browser.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  cmd record;
begin
  for cmd in
    select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name = 'public' then
      execute format('alter table if exists %s enable row level security', cmd.object_identity);
    end if;
  end loop;
end;
$$;

drop event trigger if exists ensure_rls;
create event trigger ensure_rls on ddl_command_end execute function public.rls_auto_enable();

-- The organisation's calendar day (Africa/Johannesburg), for "in force today".
create or replace function public.app_today()
returns date
language sql
stable
set search_path = ''
as $$ select (now() at time zone 'Africa/Johannesburg')::date $$;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null default '',
  last_name text not null default '',
  full_name text generated always as (trim(first_name || ' ' || last_name)) stored,
  email text not null,
  -- 'disabled' bans the login and zeroes every permission (caller_permission_levels).
  status text not null default 'active' check (status in ('active', 'disabled')),
  -- Past this date the hourly job disables the login.
  expires_at date,
  -- The person's own "offer a tidy-up when I save" setting (Text Assistance).
  ai_polish_on_save boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create unique index profiles_email_key on public.profiles (lower(email));
alter table public.profiles enable row level security;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Every new auth user gets a profile. The inviting function passes the names
-- as user metadata; anything else falls back to the email's local part.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, first_name, last_name, created_by)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'first_name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Unknown'
    ),
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'last_name'), ''), ''),
    nullif(new.raw_user_meta_data ->> 'created_by', '')::uuid
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------- access roles
create table public.access_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_system boolean not null default false,
  enabled boolean not null default true,
  landing_path text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz,
  updated_by uuid
);
alter table public.access_roles enable row level security;

create table public.access_role_permissions (
  role_id uuid not null references public.access_roles(id) on delete cascade,
  entity text not null,
  read_level smallint not null default 0 check (read_level between 0 and 2),
  write_level smallint not null default 0 check (write_level between 0 and 2),
  delete_level smallint not null default 0 check (delete_level between 0 and 2),
  primary key (role_id, entity)
);
alter table public.access_role_permissions enable row level security;

create table public.user_access_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role_id uuid not null references public.access_roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid,
  primary key (user_id, role_id)
);
create index user_access_roles_role_id_idx on public.user_access_roles (role_id);
alter table public.user_access_roles enable row level security;

-- The caller's effective levels for one entity: the max over their enabled
-- roles, and nothing at all while their profile is disabled.
create or replace function public.caller_permission_levels(p_user uuid, p_entity text)
returns table (read_level integer, write_level integer, delete_level integer)
language sql
stable
set search_path = ''
as $$
  select
    coalesce(max(p.read_level), 0)::int,
    coalesce(max(p.write_level), 0)::int,
    coalesce(max(p.delete_level), 0)::int
  from public.user_access_roles ua
  join public.access_roles r on r.id = ua.role_id and r.enabled
  join public.access_role_permissions p on p.role_id = ua.role_id and p.entity = p_entity
  where ua.user_id = p_user
    and not exists (
      select 1 from public.profiles pr where pr.id = p_user and pr.status = 'disabled'
    )
$$;

-- The last-administrator guard: how many other active people hold Users &
-- Access Roles write through an enabled role.
create or replace function public.other_active_administrators(p_exclude_user uuid, p_exclude_role uuid default null)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(distinct ua.user_id)::int
  from public.user_access_roles ua
  join public.access_roles r on r.id = ua.role_id and r.enabled
  join public.access_role_permissions p
    on p.role_id = ua.role_id
   and p.entity = 'Users & Access Roles'
   and p.write_level > 0
  join public.profiles pr on pr.id = ua.user_id and pr.status = 'active'
  where (p_exclude_user is null or ua.user_id <> p_exclude_user)
    and (p_exclude_role is null or ua.role_id <> p_exclude_role)
$$;

-- List-shaped replaces are one call, so a failed insert never leaves a role
-- granting nothing or a login with no roles.
create or replace function public.replace_role_permissions(p_role_id uuid, p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.access_role_permissions where role_id = p_role_id;
  insert into public.access_role_permissions (role_id, entity, read_level, write_level, delete_level)
  select p_role_id, r.entity, r.read_level, r.write_level, r.delete_level
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb))
      as r(entity text, read_level smallint, write_level smallint, delete_level smallint);
end;
$$;

create or replace function public.replace_user_roles(p_user_id uuid, p_role_ids uuid[], p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.user_access_roles where user_id = p_user_id;
  insert into public.user_access_roles (user_id, role_id, created_by)
  select distinct p_user_id, r, p_actor from unnest(coalesce(p_role_ids, '{}')) as r;
end;
$$;

-- ---------------------------------------------------------------- MFA helpers
create or replace function public.verified_mfa_users()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$ select distinct user_id from auth.mfa_factors where status = 'verified' $$;

create or replace function public.purge_unverified_mfa_factors(target_user uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  removed integer;
begin
  delete from auth.mfa_factors where user_id = target_user and status = 'unverified';
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- ---------------------------------------------------------------- login expiry
create or replace function public.disable_expired_users()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update auth.users u
    set banned_until = 'infinity'
  from public.profiles p
  where p.id = u.id
    and p.expires_at is not null
    and p.expires_at < public.app_today()
    and p.status <> 'disabled';

  update public.profiles
    set status = 'disabled'
  where expires_at is not null
    and expires_at < public.app_today()
    and status <> 'disabled';
end;
$$;

select cron.schedule('disable-expired-users', '0 * * * *', 'select public.disable_expired_users();');
