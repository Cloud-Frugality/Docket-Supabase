-- How long a removed file stays in the recycle bin before it is deleted for
-- good. Null keeps it until someone deletes it by hand, which is how it starts.
alter table public.organisations
  add column bin_retention_days integer check (bin_retention_days between 1 and 3650);
