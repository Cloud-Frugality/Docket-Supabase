-- The People permission is now called Users, after the page it opens.
begin;
update public.access_role_permissions set entity = 'Users' where entity = 'People';
commit;
