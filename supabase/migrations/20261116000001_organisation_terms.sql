-- What the organisation calls a client and an engagement: a law firm has
-- matters, a builder has projects. Only the words on screen change.
alter table public.organisations
  add column client_term text not null default 'Client',
  add column clients_term text not null default 'Clients',
  add column engagement_term text not null default 'Engagement',
  add column engagements_term text not null default 'Engagements';
