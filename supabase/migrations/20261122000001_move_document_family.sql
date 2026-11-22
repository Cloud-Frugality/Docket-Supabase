-- Moving a file, every version of it, to a different client or engagement.
-- The place it lands has its own approvers, so approval starts again there.
-- One transaction, so a file is never on two records or on none.
create or replace function public.move_document_family(
  p_family uuid,
  p_from text,
  p_to text,
  p_to_id uuid,
  p_folder uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  from_table text;
  to_table text;
  to_owner text;
  -- Everything a file carries with it. Its owner and folder are set apart,
  -- and its approval is left behind.
  kept constant text := 'id, file_name, content_type, size_bytes, storage_path, document_type, status, reference, '
    || 'effective_from, effective_to, note, family_id, version, archived_at, archived_by, uploaded_by, created_at, '
    || 'updated_at, updated_by, on_hold, hold_by, hold_at, custom, restricted';
begin
  if p_from not in ('client', 'engagement') or p_to not in ('client', 'engagement') then
    raise exception 'Invalid record.';
  end if;
  from_table := p_from || '_documents';
  to_table := p_to || '_documents';
  to_owner := p_to || '_id';

  execute format('delete from public.document_approvals a using public.%I d where d.family_id = $1 and a.record = $2 and a.document_id = d.id', from_table)
    using p_family, p_from;

  if p_from = p_to then
    execute format(
      'update public.%I set %I = $2, folder_id = $3, approval_state = ''none'', decided_for_group = false, '
      || 'submitted_by = null, submitted_at = null, decided_by = null, decided_for = null, decided_at = null, '
      || 'decision_comment = null, retain_until = null where family_id = $1',
      to_table, to_owner)
      using p_family, p_to_id, p_folder;
  else
    -- The two tables differ only in whose file it is, so the rows go across as they are.
    execute format('insert into public.%I (%I, folder_id, %s) select $2, $3, %s from public.%I where family_id = $1', to_table, to_owner, kept, kept, from_table)
      using p_family, p_to_id, p_folder;
    execute format('delete from public.%I where family_id = $1', from_table) using p_family;
    -- Its history follows it.
    update public.document_events set record = p_to where family_id = p_family and record = p_from;
  end if;
end;
$$;
revoke execute on function public.move_document_family(uuid, text, text, uuid, uuid) from public, anon, authenticated;
