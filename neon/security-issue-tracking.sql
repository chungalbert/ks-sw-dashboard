-- Per-project Issue Tracking rows on Security roster (after Status).
-- Apply via psql; then Neon Console → Data API → Refresh schema cache if needed.

create extension if not exists pgcrypto;

create table if not exists public.security_issue_tracking (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.security_cycles(id) on delete cascade,
  roster_id uuid not null references public.security_roster(id) on delete cascade,
  project_id text not null default '',
  project_name text not null default '',
  /** Fail / Fixed / PASS / Cancelled / blank — PASS reports keep historical rows; never drop on Cover PASS. */
  status text not null default '',
  task text not null default '',
  /** Display date string (e.g. 9/18/2026 or ISO). */
  issue_date text not null default '',
  no text not null default '',
  defect_id text not null default '',
  title text not null default '',
  /** Fail rate / F/R column. */
  fr text not null default '',
  fail_unit text not null default '',
  condition_text text not null default '',
  steps_recover text not null default '',
  observed_symptom text not null default '',
  dqa_owner text not null default '',
  dqa_verify_data text not null default '',
  dqa_comments text not null default '',
  pm text not null default '',
  rd_owner text not null default '',
  rd_comments text not null default '',
  conclusion text not null default '',
  sort_order integer not null default 0,
  created_by text references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists security_issue_tracking_roster_idx
  on public.security_issue_tracking (roster_id);

create index if not exists security_issue_tracking_cycle_idx
  on public.security_issue_tracking (cycle_id);

-- Same Defect ID cannot appear twice on one project roster row (empty defect_id allowed many times).
create unique index if not exists security_issue_tracking_roster_defect_uidx
  on public.security_issue_tracking (roster_id, defect_id)
  where defect_id <> '';

alter table public.security_issue_tracking enable row level security;

drop policy if exists security_issue_tracking_all on public.security_issue_tracking;
create policy security_issue_tracking_all on public.security_issue_tracking
  for all to authenticated using (true) with check (true);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update, delete on table public.security_issue_tracking to authenticated;
  end if;
end $$;

notify pgrst, 'reload schema';
