-- Optional one-shot: refresh security_roster.status from Project Release Tracking
-- for cycle NB 2026 IPU4 (2294fbbc-7042-4574-adfa-a4c96b2c32c5).
--
-- Mirrors src/lib/cycleDetailTypes.ts deriveRosterStatusFromRelease (exclusive ladder):
--   1. DQA Done AND Sign off Done → Completed
--   2. DQA Done (Sign off not Done) → Test Pass
--   3. DQA = Test Complete → Issue Clarification
--   4. SA BVT Test Done → SA BVT
--   5. Internal Release Done → Internal release
--   6. else → Not Started
--
-- Coordinator (DATABASE_URL available):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f neon/refresh-roster-status-ipu4.sql
--
-- Preview only: run the CTE SELECT at the bottom (commented) instead of the UPDATE.

begin;

with cells as (
  select
    r.id as roster_id,
    r.project_id,
    r.project_name,
    r.status as old_status,
    coalesce(
      d.release -> 'by_project' -> r.project_id::text ->> 'internal_release',
      ''
    ) as ir,
    coalesce(
      d.release -> 'by_project' -> r.project_id::text ->> 'sa_bvt_test',
      ''
    ) as sa,
    coalesce(
      d.release -> 'by_project' -> r.project_id::text ->> 'external_release_web',
      ''
    ) as dqa,
    coalesce(
      d.release -> 'by_project' -> r.project_id::text ->> 'external_release_wu',
      ''
    ) as sign_off
  from public.security_roster r
  join public.security_cycle_details d on d.cycle_id = r.cycle_id
  where r.cycle_id = '2294fbbc-7042-4574-adfa-a4c96b2c32c5'
),
derived as (
  select
    roster_id,
    project_name,
    old_status,
    ir,
    sa,
    dqa,
    sign_off,
    case
      when btrim(dqa) = 'Done' and btrim(sign_off) = 'Done' then 'Completed'
      when btrim(dqa) = 'Done' then 'Test Pass'
      when btrim(dqa) = 'Test Complete' then 'Issue Clarification'
      when btrim(sa) = 'Done' then 'SA BVT'
      when btrim(ir) = 'Done' then 'Internal release'
      else 'Not Started'
    end as new_status
  from cells
),
updated as (
  update public.security_roster r
  set status = d.new_status
  from derived d
  where r.id = d.roster_id
    and r.status is distinct from d.new_status
  returning r.project_name, d.old_status, r.status as new_status
)
select * from updated
order by project_name;

-- Distribution after refresh (same cycle):
select status, count(*) as n
from public.security_roster
where cycle_id = '2294fbbc-7042-4574-adfa-a4c96b2c32c5'
group by status
order by
  case status
    when 'Internal release' then 1
    when 'SA BVT' then 2
    when 'Issue Clarification' then 3
    when 'Test Pass' then 4
    when 'Completed' then 5
    when 'Not Started' then 6
    else 7
  end;

commit;

-- Preview (dry-run) — run alone instead of the transaction above:
-- with cells as ( ... same as above ... ),
-- derived as ( ... same as above ... )
-- select project_name, old_status, new_status, ir, sa, dqa, sign_off
-- from derived
-- where old_status is distinct from new_status
-- order by project_name;
