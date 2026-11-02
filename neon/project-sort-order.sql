-- Shared project display order for Projects & Issues + Security roster.
-- Apply in Neon SQL editor, then Console → Data API → Refresh schema cache.

alter table public.projects
  add column if not exists sort_order integer not null default 0;

-- Backfill contiguous 0..n-1 by created_at (skip hidden column-meta row).
with ordered as (
  select
    id,
    (row_number() over (order by created_at asc, name asc) - 1)::integer as rn
  from public.projects
  where name is distinct from '__kssw_meta__'
)
update public.projects p
set sort_order = ordered.rn
from ordered
where p.id = ordered.id;

-- Meta row stays out of the way of real projects.
update public.projects
set sort_order = 1000000
where name = '__kssw_meta__';

create index if not exists projects_sort_order_idx
  on public.projects (sort_order, created_at);
