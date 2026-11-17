-- A team can be made inactive. It leaves the team switcher and can't own new
-- engagements or templates; what it already owns stays, visible to its
-- members. Global admins switch it.
alter table public.teams add column is_active boolean not null default true;
