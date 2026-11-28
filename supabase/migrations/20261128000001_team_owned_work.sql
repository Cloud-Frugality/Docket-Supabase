-- Everything is a team's: Team > Client > Engagement > Folder > File. Any of them can
-- be locked, people can be added to any of them (as OneDrive does), shares run out,
-- names are unique within their parent, and a sync log records every change.
-- The design is docs/teams-and-locks.md.

-- ---------------------------------------------------------------- schema

alter table public.clients add column team_id uuid references public.teams (id) on delete restrict;
alter table public.clients add column restricted boolean not null default false;
alter table public.engagements add column restricted boolean not null default false;
-- Set when an admin last chose who sees a file: from then on its uploader can't change that.
alter table public.client_documents add column access_by_admin boolean not null default false;
alter table public.engagement_documents add column access_by_admin boolean not null default false;
create index clients_team_id_idx on public.clients (team_id);

-- The people added to an item: a client, an engagement, a folder or a file's family.
alter table public.document_access add column client_id uuid references public.clients (id) on delete cascade;
alter table public.document_access add column engagement_id uuid references public.engagements (id) on delete cascade;
alter table public.document_access add column can_edit boolean not null default true;
-- The old checks allowed only a folder or a family, and a person or a team.
alter table public.document_access drop constraint document_access_check;
alter table public.document_access drop constraint document_access_check1;
create index document_access_client_idx on public.document_access (client_id);
create index document_access_engagement_idx on public.document_access (engagement_id);

-- Shares reach the same four kinds of item, run out, and remember who gave them.
alter table public.document_shares add column client_id uuid references public.clients (id) on delete cascade;
alter table public.document_shares add column engagement_id uuid references public.engagements (id) on delete cascade;
alter table public.document_shares add column expires_at timestamptz;
alter table public.document_shares add column shared_by uuid references public.profiles (id) on delete set null;
alter table public.document_shares add column created_at timestamptz not null default now();
alter table public.document_shares drop constraint document_shares_check;
alter table public.document_shares add constraint document_shares_one_item
  check (num_nonnulls(client_id, engagement_id, folder_id, family_id) = 1);
create index document_shares_client_idx on public.document_shares (client_id);
create index document_shares_engagement_idx on public.document_shares (engagement_id);

-- ---------------------------------------------------------------- clients split per team

-- Names were unique across the organisation; the copies below share a name, so
-- this goes first and the per-team index comes further down.
alter table public.clients drop constraint clients_company_name_key;

-- Each client goes to one home team: the team owning most of its engagements, and
-- the creator's first team when it has none.
with engagement_teams as (
  select client_id, team_id, count(*) as n from public.engagements group by client_id, team_id
),
home as (
  select c.id,
         coalesce(
           (select et.team_id from engagement_teams et where et.client_id = c.id order by et.n desc, et.team_id limit 1),
           (select m.team_id from public.team_members m join public.teams t on t.id = m.team_id
             where m.user_id = c.created_by order by t.name, t.id limit 1)
         ) as team_id
    from public.clients c
)
update public.clients c set team_id = home.team_id from home where home.id = c.id;

do $$
declare
  stray int;
  pair record;
  copy_id uuid;
begin
  select count(*) into stray from public.clients where team_id is null;
  if stray > 0 then
    raise exception '% client(s) have no team to go to: place them in a team first.', stray;
  end if;

  -- Another team's engagements under a client move to that team's own copy of it.
  for pair in
    select distinct e.client_id, e.team_id
      from public.engagements e join public.clients c on c.id = e.client_id
     where e.team_id <> c.team_id
  loop
    insert into public.clients (name, country_code, industry, created_by, created_at, organisation_id, short_name,
                                primary_contact_name, primary_contact_email, updated_at, updated_by, archived_at, archived_by, team_id)
      select name, country_code, industry, created_by, created_at, organisation_id, short_name,
             primary_contact_name, primary_contact_email, updated_at, updated_by, archived_at, archived_by, pair.team_id
        from public.clients where id = pair.client_id
      returning id into copy_id;

    -- The client's legal entities come along, and its engagements point at the copies.
    create temp table entity_map on commit drop as
      select id as old_id, gen_random_uuid() as new_id from public.legal_entities where client_id = pair.client_id;
    insert into public.legal_entities (id, organisation_id, client_id, registered_name, trading_name, registration_number, tax_number,
                                       country_code, address_line_1, address_line_2, city, province, postal_code, is_default, is_active,
                                       created_at, created_by, updated_at, updated_by)
      select m.new_id, l.organisation_id, copy_id, l.registered_name, l.trading_name, l.registration_number, l.tax_number,
             l.country_code, l.address_line_1, l.address_line_2, l.city, l.province, l.postal_code, l.is_default, l.is_active,
             l.created_at, l.created_by, l.updated_at, l.updated_by
        from public.legal_entities l join entity_map m on m.old_id = l.id;
    update public.engagements e
       set client_id = copy_id,
           client_entity_id = coalesce((select m.new_id from entity_map m where m.old_id = e.client_entity_id), e.client_entity_id)
     where e.client_id = pair.client_id and e.team_id = pair.team_id;
    drop table entity_map;

    insert into public.approval_rules (client_id, category_id, group_id, created_at, created_by)
      select copy_id, category_id, group_id, created_at, created_by from public.approval_rules where client_id = pair.client_id;
  end loop;
end;
$$;

alter table public.clients alter column team_id set not null;

-- An engagement's team is its client's team, always.
create or replace function public.engagement_team_follows_client()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  select team_id into new.team_id from public.clients where id = new.client_id;
  return new;
end;
$$;
revoke execute on function public.engagement_team_follows_client() from public, anon, authenticated;
create trigger engagement_team_follows_client before insert or update of client_id, team_id on public.engagements
  for each row execute function public.engagement_team_follows_client();

-- ---------------------------------------------------------------- names unique within their parent

-- Existing clashes get " (2)", " (3)" so the unique indexes can go on.
with ranked as (
  select id, name, row_number() over (partition by team_id, lower(btrim(name)) order by created_at, id) as n
    from public.clients
)
update public.clients c set name = left(r.name, 190) || ' (' || r.n || ')' from ranked r where r.id = c.id and r.n > 1;

with ranked as (
  select id, name, row_number() over (partition by client_id, lower(btrim(name)) order by created_at, id) as n
    from public.engagements
)
update public.engagements e set name = left(r.name, 190) || ' (' || r.n || ')' from ranked r where r.id = e.id and r.n > 1;

create unique index clients_team_name on public.clients (team_id, lower(btrim(name)));
create unique index engagements_client_name on public.engagements (client_id, lower(btrim(name)));

-- A new version used to be filed with no folder, leaving the file's newest version
-- outside its (perhaps locked) folder. Every version goes back to the folder its
-- first version was put in; a move always moved every version, so that is where it belongs.
update public.client_documents d
   set folder_id = first.folder_id
  from public.client_documents first
 where first.family_id = d.family_id and first.version = 1
   and first.folder_id is not null and d.folder_id is null;
update public.engagement_documents d
   set folder_id = first.folder_id
  from public.engagement_documents first
 where first.family_id = d.family_id and first.version = 1
   and first.folder_id is not null and d.folder_id is null;

-- Files: one live family per name in a place. The later family gets the number,
-- before its extension, on every version.
do $$
declare
  t text;
  owner text;
begin
  foreach t in array array['client', 'engagement'] loop
    owner := t || '_id';
    execute format($f$
      with families as (
        select distinct on (family_id) family_id, %1$I as owner_id, folder_id, file_name, created_at
          from public.%2$I where archived_at is null order by family_id, version desc
      ),
      ranked as (
        select family_id, file_name,
               row_number() over (partition by owner_id, folder_id, lower(file_name) order by created_at, family_id) as n
          from families
      )
      update public.%2$I d
         set file_name = case when r.file_name ~ '\.[^.]+$'
                              then regexp_replace(r.file_name, '(\.[^.]+)$', ' (' || r.n || ')\1')
                              else r.file_name || ' (' || r.n || ')' end
        from ranked r
       where r.family_id = d.family_id and r.n > 1$f$, owner, t || '_documents');
  end loop;
end;
$$;

-- ---------------------------------------------------------------- people added, from today's restrictions

-- A team named on a restriction becomes its members; everyone named can edit.
insert into public.document_access (folder_id, family_id, profile_id, can_edit)
  select distinct a.folder_id, a.family_id, m.user_id, true
    from public.document_access a join public.team_members m on m.team_id = a.team_id
   where a.team_id is not null
     and not exists (select 1 from public.document_access x
                      where x.profile_id = m.user_id and x.folder_id is not distinct from a.folder_id
                        and x.family_id is not distinct from a.family_id);
delete from public.document_access where team_id is null and profile_id is null;
delete from public.document_access where team_id is not null;
-- Someone named twice on one item keeps one row.
delete from public.document_access a
 using public.document_access b
 where a.profile_id = b.profile_id
   and a.folder_id is not distinct from b.folder_id
   and a.family_id is not distinct from b.family_id
   and a.id > b.id;
alter table public.document_access drop column team_id;
alter table public.document_access alter column profile_id set not null;
alter table public.document_access add constraint document_access_one_item
  check (num_nonnulls(client_id, engagement_id, folder_id, family_id) = 1);
create unique index document_access_person_item on public.document_access
  (profile_id, coalesce(client_id, engagement_id, folder_id, family_id));

-- ---------------------------------------------------------------- the register: a client's file has its team

drop view if exists public.document_register;
create view public.document_register
with (security_invoker = true)
as
with files as (
  select 'engagement'::text as record, d.id, d.engagement_id as record_id, e.client_id,
         e.name as record_name, t.name as work_type, e.team_id,
         coalesce(e.archived_at, c.archived_at) as record_archived_at, d.file_name, d.content_type, d.size_bytes,
         d.uploaded_by, d.created_at, d.document_type, d.status, d.reference,
         d.effective_from, d.effective_to, d.note, d.family_id, d.version,
         d.archived_at, d.archived_by, d.updated_at, d.updated_by,
         d.approval_state, d.submitted_by, d.submitted_at, d.decided_by, d.decided_for, d.decided_at,
         d.decision_comment, d.on_hold, d.retain_until, d.folder_id, d.custom, d.restricted
    from public.engagement_documents d
    join public.engagements e on e.id = d.engagement_id
    join public.clients c on c.id = e.client_id
    join public.engagement_types t on t.id = e.engagement_type_id
  union all
  select 'client'::text, d.id, d.client_id, d.client_id, c.name, null::text, c.team_id,
         c.archived_at, d.file_name, d.content_type, d.size_bytes, d.uploaded_by,
         d.created_at, d.document_type, d.status, d.reference, d.effective_from,
         d.effective_to, d.note, d.family_id, d.version, d.archived_at, d.archived_by, d.updated_at,
         d.updated_by,
         d.approval_state, d.submitted_by, d.submitted_at, d.decided_by, d.decided_for, d.decided_at,
         d.decision_comment, d.on_hold, d.retain_until, d.folder_id, d.custom, d.restricted
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

-- ---------------------------------------------------------------- the rule: who sees what

-- Every client, engagement and folder, with whether this person sees it, may change it
-- (their access role still caps that), and whether a lock sits on it or above it.
-- You see an item if you are a global admin or an admin of its team, if you are added
-- to it, or if you see the item above it and it is not locked. A team's members see its
-- top level. A share works like being added, but view only and never past a lock.
create or replace function private.place_reach(p_user uuid)
returns table (kind text, id uuid, team_id uuid, record_id uuid, seen boolean, can_edit boolean, locked boolean)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive
    me as (
      select coalesce((select write_level >= 2 from public.caller_permission_levels(p_user, 'Users & Access Roles')), false) as global_admin
    ),
    member as (
      select m.team_id, m.role = 'team_admin' as team_admin from public.team_members m where m.user_id = p_user
    ),
    added as (
      select a.client_id, a.engagement_id, a.folder_id, a.can_edit from public.document_access a where a.profile_id = p_user
    ),
    shared as (
      select s.client_id, s.engagement_id, s.folder_id from public.document_shares s
       where (s.profile_id = p_user or s.team_id in (select team_id from member))
         and (s.expires_at is null or s.expires_at > now())
    ),
    boss as (
      select t.id as team_id,
             (select global_admin from me) or exists (select 1 from member m where m.team_id = t.id and m.team_admin) as is_boss,
             exists (select 1 from member m where m.team_id = t.id) as in_team
        from public.teams t
    ),
    client_places as (
      select c.id, c.team_id, c.restricted, b.is_boss, b.in_team,
             (select bool_or(a.can_edit) from added a where a.client_id = c.id) as added_edit,
             exists (select 1 from shared s where s.client_id = c.id) as is_shared
        from public.clients c join boss b on b.team_id = c.team_id
    ),
    clients_seen as (
      select id, team_id, id as record_id,
             is_boss or added_edit is not null or (in_team and not restricted) or (is_shared and not restricted) as seen,
             is_boss or coalesce(added_edit, false) or (in_team and not restricted) as can_edit,
             restricted as locked
        from client_places
    ),
    engagements_seen as (
      select e.id, e.team_id, e.id as record_id,
             b.is_boss or ae.added_edit is not null
               or (p.seen and not e.restricted)
               or (se.is_shared and not e.restricted and not p.locked) as seen,
             b.is_boss or coalesce(ae.added_edit, false) or (p.seen and not e.restricted and p.can_edit) as can_edit,
             p.locked or e.restricted as locked
        from public.engagements e
        join clients_seen p on p.id = e.client_id
        join boss b on b.team_id = e.team_id
        cross join lateral (select bool_or(a.can_edit) as added_edit from added a where a.engagement_id = e.id) ae
        cross join lateral (select exists (select 1 from shared s where s.engagement_id = e.id) as is_shared) se
    ),
    records_seen as (
      select * from clients_seen union all select * from engagements_seen
    ),
    folders_seen (id, team_id, record_id, seen, can_edit, locked) as (
      select f.id, p.team_id, p.record_id,
             b.is_boss or af.added_edit is not null
               or (p.seen and not f.restricted)
               or (sf.is_shared and not f.restricted and not p.locked),
             b.is_boss or coalesce(af.added_edit, false) or (p.seen and not f.restricted and p.can_edit),
             p.locked or f.restricted
        from public.document_folders f
        join records_seen p on p.id = coalesce(f.engagement_id, f.client_id)
        join boss b on b.team_id = p.team_id
        cross join lateral (select bool_or(a.can_edit) as added_edit from added a where a.folder_id = f.id) af
        cross join lateral (select exists (select 1 from shared s where s.folder_id = f.id) as is_shared) sf
       where f.parent_id is null
      union all
      select f.id, p.team_id, p.record_id,
             b.is_boss or af.added_edit is not null
               or (p.seen and not f.restricted)
               or (sf.is_shared and not f.restricted and not p.locked),
             b.is_boss or coalesce(af.added_edit, false) or (p.seen and not f.restricted and p.can_edit),
             p.locked or f.restricted
        from public.document_folders f
        join folders_seen p on p.id = f.parent_id
        join boss b on b.team_id = p.team_id
        cross join lateral (select bool_or(a.can_edit) as added_edit from added a where a.folder_id = f.id) af
        cross join lateral (select exists (select 1 from shared s where s.folder_id = f.id) as is_shared) sf
    )
  select 'client', id, team_id, record_id, seen, can_edit, locked from clients_seen
  union all
  select 'engagement', id, team_id, record_id, seen, can_edit, locked from engagements_seen
  union all
  select 'folder', id, team_id, record_id, seen, can_edit, locked from folders_seen
$$;
-- Policies run as the signed-in person, so they need it too, as the other private
-- helpers do. The private schema is not exposed through the API.
revoke execute on function private.place_reach(uuid) from public, anon;
grant execute on function private.place_reach(uuid) to authenticated, service_role;

-- Every file version this person sees. A file sits in its folder, or on its record when
-- it has none; its own lock, the people added to it and shares on it work as for folders,
-- and its uploader always sees it.
create or replace function public.register_for(p_user uuid)
returns setof public.document_register
language sql
stable
security definer
set search_path = ''
as $$
  with
    reach as (select * from private.place_reach(p_user)),
    me as (
      select coalesce((select write_level >= 2 from public.caller_permission_levels(p_user, 'Users & Access Roles')), false) as global_admin
    ),
    admin_teams as (select team_id from public.team_members where user_id = p_user and role = 'team_admin'),
    added as (select family_id from public.document_access where profile_id = p_user and family_id is not null),
    shared as (
      select s.family_id from public.document_shares s
       where s.family_id is not null
         and (s.profile_id = p_user or s.team_id in (select team_id from public.team_members where user_id = p_user))
         and (s.expires_at is null or s.expires_at > now())
    )
  select r.*
    from public.document_register r
    left join reach p on p.kind = case when r.folder_id is not null then 'folder' else r.record end
                     and p.id = coalesce(r.folder_id, r.record_id)
   where (select global_admin from me)
      or r.team_id in (select team_id from admin_teams)
      or r.uploaded_by = p_user
      or r.family_id in (select family_id from added)
      or (coalesce(p.seen, false) and not r.restricted)
      or (r.family_id in (select family_id from shared) and not r.restricted and not coalesce(p.locked, false))
$$;
revoke execute on function public.register_for(uuid) from public, anon, authenticated;
grant execute on function public.register_for(uuid) to service_role;

-- The clients, engagements and folders this person sees, as rows of their own tables,
-- so the functions can filter and page them like the tables.
create or replace function public.clients_for(p_user uuid)
returns setof public.clients
language sql stable security definer set search_path = ''
as $$
  select c.* from public.clients c
    join private.place_reach(p_user) p on p.kind = 'client' and p.id = c.id and p.seen
$$;
create or replace function public.engagements_for(p_user uuid)
returns setof public.engagements
language sql stable security definer set search_path = ''
as $$
  select e.* from public.engagements e
    join private.place_reach(p_user) p on p.kind = 'engagement' and p.id = e.id and p.seen
$$;
create or replace function public.folders_for(p_user uuid)
returns setof public.document_folders
language sql stable security definer set search_path = ''
as $$
  select f.* from public.document_folders f
    join private.place_reach(p_user) p on p.kind = 'folder' and p.id = f.id and p.seen
$$;
-- Every place, seen or not, with what this person may do there: for the functions' own checks.
create or replace function public.places_for(p_user uuid)
returns table (kind text, id uuid, team_id uuid, record_id uuid, seen boolean, can_edit boolean, locked boolean)
language sql stable security definer set search_path = ''
as $$
  select * from private.place_reach(p_user)
$$;
revoke execute on function public.clients_for(uuid), public.engagements_for(uuid), public.folders_for(uuid), public.places_for(uuid)
  from public, anon, authenticated;
grant execute on function public.clients_for(uuid), public.engagements_for(uuid), public.folders_for(uuid), public.places_for(uuid)
  to service_role;

-- Whether this person may change a file (their access role still caps it): a
-- global admin or an admin of its team; someone added to it, as they were added;
-- for a locked file nobody else but whoever uploaded its first version; otherwise
-- whoever may change its folder, or its record when it sits in none.
create or replace function public.file_can_edit(p_user uuid, p_record text, p_family uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  with
    file as (
      select r.team_id, r.record, r.record_id, r.folder_id, r.restricted,
             (select v.uploaded_by from public.document_register v
               where v.record = p_record and v.family_id = p_family order by v.version limit 1) as first_uploader
        from public.document_register r
       where r.record = p_record and r.family_id = p_family
       order by r.version desc
       limit 1
    ),
    added as (
      select bool_or(a.can_edit) as can_edit from public.document_access a where a.profile_id = p_user and a.family_id = p_family
    )
  select coalesce((
    select case
      when coalesce((select write_level >= 2 from public.caller_permission_levels(p_user, 'Users & Access Roles')), false) then true
      when exists (select 1 from public.team_members m where m.user_id = p_user and m.team_id = f.team_id and m.role = 'team_admin') then true
      when (select can_edit from added) is not null then (select can_edit from added)
      when f.restricted then f.first_uploader = p_user
      else (select p.can_edit from private.place_reach(p_user) p
             where p.kind = case when f.folder_id is not null then 'folder' else f.record end
               and p.id = coalesce(f.folder_id, f.record_id))
    end
    from file f), false)
$$;
revoke execute on function public.file_can_edit(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.file_can_edit(uuid, text, uuid) to service_role;

-- A new version stays where its family is: the same folder, and locked if the
-- family is, whatever the upload said.
create or replace function public.inherit_document_restriction()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  family_folder uuid;
  family_found boolean;
  already boolean;
begin
  execute format('select true, folder_id from public.%I where family_id = $1 order by version desc limit 1', tg_table_name)
    into family_found, family_folder using new.family_id;
  if family_found then
    new.folder_id := family_folder;
  end if;
  execute format('select exists (select 1 from public.%I where family_id = $1 and restricted)', tg_table_name)
    into already using new.family_id;
  if already then
    new.restricted := true;
  end if;
  execute format('select exists (select 1 from public.%I where family_id = $1 and access_by_admin)', tg_table_name)
    into already using new.family_id;
  if already then
    new.access_by_admin := true;
  end if;
  return new;
end;
$$;
revoke execute on function public.inherit_document_restriction() from public, anon, authenticated;

-- ---------------------------------------------------------------- policies: the same rule

drop policy if exists "clients readable through the Clients role" on public.clients;
create policy "clients readable through the Clients role" on public.clients
  for select to authenticated
  using (
    private.my_access_level('Clients', 'read') > 0
    and id in (select p.id from private.place_reach(auth.uid()) p where p.kind = 'client' and p.seen)
    and (private.my_access_level('Clients', 'read') = 2 or created_by = auth.uid())
  );

drop policy if exists "engagements readable through the Engagements role" on public.engagements;
create policy "engagements readable through the Engagements role" on public.engagements
  for select to authenticated
  using (
    private.my_access_level('Engagements', 'read') > 0
    and id in (select p.id from private.place_reach(auth.uid()) p where p.kind = 'engagement' and p.seen)
  );

-- ---------------------------------------------------------------- who is added, replaced whole

drop function if exists public.replace_document_access(uuid, text, uuid, boolean, uuid[], uuid[]);
-- p_kind is client, engagement, folder or file; for a file, p_id is its family and p_record its table.
create or replace function public.replace_document_access(
  p_kind text,
  p_id uuid,
  p_record text,
  p_restricted boolean,
  p_people uuid[],
  p_can_edit boolean[],
  p_by_admin boolean default false
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_kind = 'client' then
    update public.clients set restricted = p_restricted where id = p_id;
    delete from public.document_access where client_id = p_id;
  elsif p_kind = 'engagement' then
    update public.engagements set restricted = p_restricted where id = p_id;
    delete from public.document_access where engagement_id = p_id;
  elsif p_kind = 'folder' then
    update public.document_folders set restricted = p_restricted where id = p_id;
    delete from public.document_access where folder_id = p_id;
  elsif p_kind = 'file' and p_record = 'client' then
    update public.client_documents set restricted = p_restricted, access_by_admin = p_by_admin where family_id = p_id;
    delete from public.document_access where family_id = p_id;
  elsif p_kind = 'file' and p_record = 'engagement' then
    update public.engagement_documents set restricted = p_restricted, access_by_admin = p_by_admin where family_id = p_id;
    delete from public.document_access where family_id = p_id;
  else
    raise exception 'Invalid item.';
  end if;

  insert into public.document_access (client_id, engagement_id, folder_id, family_id, profile_id, can_edit)
    select case when p_kind = 'client' then p_id end,
           case when p_kind = 'engagement' then p_id end,
           case when p_kind = 'folder' then p_id end,
           case when p_kind = 'file' then p_id end,
           person, coalesce(p_can_edit[i], false)
      from unnest(p_people) with ordinality as x (person, i);
end;
$$;
revoke execute on function public.replace_document_access(text, uuid, text, boolean, uuid[], boolean[], boolean) from public, anon, authenticated;

drop function if exists public.replace_document_shares(uuid, uuid, uuid[], uuid[]);

-- ---------------------------------------------------------------- moving a file keeps who set its access

create or replace function public.move_document_family(
  p_family uuid,
  p_from text,
  p_to text,
  p_to_id uuid,
  p_folder uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  from_table text;
  to_table text;
  to_owner text;
  -- Everything a file carries with it. Its owner and folder are set apart,
  -- and its approval is left behind.
  kept constant text := 'id, file_name, content_type, size_bytes, storage_path, document_type, status, reference, '
    || 'effective_from, effective_to, note, family_id, version, archived_at, archived_by, uploaded_by, created_at, '
    || 'updated_at, updated_by, on_hold, hold_by, hold_at, custom, restricted, access_by_admin';
begin
  if p_from not in ('client', 'engagement') or p_to not in ('client', 'engagement') then
    raise exception 'Invalid record.';
  end if;
  from_table := p_from || '_documents';
  to_table := p_to || '_documents';
  to_owner := p_to || '_id';

  execute format('delete from public.document_approvals a using public.%I d where d.family_id = $1 and a.record = $2 and a.document_id = d.id', from_table)
    using p_family, p_from;

  if p_from = p_to then
    execute format(
      'update public.%I set %I = $2, folder_id = $3, approval_state = ''none'', decided_for_group = false, '
      || 'submitted_by = null, submitted_at = null, decided_by = null, decided_for = null, decided_at = null, '
      || 'decision_comment = null, retain_until = null where family_id = $1',
      to_table, to_owner)
      using p_family, p_to_id, p_folder;
  else
    -- The two tables differ only in whose file it is, so the rows go across as they are.
    execute format('insert into public.%I (%I, folder_id, %s) select $2, $3, %s from public.%I where family_id = $1', to_table, to_owner, kept, kept, from_table)
      using p_family, p_to_id, p_folder;
    execute format('delete from public.%I where family_id = $1', from_table) using p_family;
    -- Its history follows it.
    update public.document_events set record = p_to where family_id = p_family and record = p_from;
  end if;
end;
$$;
revoke execute on function public.move_document_family(uuid, text, text, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- the sync log

-- Every change to a client, engagement, folder, file or who may see them, in order,
-- so a sync client can catch up from the last id it saw.
create table public.sync_log (
  id bigserial primary key,
  team_id uuid,
  kind text not null check (kind in ('client', 'engagement', 'folder', 'file', 'access')),
  item_id uuid not null,
  action text not null check (action in ('created', 'renamed', 'moved', 'changed', 'removed', 'restored', 'deleted', 'locked')),
  at timestamptz not null default now()
);
create index sync_log_team_id_idx on public.sync_log (team_id, id);
alter table public.sync_log enable row level security;
-- Read through the functions only, like the file tables.

create or replace function public.log_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_now jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  row_before jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  item_kind text;
  item uuid;
  team uuid;
  what text;
begin
  item_kind := case tg_table_name
    when 'clients' then 'client' when 'engagements' then 'engagement' when 'document_folders' then 'folder'
    when 'document_access' then 'access' else 'file' end;
  item := case when item_kind = 'file' then (row_now ->> 'family_id')::uuid
               when item_kind = 'access' then coalesce(row_now ->> 'client_id', row_now ->> 'engagement_id',
                                                       row_now ->> 'folder_id', row_now ->> 'family_id')::uuid
               else (row_now ->> 'id')::uuid end;
  team := case
    when item_kind = 'client' then (row_now ->> 'team_id')::uuid
    when item_kind = 'engagement' then (row_now ->> 'team_id')::uuid
    when row_now ? 'engagement_id' and row_now ->> 'engagement_id' is not null
      then (select e.team_id from public.engagements e where e.id = (row_now ->> 'engagement_id')::uuid)
    when row_now ? 'client_id' and row_now ->> 'client_id' is not null
      then (select c.team_id from public.clients c where c.id = (row_now ->> 'client_id')::uuid)
    when row_now ? 'folder_id' and row_now ->> 'folder_id' is not null
      then (select coalesce(e.team_id, c.team_id) from public.document_folders f
              left join public.engagements e on e.id = f.engagement_id
              left join public.clients c on c.id = f.client_id
             where f.id = (row_now ->> 'folder_id')::uuid)
  end;
  what := case
    when tg_op = 'INSERT' then case when item_kind = 'access' then 'locked' else 'created' end
    when tg_op = 'DELETE' then case when item_kind = 'access' then 'locked' else 'deleted' end
    when item_kind = 'access' then 'locked'
    when row_now -> 'restricted' is distinct from row_before -> 'restricted' then 'locked'
    when row_before ->> 'archived_at' is null and row_now ->> 'archived_at' is not null then 'removed'
    when row_before ->> 'archived_at' is not null and row_now ->> 'archived_at' is null then 'restored'
    when coalesce(row_now ->> 'name', row_now ->> 'file_name') is distinct from coalesce(row_before ->> 'name', row_before ->> 'file_name') then 'renamed'
    when row_now -> 'parent_id' is distinct from row_before -> 'parent_id'
      or row_now -> 'folder_id' is distinct from row_before -> 'folder_id'
      or row_now -> 'client_id' is distinct from row_before -> 'client_id'
      or row_now -> 'engagement_id' is distinct from row_before -> 'engagement_id' then 'moved'
    else 'changed'
  end;
  insert into public.sync_log (team_id, kind, item_id, action) values (team, item_kind, item, what);
  return null;
end;
$$;
revoke execute on function public.log_sync() from public, anon, authenticated;

create trigger log_sync after insert or update or delete on public.clients for each row execute function public.log_sync();
create trigger log_sync after insert or update or delete on public.engagements for each row execute function public.log_sync();
create trigger log_sync after insert or update or delete on public.document_folders for each row execute function public.log_sync();
create trigger log_sync after insert or update or delete on public.client_documents for each row execute function public.log_sync();
create trigger log_sync after insert or update or delete on public.engagement_documents for each row execute function public.log_sync();
create trigger log_sync after insert or update or delete on public.document_access for each row execute function public.log_sync();
