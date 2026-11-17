-- A person's working details, for the documents and approvals they appear in:
--
--   * job title, phone (E.164) and country: signature blocks and contact lines;
--   * employing entity: the company they sign "for and on behalf of";
--   * signing authority: whether they may sign, and up to what value (ZAR;
--     null means no limit). Needs Users & Access Roles write;
--   * approval delegate: who approves in their place, optionally between two
--     dates. Never themselves.

alter table public.profiles
  add column job_title text not null default '' check (char_length(job_title) <= 200),
  add column phone text not null default '' check (phone = '' or phone ~ '^\+[1-9][0-9]{7,14}$'),
  add column country_code text not null default '' check (country_code = '' or country_code ~ '^[A-Z]{2}$'),
  -- One of our entities (client_id null); the function checks the side.
  add column employing_entity_id uuid references public.legal_entities(id) on delete set null,
  add column can_sign boolean not null default false,
  add column signing_limit numeric check (signing_limit is null or (signing_limit > 0 and signing_limit <= 1000000000000)),
  add column delegate_id uuid references public.profiles(id) on delete set null,
  add column delegate_from date,
  add column delegate_to date,
  add constraint profiles_delegate_not_self check (delegate_id is null or delegate_id <> id),
  add constraint profiles_delegate_dates check (delegate_to is null or delegate_from is null or delegate_to >= delegate_from);
create index profiles_employing_entity_idx on public.profiles (employing_entity_id);
create index profiles_delegate_idx on public.profiles (delegate_id);
