-- The API refuses an UPDATE with no WHERE, so saving the organisation failed
-- at its last step. There is one organisation row; say so explicitly.
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
         updated_at = now(), updated_by = p_actor
   where true;
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

revoke execute on function public.save_organisation_locale(text, boolean, text, boolean, uuid)
  from public, anon, authenticated;
