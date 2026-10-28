-- KSSW Work Log (WORKSPACE sheet) — apply in Neon SQL editor, then refresh Data API schema.
-- Access: Admin / DM / DL / DE (app nav + RLS). DQA / PM / SA excluded.

create extension if not exists pgcrypto;

create table if not exists public.work_log_entries (
  id uuid primary key default gen_random_uuid(),
  entry_date text not null default '',
  entry_type text not null default ''
    check (entry_type = '' or entry_type in ('PCR', 'INV', 'Bootleg', 'SPB', 'Formal', 'IPU', 'Sum')),
  project_id uuid references public.projects(id) on delete set null,
  project_name text not null default '',
  product_name text not null default '',
  content text not null default '',
  owner_id text references public.profiles(id) on delete set null,
  done boolean not null default false,
  sort_order integer not null default 0,
  created_by text references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists work_log_entries_date_idx on public.work_log_entries (entry_date);
create index if not exists work_log_entries_sort_idx on public.work_log_entries (sort_order, created_at);

create or replace function public.can_access_work_log()
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

alter table public.work_log_entries enable row level security;

drop policy if exists work_log_entries_all on public.work_log_entries;
create policy work_log_entries_all on public.work_log_entries
  for all to authenticated
  using (public.can_access_work_log())
  with check (public.can_access_work_log());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update, delete on table public.work_log_entries to authenticated;
    grant execute on function public.can_access_work_log() to authenticated;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
