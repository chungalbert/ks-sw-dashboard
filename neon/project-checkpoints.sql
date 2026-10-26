-- Project handover CheckPoints (Actions column).
-- Safe to re-run.
-- Prefer dedicated jsonb column; client also keeps a custom-key fallback
-- (`custom.__kssw_checkpoints`) until this migration is applied + Data API refresh.
--
-- Document shape (client-owned; no further ALTER needed):
--   { "handover_date": "YYYY-MM-DD", "items": [
--       { "id", "type", "item", "description", "checked" }
--     ] }
-- Legacy bare arrays `[{id,text,checked}]` are still accepted and migrated on read.

alter table public.projects
  add column if not exists checkpoints jsonb not null default '[]'::jsonb;

-- Backfill from custom fallback key when the dedicated column is still empty.
update public.projects p
set checkpoints = coalesce(
  case
    when jsonb_typeof(p.custom->'__kssw_checkpoints') = 'array'
      then p.custom->'__kssw_checkpoints'
    when nullif(trim(p.custom->>'__kssw_checkpoints'), '') is not null
      then (p.custom->>'__kssw_checkpoints')::jsonb
    else null
  end,
  p.checkpoints
)
where coalesce(jsonb_array_length(p.checkpoints), 0) = 0
  and (
    jsonb_typeof(p.custom->'__kssw_checkpoints') = 'array'
    or nullif(trim(p.custom->>'__kssw_checkpoints'), '') is not null
  );

notify pgrst, 'reload schema';
