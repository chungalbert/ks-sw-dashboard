-- Admin / DM / DL have the same Projects & Issues privileges (see all projects,
-- edit fields/columns/CheckPoints, create/delete). Personnel Add Member /
-- ACTIONS stay Admin-only via profiles.is_admin / is_admin().
-- Apply on Neon, then refresh Data API schema cache if policies appear stale.
-- Incremental DM elevation: also see neon/dm-projects-elevated.sql.

CREATE OR REPLACE FUNCTION public.is_projects_elevated()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select coalesce((
    select p.is_admin
      or coalesce(p.personnel_role, '') in ('Admin', 'DM', 'DL')
    from public.profiles p
    where p.id = auth.user_id()
  ), false);
$$;

CREATE OR REPLACE FUNCTION public.is_project_leader(_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select public.is_projects_elevated() or exists (
    select 1 from public.project_members m
    where m.project_id = _project_id and m.user_id = auth.user_id() and m.role = 'leader'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_project_member(_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select public.is_projects_elevated() or exists (
    select 1 from public.project_members m
    where m.project_id = _project_id and m.user_id = auth.user_id()
  );
$$;

-- projects_delete was Admin-only; allow elevated (Admin/DM/DL) too.
DROP POLICY IF EXISTS projects_delete ON public.projects;
CREATE POLICY projects_delete ON public.projects
  FOR DELETE USING (public.is_projects_elevated());

-- project_columns write paths: Admin + DM + DL (Projects & Issues edit mode).
DROP POLICY IF EXISTS project_columns_insert ON public.project_columns;
CREATE POLICY project_columns_insert ON public.project_columns
  FOR INSERT WITH CHECK (public.is_projects_elevated());

DROP POLICY IF EXISTS project_columns_update ON public.project_columns;
CREATE POLICY project_columns_update ON public.project_columns
  FOR UPDATE USING (public.is_projects_elevated());

DROP POLICY IF EXISTS project_columns_delete ON public.project_columns;
CREATE POLICY project_columns_delete ON public.project_columns
  FOR DELETE USING (public.is_projects_elevated());
