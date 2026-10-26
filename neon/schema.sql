-- Apply in the Neon SQL editor after Auth and the Data API are enabled.
-- User ids are text because Neon Auth ids are text. auth.user_id() replaces Supabase auth.uid().

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id text primary key,
  username text not null unique,
  display_name text not null,
  unit text not null default '',
  email text not null,
  is_admin boolean not null default false,
  personnel_role text not null default 'DE'
    check (personnel_role in ('Admin', 'DM', 'DL', 'DE', 'DQA', 'PM', 'SA')),
  created_at timestamptz not null default now()
);

-- Incremental DBs created before personnel_role: see neon/personnel-role.sql.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  created_by text not null references public.profiles(id),
  created_at timestamptz not null default now(),
  lenovo_name text not null default '',
  bios_id text not null default '',
  platform text not null default '',
  dis text not null default '',
  ss_date text not null default '',
  eol_date text not null default '',
  security_update text not null default '',
  talent_policy text not null default '',
  owner text not null default '',
  -- Owner (beside PROJECT LEADER); distinct from tpe_owner (TPE OWNER).
  project_owner text not null default '',
  -- TPE OWNER; distinct from owner (PROJECT LEADER) and project_owner (Owner).
  tpe_owner text not null default '',
  custom jsonb not null default '{}'::jsonb,
  -- Handover CheckPoints (Actions column). Incremental DBs: neon/project-checkpoints.sql.
  checkpoints jsonb not null default '[]'::jsonb
);

create table if not exists public.project_columns (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  sort_order integer not null default 0,
  created_by text references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists project_columns_label_upper_uidx
  on public.project_columns (upper(trim(label)));

create table if not exists public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id text not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('leader', 'member')),
  primary key (project_id, user_id)
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  assignee_id text references public.profiles(id) on delete set null,
  start_date date not null,
  due_date date not null,
  status text not null default 'opening' check (status in ('opening', 'working', 'closing', 'verify')),
  note text not null default '',
  analyzed text not null default '',
  analyzed_by text references public.profiles(id) on delete set null,
  analyzed_at timestamptz,
  analyzed_notes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.shared_notes (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  color text not null default 'blue',
  pinned boolean not null default false,
  url text,
  created_by text references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.otp_vault_entries (
  id text primary key,
  label text not null default '',
  issuer text not null default '',
  account text not null default '',
  secret text not null,
  qr_text text,
  thumb text,
  access_password text,
  created_by text references public.profiles(id) on delete set null,
  created_at bigint not null
);

create or replace function public.set_first_admin()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from public.profiles) then
    new.is_admin := true;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_first_admin on public.profiles;
create trigger profiles_first_admin
  before insert on public.profiles
  for each row execute function public.set_first_admin();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.user_id()), false);
$$;

create or replace function public.is_project_member(_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or exists (
    select 1 from public.project_members m
    where m.project_id = _project_id and m.user_id = auth.user_id()
  );
$$;

create or replace function public.is_project_leader(_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or exists (
    select 1 from public.project_members m
    where m.project_id = _project_id and m.user_id = auth.user_id() and m.role = 'leader'
  );
$$;

create or replace function public.lookup_login_email(identifier text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.email from public.profiles p
  where lower(p.username) = lower(identifier)
     or lower(p.email) = lower(identifier)
     or lower(p.display_name) = lower(identifier)
  limit 1;
$$;

create or replace function public.handle_new_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.created_by, 'leader')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_project_created on public.projects;
create trigger on_project_created
  after insert on public.projects
  for each row execute function public.handle_new_project();

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.tasks enable row level security;
alter table public.shared_notes enable row level security;
alter table public.otp_vault_entries enable row level security;
alter table public.project_columns enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = auth.user_id());

drop policy if exists profiles_insert_admin on public.profiles;
create policy profiles_insert_admin on public.profiles
  for insert to authenticated with check (public.is_admin());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.user_id());

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles
  for update to authenticated using (public.is_admin());

drop policy if exists profiles_delete_admin on public.profiles;
create policy profiles_delete_admin on public.profiles
  for delete to authenticated using (public.is_admin());

drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated using (public.is_project_member(id) or public.is_admin());

drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects
  for insert to authenticated with check (created_by = auth.user_id());

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update to authenticated using (public.is_project_leader(id));

drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects
  for delete to authenticated using (public.is_admin());

-- Hidden __kssw_meta__ row holds column defs in custom jsonb (Data API fallback).
drop policy if exists projects_select_column_meta on public.projects;
create policy projects_select_column_meta on public.projects
  for select to authenticated
  using (name = '__kssw_meta__');

drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members
  for select to authenticated using (public.is_project_member(project_id));

drop policy if exists members_write on public.project_members;
create policy members_write on public.project_members
  for all to authenticated using (public.is_project_leader(project_id))
  with check (public.is_project_leader(project_id));

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select to authenticated using (public.is_project_member(project_id));

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert to authenticated with check (public.is_project_leader(project_id));

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update to authenticated using (
    public.is_project_leader(project_id) or assignee_id = auth.user_id()
  );

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks
  for delete to authenticated using (public.is_project_leader(project_id));

drop policy if exists shared_notes_all on public.shared_notes;
create policy shared_notes_all on public.shared_notes
  for all to authenticated using (true) with check (true);

drop policy if exists otp_vault_all on public.otp_vault_entries;
create policy otp_vault_all on public.otp_vault_entries
  for all to authenticated using (true) with check (true);

drop policy if exists project_columns_select on public.project_columns;
create policy project_columns_select on public.project_columns
  for select to authenticated using (true);

drop policy if exists project_columns_insert on public.project_columns;
create policy project_columns_insert on public.project_columns
  for insert to authenticated with check (public.is_admin());

drop policy if exists project_columns_update on public.project_columns;
create policy project_columns_update on public.project_columns
  for update to authenticated using (public.is_admin());

drop policy if exists project_columns_delete on public.project_columns;
create policy project_columns_delete on public.project_columns
  for delete to authenticated using (public.is_admin());

-- Best-effort NOTIFY only. Neon Auth Data API needs Console "Refresh schema cache"
-- (or neon data-api refresh-schema). See neon/project-columns.sql.
create or replace function public.reload_pgrst_schema()
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if not public.is_admin() then
    raise exception 'only admin can reload schema cache';
  end if;
  perform pg_notify('pgrst', 'reload schema');
  return 'ok';
end;
$$;

revoke all on function public.reload_pgrst_schema() from public;

do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'anonymous', 'authenticated']
  loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('grant usage on schema public to %I', role_name);
      execute format('grant select on table public.profiles to %I', role_name);
      execute format('grant execute on function public.lookup_login_email(text) to %I', role_name);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant insert, update, delete on table public.profiles to authenticated;
    grant select, insert, update, delete on table public.projects to authenticated;
    grant select, insert, update, delete on table public.project_members to authenticated;
    grant select, insert, update, delete on table public.tasks to authenticated;
    grant select, insert, update, delete on table public.shared_notes to authenticated;
    grant select, insert, update, delete on table public.otp_vault_entries to authenticated;
    grant select, insert, update, delete on table public.project_columns to authenticated;
    grant execute on function public.is_admin() to authenticated;
    grant execute on function public.is_project_member(uuid) to authenticated;
    grant execute on function public.is_project_leader(uuid) to authenticated;
    grant execute on function public.reload_pgrst_schema() to authenticated;
  end if;
end $$;

notify pgrst, 'reload schema';
