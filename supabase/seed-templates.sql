-- A sample template: an organisation Statement of Work, published as version
-- 1, with a locked clause, an AI-only section, a removable one and a rate
-- table. Run after seed.sql (scripts/seed.mjs runs both). Refuses if any
-- template exists.

do $$
declare
  v_admin uuid := (select id from public.profiles where email = 'admin@example.com');
  v_org uuid := (select id from public.organisations order by created_at limit 1);
  v_template uuid := gen_random_uuid();
begin
  if exists (select 1 from public.templates) then
    raise exception 'Seed refused: templates already exist.';
  end if;

  insert into public.templates (id, organisation_id, scope, name, description, document_category_id, engagement_type_id,
                                requires_client, requires_engagement, created_by, updated_by)
  values (v_template, v_org, 'organisation', 'Statement of Work',
          'The standard SOW for professional services work under an MSA.',
          (select id from public.document_categories where name = 'SOW'),
          (select id from public.engagement_types where name = 'Professional Services'),
          true, true, v_admin, v_admin);

  perform public.save_template_draft(v_template, $body$[
    {"key":"introduction","title":"Introduction","edit_mode":"locked","default_included":true,"include_if":null,
     "body":"This Statement of Work is entered into between **NTT** and **{client_name}** under the Master Services Agreement dated {msa_date}, and describes the services for **{engagement_name}**."},
    {"key":"scope","title":"Scope of Work","edit_mode":"ai_only","default_included":true,"include_if":null,
     "body":"{scope_summary}\n\nThe work runs from {start_date} to {end_date}."},
    {"key":"fees","title":"Fees","edit_mode":"locked","default_included":true,"include_if":null,
     "body":"Services are charged at the following rates:\n\n{rate_table}\n\nInvoices are issued {billing_frequency} and are payable within 30 days."},
    {"key":"travel","title":"Travel and Expenses","edit_mode":"removable","default_included":false,"include_if":null,
     "body":"Reasonable travel expenses are charged at cost, approved in writing beforehand."},
    {"key":"acceptance","title":"Acceptance","edit_mode":"open","default_included":true,"include_if":null,
     "body":"Each deliverable is accepted in writing by {client_contact} within ten business days of delivery."}
  ]$body$::jsonb, $fields$[
    {"key":"client_name","label":"Client Name","type":"text","required":true,"default_value":"","help_text":"The client's legal name.","options":[],"config":{},"sort_order":0,"is_orphaned":false},
    {"key":"msa_date","label":"MSA Date","type":"date","required":true,"default_value":"","help_text":"","options":[],"config":{},"sort_order":1,"is_orphaned":false},
    {"key":"engagement_name","label":"Engagement Name","type":"text","required":true,"default_value":"","help_text":"","options":[],"config":{},"sort_order":2,"is_orphaned":false},
    {"key":"scope_summary","label":"Scope Summary","type":"textarea","required":true,"default_value":"","help_text":"What is in scope, and what is not.","options":[],"config":{},"sort_order":3,"is_orphaned":false},
    {"key":"start_date","label":"Start Date","type":"date","required":true,"default_value":"","help_text":"","options":[],"config":{},"sort_order":4,"is_orphaned":false},
    {"key":"end_date","label":"End Date","type":"date","required":true,"default_value":"","help_text":"","options":[],"config":{},"sort_order":5,"is_orphaned":false},
    {"key":"rate_table","label":"Rate Table","type":"table","required":true,"default_value":"","help_text":"","options":[],"sort_order":6,"is_orphaned":false,
     "config":{"columns":[{"key":"role","label":"Role","type":"select","source":"rate_card_roles"},{"key":"grade","label":"Grade","type":"select","source":"rate_card_levels"},{"key":"rate","label":"Rate","type":"currency"},{"key":"unit","label":"Unit","type":"select","options":["hour","day","month"]},{"key":"duration","label":"Duration","type":"number"}],"allow_add_rows":true,"min_rows":1,"show_totals":["rate"]}},
    {"key":"billing_frequency","label":"Billing Frequency","type":"select","required":true,"default_value":"monthly","help_text":"","options":["monthly","on delivery","quarterly"],"config":{},"sort_order":7,"is_orphaned":false},
    {"key":"client_contact","label":"Client Contact","type":"text","required":false,"default_value":"","help_text":"Who signs off deliverables.","options":[],"config":{},"sort_order":8,"is_orphaned":false}
  ]$fields$::jsonb, v_admin);
  perform public.publish_template(v_template, v_admin);
end $$;
