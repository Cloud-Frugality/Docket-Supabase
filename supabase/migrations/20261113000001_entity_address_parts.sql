-- A legal entity's address in parts, so a template can place the city or the
-- postal code on its own and every document lays an address out the same way.
-- Free text can't be split reliably, so what was there moves into line 1 for
-- someone to tidy.
alter table public.legal_entities
  add column address_line_1 text not null default '' check (char_length(address_line_1) <= 200),
  add column address_line_2 text not null default '' check (char_length(address_line_2) <= 200),
  add column city text not null default '' check (char_length(city) <= 100),
  add column province text not null default '' check (char_length(province) <= 100),
  add column postal_code text not null default '' check (char_length(postal_code) <= 20);

update public.legal_entities
   set address_line_1 = left(regexp_replace(trim(registered_address), '\s*[\r\n]+\s*', ', ', 'g'), 200)
 where trim(registered_address) <> '';

alter table public.legal_entities drop column registered_address;
