-- Clients, engagements and rate cards, without the resourcing (no seats, cost
-- structure or timesheets). Later migrations adapt these further.

create type public.industry as enum (
  'Finance', 'Healthcare', 'Insurance', 'Retail', 'Telecommunications', 'Logistics',
  'Technology', 'Energy', 'Public Sector', 'Tourism', 'Banking'
);
create type public.engagement_type as enum (
  'Professional Services', 'Managed Services', 'Proof of Concept', 'Proof of Value'
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  company_name text not null unique,
  country_code char(2) not null,
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  industry public.industry not null,
  relationship_owner_id uuid references public.profiles(id) on delete set null,
  technical_owner_id uuid references public.profiles(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index clients_relationship_owner_idx on public.clients (relationship_owner_id);
create index clients_technical_owner_idx on public.clients (technical_owner_id);
alter table public.clients enable row level security;

create table public.engagements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  engagement_name text not null,
  status text not null default 'Pipeline'
    check (status in ('Pipeline', 'Active', 'Inactive', 'Cancelled', 'On-hold')),
  engagement_type public.engagement_type not null,
  country_code char(2) not null,
  start_date date not null,
  end_date date not null,
  is_disabled boolean not null default false,
  -- Set when the engagement was disabled BY its client being disabled, so
  -- re-enabling the client restores exactly what it switched off.
  cascade_disabled boolean not null default false,
  -- Engagements archive rather than hard-delete.
  archived_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create index engagements_client_idx on public.engagements (client_id);
create index engagements_dates_idx on public.engagements (start_date, end_date);
alter table public.engagements enable row level security;

-- The people who administer an engagement; they make it "theirs" for an Own
-- grant on Engagements.
create table public.engagement_administrators (
  engagement_id uuid not null references public.engagements(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  primary key (engagement_id, profile_id)
);
create index engagement_administrators_profile_idx on public.engagement_administrators (profile_id);
alter table public.engagement_administrators enable row level security;

create or replace function public.replace_engagement_administrators(p_engagement_id uuid, p_profile_ids uuid[], p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.engagement_administrators where engagement_id = p_engagement_id;
  insert into public.engagement_administrators (engagement_id, profile_id, created_by)
  select distinct p_engagement_id, r, p_actor from unnest(coalesce(p_profile_ids, '{}')) as r;
end;
$$;

-- ---------------------------------------------------------------- rate cards
-- A dated set of role/grade rates, scoped to a (client, engagement type) pair;
-- a null client is the standard card. The card in force is the Active one
-- whose window covers today.
create table public.rate_cards (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  engagement_type text check (
    engagement_type is null
    or engagement_type in ('Professional Services', 'Managed Services', 'Proof of Concept', 'Proof of Value')
  ),
  status text not null default 'Draft' check (status in ('Draft', 'Active', 'Inactive')),
  effective_from date not null,
  effective_to date not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to >= effective_from),
  -- Two Active standard cards for the same engagement type may not overlap.
  exclude using gist (
    coalesce(engagement_type, '') with =,
    daterange(effective_from, effective_to, '[]') with &&
  ) where (status = 'Active' and client_id is null)
);
create index rate_cards_client_idx on public.rate_cards (client_id);
alter table public.rate_cards enable row level security;

create table public.rate_card_entries (
  id uuid primary key default gen_random_uuid(),
  rate_card_id uuid not null references public.rate_cards(id) on delete cascade,
  resource_role text not null,
  resource_level text not null,
  cost_rate numeric not null default 0,
  sell_rate numeric not null default 0,
  unique (rate_card_id, resource_role, resource_level)
);
create index rate_card_entries_card_idx on public.rate_card_entries (rate_card_id);
alter table public.rate_card_entries enable row level security;

-- Upsert a card and replace its rows in one transaction.
create or replace function public.save_rate_card(
  p_rate_card_id uuid,
  p_effective_from date,
  p_effective_to date,
  p_client_id uuid,
  p_engagement_type text,
  p_status text,
  p_entries jsonb,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card_id uuid := p_rate_card_id;
  v_created boolean := false;
begin
  if jsonb_array_length(coalesce(p_entries, '[]'::jsonb)) = 0 then
    raise exception 'A rate card needs at least one row.';
  end if;

  if v_card_id is not null then
    update public.rate_cards
      set effective_from = p_effective_from,
          effective_to = p_effective_to,
          client_id = p_client_id,
          engagement_type = p_engagement_type,
          status = p_status,
          updated_at = now()
      where id = v_card_id;
    if not found then
      raise exception 'Rate card not found.';
    end if;
  else
    insert into public.rate_cards (effective_from, effective_to, client_id, engagement_type, status, created_by)
      values (p_effective_from, p_effective_to, p_client_id, p_engagement_type, p_status, p_actor)
      returning id into v_card_id;
    v_created := true;
  end if;

  delete from public.rate_card_entries where rate_card_id = v_card_id;
  insert into public.rate_card_entries (rate_card_id, resource_role, resource_level, cost_rate, sell_rate)
  select v_card_id, e->>'resource_role', e->>'resource_level', (e->>'cost_rate')::numeric, (e->>'sell_rate')::numeric
    from jsonb_array_elements(p_entries) e;

  return jsonb_build_object('rateCardId', v_card_id, 'created', v_created);
end;
$$;
