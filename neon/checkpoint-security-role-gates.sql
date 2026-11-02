-- DE: CheckPoint edit on all projects (see + update), without full Admin/DM/DL
-- Projects & Issues elevated (columns/delete). Security RLS stays open (UI gates).
-- DQA/PM/SA: SELECT all projects for Security Lenovo / cycle-detail context
-- (see also neon/security-projects-read.sql). UPDATE stays checkpoint-elevated only.
-- Apply on Neon after deploy; refresh Data API schema cache if needed.
-- Incremental DM elevation: also see neon/dm-projects-elevated.sql.

CREATE OR REPLACE FUNCTION public.is_checkpoint_elevated()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select coalesce((
    select p.is_admin
      or coalesce(p.personnel_role, '') in ('Admin', 'DM', 'DL', 'DE')
    from public.profiles p
    where p.id = auth.user_id()
  ), false);
$$;

CREATE OR REPLACE FUNCTION public.is_security_projects_reader()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select coalesce((
    select p.is_admin
      or coalesce(p.personnel_role, '') in ('Admin', 'DM', 'DL', 'DE', 'DQA', 'PM', 'SA')
    from public.profiles p
    where p.id = auth.user_id()
  ), false);
$$;

-- DE (CheckPoint) + DQA/PM/SA (Security context) + Admin/DM/DL see every project.
DROP POLICY IF EXISTS projects_select ON public.projects;
CREATE POLICY projects_select ON public.projects
  FOR SELECT USING (
    public.is_project_member(id)
    OR public.is_admin()
    OR public.is_checkpoint_elevated()
    OR public.is_security_projects_reader()
  );

-- Keep meta row readable.
DROP POLICY IF EXISTS projects_select_column_meta ON public.projects;
CREATE POLICY projects_select_column_meta ON public.projects
  FOR SELECT USING (name = '__kssw_meta__'::text);

-- DE can UPDATE projects (CheckPoint / handover) without being project leader.
DROP POLICY IF EXISTS projects_update ON public.projects;
CREATE POLICY projects_update ON public.projects
  FOR UPDATE USING (
    public.is_project_leader(id)
    OR public.is_checkpoint_elevated()
  );
