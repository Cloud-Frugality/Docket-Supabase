-- The organisation's time zone (what "today" is) and how dates are shown.
-- Both lists are kept in step with _shared/vocabularies.ts.

alter table public.organisations
  add column time_zone text not null default 'Africa/Johannesburg'
    check (time_zone in (
      'Africa/Johannesburg', 'Africa/Nairobi', 'Africa/Lagos', 'Africa/Cairo',
      'Europe/London', 'Europe/Dublin', 'Europe/Amsterdam', 'Europe/Berlin', 'Europe/Paris',
      'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo',
      'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland',
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
      'UTC'
    )),
  add column date_format text not null default 'dd MMM yyyy'
    check (date_format in ('dd MMM yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd'));

-- Today in the organisation's zone rather than a fixed one.
create or replace function public.app_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone coalesce(
    (select time_zone from public.organisations order by created_at limit 1),
    'Africa/Johannesburg'
  ))::date
$$;
