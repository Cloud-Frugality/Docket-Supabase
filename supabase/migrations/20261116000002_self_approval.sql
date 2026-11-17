-- Whether someone may approve a document they wrote. Off by default, so a
-- second person always signs off unless the organisation says otherwise.
alter table public.organisations
  add column allow_self_approval boolean not null default false;
