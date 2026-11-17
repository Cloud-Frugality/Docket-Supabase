-- Preferences, text assistance, rate limiting, realtime and the starting
-- access roles.

-- ---------------------------------------------------------------- preferences
-- A user's view preferences (layouts, folds, density, saved filters), synced
-- from the browser so they follow the person between machines.
create table public.user_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (char_length(key) between 1 and 200),
  value text not null check (char_length(value) <= 50000),
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.user_preferences enable row level security;

-- App-wide default layouts an administrator publishes; a user's own wins.
create table public.preference_defaults (
  key text primary key check (char_length(key) between 1 and 200),
  value text not null check (char_length(value) <= 50000),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.preference_defaults enable row level security;

-- ---------------------------------------------------------------- text assistance
-- Singleton: who this organisation is, given to the text-cleanup model as
-- context before it reads a user's sentence.
create table public.ai_settings (
  id boolean primary key default true check (id),
  org_context text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.ai_settings enable row level security;
insert into public.ai_settings (id) values (true);

-- ---------------------------------------------------------------- rate limiting
create table public.rate_limit_buckets (
  key text primary key,
  tokens double precision not null,
  updated_at timestamptz not null default now()
);
alter table public.rate_limit_buckets enable row level security;

-- Token bucket: one token per mutating request, sized to stop scripts rather
-- than people.
create or replace function public.rate_limit_take(p_key text, p_capacity double precision, p_refill_per_sec double precision)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  now_ts timestamptz := now();
  cur_tokens float8;
begin
  insert into public.rate_limit_buckets as b (key, tokens, updated_at)
    values (p_key, p_capacity, now_ts)
  on conflict (key) do update set
    tokens = least(p_capacity, b.tokens + extract(epoch from (now_ts - b.updated_at)) * p_refill_per_sec),
    updated_at = now_ts
  returning tokens into cur_tokens;

  if cur_tokens >= 1 then
    update public.rate_limit_buckets set tokens = tokens - 1 where key = p_key;
    return true;
  end if;
  return false;
end
$$;

-- ---------------------------------------------------------------- realtime
-- Another user's save reaches every open session as a refetch: shared-state
-- tables broadcast their name on the private app:invalidate channel, and
-- src/hooks/use-realtime-invalidation.ts maps it to query keys.
create or replace function public.notify_invalidate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(jsonb_build_object('table', tg_table_name), 'change', 'app:invalidate', true);
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'access_roles', 'access_role_permissions', 'user_access_roles',
    'clients', 'engagements', 'engagement_administrators',
    'client_documents', 'engagement_documents', 'rate_cards'
  ] loop
    execute format(
      'create trigger notify_invalidate after insert or update or delete on public.%I
         for each statement execute function public.notify_invalidate()', t);
  end loop;
end;
$$;

create policy "authenticated receive app invalidations"
  on realtime.messages for select to authenticated
  using (realtime.topic() = 'app:invalidate' and extension = 'broadcast');

-- ---------------------------------------------------------------- lock down
-- The browser never calls these; the Edge Functions do, with the service key.
revoke execute on all functions in schema public from public, anon, authenticated;

-- ---------------------------------------------------------------- access roles
-- The built-in role. The first person in is made an Administrator by hand
-- (see README); everything after that is managed in the app.
with admin as (
  insert into public.access_roles (name, is_system) values ('Administrator', true) returning id
)
insert into public.access_role_permissions (role_id, entity, read_level, write_level, delete_level)
select admin.id, e, 2, 2, 2
  from admin, unnest(array[
    'Clients', 'Engagements', 'People', 'Rate Cards', 'Bug Reports',
    'Feature Requests', 'Users & Access Roles', 'Documents'
  ]) as e;
