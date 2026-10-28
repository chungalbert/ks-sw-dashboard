import type { PersonnelRole, Role } from "./types";

/** Project-membership label (leader/member) — not the org Personnel Role. */
export function roleLabel(isAdmin: boolean, role: Role | null): string {
  if (isAdmin) return "管理員";
  if (role === "leader") return "專案領導";
  if (role === "member") return "專案成員";
  return "未加入此專案";
}

/** Sidebar / shell: show profiles.personnel_role (Admin/DM/DL/DE/DQA/PM/SA). */
export function personnelRoleLabel(role: PersonnelRole): string {
  return role;
}
