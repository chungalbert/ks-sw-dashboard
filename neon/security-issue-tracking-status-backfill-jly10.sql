-- Backfill empty Issue Tracking Status for JLY10 (and optional cycle-wide blanks → Fail)
-- Cycle: 2294fbbc-7042-4574-adfa-a4c96b2c32c5 (NB 2026 IPU4 / 2026 Q4)
--
-- Use when the UI shows blank Status but Neon Console already has Fail, OR when
-- rows were imported before status was populated. Safe: only updates rows where
-- status is null/blank. Does not overwrite PASS / Fixed / Cancelled / Fail.
--
-- Apply (coordinator secret path):
--   export DATABASE_URL="$(tr -d '\n' < /tmp/kssw-neon-secrets/DATABASE_URL)"
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f neon/security-issue-tracking-status-backfill-jly10.sql
--   # Then Neon Console → Data API → Refresh schema cache if Status still missing in API
--   unset DATABASE_URL

begin;

-- Preview (read-only): blank statuses for JLY10 in the IPU4 cycle
-- select id, project_name, defect_id, title, status
-- from public.security_issue_tracking
-- where cycle_id = '2294fbbc-7042-4574-adfa-a4c96b2c32c5'
--   and project_name ilike '%JLY10%'
--   and coalesce(nullif(btrim(status), ''), '') = '';

-- 1) JLY10 rows with empty status → Fail (issue rows, not Cover PASS placeholders)
update public.security_issue_tracking
set
  status = 'Fail',
  updated_at = now()
where cycle_id = '2294fbbc-7042-4574-adfa-a4c96b2c32c5'
  and project_name ilike '%JLY10%'
  and coalesce(nullif(btrim(status), ''), '') = ''
  and (
    nullif(btrim(title), '') is not null
    or nullif(btrim(defect_id), '') is not null
    or nullif(btrim(task), '') is not null
  );

-- 2) Normalize common casing variants across the same cycle (optional, idempotent)
update public.security_issue_tracking
set
  status = case lower(btrim(status))
    when 'pass' then 'PASS'
    when 'passed' then 'PASS'
    when 'fail' then 'Fail'
    when 'failed' then 'Fail'
    when 'fixed' then 'Fixed'
    when 'cancelled' then 'Cancelled'
    when 'canceled' then 'Cancelled'
    else status
  end,
  updated_at = now()
where cycle_id = '2294fbbc-7042-4574-adfa-a4c96b2c32c5'
  and nullif(btrim(status), '') is not null
  and status is distinct from case lower(btrim(status))
    when 'pass' then 'PASS'
    when 'passed' then 'PASS'
    when 'fail' then 'Fail'
    when 'failed' then 'Fail'
    when 'fixed' then 'Fixed'
    when 'cancelled' then 'Cancelled'
    when 'canceled' then 'Cancelled'
    else status
  end;

notify pgrst, 'reload schema';

commit;

-- Post-check:
-- select project_name, status, count(*)
-- from public.security_issue_tracking
-- where cycle_id = '2294fbbc-7042-4574-adfa-a4c96b2c32c5'
--   and project_name ilike '%JLY10%'
-- group by 1, 2
-- order by 1, 2;
