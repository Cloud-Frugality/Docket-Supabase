-- Templates come from Word files. The file lives in a private bucket; its
-- sections and fields are read from it into the template (docx-template.ts),
-- and each published version keeps the file it was published from.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('template-files', 'template-files', false, 20971520,
        array['application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

alter table public.templates
  add column source_file_path text,
  add column source_file_name text not null default '' check (char_length(source_file_name) <= 255);
alter table public.template_versions add column source_file_path text;

-- Publishing now freezes the Word file with the body and fields.
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
  insert into public.template_versions (template_id, version, body, fields, source_file_path, published_by)
  select t.id, v_next, t.body,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'key', f.key, 'label', f.label, 'type', f.type, 'required', f.required,
             'default_value', f.default_value, 'help_text', f.help_text,
             'options', f.options, 'config', f.config, 'sort_order', f.sort_order
           ) order by f.sort_order, f.key)
           from public.template_fields f where f.template_id = t.id
         ), '[]'::jsonb),
         t.source_file_path,
         p_actor
    from public.templates t where t.id = p_template_id;
  update public.templates
     set current_version = v_next, status = 'published', has_unpublished_changes = false,
         updated_at = now(), updated_by = p_actor
   where id = p_template_id;
  return v_next;
end;
$$;
revoke execute on function public.publish_template(uuid, uuid) from public, anon, authenticated;

-- A template's file, swapped for a new upload, with the body and fields read
-- from it, in one transaction.
create or replace function public.replace_template_file(
  p_template_id uuid, p_path text, p_file_name text, p_body jsonb, p_fields jsonb, p_actor uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.templates set source_file_path = p_path, source_file_name = p_file_name where id = p_template_id;
  if not found then
    raise exception 'Template not found.';
  end if;
  perform public.save_template_draft(p_template_id, p_body, p_fields, p_actor);
end;
$$;
revoke execute on function public.replace_template_file(uuid, text, text, jsonb, jsonb, uuid) from public, anon, authenticated;
