import { cloudApi } from "./cloudApi";
import { ensureSampleIfEmpty, localApi } from "./localApi";
import { importColumnsIfEmpty, personnelUiStore } from "./personnelUiStore";
import {
  clearProjectsUiLocal,
  projectsUiStore,
  readProjectsUiState,
  replaceProjectsUiLocal,
  type ProjectFieldPatch,
} from "./projectsUiStore";
import {
  CLOUD_TABLES_MISSING_MESSAGE,
  isSharedStoreUnavailableError,
  markSharedCloudReady,
  markSharedCloudUnavailable,
  maybeAutoMigrateLocalShared,
} from "./sharedStore";
import {
  normalizePersonnelRole,
  type AccountInput,
  type CreatePersonnelInput,
  type InviteInput,
  type NoteColor,
  type NoteItem,
  type OtpVaultEntry,
  type PersonnelColumn,
  type PersonnelRole,
  type Profile,
  type Project,
  type ProjectColumn,
  type ProjectMember,
  type Role,
  type Task,
} from "./types";
import { hasNeonConfig, hasSupabaseConfig } from "./util";

const PROJECTS_UI_MIGRATE_FLAG = "awb-projects-ui-migrated-v1";
let projectsUiMigrateInFlight: Promise<void> | null = null;

function isEmptyField(value: string | undefined | null): boolean {
  return value == null || String(value).trim() === "";
}

/** Quoted identifiers PostgREST/Postgres use in "missing column/table" errors. */
const PROJECT_SCHEMA_COLUMNS = [
  "lenovo_name",
  "bios_id",
  "platform",
  "dis",
  "ss_date",
  "eol_date",
  "security_update",
  "talent_policy",
  "owner",
  "project_owner",
  "tpe_owner",
  "custom",
] as const;

function projectColumnsErrorParts(err: unknown): { msg: string; code: string } {
  const msg = (
    err && typeof err === "object" && "message" in err
      ? String((err as { message?: unknown }).message ?? "")
      : err instanceof Error
        ? err.message
        : String(err ?? "")
  ).toLowerCase();
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : "";
  return { msg, code };
}

function isProjectColumnsUnavailableError(err: unknown): boolean {
  const { msg, code } = projectColumnsErrorParts(err);

  // Permission / RLS / unique violations mention "project_columns" too — ignore those.
  // Only treat missing relation / PostgREST schema-cache misses as "run SQL".
  const missingTableOrColumn =
    code === "42P01" ||
    code === "PGRST205" ||
    code === "PGRST204" ||
    msg.includes("does not exist") ||
    msg.includes("schema cache") ||
    msg.includes("could not find the table") ||
    msg.includes("could not find the '");

  if (!missingTableOrColumn) return false;

  if (msg.includes("project_columns")) return true;

  return PROJECT_SCHEMA_COLUMNS.some(
    (col) => msg.includes(`'${col}'`) || msg.includes(`"${col}"`),
  );
}

/** Stale PostgREST cache (table exists in Postgres, Data API hasn't reloaded yet). */
function isProjectColumnsSchemaCacheError(err: unknown): boolean {
  if (!isProjectColumnsUnavailableError(err)) return false;
  const { msg, code } = projectColumnsErrorParts(err);
  return (
    code === "PGRST205" ||
    msg.includes("schema cache") ||
    msg.includes("could not find the table")
  );
}

function projectColumnsUnavailableMessage(err: unknown): string {
  if (isProjectColumnsSchemaCacheError(err)) {
    return "Neon Data API schema cache 尚未載入 project_columns。請在 Neon Console → Data API 按 Refresh schema cache（NOTIFY pgrst 無效）；應用程式會改寫入 __kssw_meta__。";
  }
  return "專案欄位尚未同步到 Neon。請管理員執行 neon/project-columns.sql 後重新整理。";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry project_columns Data API calls when PostgREST returns a stale schema cache miss.
 * On first cache miss, best-effort NOTIFY via reload_pgrst_schema (admin RPC).
 */
async function withProjectColumnsRetry<T>(work: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      last = err;
      if (!isProjectColumnsSchemaCacheError(err)) throw err;
      if (attempt === 0) {
        try {
          await cloudApi.reloadPgrstSchema();
        } catch {
          /* RPC missing or not admin — still retry after backoff */
        }
      }
      await sleep(350 * (attempt + 1));
    }
  }
  throw last;
}

function overlayHasValues(overlay: ProjectFieldPatch | undefined): boolean {
  if (!overlay) return false;
  return Boolean(
    overlay.name ||
      overlay.description ||
      overlay.lenovo_name ||
      overlay.bios_id ||
      overlay.platform ||
      overlay.dis ||
      overlay.ss_date ||
      overlay.eol_date ||
      overlay.security_update ||
      overlay.talent_policy ||
      overlay.owner ||
      overlay.project_owner ||
      overlay.tpe_owner ||
      (overlay.checkpoints && overlay.checkpoints.length > 0) ||
      (overlay.checkpoint_handover_date && overlay.checkpoint_handover_date.trim() !== "") ||
      (overlay.custom && Object.keys(overlay.custom).length > 0),
  );
}

/**
 * One-time (per browser): push local awb-projects-ui-v1 extras into Neon.
 * Never overwrites non-empty cloud field values; preserves custom column ids when possible.
 * Clears local only after a successful migrate pass (or when there was nothing left to keep).
 */
async function maybeMigrateProjectsUiToCloud(): Promise<void> {
  if (!hasSupabaseConfig()) return;
  if (localStorage.getItem(PROJECTS_UI_MIGRATE_FLAG) === "1") return;
  if (projectsUiMigrateInFlight) return projectsUiMigrateInFlight;

  projectsUiMigrateInFlight = (async () => {
    const local = readProjectsUiState();
    const hasLocal =
      local.columns.length > 0 || Object.values(local.overlays).some((o) => overlayHasValues(o));
    if (!hasLocal) {
      localStorage.setItem(PROJECTS_UI_MIGRATE_FLAG, "1");
      return;
    }

    let cloudColumns: ProjectColumn[] = [];
    try {
      cloudColumns = await withProjectColumnsRetry(() => cloudApi.listProjectColumns());
    } catch (err) {
      if (isProjectColumnsUnavailableError(err)) return;
      throw err;
    }

    const labelOf = (label: string) => label.trim().toUpperCase();
    for (const col of local.columns) {
      if (cloudColumns.some((c) => labelOf(c.label) === labelOf(col.label))) continue;
      try {
        const created = await withProjectColumnsRetry(() =>
          cloudApi.addProjectColumn(col.label, col.id),
        );
        cloudColumns.push(created);
      } catch {
        /* non-admin or duplicate — skip; fields may still migrate under existing ids */
      }
    }

    // Remap local custom keys when cloud kept a different id for the same label.
    const localIdToCloudId = new Map<string, string>();
    for (const localCol of local.columns) {
      const cloudCol = cloudColumns.find((c) => labelOf(c.label) === labelOf(localCol.label));
      if (cloudCol) localIdToCloudId.set(localCol.id, cloudCol.id);
    }

    let projects: Project[] = [];
    try {
      projects = await cloudApi.listProjects();
    } catch (err) {
      if (isProjectColumnsUnavailableError(err)) return;
      throw err;
    }

    const fieldKeys = [
      "name",
      "description",
      "lenovo_name",
      "bios_id",
      "platform",
      "dis",
      "ss_date",
      "eol_date",
      "security_update",
      "talent_policy",
      "owner",
      "project_owner",
      "tpe_owner",
    ] as const;

    const failedProjectIds = new Set<string>();
    for (const project of projects) {
      const overlay = local.overlays[project.id];
      if (!overlay) continue;
      const patch: ProjectFieldPatch = {};
      for (const key of fieldKeys) {
        const localVal = overlay[key];
        if (typeof localVal !== "string" || localVal.trim() === "") continue;
        const cloudVal = project[key];
        if (isEmptyField(cloudVal)) {
          (patch as Record<string, string>)[key] = localVal;
        }
      }
      if (overlay.custom) {
        const mergedCustom: Record<string, string> = {};
        for (const [localKey, value] of Object.entries(overlay.custom)) {
          if (value == null || String(value) === "") continue;
          const cloudKey = localIdToCloudId.get(localKey) ?? localKey;
          if (isEmptyField(project.custom?.[cloudKey])) {
            mergedCustom[cloudKey] = String(value);
          }
        }
        if (Object.keys(mergedCustom).length > 0) patch.custom = mergedCustom;
      }
      if (Object.keys(patch).length === 0) continue;
      try {
        await cloudApi.updateProject(project.id, patch);
      } catch {
        failedProjectIds.add(project.id);
      }
    }

    // Drop local column defs that now exist in Neon (by label).
    const remainingColumns = local.columns.filter(
      (col) => !cloudColumns.some((c) => labelOf(c.label) === labelOf(col.label)),
    );
    const remainingOverlays: typeof local.overlays = {};
    for (const [projectId, overlay] of Object.entries(local.overlays)) {
      if (failedProjectIds.has(projectId) && overlayHasValues(overlay)) {
        remainingOverlays[projectId] = overlay;
      }
    }

    if (remainingColumns.length === 0 && Object.keys(remainingOverlays).length === 0) {
      clearProjectsUiLocal();
      localStorage.setItem(PROJECTS_UI_MIGRATE_FLAG, "1");
      return;
    }

    // Keep only unmigrated leftovers (preserve ids); retry next session (do not set flag).
    replaceProjectsUiLocal({ columns: remainingColumns, overlays: remainingOverlays });
  })();

  try {
    await projectsUiMigrateInFlight;
  } finally {
    projectsUiMigrateInFlight = null;
  }
}

export const isCloud = hasSupabaseConfig;

/**
 * Cloud mode: Neon Auth+Data API (VITE_NEON_URL) or legacy Supabase.
 * Never sticky-fall-back to per-browser localStorage — that siloed Admin vs Lay_Zhang (#35).
 * Local-only builds (no VITE_NEON_URL / VITE_SUPABASE_*) still use awb-store-v1.
 * Reads may surface local leftovers only while tables are missing (with UI banner).
 * Writes in cloud mode require tables; otherwise throw apply-migration guidance.
 */
async function withSharedCloud<T>(
  cloudCall: () => Promise<T>,
  localRead: () => T | Promise<T>,
  mode: "read" | "write",
): Promise<T> {
  if (!hasSupabaseConfig()) {
    return localRead();
  }
  try {
    const result = await cloudCall();
    markSharedCloudReady();
    void maybeAutoMigrateLocalShared();
    return result;
  } catch (err) {
    if (!isSharedStoreUnavailableError(err)) throw err;
    markSharedCloudUnavailable();
    if (mode === "write") {
      throw new Error(CLOUD_TABLES_MISSING_MESSAGE);
    }
    // Degraded read: show this browser's leftovers so Admin can still see pre-fix data
    // until migration is applied + Upload local runs. Other users will see [].
    return localRead();
  }
}

function withPersonnelOverlay(profile: Profile): Profile {
  return personnelUiStore.mergeProfile(profile);
}

function withProjectOverlay(project: Project): Project {
  return projectsUiStore.mergeProject(project);
}

function mergeProfilesWithExtras(profiles: Profile[]): Profile[] {
  const byId = new Map(profiles.map((p) => [p.id, withPersonnelOverlay(p)]));
  for (const extra of personnelUiStore.listExtraMembers()) {
    if (!byId.has(extra.id) && ![...byId.values()].some((p) => p.email.toLowerCase() === extra.email.toLowerCase())) {
      byId.set(extra.id, extra);
    }
  }
  return [...byId.values()];
}

function mergeMembersWithExtras(members: ProjectMember[]): ProjectMember[] {
  const keys = new Set(members.map((m) => `${m.project_id}:${m.user_id}`));
  const merged = [...members];
  for (const row of personnelUiStore.listExtraMemberships()) {
    const key = `${row.project_id}:${row.user_id}`;
    if (!keys.has(key)) {
      keys.add(key);
      merged.push(row);
    }
  }
  return merged;
}

export const api = {
  async signIn(identifier: string, password: string): Promise<Profile> {
    if (hasSupabaseConfig()) return withPersonnelOverlay(await cloudApi.signIn(identifier, password));
    const profile = await localApi.signIn(identifier, password);
    ensureSampleIfEmpty();
    return withPersonnelOverlay(profile);
  },
  async signOut() {
    if (hasSupabaseConfig()) return cloudApi.signOut();
    localApi.signOut();
  },
  async currentUser(): Promise<Profile | null> {
    if (hasSupabaseConfig()) {
      const profile = await cloudApi.currentUser();
      return profile ? withPersonnelOverlay(profile) : null;
    }
    await localApi.ensurePasswordScheme();
    const profile = localApi.currentUser();
    return profile ? withPersonnelOverlay(profile) : null;
  },
  async listProfiles(): Promise<Profile[]> {
    if (hasSupabaseConfig()) {
      const profiles = await cloudApi.listProfiles();
      return mergeProfilesWithExtras(profiles);
    }
    await localApi.ensurePasswordScheme();
    importColumnsIfEmpty(localApi.listPersonnelColumns());
    return mergeProfilesWithExtras(localApi.listProfiles());
  },
  async listProjects(): Promise<Project[]> {
    if (hasSupabaseConfig()) {
      await maybeMigrateProjectsUiToCloud();
      // Neon is source of truth after migrate; overlay only covers unmigrated leftovers.
      return (await cloudApi.listProjects()).map(withProjectOverlay);
    }
    return localApi.listProjects().map(withProjectOverlay);
  },
  async createProject(name: string, description: string): Promise<Project> {
    if (hasSupabaseConfig()) return withProjectOverlay(await cloudApi.createProject(name, description));
    return withProjectOverlay(localApi.createProject(name, description));
  },
  async updateProject(projectId: string, patch: ProjectFieldPatch): Promise<Project> {
    if (!hasSupabaseConfig()) {
      return withProjectOverlay(localApi.updateProject(projectId, patch));
    }
    try {
      return withProjectOverlay(
        await withProjectColumnsRetry(() => cloudApi.updateProject(projectId, patch)),
      );
    } catch (err) {
      if (isProjectColumnsUnavailableError(err)) {
        throw new Error(projectColumnsUnavailableMessage(err));
      }
      throw err;
    }
  },
  async listProjectColumns(): Promise<ProjectColumn[]> {
    if (!hasSupabaseConfig()) {
      return projectsUiStore.listColumns();
    }
    await maybeMigrateProjectsUiToCloud();
    try {
      return await withProjectColumnsRetry(() => cloudApi.listProjectColumns());
    } catch (err) {
      if (isProjectColumnsUnavailableError(err)) {
        // Only use local leftovers when they exist — never mask a cloud miss with [].
        const local = projectsUiStore.listColumns();
        if (local.length > 0) return local;
        throw new Error(projectColumnsUnavailableMessage(err));
      }
      throw err;
    }
  },
  async addProjectColumn(label: string): Promise<ProjectColumn> {
    if (!hasSupabaseConfig()) {
      return projectsUiStore.addColumn(label);
    }
    try {
      return await withProjectColumnsRetry(() => cloudApi.addProjectColumn(label));
    } catch (err) {
      if (isProjectColumnsUnavailableError(err)) {
        throw new Error(projectColumnsUnavailableMessage(err));
      }
      throw err;
    }
  },
  async removeProjectColumn(columnId: string) {
    if (!hasSupabaseConfig()) {
      projectsUiStore.removeColumn(columnId);
      return;
    }
    try {
      await withProjectColumnsRetry(() => cloudApi.removeProjectColumn(columnId));
    } catch (err) {
      if (isProjectColumnsUnavailableError(err)) {
        throw new Error(projectColumnsUnavailableMessage(err));
      }
      throw err;
    }
  },
  /** Admin Save: persist full managed column list + display order. */
  async replaceProjectColumns(columns: ProjectColumn[]): Promise<ProjectColumn[]> {
    if (!hasSupabaseConfig()) {
      return projectsUiStore.replaceColumns(columns);
    }
    try {
      const next = await withProjectColumnsRetry(() => cloudApi.replaceProjectColumns(columns));
      // Keep local mirror aligned so a later local fallback cannot resurrect removed cols.
      try {
        projectsUiStore.replaceColumns(next);
      } catch {
        /* ignore local mirror failures */
      }
      return next;
    } catch (err) {
      if (isProjectColumnsUnavailableError(err)) {
        throw new Error(projectColumnsUnavailableMessage(err));
      }
      throw err;
    }
  },
  async listLeaderProjectIds(): Promise<string[]> {
    if (hasSupabaseConfig()) return cloudApi.listLeaderProjectIds();
    return localApi.listLeaderProjectIds();
  },
  async deleteProject(id: string) {
    if (hasSupabaseConfig()) return cloudApi.deleteProject(id);
    localApi.deleteProject(id);
  },
  async listMembers(projectId: string): Promise<ProjectMember[]> {
    if (hasSupabaseConfig()) {
      return mergeMembersWithExtras(await cloudApi.listMembers(projectId)).filter(
        (m) => m.project_id === projectId,
      );
    }
    return mergeMembersWithExtras(localApi.listMembers(projectId)).filter(
      (m) => m.project_id === projectId,
    );
  },
  async listAllMembers(): Promise<ProjectMember[]> {
    if (hasSupabaseConfig()) return mergeMembersWithExtras(await cloudApi.listAllMembers());
    return mergeMembersWithExtras(localApi.listAllMembers());
  },
  async myRole(projectId: string): Promise<Role | null> {
    if (hasSupabaseConfig()) return cloudApi.myRole(projectId);
    return localApi.myRole(projectId);
  },
  async createAccounts(rows: AccountInput[]) {
    if (hasSupabaseConfig()) return cloudApi.createAccounts(rows);
    return localApi.createAccounts(rows);
  },
  async addProjectMember(projectId: string, userId: string, role: Role) {
    if (hasSupabaseConfig()) return cloudApi.addProjectMember(projectId, userId, role);
    return localApi.addProjectMember(projectId, userId, role);
  },
  async removeProjectMember(projectId: string, userId: string) {
    if (hasSupabaseConfig()) return cloudApi.removeProjectMember(projectId, userId);
    localApi.removeProjectMember(projectId, userId);
  },
  async inviteMembers(rows: InviteInput[]) {
    if (hasSupabaseConfig()) return cloudApi.inviteMembers(rows);
    return localApi.inviteMembers(rows);
  },
  async changePassword(current: string, next: string) {
    if (hasSupabaseConfig()) return cloudApi.changePassword(current, next);
    return localApi.changePassword(current, next);
  },
  async resetPassword(userId: string) {
    if (hasSupabaseConfig()) return cloudApi.resetPassword(userId);
    return localApi.resetPassword(userId);
  },
  async deletePerson(userId: string) {
    const extras = personnelUiStore.listExtraMembers();
    if (extras.some((p) => p.id === userId)) {
      personnelUiStore.removeExtraMember(userId);
      return;
    }
    if (hasSupabaseConfig()) return cloudApi.deletePerson(userId);
    localApi.deletePerson(userId);
  },
  async createPersonnelMember(input: CreatePersonnelInput): Promise<Profile> {
    const me = await api.currentUser();
    if (!me || normalizePersonnelRole(me) !== "Admin") {
      throw new Error("只有 Admin 可以新增 Member");
    }
    const display_name = input.display_name.trim();
    if (!display_name) throw new Error("姓名不能空白");
    const personnel_role = input.personnel_role;
    const projectIds = [...new Set(input.projectIds ?? [])];
    const phone = (input.phone ?? "").trim();
    let email = (input.email ?? "").trim().toLowerCase();
    const username = (input.username ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
    if (!email && username) email = `${username}@local`;
    if (!email) throw new Error("請填寫帳號或 EMAIL");

    if (!hasSupabaseConfig()) {
      const created = await localApi.createPersonnelMember({
        display_name,
        username: username || undefined,
        email,
        phone,
        personnel_role,
        projectIds,
      });
      return withPersonnelOverlay(created);
    }

    // Neon: Better Auth admin.createUser (no Edge Functions). Legacy Supabase: invite-members.
    // Do not silent-fall-back to localStorage extras on Neon — that looked like success but
    // new members could not log in with DEFAULT_PASSWORD.
    try {
      const creds = await cloudApi.createAccounts([
        { display_name, unit: phone, email },
      ]);
      const cred = creds[0];
      const profiles = await cloudApi.listProfiles();
      let profile =
        profiles.find((p) => p.email.toLowerCase() === email) ??
        (cred ? profiles.find((p) => p.username === cred.username) : undefined);
      if (!profile) throw new Error("帳號已建立，但找不到人員資料");

      const login =
        username ||
        cred?.username ||
        profile.username;
      if (hasNeonConfig()) {
        await cloudApi.syncPersonnelProfile(profile.id, {
          username: login,
          display_name,
          unit: phone,
          is_admin: personnel_role === "Admin",
          personnel_role,
        });
        const refreshed = await cloudApi.listProfiles();
        profile = refreshed.find((p) => p.id === profile!.id) ?? profile;
      }

      profile = personnelUiStore.applyOverlay(profile.id, profile, {
        display_name,
        unit: phone,
        email,
        personnel_role,
        projectIds,
      });
      if (projectIds.length > 0) {
        await api.setPersonProjects(profile.id, projectIds);
      }
      return withPersonnelOverlay(profile);
    } catch (err) {
      if (hasNeonConfig()) throw err;
      // Legacy Supabase-only: keep UI-only extra member if Edge invite is unavailable.
      const id = crypto.randomUUID();
      const login =
        username ||
        email.split("@")[0].toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 24) ||
        "user";
      return personnelUiStore.addExtraMember(
        {
          id,
          username: login,
          display_name,
          unit: phone,
          email,
          is_admin: personnel_role === "Admin",
          personnel_role,
          custom: {},
        },
        projectIds,
      );
    }
  },
  async listPersonnelColumns(): Promise<PersonnelColumn[]> {
    if (!hasSupabaseConfig()) {
      importColumnsIfEmpty(localApi.listPersonnelColumns());
    }
    return personnelUiStore.listColumns();
  },
  async addPersonnelColumn(label: string): Promise<PersonnelColumn> {
    // Client-side persistence for both local and Supabase (cloud) modes.
    return personnelUiStore.addColumn(label);
  },
  async removePersonnelColumn(columnId: string) {
    personnelUiStore.removeColumn(columnId);
  },
  async updateProfile(
    userId: string,
    patch: {
      display_name?: string;
      unit?: string;
      email?: string;
      personnel_role?: PersonnelRole;
      custom?: Record<string, string>;
    },
  ): Promise<Profile> {
    const extra = personnelUiStore.listExtraMembers().find((p) => p.id === userId);
    if (extra) {
      return personnelUiStore.applyOverlay(userId, extra, patch);
    }
    if (!hasSupabaseConfig()) {
      const updated = localApi.updateProfile(userId, patch);
      return withPersonnelOverlay(updated);
    }
    const profiles = await cloudApi.listProfiles();
    const base = profiles.find((p) => p.id === userId);
    if (!base) throw new Error("找不到這位人員");
    // Neon: persist Personnel fields on profiles (role was previously localStorage-only).
    if (hasNeonConfig()) {
      const neonPatch: {
        display_name?: string;
        unit?: string;
        is_admin?: boolean;
        personnel_role?: PersonnelRole;
      } = {};
      if (patch.display_name !== undefined) neonPatch.display_name = patch.display_name;
      if (patch.unit !== undefined) neonPatch.unit = patch.unit;
      if (patch.personnel_role !== undefined) {
        neonPatch.personnel_role = patch.personnel_role;
        neonPatch.is_admin = patch.personnel_role === "Admin";
      }
      if (Object.keys(neonPatch).length > 0) {
        await cloudApi.syncPersonnelProfile(userId, neonPatch);
      }
    }
    const refreshed =
      hasNeonConfig() &&
      (patch.personnel_role !== undefined ||
        patch.display_name !== undefined ||
        patch.unit !== undefined)
        ? ((await cloudApi.listProfiles()).find((p) => p.id === userId) ?? base)
        : base;
    return personnelUiStore.applyOverlay(userId, refreshed, patch);
  },
  async setPersonProjects(userId: string, projectIds: string[]) {
    if (personnelUiStore.listExtraMembers().some((p) => p.id === userId)) {
      personnelUiStore.setExtraProjectIds(userId, projectIds);
      return;
    }
    if (!hasSupabaseConfig()) {
      localApi.setPersonProjects(userId, projectIds);
      return;
    }
    // Cloud: sync memberships via existing member APIs (member role by default).
    const current = (await cloudApi.listAllMembers()).filter((m) => m.user_id === userId);
    const wanted = new Set(projectIds);
    for (const m of current) {
      if (!wanted.has(m.project_id)) {
        await cloudApi.removeProjectMember(m.project_id, userId);
      }
    }
    for (const projectId of wanted) {
      if (!current.some((m) => m.project_id === projectId)) {
        await cloudApi.addProjectMember(projectId, userId, "member");
      }
    }
  },
  async listTasks(projectId: string): Promise<Task[]> {
    if (hasSupabaseConfig()) return cloudApi.listTasks(projectId);
    return localApi.listTasks(projectId);
  },
  async createTask(input: Omit<Task, "id">): Promise<Task> {
    if (hasSupabaseConfig()) return cloudApi.createTask(input);
    return localApi.createTask(input);
  },
  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    if (hasSupabaseConfig()) return cloudApi.updateTask(id, patch);
    return localApi.updateTask(id, patch);
  },
  async deleteTask(id: string) {
    if (hasSupabaseConfig()) return cloudApi.deleteTask(id);
    localApi.deleteTask(id);
  },
  async allTasks(): Promise<Task[]> {
    if (hasSupabaseConfig()) return cloudApi.allTasksForUser();
    return localApi.allTasks();
  },
  async bootstrapAdmin(_username: string, _password: string, _email: string) {
    throw new Error("Public Create admin is disabled. Ask an Admin to Add Member in Personnel.");
  },

  /** Shared notes — visible to all authenticated members (no owner filter). */
  async listNotes(): Promise<NoteItem[]> {
    return withSharedCloud(() => cloudApi.listNotes(), () => localApi.listNotes(), "read");
  },
  async createNote(input: { title: string; body: string; color: NoteColor; url?: string }): Promise<NoteItem> {
    return withSharedCloud(() => cloudApi.createNote(input), () => localApi.createNote(input), "write");
  },
  async updateNote(
    id: string,
    patch: Partial<{ title: string; body: string; color: NoteColor; url: string; pinned: boolean }>,
  ): Promise<NoteItem> {
    return withSharedCloud(() => cloudApi.updateNote(id, patch), () => localApi.updateNote(id, patch), "write");
  },
  async removeNote(id: string) {
    await withSharedCloud(() => cloudApi.removeNote(id), () => {
      localApi.removeNote(id);
    }, "write");
  },

  /** Shared OTP vault — visible to all authenticated members (no owner filter). */
  async listOtpEntries(): Promise<OtpVaultEntry[]> {
    return withSharedCloud(() => cloudApi.listOtpEntries(), () => localApi.listOtpEntries(), "read");
  },
  async addOtpEntry(input: {
    label?: string;
    issuer?: string;
    account?: string;
    secret: string;
    qr_text?: string;
    thumb?: string;
    access_password?: string;
    owner_id?: string;
  }): Promise<OtpVaultEntry> {
    return withSharedCloud(() => cloudApi.addOtpEntry(input), () => localApi.addOtpEntry(input), "write");
  },
  async removeOtpEntry(id: string) {
    await withSharedCloud(() => cloudApi.removeOtpEntry(id), () => {
      localApi.removeOtpEntry(id);
    }, "write");
  },
};
