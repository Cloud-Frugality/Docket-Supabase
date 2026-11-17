-- The Workforce page is now People, at /people. Job titles are dropped: they
-- drift from the directory and people's real roles.
begin;
update public.access_roles set landing_path = '/people' where landing_path = '/workforce';
update public.bug_reports set location = 'People' where location = 'Workforce Management';
alter table public.profiles drop column job_title;
commit;
