-- Templates.
--
-- A template is a body of sections whose Markdown carries {field_key}
-- placeholders, and the input form comes from those placeholders. The row is
-- the working draft (body plus its template_fields rows); publishing freezes
-- both into an immutable template_versions row, and documents only point at a
-- version.
--
-- The fork columns exist but nothing forks yet. The "no edit-mode change on a
-- fork's section unless global admin" rule is enforced in template-rules.ts,
-- because the functions write as the service role and a trigger on auth.uid()
-- couldn't tell callers apart.

-- ---------------------------------------------------------------- categories
create table public.document_categories (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null
);
create unique index document_categories_organisation_name_key on public.document_categories (organisation_id, lower(name));
alter table public.document_categories enable row level security;

insert into public.document_categories (organisation_id, name, sort_order)
select o.id, c.name, c.sort_order
  from (select id from public.organisations order by created_at limit 1) o,
       (values ('SOW', 1), ('MSA', 2), ('Order Form', 3), ('Change Request', 4), ('Job Profile', 5), ('NDA', 6)) as c(name, sort_order);

-- ---------------------------------------------------------------- templates
create table public.templates (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  -- Null for an organisation template.
  team_id uuid references public.teams(id) on delete restrict,
  scope text not null check (scope in ('organisation', 'team')),
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '' check (char_length(description) <= 1000),
  document_category_id uuid references public.document_categories(id) on delete restrict,
  -- Null: applies to any engagement type (NDAs, change requests).
  engagement_type_id uuid references public.engagement_types(id) on delete restrict,
  requires_client boolean not null default false,
  requires_engagement boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  -- The latest published version; 0 until the first publish.
  current_version integer not null default 0 check (current_version >= 0),
  -- The working draft: an ordered array of sections (template-rules.ts).
  body jsonb not null default '[]'::jsonb check (jsonb_typeof(body) = 'array'),
  -- The draft differs from the latest published version.
  has_unpublished_changes boolean not null default true,
  forked_from_template_id uuid references public.templates(id) on delete set null,
  forked_from_version integer,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check ((scope = 'organisation' and team_id is null) or (scope = 'team' and team_id is not null)),
  -- An engagement can only be picked under its client.
  check (not requires_engagement or requires_client)
);
create unique index templates_scope_name_key
  on public.templates (organisation_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index templates_team_idx on public.templates (team_id);
create index templates_category_idx on public.templates (document_category_id);
create index templates_type_idx on public.templates (engagement_type_id);
alter table public.templates enable row level security;

create table public.template_fields (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  label text not null check (char_length(label) between 1 and 200),
  type text not null default 'text'
    check (type in ('text', 'textarea', 'number', 'currency', 'date', 'select', 'multi_select', 'boolean', 'table')),
  required boolean not null default false,
  default_value text not null default '' check (char_length(default_value) <= 5000),
  help_text text not null default '' check (char_length(help_text) <= 1000),
  options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  sort_order integer not null default 0,
  -- Its placeholder left the body; the template can't publish until the author
  -- restores the placeholder or confirms the deletion.
  is_orphaned boolean not null default false,
  unique (template_id, key)
);
alter table public.template_fields enable row level security;

create table public.template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates(id) on delete cascade,
  version integer not null check (version > 0),
  body jsonb not null,
  fields jsonb not null,
  published_by uuid references auth.users(id) on delete set null,
  published_at timestamptz not null default now(),
  unique (template_id, version)
);
alter table public.template_versions enable row level security;

-- A published version is immutable: documents point at it.
create or replace function public.template_versions_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'A published template version cannot be changed.';
end;
$$;
create trigger template_versions_no_update before update on public.template_versions
  for each row execute function public.template_versions_immutable();

-- ---------------------------------------------------------------- writes
-- The draft's body and its whole field set in one transaction. The caller has
-- already reconciled the fields against the body's placeholders; this only
-- writes what it's handed.
create or replace function public.save_template_draft(p_template_id uuid, p_body jsonb, p_fields jsonb, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.templates
     set body = p_body, has_unpublished_changes = true, updated_at = now(), updated_by = p_actor
   where id = p_template_id;
  if not found then
    raise exception 'Template not found.';
  end if;
  delete from public.template_fields where template_id = p_template_id;
  insert into public.template_fields
    (template_id, key, label, type, required, default_value, help_text, options, config, sort_order, is_orphaned)
  select p_template_id, f.key, f.label, f.type, f.required, f.default_value, f.help_text,
         f.options, f.config, f.sort_order, f.is_orphaned
    from jsonb_to_recordset(coalesce(p_fields, '[]'::jsonb)) as f(
      key text, label text, type text, required boolean, default_value text, help_text text,
      options jsonb, config jsonb, sort_order integer, is_orphaned boolean);
end;
$$;

-- Freeze the draft as the next version. Refuses orphaned fields (the
-- function says why first; this is the backstop).
create or replace function public.publish_template(p_template_id uuid, p_actor uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  if exists (select 1 from public.template_fields where template_id = p_template_id and is_orphaned) then
    raise exception 'Resolve the orphaned fields before publishing.';
  end if;
  select current_version + 1 into v_next from public.templates where id = p_template_id for update;
  if v_next is null then
    raise exception 'Template not found.';
  end if;
  insert into public.template_versions (template_id, version, body, fields, published_by)
  select t.id, v_next, t.body,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'key', f.key, 'label', f.label, 'type', f.type, 'required', f.required,
             'default_value', f.default_value, 'help_text', f.help_text,
             'options', f.options, 'config', f.config, 'sort_order', f.sort_order
           ) order by f.sort_order, f.key)
           from public.template_fields f where f.template_id = t.id
         ), '[]'::jsonb),
         p_actor
    from public.templates t where t.id = p_template_id;
  update public.templates
     set current_version = v_next, status = 'published', has_unpublished_changes = false,
         updated_at = now(), updated_by = p_actor
   where id = p_template_id;
  return v_next;
end;
$$;

revoke execute on function public.template_versions_immutable(), public.save_template_draft(uuid, jsonb, jsonb, uuid),
  public.publish_template(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- policies
-- Read-only second guards behind the Edge Functions, access role included.
create policy "document categories readable by signed-in users"
  on public.document_categories for select to authenticated using (true);
create policy "templates readable through the Templates role and teams"
  on public.templates for select to authenticated
  using (private.my_access_level('Templates', 'read') > 0
     and (scope = 'organisation' or team_id in (select private.my_team_ids()) or private.is_global_admin()));
create policy "template fields follow their template"
  on public.template_fields for select to authenticated
  using (exists (select 1 from public.templates t where t.id = template_id));
create policy "template versions follow their template"
  on public.template_versions for select to authenticated
  using (exists (select 1 from public.templates t where t.id = template_id));

-- ---------------------------------------------------------------- access
-- The new entity on the built-in Administrator role.
insert into public.access_role_permissions (role_id, entity, read_level, write_level, delete_level)
select id, 'Templates', 2, 2, 2 from public.access_roles where name = 'Administrator' and is_system
on conflict (role_id, entity) do nothing;

-- ---------------------------------------------------------------- realtime
do $$
declare
  t text;
begin
  foreach t in array array['document_categories', 'templates', 'template_fields', 'template_versions'] loop
    execute format(
      'create trigger notify_invalidate after insert or update or delete on public.%I
         for each statement execute function public.notify_invalidate()', t);
  end loop;
end;
$$;
