-- A delegate stands in whenever one is set: no date window.
begin;
alter table public.profiles drop constraint if exists profiles_delegate_dates;
alter table public.profiles drop column delegate_from, drop column delegate_to;
commit;
