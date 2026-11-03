-- KSSW Test Reports (WORKSPACE sheet, sibling of Work Log) — apply in Neon SQL editor, then refresh Data API schema.
-- Access: Admin / DM / DL / DE (app nav + RLS). DQA / PM / SA excluded.
-- No security_* FKs — BIOS+OS / Stress cover reports are independent of Security Issue Tracking.

create extension if not exists pgcrypto;

create table if not exists public.test_reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects(id) on delete set null,
  project_name text not null default '',
  bios text not null default '',
  os_image text not null default '',
  report_type text not null default '',
  link text not null default '',
  -- file_path: repo-relative GitHub path after Contents upload (public/test-reports/...).
  file_path text not null default '',
  file_name text not null default '',
  report_date text not null default '',
  owner text not null default '',
  result text not null default ''
    check (result = '' or result in ('PASS', 'Fail')),
  sort_order integer not null default 0,
  created_by text references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists test_reports_project_idx on public.test_reports (project_id);
create index if not exists test_reports_date_idx on public.test_reports (report_date);
create index if not exists test_reports_sort_idx on public.test_reports (sort_order, created_at);

create or replace function public.can_access_test_reports()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or exists (
      select 1
      from public.profiles p
      where p.id = auth.user_id()
        and p.personnel_role in ('Admin', 'DM', 'DL', 'DE')
    );
$$;

alter table public.test_reports enable row level security;

drop policy if exists test_reports_all on public.test_reports;
create policy test_reports_all on public.test_reports
  for all to authenticated
  using (public.can_access_test_reports())
  with check (public.can_access_test_reports());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update, delete on table public.test_reports to authenticated;
    grant execute on function public.can_access_test_reports() to authenticated;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
