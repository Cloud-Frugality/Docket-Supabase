-- Full-text search over a document's title, reference and section text. The
-- vector lives on the document and triggers keep it current.
alter table public.documents add column search_vector tsvector not null default ''::tsvector;
create index documents_search_idx on public.documents using gin (search_vector);

create or replace function public.document_search_vector(p_document_id uuid, p_title text, p_reference text)
returns tsvector
language sql
stable
set search_path = ''
as $$
  select setweight(to_tsvector('english', coalesce(p_title, '') || ' ' || coalesce(p_reference, '')), 'A')
      || setweight(to_tsvector('english', coalesce(
           (select string_agg(s.current_text, ' ' order by s.sort_order)
              from public.document_sections s
             where s.document_id = p_document_id and s.is_included), '')), 'B')
$$;

create or replace function public.documents_search_refresh()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.search_vector := public.document_search_vector(new.id, new.title, new.reference_number);
  return new;
end;
$$;
create trigger documents_search_refresh before insert or update of title, reference_number on public.documents
  for each row execute function public.documents_search_refresh();

-- Section changes refresh their documents once per statement, so creating a
-- document with many sections recounts it once.
create or replace function public.document_sections_search_refresh()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.documents d
     set search_vector = public.document_search_vector(d.id, d.title, d.reference_number)
   where d.id in (select document_id from changed);
  return null;
end;
$$;
create trigger document_sections_search_insert after insert on public.document_sections
  referencing new table as changed for each statement execute function public.document_sections_search_refresh();
create trigger document_sections_search_update after update on public.document_sections
  referencing new table as changed for each statement execute function public.document_sections_search_refresh();
create trigger document_sections_search_delete after delete on public.document_sections
  referencing old table as changed for each statement execute function public.document_sections_search_refresh();

revoke execute on function public.document_search_vector(uuid, text, text), public.documents_search_refresh(),
  public.document_sections_search_refresh() from public, anon, authenticated;

update public.documents set search_vector = public.document_search_vector(id, title, reference_number);
