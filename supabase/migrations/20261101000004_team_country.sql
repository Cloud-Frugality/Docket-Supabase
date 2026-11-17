-- A team's country, since teams aren't all in one country. Required on new
-- teams; '' only for older teams until a global admin sets it.
alter table public.teams
  add column country_code text not null default '' check (country_code = '' or country_code ~ '^[A-Z]{2}$');
