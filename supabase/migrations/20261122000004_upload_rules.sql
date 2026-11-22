-- What may be uploaded is the organisation's to set: which kinds of file, and
-- how big one may be, up to a ceiling of 50MB that nobody can raise. It starts
-- where the fixed rules were: PDF, Word and Excel, 20MB.
alter table public.organisations
  add column upload_types text[] not null default '{pdf,word,excel}'
    check (cardinality(upload_types) > 0),
  add column upload_max_mb integer not null default 20
    check (upload_max_mb between 1 and 50);

-- Saves the rules and sets the document buckets to match, in one transaction,
-- so storage stays the hard wall behind the functions' checks. The content
-- types come from the function, which keeps the list of kinds. Definer rights
-- because the buckets belong to storage.
create or replace function public.save_upload_rules(
  p_organisation_id uuid,
  p_types text[],
  p_max_mb integer,
  p_mime_types text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.organisations
     set upload_types = p_types, upload_max_mb = p_max_mb
   where id = p_organisation_id;
  update storage.buckets
     set file_size_limit = p_max_mb::bigint * 1048576, allowed_mime_types = p_mime_types
   where id in ('client-documents', 'engagement-documents', 'feature-request-documents');
end;
$$;
revoke execute on function public.save_upload_rules(uuid, text[], integer, text[]) from public, anon, authenticated;
