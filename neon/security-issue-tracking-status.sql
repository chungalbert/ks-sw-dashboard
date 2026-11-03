-- Issue Tracking Status column (before Task in UI).
-- PASS reports set status='PASS' but never delete prior rows.
-- Apply via psql / Neon SQL editor; then Data API → Refresh schema cache if needed.

alter table public.security_issue_tracking
  add column if not exists status text not null default '';

comment on column public.security_issue_tracking.status is
  'Issue Tracking Status (Fail / Fixed / PASS / Cancelled / blank). PASS keeps historical rows visible.';

notify pgrst, 'reload schema';
