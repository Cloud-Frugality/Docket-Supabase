-- The organisation's default country and currency, each with a lock.
--
-- Unlocked, a default only starts a field (an engagement starts on its team's
-- country). Locked, fields stay on screen but fixed, and the functions save the
-- default whatever they're sent. Turning a lock on moves every differing record
-- onto the default in the same transaction, once the global admin confirms.
--
-- Rate cards get their own currency, starting on the organisation's.

alter table public.organisations
  add column default_country_code text not null default 'ZA' check (default_country_code ~ '^[A-Z]{2}$'),
  add column lock_country boolean not null default false,
  add column default_currency text not null default 'ZAR'
    check (default_currency in ('ZAR', 'USD', 'GBP', 'EUR', 'KES', 'AED', 'AUD')),
  add column lock_currency boolean not null default false;

alter table public.rate_cards
  add column currency text not null default 'ZAR'
    check (currency in ('ZAR', 'USD', 'GBP', 'EUR', 'KES', 'AED', 'AUD'));

-- How many records a lock would move, for the confirmation.
create or replace function public.organisation_locale_drift(p_country text, p_currency text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'country', (select count(*) from public.clients where country_code <> p_country)
             + (select count(*) from public.engagements where country_code <> p_country)
             + (select count(*) from public.teams where country_code <> p_country)
             + (select count(*) from public.profiles where country_code <> '' and country_code <> p_country)
             + (select count(*) from public.legal_entities where country_code <> '' and country_code <> p_country),
    'currency', (select count(*) from public.teams where default_currency <> '' and default_currency <> p_currency)
              + (select count(*) from public.rate_cards where currency <> p_currency)
  )
$$;

-- Save the settings. Turning a lock on moves differing records onto the
-- default in the same transaction. A blank country on a person or entity
-- stays blank.
create or replace function public.save_organisation_locale(
  p_country text,
  p_lock_country boolean,
  p_currency text,
  p_lock_currency boolean,
  p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.organisations
     set default_country_code = p_country, lock_country = p_lock_country,
         default_currency = p_currency, lock_currency = p_lock_currency,
         updated_at = now(), updated_by = p_actor;
  if p_lock_country then
    update public.clients set country_code = p_country where country_code <> p_country;
    update public.engagements set country_code = p_country where country_code <> p_country;
    update public.teams set country_code = p_country where country_code <> p_country;
    update public.profiles set country_code = p_country where country_code <> '' and country_code <> p_country;
    update public.legal_entities set country_code = p_country where country_code <> '' and country_code <> p_country;
  end if;
  if p_lock_currency then
    -- A team's '' already means the organisation's currency.
    update public.teams set default_currency = '' where default_currency <> '';
    update public.rate_cards set currency = p_currency where currency <> p_currency;
  end if;
end;
$$;

revoke execute on function public.organisation_locale_drift(text, text), public.save_organisation_locale(text, boolean, text, boolean, uuid)
  from public, anon, authenticated;

create or replace function public.save_rate_card(
  p_rate_card_id uuid,
  p_effective_from date,
  p_effective_to date,
  p_client_id uuid,
  p_engagement_type_id uuid,
  p_status text,
  p_entries jsonb,
  p_actor uuid,
  p_currency text default 'ZAR'
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
          engagement_type_id = p_engagement_type_id,
          status = p_status,
          currency = p_currency,
          updated_at = now()
      where id = v_card_id;
    if not found then
      raise exception 'Rate card not found.';
    end if;
  else
    insert into public.rate_cards (effective_from, effective_to, client_id, engagement_type_id, status, currency, created_by)
      values (p_effective_from, p_effective_to, p_client_id, p_engagement_type_id, p_status, p_currency, p_actor)
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
drop function public.save_rate_card(uuid, date, date, uuid, uuid, text, jsonb, uuid);
revoke execute on function public.save_rate_card(uuid, date, date, uuid, uuid, text, jsonb, uuid, text) from public, anon, authenticated;
