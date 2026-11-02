-- DQA / PM / SA need SELECT on public.projects so Security can join
-- Lenovo Project Name, platform, SS/EOL (MP/EOP), segment, etc.
-- Roster Lenovo column + cycle-detail headers / info popover read from
-- projects via client join (security_roster has Compal name only).
-- Write rules unchanged: UPDATE still leader / is_checkpoint_elevated only.
-- Apply on Neon after deploy; refresh Data API schema cache if needed.

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

DROP POLICY IF EXISTS projects_select ON public.projects;
CREATE POLICY projects_select ON public.projects
  FOR SELECT USING (
    public.is_project_member(id)
    OR public.is_admin()
    OR public.is_checkpoint_elevated()
    OR public.is_security_projects_reader()
  );

-- Keep meta row readable for column-def fallback.
DROP POLICY IF EXISTS projects_select_column_meta ON public.projects;
CREATE POLICY projects_select_column_meta ON public.projects
  FOR SELECT USING (name = '__kssw_meta__'::text);

NOTIFY pgrst, 'reload schema';
