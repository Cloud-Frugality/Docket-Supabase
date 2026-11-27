-- A global admin is someone with Users & Access Roles write at All. Own there is
-- refused when a role is saved, but a stray one must not lift every restriction.
create or replace function private.is_global_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select write_level >= 2 from public.caller_permission_levels(auth.uid(), 'Users & Access Roles')), false)
$$;
