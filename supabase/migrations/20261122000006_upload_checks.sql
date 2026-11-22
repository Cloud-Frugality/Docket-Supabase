-- Every upload is opened and checked before it is filed. Each check is the
-- organisation's to switch off; this lists the ones it has switched off, so a
-- check added later starts switched on.
alter table public.organisations
  add column upload_checks_off text[] not null default '{}';
