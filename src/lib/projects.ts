import type { Project } from "./types";

export const ALL_PROJECTS_ID = "all";

export function isAllProjects(projectId: string | null | undefined): boolean {
  return projectId === ALL_PROJECTS_ID;
}

/** Coerce Neon / local sort_order; missing → large so unsorted rows sink. */
export function projectSortOrderValue(
  project: Pick<Project, "sort_order"> | null | undefined,
  fallback = Number.MAX_SAFE_INTEGER,
): number {
  if (!project) return fallback;
  const n = Number(project.sort_order);
  return Number.isFinite(n) ? n : fallback;
}

/** Ascending sort_order (small → large), then Compal name, then id. */
export function compareProjectsBySortOrder(
  a: Pick<Project, "id" | "name" | "sort_order">,
  b: Pick<Project, "id" | "name" | "sort_order">,
): number {
  const byOrder = projectSortOrderValue(a, 0) - projectSortOrderValue(b, 0);
  if (byOrder !== 0) return byOrder;
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

export function sortedProjectsBySortOrder<T extends Pick<Project, "id" | "name" | "sort_order">>(
  projects: T[],
): T[] {
  return projects.slice().sort(compareProjectsBySortOrder);
}
