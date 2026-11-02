-- DM matches Admin on Projects & Issues (and CheckPoint reachability), except
-- Personnel Add Member / ACTIONS / Excel bulk / ADD COLUMN (still Admin-only).
-- Apply on Neon after deploy; refresh Data API schema cache if policies appear stale.

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
