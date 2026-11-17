-- Who approves which kind of file. An approver group is a named set of people,
-- kept for the whole organisation (team_id null) or by one team. A rule sends
-- one document category to one group, for a team, a client or an engagement;
-- the most specific rule wins and a category with none falls back to the
-- team's default approvers. A group can ask for every member's approval, so
-- each one's is recorded until the file is settled.

create table public.approver_groups (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  -- Null: the whole organisation's, kept by global admins.
  team_id uuid references public.teams(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  -- On: every member approves. Off: any one member decides.
  requires_all boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null
);
create unique index approver_groups_scope_name_key
  on public.approver_groups (coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
alter table public.approver_groups enable row level security;

create table public.approver_group_members (
  group_id uuid not null references public.approver_groups(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  primary key (group_id, profile_id)
);
create index approver_group_members_profile_idx on public.approver_group_members (profile_id);
alter table public.approver_group_members enable row level security;

create table public.approval_rules (
  id uuid primary key default gen_random_uuid(),
  -- Exactly one of the three says whose rule it is.
  team_id uuid references public.teams(id) on delete cascade,
  client_id uuid references public.clients(id) on delete cascade,
  engagement_id uuid references public.engagements(id) on delete cascade,
  category_id uuid not null references public.document_categories(id) on delete cascade,
  group_id uuid not null references public.approver_groups(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  check (num_nonnulls(team_id, client_id, engagement_id) = 1)
);
create unique index approval_rules_team_key on public.approval_rules (team_id, category_id) where team_id is not null;
create unique index approval_rules_client_key on public.approval_rules (client_id, category_id) where client_id is not null;
create unique index approval_rules_engagement_key on public.approval_rules (engagement_id, category_id) where engagement_id is not null;
create index approval_rules_group_idx on public.approval_rules (group_id);
create index approval_rules_category_idx on public.approval_rules (category_id);
alter table public.approval_rules enable row level security;

-- One member's approval of a waiting file, where the group needs everyone's.
-- Files live in two tables, so the file is named by record and id.
create table public.document_approvals (
  record text not null check (record in ('engagement', 'client')),
  document_id uuid not null,
  -- Whose approval it is, and who gave it (their delegate, when one stood in).
  profile_id uuid not null references public.profiles(id) on delete cascade,
  approved_by uuid not null references public.profiles(id) on delete cascade,
  approved_at timestamptz not null default now(),
  primary key (record, document_id, profile_id)
);
alter table public.document_approvals enable row level security;

-- Set when one member approved for a group that needed everyone.
alter table public.engagement_documents add column decided_for_group boolean not null default false;
alter table public.client_documents add column decided_for_group boolean not null default false;

-- A deleted file takes its approvals with it.
create or replace function public.clear_document_approvals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.document_approvals where record = tg_argv[0] and document_id = old.id;
  return old;
end;
$$;
create trigger clear_document_approvals after delete on public.engagement_documents
  for each row execute function public.clear_document_approvals('engagement');
create trigger clear_document_approvals after delete on public.client_documents
  for each row execute function public.clear_document_approvals('client');

do $$
declare
  t text;
begin
  foreach t in array array['approver_groups', 'approver_group_members', 'approval_rules', 'document_approvals'] loop
    execute format(
      'create trigger notify_invalidate after insert or update or delete on public.%I
         for each statement execute function public.notify_invalidate()', t);
  end loop;
end $$;

-- Create or change a group and its members together. Null when the group
-- named isn't in the scope named.
create or replace function public.save_approver_group(
  p_group_id uuid,
  p_team_id uuid,
  p_name text,
  p_requires_all boolean,
  p_member_ids uuid[],
  p_actor uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_group_id is null then
    insert into public.approver_groups (organisation_id, team_id, name, requires_all, created_by)
    select o.id, p_team_id, p_name, p_requires_all, p_actor
      from (select id from public.organisations order by created_at limit 1) o
    returning id into v_id;
  else
    update public.approver_groups
       set name = p_name, requires_all = p_requires_all, updated_at = now(), updated_by = p_actor
     where id = p_group_id and team_id is not distinct from p_team_id
    returning id into v_id;
    if v_id is null then
      return null;
    end if;
  end if;
  delete from public.approver_group_members
   where group_id = v_id and profile_id <> all (coalesce(p_member_ids, '{}'));
  insert into public.approver_group_members (group_id, profile_id)
  select distinct v_id, m from unnest(coalesce(p_member_ids, '{}')) as m
  on conflict do nothing;
  return v_id;
end;
$$;

-- Set, change or (with no group) remove the rule for one category on one
-- team, client or engagement.
create or replace function public.set_approval_rule(
  p_scope text,
  p_id uuid,
  p_category_id uuid,
  p_group_id uuid,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.approval_rules
   where category_id = p_category_id
     and ((p_scope = 'team' and team_id = p_id)
       or (p_scope = 'client' and client_id = p_id)
       or (p_scope = 'engagement' and engagement_id = p_id));
  if p_group_id is not null then
    insert into public.approval_rules (team_id, client_id, engagement_id, category_id, group_id, created_by)
    values (
      case when p_scope = 'team' then p_id end,
      case when p_scope = 'client' then p_id end,
      case when p_scope = 'engagement' then p_id end,
      p_category_id, p_group_id, p_actor);
  end if;
end;
$$;

revoke execute on function
  public.clear_document_approvals(),
  public.save_approver_group(uuid, uuid, text, boolean, uuid[], uuid),
  public.set_approval_rule(text, uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
