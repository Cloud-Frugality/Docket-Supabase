-- The People page is now Users, at /users.
begin;
update public.access_roles set landing_path = '/users' where landing_path = '/people';
update public.bug_reports set location = 'Users' where location = 'People';
commit;
