-- The feature roadmap (votes and statuses) and the published dashboard layouts
-- are gone. Feature requests keep the form and their attachments.
drop table public.feature_request_votes;
drop function public.sync_feature_request_vote_count();

alter table public.feature_requests
  drop column status,
  drop column vote_count,
  drop column description_original,
  drop column updated_at,
  drop column updated_by;

drop table public.preference_defaults;
