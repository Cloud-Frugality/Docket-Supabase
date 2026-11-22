-- A file may be 25MB unless the organisation says otherwise. The 20MB it
-- started on was only ever the default, so it moves too, and the document
-- buckets with it.
alter table public.organisations alter column upload_max_mb set default 25;

update public.organisations set upload_max_mb = 25 where upload_max_mb = 20;

update storage.buckets
   set file_size_limit = 25 * 1048576
 where id in ('client-documents', 'engagement-documents', 'feature-request-documents')
   and file_size_limit = 20 * 1048576;
