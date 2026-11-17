-- Move the policy helpers out of the API.
--
-- They're security definer and executable by signed-in users because the RLS
-- policies call them as the user, but in `public` they were also callable via
-- /rest/v1/rpc. A schema PostgREST doesn't expose keeps them usable by the
-- policies (which hold them by OID, so the policies are unaffected) and out of
-- the API.

create schema if not exists private;
grant usage on schema private to authenticated;

alter function public.is_global_admin() set schema private;
alter function public.my_team_ids() set schema private;
alter function public.my_access_level(text, text) set schema private;
alter function public.is_team_admin(uuid) set schema private;

-- is_team_admin names is_global_admin in its body, by schema, so it follows.
create or replace function private.is_team_admin(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_global_admin()
      or exists (
        select 1 from public.team_members
        where team_id = p_team_id and user_id = auth.uid() and role = 'team_admin'
      )
$$;
