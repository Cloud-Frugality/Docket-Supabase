-- Sharing a folder or a file with people and teams. Someone who only sees the
-- files they uploaded can open what is shared with them, and nothing else on
-- its record. A shared folder covers everything inside it. Sharing never
-- opens something restricted: that still needs them named in document_access.
create table public.document_shares (
  id uuid primary key default gen_random_uuid(),
  -- A folder, or a file by its family so every version is covered.
  folder_id uuid references public.document_folders(id) on delete cascade,
  family_id uuid,
  -- A person, or everyone in a team.
  profile_id uuid references public.profiles(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  check ((folder_id is null) <> (family_id is null)),
  check ((profile_id is null) <> (team_id is null))
);
-- Read and written by the Edge Functions only, so no policies.
alter table public.document_shares enable row level security;
create index document_shares_folder on public.document_shares (folder_id);
create index document_shares_family on public.document_shares (family_id);
create index document_shares_profile on public.document_shares (profile_id);
create index document_shares_team on public.document_shares (team_id);

create trigger notify_invalidate after insert or update or delete on public.document_shares
  for each statement execute function public.notify_invalidate();

-- Who one folder or file is shared with, replaced whole in one transaction.
create or replace function public.replace_document_shares(
  p_folder_id uuid,
  p_family_id uuid,
  p_profile_ids uuid[],
  p_team_ids uuid[]
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_folder_id is not null then
    delete from public.document_shares where folder_id = p_folder_id;
  else
    delete from public.document_shares where family_id = p_family_id;
  end if;

  insert into public.document_shares (folder_id, family_id, profile_id)
    select p_folder_id, case when p_folder_id is null then p_family_id end, person
      from unnest(p_profile_ids) as person;
  insert into public.document_shares (folder_id, family_id, team_id)
    select p_folder_id, case when p_folder_id is null then p_family_id end, team
      from unnest(p_team_ids) as team;
end;
$$;
revoke execute on function public.replace_document_shares(uuid, uuid, uuid[], uuid[]) from public, anon, authenticated;
