-- Sample data for a fresh project. Run by scripts/seed.mjs after it has created
-- the sample people (profiles come from auth users, which SQL can't make
-- cleanly). Refuses a database that already has clients or teams.

do $$
declare
  v_admin uuid := (select id from public.profiles where email = 'admin@example.com');
  p_thandi uuid := (select id from public.profiles where email = 'thandi.mokoena@example.com');
  p_liam uuid := (select id from public.profiles where email = 'liam.oconnor@example.com');
  p_priya uuid := (select id from public.profiles where email = 'priya.naidoo@example.com');
  p_sipho uuid := (select id from public.profiles where email = 'sipho.dlamini@example.com');
  p_emma uuid := (select id from public.profiles where email = 'emma.vandermerwe@example.com');
  p_ahmed uuid := (select id from public.profiles where email = 'ahmed.patel@example.com');
  v_org uuid := (select id from public.organisations order by created_at limit 1);
  t_cx uuid; t_marketing uuid; t_hr uuid;
  u_consulting uuid; u_marketing uuid; u_people uuid;
  ty_ps uuid := (select id from public.engagement_types where name = 'Professional Services');
  ty_ms uuid := (select id from public.engagement_types where name = 'Managed Services');
  ty_poc uuid := (select id from public.engagement_types where name = 'Proof of Concept');
  ty_pov uuid := (select id from public.engagement_types where name = 'Proof of Value');
  c_meridian uuid; c_harbour uuid; c_northwind uuid; c_atlas uuid;
  c_kestrel uuid; c_solace uuid; c_brightmart uuid; c_civitas uuid;
  card uuid;
begin
  if exists (select 1 from public.clients) or exists (select 1 from public.teams) then
    raise exception 'Seed refused: clients or teams already exist.';
  end if;
  if v_admin is null or p_ahmed is null then
    raise exception 'Seed refused: run scripts/seed.mjs so the people exist first.';
  end if;

  -- ------------------------------------------------------------ teams
  -- Three teams, each with a team admin.
  insert into public.business_units (organisation_id, name, sort_order) values (v_org, 'Consulting', 1) returning id into u_consulting;
  insert into public.business_units (organisation_id, name, sort_order) values (v_org, 'Marketing', 2) returning id into u_marketing;
  insert into public.business_units (organisation_id, name, sort_order) values (v_org, 'People', 3) returning id into u_people;
  insert into public.teams (organisation_id, name, country_code, business_unit_id, region, reference_prefix, created_by)
    values (v_org, 'CX & Design', 'ZA', u_consulting, 'Africa', 'CXD', v_admin) returning id into t_cx;
  insert into public.teams (organisation_id, name, country_code, business_unit_id, region, reference_prefix, default_currency, created_by)
    values (v_org, 'Marketing', 'GB', u_marketing, 'Europe', 'MKT', 'GBP', v_admin) returning id into t_marketing;
  insert into public.teams (organisation_id, name, country_code, business_unit_id, region, reference_prefix, created_by)
    values (v_org, 'HR', 'ZA', u_people, 'Africa', 'HR', v_admin) returning id into t_hr;
  insert into public.team_members (team_id, user_id, role, created_by) values
    (t_cx, v_admin, 'team_admin', v_admin), (t_cx, p_thandi, 'team_admin', v_admin),
    (t_cx, p_liam, 'member', v_admin), (t_cx, p_emma, 'member', v_admin),
    (t_marketing, p_priya, 'team_admin', v_admin), (t_marketing, p_sipho, 'member', v_admin),
    (t_marketing, v_admin, 'member', v_admin),
    (t_hr, p_ahmed, 'team_admin', v_admin);

  -- ------------------------------------------------------------ clients
  insert into public.clients (organisation_id, name, short_name, country_code, industry, primary_contact_name, primary_contact_email, created_by)
    values (v_org, 'Meridian Bank', 'MB', 'ZA', 'Banking', 'Ana Ferreira', 'ana.ferreira@meridian.example', v_admin) returning id into c_meridian;
  insert into public.clients (organisation_id, name, short_name, country_code, industry, created_by)
    values (v_org, 'Harbourline Logistics', 'HL', 'ZA', 'Logistics', v_admin) returning id into c_harbour;
  insert into public.clients (organisation_id, name, short_name, country_code, industry, primary_contact_name, primary_contact_email, created_by)
    values (v_org, 'Northwind Health', 'NWH', 'GB', 'Healthcare', 'Oliver Grant', 'oliver.grant@northwind.example', v_admin) returning id into c_northwind;
  insert into public.clients (organisation_id, name, country_code, industry, created_by)
    values (v_org, 'Atlas Insurance Group', 'ZA', 'Insurance', v_admin) returning id into c_atlas;
  insert into public.clients (organisation_id, name, country_code, industry, created_by)
    values (v_org, 'Kestrel Telecom', 'KE', 'Telecommunications', v_admin) returning id into c_kestrel;
  insert into public.clients (organisation_id, name, country_code, industry, created_by)
    values (v_org, 'Solace Energy', 'AE', 'Energy', v_admin) returning id into c_solace;
  -- Archived: no work in a while, documents kept.
  insert into public.clients (organisation_id, name, country_code, industry, archived_at, archived_by, created_by)
    values (v_org, 'Brightmart Retail', 'ZA', 'Retail', now(), v_admin, v_admin) returning id into c_brightmart;
  insert into public.clients (organisation_id, name, country_code, industry, created_by)
    values (v_org, 'Civitas Public Services', 'GB', 'Public Sector', v_admin) returning id into c_civitas;

  -- ------------------------------------------------------------ legal entities
  -- Every client's default entity, named after it (the app makes one on
  -- create); Meridian also contracts through a second group company and trades
  -- under a shorter name. Ours: two companies, one the default, with sample
  -- numbers and addresses for a global admin to replace.
  insert into public.legal_entities (organisation_id, client_id, registered_name, country_code, is_default, created_by)
    select v_org, c.id, c.name, c.country_code, true, v_admin from public.clients c;
  update public.legal_entities set registered_name = 'Meridian Bank Limited', trading_name = 'Meridian Bank',
    registration_number = '1951/000009/06', tax_number = '4000123456' where client_id = c_meridian;
  insert into public.legal_entities (organisation_id, client_id, registered_name, trading_name, registration_number, country_code, created_by)
    values (v_org, c_meridian, 'Meridian Insurance (Pty) Ltd', 'Meridian Insure', '2004/012345/07', 'ZA', v_admin);
  update public.legal_entities set registration_number = '2009/123456/07' where client_id = c_atlas;
  insert into public.legal_entities (organisation_id, client_id, registered_name, registration_number, tax_number, address_line_1, country_code, is_default, created_by) values
    (v_org, null, 'NTT Ltd', 'SAMPLE-0001', 'SAMPLE-TAX-0001', 'Sample address: replace with the registered address', 'GB', true, v_admin),
    (v_org, null, 'NTT Data South Africa (Pty) Ltd', 'SAMPLE-0002', 'SAMPLE-TAX-0002', 'Sample address: replace with the registered address', 'ZA', false, v_admin);

  -- People's working details: phones, countries and the company each
  -- signs for. Phones are sample numbers.
  update public.profiles p set phone = d.ph, country_code = d.c,
         employing_entity_id = (select id from public.legal_entities where client_id is null and registered_name = d.e)
    from (values
      ('admin@example.com', 'Practice Head', '', 'ZA', 'NTT Data South Africa (Pty) Ltd'),
      ('thandi.mokoena@example.com', 'Client Director', '+27820000001', 'ZA', 'NTT Data South Africa (Pty) Ltd'),
      ('liam.oconnor@example.com', 'Solutions Architect', '+447700900001', 'GB', 'NTT Ltd'),
      ('priya.naidoo@example.com', 'Marketing Lead', '+27820000002', 'ZA', 'NTT Data South Africa (Pty) Ltd'),
      ('sipho.dlamini@example.com', 'Account Manager', '+254700000001', 'KE', 'NTT Ltd'),
      ('emma.vandermerwe@example.com', 'UX Designer', '+447700900002', 'GB', 'NTT Ltd'),
      ('ahmed.patel@example.com', 'HR Business Partner', '+27820000003', 'ZA', 'NTT Data South Africa (Pty) Ltd')
    ) as d(email, t, ph, c, e)
   where p.email = d.email;
  update public.profiles set can_sign = true, signing_limit = 5000000 where email = 'thandi.mokoena@example.com';
  update public.profiles set can_sign = true where email = 'admin@example.com';

  -- ------------------------------------------------------------ engagements
  insert into public.engagements (organisation_id, client_id, team_id, engagement_type_id, name, reference, status, country_code, start_date, end_date, created_by) values
    (v_org, c_meridian, t_cx, ty_ps, 'Digital Onboarding Platform', 'SOW-1001', 'active', 'ZA', '2026-03-01', '2027-02-28', v_admin),
    (v_org, c_meridian, t_cx, ty_ms, 'Core Banking Support', 'MSA-0420', 'active', 'ZA', '2026-01-01', '2028-12-31', v_admin),
    (v_org, c_meridian, t_cx, ty_poc, 'Fraud Analytics Pilot', '', 'prospective', 'ZA', '2027-01-15', '2027-04-15', v_admin),
    (v_org, c_harbour, t_marketing, ty_ps, 'Fleet Tracking Rebuild', 'SOW-1002', 'active', 'ZA', '2026-06-01', '2027-05-31', v_admin),
    (v_org, c_harbour, t_marketing, ty_ms, 'Warehouse Systems Support', '', 'active', 'ZA', '2026-02-01', '2027-01-31', v_admin),
    (v_org, c_northwind, t_cx, ty_pov, 'Patient Portal Discovery', 'POV-0007', 'active', 'GB', '2026-09-01', '2026-12-15', v_admin),
    (v_org, c_northwind, t_cx, ty_ps, 'Clinical Records Integration', '', 'prospective', 'GB', '2027-02-01', '2027-11-30', v_admin),
    (v_org, c_atlas, t_hr, ty_ps, 'Claims Automation', 'SOW-1003', 'active', 'ZA', '2026-04-01', '2026-12-31', v_admin),
    (v_org, c_atlas, t_hr, ty_ps, 'Broker Portal Refresh', '', 'closed', 'ZA', '2026-01-15', '2026-07-15', v_admin),
    (v_org, c_kestrel, t_marketing, ty_ms, 'Network Operations Centre', 'MSA-0421', 'active', 'KE', '2025-11-01', '2027-10-31', v_admin),
    (v_org, c_kestrel, t_marketing, ty_poc, '5G Billing Proof of Concept', '', 'prospective', 'KE', '2027-01-05', '2027-03-31', v_admin),
    (v_org, c_solace, t_marketing, ty_ps, 'Grid Monitoring Dashboard', 'SOW-1004', 'active', 'AE', '2026-07-01', '2027-03-31', v_admin),
    (v_org, c_brightmart, t_cx, ty_ps, 'Loyalty App', 'SOW-0900', 'closed', 'ZA', '2025-03-01', '2025-11-30', v_admin),
    (v_org, c_civitas, t_cx, ty_ps, 'Citizen Services Portal', 'SOW-1005', 'active', 'GB', '2026-05-01', '2027-04-30', v_admin);

  -- ------------------------------------------------------------ rate cards
  -- Hourly cost and sell per role and level; sell is cost plus a margin.
  insert into public.rate_cards (client_id, engagement_type_id, status, effective_from, effective_to, created_by)
    values (null, ty_ps, 'Active', '2026-01-01', '2026-12-31', v_admin) returning id into card;
  insert into public.rate_card_entries (rate_card_id, resource_role, resource_level, cost_rate, sell_rate)
  select card, r, l, base * m, round(base * m * 1.65)
    from (values ('Developer', 600), ('Business Analyst', 620), ('Project Manager', 700), ('Architect', 900)) as roles(r, base),
         (values ('Junior', 1.0), ('Intermediate', 1.35), ('Senior', 1.75)) as levels(l, m);

  insert into public.rate_cards (client_id, engagement_type_id, status, effective_from, effective_to, created_by)
    values (null, ty_ms, 'Active', '2026-01-01', '2026-12-31', v_admin) returning id into card;
  insert into public.rate_card_entries (rate_card_id, resource_role, resource_level, cost_rate, sell_rate)
  select card, r, l, base * m, round(base * m * 1.5)
    from (values ('Support Engineer', 450), ('Service Delivery Manager', 750), ('Operations Manager', 800)) as roles(r, base),
         (values ('Junior', 1.0), ('Intermediate', 1.3), ('Senior', 1.6)) as levels(l, m);

  -- Meridian's negotiated card, and next year's standard card still in draft.
  insert into public.rate_cards (client_id, engagement_type_id, status, effective_from, effective_to, created_by)
    values (c_meridian, ty_ps, 'Active', '2026-03-01', '2027-02-28', v_admin) returning id into card;
  insert into public.rate_card_entries (rate_card_id, resource_role, resource_level, cost_rate, sell_rate)
  select card, r, l, base * m, round(base * m * 1.5)
    from (values ('Developer', 600), ('Architect', 900), ('Product Owner', 680)) as roles(r, base),
         (values ('Intermediate', 1.35), ('Senior', 1.75)) as levels(l, m);

  insert into public.rate_cards (client_id, engagement_type_id, status, effective_from, effective_to, created_by)
    values (null, ty_ps, 'Draft', '2027-01-01', '2027-12-31', v_admin) returning id into card;
  insert into public.rate_card_entries (rate_card_id, resource_role, resource_level, cost_rate, sell_rate)
  select card, r, l, round(base * m * 1.06), round(base * m * 1.06 * 1.65)
    from (values ('Developer', 600), ('Business Analyst', 620), ('Project Manager', 700), ('Architect', 900)) as roles(r, base),
         (values ('Junior', 1.0), ('Intermediate', 1.35), ('Senior', 1.75)) as levels(l, m);

  -- ------------------------------------------------------------ feedback
  insert into public.bug_reports (title, location, defect_type, severity, browser, status, description, steps_to_reproduce, route, created_by) values
    ('Engagement end date accepts a date before the start', 'Engagement Management', 'Functionality', 'Medium', 'Edge', 'Open',
     'The drawer lets me pick an end date earlier than the start date and only complains on save.',
     'Open an engagement, set the end date before the start date, press Save Changes.', '/engagements', p_liam),
    ('Client filter chips overflow on narrow screens', 'Client Management', 'UI / Visual', 'Low', 'Chrome', 'Open',
     'With four or more filters applied the chips run off the right edge at tablet width.', null, '/clients', p_emma);

  insert into public.feature_requests (title, area, feature_type, impact, description, status, requested_by) values
    ('Export the client list to Excel', 'Client Management', 'Reporting', 'Would save time',
     'A one-click export of the filtered client list for monthly account reviews.', 'Open', p_thandi),
    ('Show engagement value on the card', 'Engagement Management', 'Enhancement', 'Nice to have',
     'Seeing the contract value at a glance would help when prioritising.', 'Under Review', p_sipho);
  insert into public.feature_request_votes (feature_request_id, user_id)
    select fr.id, u from public.feature_requests fr, unnest(array[p_liam, p_priya, v_admin]) as u
    where fr.title = 'Export the client list to Excel';
end $$;
