-- Folder templates: the folders a new client or engagement starts with.
-- Clients have one. An engagement takes the closest of its team and type,
-- its team alone, its type alone, then the one for any engagement.

create table public.folder_templates (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('client', 'engagement')),
  -- Null means any team, or any type.
  team_id uuid references public.teams(id) on delete cascade,
  engagement_type_id uuid references public.engagement_types(id) on delete cascade,
  -- One path per folder, a parent before what is inside it ("Contracts", "Contracts/Signed").
  folders text[] not null default '{}',
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  -- A client has no team or type to go by.
  check (kind = 'engagement' or (team_id is null and engagement_type_id is null))
);
-- Read and written by the Edge Functions only, so no policies.
alter table public.folder_templates enable row level security;

-- One template for each thing it can be for.
create unique index folder_templates_target
  on public.folder_templates (
    kind,
    coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(engagement_type_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create trigger notify_invalidate after insert or update or delete on public.folder_templates
  for each statement execute function public.notify_invalidate();
