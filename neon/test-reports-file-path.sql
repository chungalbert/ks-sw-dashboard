-- Additive: Test Reports GitHub-stored file metadata (apply after neon/test-reports.sql).
-- Access unchanged: Admin / DM / DL / DE via can_access_test_reports().

alter table public.test_reports
  add column if not exists file_path text not null default '',
  add column if not exists file_name text not null default '';

comment on column public.test_reports.file_path is
  'Repo-relative GitHub path, e.g. public/test-reports/<id>/report.pdf';
comment on column public.test_reports.file_name is
  'Original/sanitized uploaded file name';
comment on column public.test_reports.link is
  'Openable URL (raw.githubusercontent.com after upload, or manual URL/UNC)';

select pg_notify('pgrst', 'reload schema');
