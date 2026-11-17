-- Legal entities.
--
-- A client is a relationship; a contract or invoice is with a legal entity.
-- One table holds both sides:
--   * client_id null: one of our entities, kept by global admins. A team picks
--     a default; with none, the organisation default.
--   * client_id set: one of that client's entities (a group may contract
--     through several). One per client is the default.
-- An engagement may name either side's entity; null means the default.
--
-- Clients lose `notes` and `registration_number`, which moves onto each
-- client's default entity, named after the client.

create table public.legal_entities (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  -- Null: one of ours.
  client_id uuid references public.clients(id) on delete cascade,
  registered_name text not null check (char_length(registered_name) between 1 and 200),
  -- "Trading as", when it differs from the registered name.
  trading_name text not null default '' check (char_length(trading_name) <= 200),
  registration_number text not null default '' check (char_length(registration_number) <= 100),
  tax_number text not null default '' check (char_length(tax_number) <= 100),
  registered_address text not null default '' check (char_length(registered_address) <= 1000),
  country_code text not null default '' check (country_code = '' or country_code ~ '^[A-Z]{2}$'),
  is_default boolean not null default false,
  -- Switched off rather than deleted once anything names it.
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  -- A default is always a live entity.
  check (not is_default or is_active)
);
create unique index legal_entities_owner_name_key
  on public.legal_entities (organisation_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(registered_name));
-- One default per side: per client, and one of ours.
create unique index legal_entities_one_client_default on public.legal_entities (client_id) where is_default and client_id is not null;
create unique index legal_entities_one_own_default on public.legal_entities (organisation_id) where is_default and client_id is null;
create index legal_entities_client_idx on public.legal_entities (client_id);
alter table public.legal_entities enable row level security;

-- Make one entity its side's default in one transaction, so the one-default
-- indexes never see two.
create or replace function public.set_default_legal_entity(p_entity_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_client uuid;
begin
  select organisation_id, client_id into v_org, v_client from public.legal_entities where id = p_entity_id and is_active;
  if v_org is null then
    raise exception 'Entity not found, or switched off.';
  end if;
  update public.legal_entities
     set is_default = false, updated_at = now(), updated_by = p_actor
   where organisation_id = v_org and client_id is not distinct from v_client and is_default and id <> p_entity_id;
  update public.legal_entities
     set is_default = true, updated_at = now(), updated_by = p_actor
   where id = p_entity_id;
end;
$$;
revoke execute on function public.set_default_legal_entity(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- clients
-- Every client gets a default entity named after it, carrying the number it had.
insert into public.legal_entities (organisation_id, client_id, registered_name, registration_number, country_code, is_default, created_by)
select c.organisation_id, c.id, c.name, c.registration_number, c.country_code, true, c.created_by
  from public.clients c;
alter table public.clients drop column registration_number, drop column notes;

-- ---------------------------------------------------------------- defaults and choices
alter table public.teams
  add column default_entity_id uuid references public.legal_entities(id) on delete set null;
alter table public.engagements
  add column our_entity_id uuid references public.legal_entities(id),
  add column client_entity_id uuid references public.legal_entities(id);
create index engagements_our_entity_idx on public.engagements (our_entity_id);
create index engagements_client_entity_idx on public.engagements (client_entity_id);

-- ---------------------------------------------------------------- policies
-- Our entities appear in every team's documents; a client's follow the
-- Clients role, as the client does.
create policy "own legal entities readable by signed-in users"
  on public.legal_entities for select to authenticated
  using (client_id is null);
create policy "client legal entities follow the client"
  on public.legal_entities for select to authenticated
  using (client_id is not null and exists (select 1 from public.clients c where c.id = client_id));

create trigger notify_invalidate after insert or update or delete on public.legal_entities
  for each statement execute function public.notify_invalidate();

-- The view still names notes nowhere; nothing else reads the dropped columns.
