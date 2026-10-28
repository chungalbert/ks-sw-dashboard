import { normalizeAnalyzedNotes, syncAnalyzedFields } from "./analyzed";
import { credentialOrTransportMessage, isTransportFailure, NETWORK_MESSAGE } from "./loginError";
import { getSupabase } from "./supabase";
import {
  checkpointDocFromProjectRow,
  PROJECT_CHECKPOINTS_CUSTOM_KEY,
  serializeCheckpointsForCustom,
  serializeCheckpointDoc,
  stripCheckpointsCustomKey,
  toCheckpointDoc,
} from "./projectCheckpoints";
import {
  findStandardProjectColumn,
  isReservedProjectColumnLabel,
  isStandardProjectColumnId,
  PROJECT_OMITTED_DEFAULT_IDS,
  seedStandardProjectColumns,
  type ProjectFieldPatch,
} from "./projectsUiStore";
import type { CycleDetailDoc, CycleDetailItem, ItemApplyCell } from "./cycleDetailTypes";
import { normalizeApplyCell } from "./cycleDetailTypes";
import type {
  NewCycleInput,
  SecurityCycle,
  SecurityIssue,
  SecurityIssueInput,
  SecurityRosterEntry,
  SecurityRosterStatus,
  SecurityWave,
  UpdateCycleInput,
} from "./securityTypes";
import {
  SECURITY_STATUSES,
  legacyDatesFromWaves,
  normalizeCycleWaves,
  wavesFromLegacyDates,
} from "./securityTypes";
import type {
  AccountInput,
  CredentialRow,
  InviteInput,
  NoteColor,
  NoteItem,
  OtpVaultEntry,
  PersonnelRole,
  Profile,
  Project,
  ProjectColumn,
  ProjectMember,
  Role,
  Task,
  WorkLogEntry,
  WorkLogEntryPatch,
  WorkLogType,
} from "./types";
import { canManageProjectsIssues, normalizePersonnelRole, normalizeTaskStatus, WORK_LOG_TYPES } from "./types";
import { DEFAULT_PASSWORD, hasNeonConfig, usernameFromEmail } from "./util";

/** Admin + DL elevated for Projects & Issues (not Personnel Add Member). */
function isProjectsElevated(me: Pick<Profile, "is_admin" | "personnel_role">): boolean {
  return canManageProjectsIssues(normalizePersonnelRole(me));
}

function asJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* ignore */
    }
  }
  return [];
}

function normalizeSecurityStatus(raw: string | undefined): SecurityRosterStatus {
  if (raw && (SECURITY_STATUSES as string[]).includes(raw)) return raw as SecurityRosterStatus;
  return "Not Started";
}

function parseWavesJson(raw: unknown): SecurityWave[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, i) => {
      if (!item || typeof item !== "object") return null;
      const o = item as Record<string, unknown>;
      const name = String(o.name ?? "").trim();
      if (!name) return null;
      return {
        id: String(o.id ?? `wave-${i}`),
        name,
        target_date: String(o.target_date ?? "").trim(),
      };
    })
    .filter((w): w is SecurityWave => Boolean(w));
}

function mapSecurityCycle(row: Record<string, unknown>): SecurityCycle {
  const wave1_date = String(row.wave1_date ?? "");
  const wave2_date = String(row.wave2_date ?? "");
  const external_release_date = String(row.external_release_date ?? "");
  const waves = normalizeCycleWaves({
    waves: parseWavesJson(row.waves),
    wave1_date,
    wave2_date,
    external_release_date,
  });
  const legacy = legacyDatesFromWaves(waves);
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    cycle_type: String(row.cycle_type ?? "Quarter"),
    quarter: String(row.quarter ?? ""),
    wave1_date: waves.length ? legacy.wave1_date : wave1_date,
    wave2_date: waves.length ? legacy.wave2_date : wave2_date,
    external_release_date: waves.length ? legacy.external_release_date : external_release_date,
    waves,
    project_ids: asJsonStringArray(row.project_ids),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? row.created_at ?? ""),
  };
}

function mapSecurityRoster(row: Record<string, unknown>): SecurityRosterEntry {
  return {
    id: String(row.id),
    cycle_id: String(row.cycle_id),
    project_id: String(row.project_id ?? ""),
    project_name: String(row.project_name ?? ""),
    wave: String(row.wave ?? "Not set"),
    owner_id: row.owner_id ? String(row.owner_id) : null,
    reviewer_id: row.reviewer_id ? String(row.reviewer_id) : null,
    sa_owner: String(row.sa_owner ?? "").trim(),
    pm_owner: String(row.pm_owner ?? "").trim(),
    dqa_owner: String(row.dqa_owner ?? "").trim(),
    status: normalizeSecurityStatus(row.status != null ? String(row.status) : undefined),
    sort_order: Number(row.sort_order) || 0,
  };
}

function mapSecurityIssue(row: Record<string, unknown>): SecurityIssue {
  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    oem_request_id: String(row.oem_request_id ?? ""),
    detail: String(row.detail ?? ""),
    reference_path: String(row.reference_path ?? ""),
    cycle_ids: asJsonStringArray(row.cycle_ids),
    project_ids: asJsonStringArray(row.project_ids),
    project_names: String(row.project_names ?? ""),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? row.created_at ?? ""),
  };
}

function mapSecurityCycleDetail(row: Record<string, unknown>): CycleDetailDoc {
  const cycleId = String(row.cycle_id ?? "");
  const itemsRaw = Array.isArray(row.items) ? row.items : [];
  const items: CycleDetailItem[] = itemsRaw.map((item, i) => {
    const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const appliesRaw =
      o.applies && typeof o.applies === "object" ? (o.applies as Record<string, unknown>) : {};
    const applies: Record<string, ItemApplyCell> = {};
    for (const [pid, v] of Object.entries(appliesRaw)) {
      applies[pid] = normalizeApplyCell(v);
    }
    const issueId = String(o.issue_id ?? "").trim();
    return {
      id: String(o.id ?? `cdi-${i}`),
      ...(issueId ? { issue_id: issueId } : {}),
      title: String(o.title ?? ""),
      detail: String(o.detail ?? ""),
      cycle_comment: String(o.cycle_comment ?? ""),
      applies,
      sort_order: Number(o.sort_order) || i,
    };
  });
  const releaseRaw =
    row.release && typeof row.release === "object" ? (row.release as Record<string, unknown>) : {};
  const by_project =
    releaseRaw.by_project && typeof releaseRaw.by_project === "object"
      ? (releaseRaw.by_project as CycleDetailDoc["release"]["by_project"])
      : {};
  return {
    cycle_id: cycleId,
    items,
    release: { by_project },
    updated_at: String(row.updated_at ?? new Date().toISOString()),
  };
}

/** Hidden project row: durable store for custom column defs when Data API cache misses project_columns. */
export const PROJECT_COLUMNS_META_NAME = "__kssw_meta__";
const PROJECT_COLUMNS_DEFS_KEY = "__kssw_column_defs";
/** Set after one-time seed of former builtin middle columns into meta defs. */
const PROJECT_COLUMNS_SEEDED_KEY = "__kssw_columns_seeded";
/** One-time drop of DIS + TALENT POLICY from shared meta (re-addable afterward). */
const PROJECT_OMIT_DIS_TALENT_KEY = "__kssw_omit_dis_talent_v1";

type StoredProjectColumn = ProjectColumn & { sort_order: number };

function metaSeededFlag(custom: Record<string, unknown> | undefined): boolean {
  return String(custom?.[PROJECT_COLUMNS_SEEDED_KEY] ?? "") === "1";
}

function metaOmitDisTalentDone(custom: Record<string, unknown> | undefined): boolean {
  return String(custom?.[PROJECT_OMIT_DIS_TALENT_KEY] ?? "") === "1";
}

function withSortOrder(columns: ProjectColumn[]): StoredProjectColumn[] {
  return columns.map((col, index) => ({
    id: col.id,
    label: col.label,
    sort_order: index,
  }));
}

function isProjectColumnsMetaProject(project: Pick<Project, "name">): boolean {
  return project.name === PROJECT_COLUMNS_META_NAME;
}

/** Legacy custom-column id for TPE OWNER before `projects.tpe_owner` existed. */
const LEGACY_TPE_OWNER_COLUMN_ID = "713a0362-9c56-4be0-bd1c-4c3e912e334a";

function normalizeProjectRow(row: Project): Project {
  const custom =
    row.custom && typeof row.custom === "object" && !Array.isArray(row.custom)
      ? { ...(row.custom as Record<string, string>) }
      : {};
  let tpe_owner = row.tpe_owner ?? "";
  if (!tpe_owner.trim() && custom[LEGACY_TPE_OWNER_COLUMN_ID]?.trim()) {
    tpe_owner = custom[LEGACY_TPE_OWNER_COLUMN_ID].trim();
  }
  // Prefer dedicated column; drop legacy custom key from the client view.
  if (LEGACY_TPE_OWNER_COLUMN_ID in custom) {
    delete custom[LEGACY_TPE_OWNER_COLUMN_ID];
  }
  const checkpointDoc = checkpointDocFromProjectRow({
    checkpoints: (row as Project & { checkpoints?: unknown }).checkpoints,
    custom,
  });
  const customClean = stripCheckpointsCustomKey(custom);
  return {
    ...row,
    lenovo_name: row.lenovo_name ?? "",
    bios_id: row.bios_id ?? "",
    platform: row.platform ?? "",
    dis: row.dis ?? "",
    ss_date: row.ss_date ?? "",
    eol_date: row.eol_date ?? "",
    security_update: row.security_update ?? "",
    talent_policy: row.talent_policy ?? "",
    owner: row.owner ?? "",
    project_owner: row.project_owner ?? "",
    tpe_owner,
    custom: customClean,
    checkpoints: checkpointDoc.items,
    checkpoint_handover_date: checkpointDoc.handover_date,
  };
}

/**
 * Meta column defs may be a JSON string, a double-encoded string, or a jsonb array
 * already parsed by PostgREST. Empty / unreadable → [].
 */
function parseStoredProjectColumns(raw: unknown): StoredProjectColumn[] {
  if (raw == null) return [];
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return [];
    }
    // Double-encoded: JSON string of a JSON array.
    if (typeof parsed === "string") {
      try {
        parsed = JSON.parse(parsed) as unknown;
      } catch {
        return [];
      }
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const row = item as { id?: unknown; label?: unknown; sort_order?: unknown };
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const label = typeof row.label === "string" ? row.label.trim() : "";
      if (!id || !label) return null;
      const sort_order = Number(row.sort_order);
      return {
        id,
        label,
        sort_order: Number.isFinite(sort_order) ? sort_order : index,
      };
    })
    .filter((row): row is StoredProjectColumn => Boolean(row));
}

function postgrestErrorMessage(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "object") {
    const row = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    return [row.message, row.code, row.details, row.hint].filter(Boolean).map(String).join(" ").trim();
  }
  return String(err);
}

function throwPostgrestError(error: unknown): never {
  const msg = postgrestErrorMessage(error) || "Request failed";
  const wrapped = new Error(msg);
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (code != null) (wrapped as Error & { code?: string }).code = String(code);
  }
  throw wrapped;
}

function isSchemaCacheMissError(err: unknown): boolean {
  const msg = postgrestErrorMessage(err).toLowerCase();
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : "";
  return (
    code === "PGRST205" ||
    code === "PGRST202" ||
    code === "PGRST204" ||
    msg.includes("schema cache") ||
    msg.includes("could not find the table") ||
    msg.includes("could not find the function") ||
    msg.includes("could not find the") && msg.includes("column")
  );
}

function normalizeTask(task: Task): Task {
  return {
    ...task,
    status: normalizeTaskStatus(task.status),
    note: task.note ?? "",
    created_at: typeof task.created_at === "string" && task.created_at ? task.created_at : undefined,
    ...syncAnalyzedFields(normalizeAnalyzedNotes(task)),
  };
}

function sb() {
  const client = getSupabase();
  if (!client) throw new Error("尚未設定 Supabase 或 Neon");
  return client;
}

/** Better Auth client behind Neon SupabaseAuthAdapter (admin.createUser / setUserPassword / removeUser). */
function neonBetterAuth() {
  const auth = sb().auth as {
    getBetterAuthInstance?: () => {
      admin: {
        createUser: (input: {
          email: string;
          password: string;
          name: string;
          role?: string;
          data?: Record<string, unknown>;
        }) => Promise<{ data?: { user?: { id: string } }; user?: { id: string }; error?: { message?: string } }>;
        setUserPassword: (input: { userId: string; newPassword: string }) => Promise<{ error?: { message?: string } }>;
        removeUser: (input: { userId: string }) => Promise<{ error?: { message?: string } }>;
        setRole: (input: { userId: string; role: string }) => Promise<{ error?: { message?: string } }>;
      };
    };
  };
  const instance = auth.getBetterAuthInstance?.();
  if (!instance?.admin) {
    throw new Error("Neon Auth admin API 不可用");
  }
  return instance;
}

function neonAdminErrorMessage(err: unknown, fallback: string): string {
  const message =
    err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string"
      ? (err as { message: string }).message
      : err instanceof Error
        ? err.message
        : "";
  const status =
    err && typeof err === "object" && "status" in err ? Number((err as { status: unknown }).status) : NaN;
  if (status === 403 || /forbidden|not admin|unauthorized|permission/i.test(message)) {
    return "Neon Auth 需要 Admin 角色：請在 Neon Console → Auth → Users 對此帳號選 Make admin（與 Personnel Admin 不同）";
  }
  return message || fallback;
}

async function createAccountsViaNeon(rows: AccountInput[]): Promise<CredentialRow[]> {
  const me = await cloudApi.currentUser();
  if (!me) throw new Error("尚未登入");
  if (normalizePersonnelRole(me) !== "Admin") {
    throw new Error("只有 Admin 可以新增 Member");
  }

  const betterAuth = neonBetterAuth();
  const existingProfiles = await cloudApi.listProfiles();
  const taken = new Set(existingProfiles.map((p) => p.username.toLowerCase()));
  const credentials: CredentialRow[] = [];

  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!email || !row.display_name?.trim()) continue;

    const existing = existingProfiles.find((p) => p.email.toLowerCase() === email);
    if (existing) {
      credentials.push({
        display_name: existing.display_name,
        username: existing.username,
        email: existing.email,
        password: "(已有帳號，沿用原密碼)",
      });
      continue;
    }

    const username = usernameFromEmail(email, taken);
    taken.add(username);
    const password = DEFAULT_PASSWORD;
    const display_name = row.display_name.trim();
    const unit = row.unit?.trim() ?? "";

    let userId = "";
    try {
      const created = await betterAuth.admin.createUser({
        email,
        password,
        name: display_name,
        role: "user",
        data: { username, display_name, unit },
      });
      if (created?.error?.message) throw new Error(created.error.message);
      userId = created?.data?.user?.id ?? created?.user?.id ?? "";
    } catch (err) {
      throw new Error(neonAdminErrorMessage(err, "建立 Neon 帳號失敗"));
    }
    if (!userId) throw new Error("建立 Neon 帳號失敗：沒有回傳使用者 id");

    const { error: insertError } = await sb().from("profiles").insert({
      id: userId,
      username,
      display_name,
      unit,
      email,
      is_admin: false,
    });
    if (insertError) throw insertError;

    existingProfiles.push({
      id: userId,
      username,
      display_name,
      unit,
      email,
      is_admin: false,
    });
    credentials.push({ display_name, username, email, password });
  }

  return credentials;
}

async function invokeInviteMembers(body: Record<string, unknown>) {
  const { data, error } = await sb().functions.invoke("invite-members", { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

async function ensureOwnProfile(): Promise<Profile | null> {
  const existing = await cloudApi.currentUser();
  if (existing) return existing;
  const client = sb();
  const { data: session } = await client.auth.getSession();
  const user = session.session?.user;
  if (!user?.id || !user.email) return null;
  const meta = (user.user_metadata ?? {}) as { username?: string; display_name?: string; unit?: string };
  const username = (meta.username || user.email.split("@")[0] || "user").slice(0, 24);
  const { error } = await client.from("profiles").insert({
    id: user.id,
    username,
    display_name: meta.display_name || username,
    email: user.email,
    unit: meta.unit || "",
    is_admin: false,
  });
  if (error && !/duplicate|already exists|unique/i.test(error.message)) throw error;
  return cloudApi.currentUser();
}

export const cloudApi = {
  async signIn(identifier: string, password: string): Promise<Profile> {
    const client = sb();
    let email = identifier.trim();
    if (!email.includes("@")) {
      const lookedUp = await client.rpc("lookup_login_email", {
        identifier: email,
      });
      if (lookedUp.error || !lookedUp.data) {
        throw new Error(credentialOrTransportMessage(lookedUp.error, lookedUp.status));
      }
      email = lookedUp.data as string;
    }
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) {
      if (isTransportFailure(error)) throw new Error(NETWORK_MESSAGE);
      throw new Error(error.message === "Invalid login credentials" ? "帳號或密碼不正確。" : error.message);
    }
    const profile = await ensureOwnProfile();
    if (!profile) throw new Error("找不到個人資料");
    return profile;
  },

  async signOut() {
    await sb().auth.signOut();
  },

  async currentUser(): Promise<Profile | null> {
    const client = sb();
    const { data: session } = await client.auth.getSession();
    const id = session.session?.user.id;
    if (!id) return null;
    const { data, error } = await client.from("profiles").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data as Profile | null;
  },

  async bootstrapAdmin(_username: string, _password: string, _email: string): Promise<Profile> {
    throw new Error("Public Create admin is disabled. Ask an Admin to Add Member in Personnel.");
  },

  async listProfiles(): Promise<Profile[]> {
    const { data, error } = await sb().from("profiles").select("*").order("display_name");
    if (error) throw error;
    return data as Profile[];
  },

  async listProjects(): Promise<Project[]> {
    const { data, error } = await sb().from("projects").select("*").order("created_at");
    if (error) throw error;
    return (data as Project[])
      .map(normalizeProjectRow)
      .filter((project) => !isProjectColumnsMetaProject(project));
  },

  async createProject(name: string, description: string): Promise<Project> {
    const me = await cloudApi.currentUser();
    if (!me) throw new Error("尚未登入");
    const trimmed = name.trim();
    if (!trimmed) throw new Error("專案名稱不能空白");
    if (trimmed === PROJECT_COLUMNS_META_NAME) {
      throw new Error("此專案名稱為系統保留");
    }
    const { data, error } = await sb()
      .from("projects")
      .insert({ name: trimmed, description, created_by: me.id })
      .select()
      .single();
    if (error) throw error;
    return normalizeProjectRow(data as Project);
  },

  async updateProject(projectId: string, patch: ProjectFieldPatch): Promise<Project> {
    // Fetch by id — do NOT listProjects()+find. Neon Data API can briefly return an
    // incomplete/empty list while the UI still shows a retained prior list (StoreContext
    // retainPrior). CheckPoint Save then threw「找不到專案」even though the row was visible.
    const { data: rawBase, error: loadError } = await sb()
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .maybeSingle();
    if (loadError) throwPostgrestError(loadError);
    if (!rawBase) throw new Error("找不到專案");
    const base = normalizeProjectRow(rawBase as Project);

    const updates: Record<string, string | Record<string, string> | unknown> = {};
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("專案名稱不能空白");
      updates.name = name;
    }
    if (patch.description !== undefined) updates.description = patch.description.trim();
    if (patch.lenovo_name !== undefined) updates.lenovo_name = patch.lenovo_name.trim();
    if (patch.bios_id !== undefined) updates.bios_id = patch.bios_id.trim();
    if (patch.platform !== undefined) updates.platform = patch.platform.trim();
    if (patch.dis !== undefined) updates.dis = patch.dis.trim();
    if (patch.ss_date !== undefined) updates.ss_date = patch.ss_date.trim();
    if (patch.eol_date !== undefined) updates.eol_date = patch.eol_date.trim();
    if (patch.security_update !== undefined) updates.security_update = patch.security_update.trim();
    if (patch.talent_policy !== undefined) updates.talent_policy = patch.talent_policy.trim();
    if (patch.owner !== undefined) updates.owner = patch.owner.trim();
    if (patch.project_owner !== undefined) updates.project_owner = patch.project_owner.trim();
    if (patch.tpe_owner !== undefined) updates.tpe_owner = patch.tpe_owner.trim();

    let nextCustom: Record<string, string> | undefined =
      patch.custom !== undefined ? { ...(base.custom ?? {}), ...patch.custom } : undefined;

    if (patch.checkpoints !== undefined || patch.checkpoint_handover_date !== undefined) {
      const doc = serializeCheckpointDoc(
        toCheckpointDoc(
          patch.checkpoints ?? base.checkpoints ?? [],
          patch.checkpoint_handover_date !== undefined
            ? patch.checkpoint_handover_date
            : (base.checkpoint_handover_date ?? ""),
        ),
      );
      updates.checkpoints = doc;
      nextCustom = {
        ...(base.custom ?? {}),
        ...(nextCustom ?? {}),
        [PROJECT_CHECKPOINTS_CUSTOM_KEY]: serializeCheckpointsForCustom(doc),
      };
    } else if (nextCustom !== undefined) {
      // Re-embed fallback key so unrelated custom column saves do not wipe CheckPoints.
      nextCustom = {
        ...nextCustom,
        [PROJECT_CHECKPOINTS_CUSTOM_KEY]: serializeCheckpointsForCustom(
          toCheckpointDoc(base.checkpoints ?? [], base.checkpoint_handover_date ?? ""),
        ),
      };
    }

    if (nextCustom !== undefined) updates.custom = nextCustom;
    if (Object.keys(updates).length === 0) return base;

    const runUpdate = async (payload: Record<string, unknown>) => {
      const { data, error } = await sb()
        .from("projects")
        .update(payload)
        .eq("id", projectId)
        .select()
        .single();
      if (error) throwPostgrestError(error);
      return normalizeProjectRow(data as Project);
    };

    try {
      return await runUpdate(updates);
    } catch (err) {
      // Stale Data API cache / missing checkpoints column: persist via custom fallback only.
      const wroteCheckpoints =
        patch.checkpoints !== undefined || patch.checkpoint_handover_date !== undefined;
      const msg = postgrestErrorMessage(err);
      const missingOrBadCheckpointsCol =
        wroteCheckpoints &&
        "checkpoints" in updates &&
        (/checkpoints/i.test(msg) || isSchemaCacheMissError(err));
      if (!missingOrBadCheckpointsCol) throw err instanceof Error ? err : new Error(msg || "Update failed");
      const { checkpoints: _drop, ...rest } = updates;
      if (Object.keys(rest).length === 0) {
        throw err instanceof Error ? err : new Error(msg || "CheckPoint save failed");
      }
      return await runUpdate(rest);
    }
  },

  /** Ask PostgREST to reload its schema cache (admin-only SECURITY DEFINER). */
  async reloadPgrstSchema(): Promise<void> {
    const { error } = await sb().rpc("reload_pgrst_schema");
    if (error) throw error;
  },

  /**
   * Ensure the hidden meta project that stores column defs in projects.custom.
   * Neon Data API often returns PGRST205 for project_columns INSERT even when the table
   * exists; projects.custom PATCH is reliable and does not need a schema-cache refresh.
   */
  async ensureProjectColumnsMeta(): Promise<Project> {
    const { data, error } = await sb()
      .from("projects")
      .select("*")
      .eq("name", PROJECT_COLUMNS_META_NAME)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) return normalizeProjectRow(data as Project);

    const me = await cloudApi.currentUser();
    if (!me) throw new Error("尚未登入");
    const seeded = seedStandardProjectColumns([], false);
    const { data: created, error: createError } = await sb()
      .from("projects")
      .insert({
        name: PROJECT_COLUMNS_META_NAME,
        description: "System: shared project column definitions",
        created_by: me.id,
        custom: {
          [PROJECT_COLUMNS_DEFS_KEY]: JSON.stringify(withSortOrder(seeded.columns)),
          [PROJECT_COLUMNS_SEEDED_KEY]: "1",
        },
      })
      .select()
      .single();
    if (createError) throw createError;
    return normalizeProjectRow(created as Project);
  },

  async listProjectColumnsFromMeta(): Promise<StoredProjectColumn[]> {
    const meta = await cloudApi.ensureProjectColumnsMeta();
    const custom = (meta.custom ?? {}) as Record<string, unknown>;
    return parseStoredProjectColumns(custom[PROJECT_COLUMNS_DEFS_KEY]).sort(
      (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label),
    );
  },

  async saveProjectColumnsToMeta(
    columns: StoredProjectColumn[],
    options?: { markSeeded?: boolean; markOmitDisTalent?: boolean },
  ): Promise<void> {
    const meta = await cloudApi.ensureProjectColumnsMeta();
    const normalized = columns
      .map((col, index) => ({
        id: col.id,
        label: col.label.trim(),
        sort_order: Number.isFinite(col.sort_order) ? col.sort_order : index,
      }))
      .filter((col) => col.id && col.label)
      .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label));
    const prevCustom = (meta.custom ?? {}) as Record<string, unknown>;
    const nextCustom: Record<string, unknown> = {
      ...prevCustom,
      // Always store as a JSON string so parseStoredProjectColumns stays deterministic.
      [PROJECT_COLUMNS_DEFS_KEY]: JSON.stringify(normalized),
    };
    if (options?.markSeeded || metaSeededFlag(prevCustom)) {
      nextCustom[PROJECT_COLUMNS_SEEDED_KEY] = "1";
    }
    if (options?.markOmitDisTalent || metaOmitDisTalentDone(prevCustom)) {
      nextCustom[PROJECT_OMIT_DIS_TALENT_KEY] = "1";
    }
    const { error } = await sb().from("projects").update({ custom: nextCustom }).eq("id", meta.id);
    if (error) throw error;
  },

  async listProjectColumnsFromTable(): Promise<StoredProjectColumn[]> {
    const { data, error } = await sb()
      .from("project_columns")
      .select("id, label, sort_order")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as { id: string; label: string; sort_order: number }[]).map((row, index) => ({
      id: row.id,
      label: row.label,
      sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : index,
    }));
  },

  async listProjectColumns(): Promise<ProjectColumn[]> {
    let tableCols: StoredProjectColumn[] = [];
    try {
      tableCols = await cloudApi.listProjectColumnsFromTable();
    } catch (err) {
      if (!isSchemaCacheMissError(err)) throw err;
    }
    const meta = await cloudApi.ensureProjectColumnsMeta();
    const metaCustom = (meta.custom ?? {}) as Record<string, unknown>;
    const metaCols = parseStoredProjectColumns(metaCustom[PROJECT_COLUMNS_DEFS_KEY]).sort(
      (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label),
    );
    const alreadySeeded = metaSeededFlag(metaCustom);
    // After seed, meta is the membership source of truth (table is best-effort mirror).
    // Otherwise a failed project_columns DELETE would resurrect removed columns.
    const mergedStored = (() => {
      const byId = new Map<string, StoredProjectColumn>();
      for (const col of metaCols) byId.set(col.id, col);
      for (const col of tableCols) {
        const prev = byId.get(col.id);
        if (prev) {
          // Prefer meta label when both exist — avoids stale project_columns
          // (e.g. da still "Owner" after TPE OWNER restore) overwriting meta.
          byId.set(col.id, {
            ...prev,
            ...col,
            label: prev.label || col.label,
            sort_order: prev.sort_order,
          });
        } else if (!alreadySeeded) {
          byId.set(col.id, col);
        }
      }
      return [...byId.values()].sort(
        (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label),
      );
    })();
    const seeded = seedStandardProjectColumns(
      mergedStored.map(({ id, label }) => ({ id, label })),
      alreadySeeded,
    );

    // One-time: drop DIS + TALENT POLICY from shared defaults (Admin can re-add later).
    let omitDisTalent = false;
    let membership = seeded.columns;
    if (!metaOmitDisTalentDone(metaCustom)) {
      const filtered = membership.filter((c) => !PROJECT_OMITTED_DEFAULT_IDS.has(c.id));
      if (filtered.length !== membership.length) {
        membership = filtered;
        omitDisTalent = true;
      } else {
        // Flag even when already absent so we do not re-check forever.
        omitDisTalent = true;
      }
    }

    const finalStored = withSortOrder(membership);

    // Keep meta as durable mirror so Add Column survives project_columns PGRST205.
    const metaKey = metaCols
      .map((c) => `${c.id}:${c.label}:${c.sort_order}`)
      .sort()
      .join("|");
    const finalKey = finalStored
      .map((c) => `${c.id}:${c.label}:${c.sort_order}`)
      .sort()
      .join("|");
    const needWrite =
      finalKey !== metaKey ||
      seeded.changed ||
      omitDisTalent ||
      (seeded.seeded && !alreadySeeded);
    if (needWrite) {
      try {
        await cloudApi.saveProjectColumnsToMeta(finalStored, {
          markSeeded: seeded.seeded,
          markOmitDisTalent: omitDisTalent || metaOmitDisTalentDone(metaCustom),
        });
        // Best-effort delete omitted ids from project_columns mirror.
        if (omitDisTalent) {
          for (const id of PROJECT_OMITTED_DEFAULT_IDS) {
            try {
              const { error } = await sb().from("project_columns").delete().eq("id", id);
              if (error && !isSchemaCacheMissError(error)) throw error;
            } catch (err) {
              if (!isSchemaCacheMissError(err)) throw err;
            }
          }
        }
      } catch {
        /* non-admin readers may lack update — listing still works from merge */
      }
    }

    return finalStored.map(({ id, label }) => ({ id, label }));
  },

  async addProjectColumn(label: string, id?: string): Promise<ProjectColumn> {
    const me = await cloudApi.currentUser();
    if (!me) throw new Error("尚未登入");
    if (!isProjectsElevated(me)) throw new Error("只有 Admin 或 DL 可以新增欄位");
    const trimmed = label.trim();
    if (!trimmed) throw new Error("欄位名稱不能空白");
    if (isReservedProjectColumnLabel(trimmed)) {
      throw new Error(`「${trimmed}」是固定欄位，無法再新增`);
    }

    const existing = await cloudApi.listProjectColumns();
    if (existing.some((c) => c.label.trim().toUpperCase() === trimmed.toUpperCase())) {
      throw new Error("欄位名稱已存在");
    }

    const std = findStandardProjectColumn(trimmed);
    if (std && existing.some((c) => c.id === std.id)) {
      throw new Error("欄位名稱已存在");
    }

    const metaCols = await cloudApi.listProjectColumnsFromMeta();
    const maxOrder = metaCols.reduce((max, row) => Math.max(max, row.sort_order), -1);
    const col: StoredProjectColumn = {
      id: std?.id ?? id ?? crypto.randomUUID(),
      label: std?.label ?? trimmed,
      sort_order: maxOrder + 1,
    };

    // Durable path first: projects.custom is always in the Data API schema cache.
    await cloudApi.saveProjectColumnsToMeta([...metaCols, col], { markSeeded: true });

    // Best-effort mirror into project_columns (may 404 PGRST205 on Neon until Console refresh).
    try {
      const { error } = await sb()
        .from("project_columns")
        .insert({
          id: col.id,
          label: col.label,
          sort_order: col.sort_order,
          created_by: me.id,
        });
      if (error && !isSchemaCacheMissError(error)) {
        // Unique race with a concurrent table insert — meta already has the row.
        const code = String((error as { code?: string }).code ?? "");
        if (code !== "23505") throw error;
      }
    } catch (err) {
      if (!isSchemaCacheMissError(err)) throw err;
    }

    return { id: col.id, label: col.label };
  },

  async removeProjectColumn(columnId: string) {
    const me = await cloudApi.currentUser();
    if (!me) throw new Error("尚未登入");
    if (!isProjectsElevated(me)) throw new Error("只有 Admin 或 DL 可以刪除欄位");

    const metaCols = await cloudApi.listProjectColumnsFromMeta();
    const target = metaCols.find((col) => col.id === columnId);
    if (target && isReservedProjectColumnLabel(target.label)) {
      throw new Error("固定欄位無法刪除");
    }

    await cloudApi.saveProjectColumnsToMeta(
      metaCols.filter((col) => col.id !== columnId),
      { markSeeded: true },
    );

    try {
      const { error } = await sb().from("project_columns").delete().eq("id", columnId);
      if (error && !isSchemaCacheMissError(error)) throw error;
    } catch (err) {
      if (!isSchemaCacheMissError(err)) throw err;
    }

    // Standard middle columns keep values on projects.* fields so re-add restores cells.
    if (isStandardProjectColumnId(columnId)) return;

    // Strip custom cell values for this column from every visible project (best-effort).
    // Read raw `custom` — normalizeProjectRow strips __kssw_checkpoints; rewriting that
    // cleaned object would wipe the CheckPoint dual-write fallback.
    const { data: rawRows, error: rawError } = await sb()
      .from("projects")
      .select("id, custom, name");
    if (rawError) throwPostgrestError(rawError);
    for (const row of rawRows ?? []) {
      if (isProjectColumnsMetaProject(row as { name: string })) continue;
      const custom =
        row.custom && typeof row.custom === "object" && !Array.isArray(row.custom)
          ? { ...(row.custom as Record<string, string>) }
          : {};
      if (!(columnId in custom)) continue;
      const nextCustom = { ...custom };
      delete nextCustom[columnId];
      const { error: updateError } = await sb()
        .from("projects")
        .update({ custom: nextCustom })
        .eq("id", row.id);
      if (updateError) throwPostgrestError(updateError);
    }
  },

  /**
   * Replace managed column defs + display order in one meta write (Admin Save).
   * Mirrors into project_columns best-effort; strips custom cells for removed non-standards.
   */
  async replaceProjectColumns(columns: ProjectColumn[]): Promise<ProjectColumn[]> {
    const me = await cloudApi.currentUser();
    if (!me) throw new Error("尚未登入");
    if (!isProjectsElevated(me)) throw new Error("只有 Admin 或 DL 可以編輯欄位");

    const labels = new Set<string>();
    const normalized: ProjectColumn[] = [];
    for (const raw of columns) {
      const id = typeof raw.id === "string" ? raw.id.trim() : "";
      const label = typeof raw.label === "string" ? raw.label.trim() : "";
      if (!id || !label) throw new Error("欄位定義不完整");
      if (isReservedProjectColumnLabel(label)) {
        throw new Error(`「${label}」是固定欄位，無法再新增`);
      }
      const key = label.toUpperCase();
      if (labels.has(key)) throw new Error("欄位名稱已存在");
      labels.add(key);
      const std = findStandardProjectColumn(id) ?? findStandardProjectColumn(label);
      normalized.push(std ? { id: std.id, label: std.label } : { id, label });
    }

    const prev = await cloudApi.listProjectColumnsFromMeta();
    const nextIds = new Set(normalized.map((c) => c.id));
    const removed = prev.filter((c) => !nextIds.has(c.id));
    const stored = withSortOrder(normalized);

    await cloudApi.saveProjectColumnsToMeta(stored, { markSeeded: true });

    try {
      for (const col of removed) {
        const { error } = await sb().from("project_columns").delete().eq("id", col.id);
        if (error && !isSchemaCacheMissError(error)) throw error;
      }
      for (const col of stored) {
        const { error: updateError } = await sb()
          .from("project_columns")
          .update({ label: col.label, sort_order: col.sort_order })
          .eq("id", col.id);
        if (updateError && !isSchemaCacheMissError(updateError)) throw updateError;
        const { error: insertError } = await sb().from("project_columns").insert({
          id: col.id,
          label: col.label,
          sort_order: col.sort_order,
          created_by: me.id,
        });
        if (insertError && !isSchemaCacheMissError(insertError)) {
          const code = String((insertError as { code?: string }).code ?? "");
          if (code !== "23505") throw insertError;
        }
      }
    } catch (err) {
      if (!isSchemaCacheMissError(err)) throw err;
    }

    const stripIds = removed
      .map((c) => c.id)
      .filter((id) => !isStandardProjectColumnId(id));
    if (stripIds.length > 0) {
      // Raw custom (not normalizeProjectRow) so __kssw_checkpoints dual-write survives.
      const { data: rawRows, error: rawError } = await sb()
        .from("projects")
        .select("id, custom, name");
      if (rawError) throwPostgrestError(rawError);
      for (const row of rawRows ?? []) {
        if (isProjectColumnsMetaProject(row as { name: string })) continue;
        const custom =
          row.custom && typeof row.custom === "object" && !Array.isArray(row.custom)
            ? { ...(row.custom as Record<string, string>) }
            : {};
        let changed = false;
        const nextCustom = { ...custom };
        for (const id of stripIds) {
          if (id in nextCustom) {
            delete nextCustom[id];
            changed = true;
          }
        }
        if (!changed) continue;
        const { error: updateError } = await sb()
          .from("projects")
          .update({ custom: nextCustom })
          .eq("id", row.id);
        if (updateError) throwPostgrestError(updateError);
      }
    }

    return normalized;
  },

  async listLeaderProjectIds(): Promise<string[]> {
    const me = await cloudApi.currentUser();
    if (!me) return [];
    if (isProjectsElevated(me)) {
      const projects = await cloudApi.listProjects();
      return projects.map((p) => p.id);
    }
    const { data, error } = await sb()
      .from("project_members")
      .select("project_id")
      .eq("user_id", me.id)
      .eq("role", "leader");
    if (error) throw error;
    return (data ?? []).map((row: { project_id: string }) => row.project_id);
  },

  async deleteProject(id: string) {
    const { data: row, error: readError } = await sb().from("projects").select("name").eq("id", id).maybeSingle();
    if (readError) throw readError;
    if (row && isProjectColumnsMetaProject(row as Project)) {
      throw new Error("系統保留專案無法刪除");
    }
    const { error } = await sb().from("projects").delete().eq("id", id);
    if (error) throw error;
  },

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const { data, error } = await sb()
      .from("project_members")
      .select("*")
      .eq("project_id", projectId);
    if (error) throw error;
    return data as ProjectMember[];
  },

  async listAllMembers(): Promise<ProjectMember[]> {
    const { data, error } = await sb().from("project_members").select("*");
    if (error) throw error;
    return data as ProjectMember[];
  },

  async myRole(projectId: string): Promise<Role | null> {
    const me = await cloudApi.currentUser();
    if (!me) return null;
    if (isProjectsElevated(me)) return "leader";
    const members = await cloudApi.listMembers(projectId);
    return members.find((m) => m.user_id === me.id)?.role ?? null;
  },

  async createAccounts(rows: AccountInput[]): Promise<CredentialRow[]> {
    // Neon Auth has no Edge Functions — use Better Auth admin.createUser + profiles insert.
    if (hasNeonConfig()) return createAccountsViaNeon(rows);
    const data = await invokeInviteMembers({ rows });
    return data.credentials as CredentialRow[];
  },

  /** After Add Member / Personnel edit: persist profile fields and promote Neon Auth admin when needed. */
  async syncPersonnelProfile(
    userId: string,
    patch: {
      username?: string;
      display_name?: string;
      unit?: string;
      is_admin?: boolean;
      personnel_role?: PersonnelRole;
    },
  ) {
    if (!hasNeonConfig()) return;
    const updates: Record<string, string | boolean> = {};
    if (patch.username !== undefined) updates.username = patch.username;
    if (patch.display_name !== undefined) updates.display_name = patch.display_name;
    if (patch.unit !== undefined) updates.unit = patch.unit;
    if (patch.is_admin !== undefined) updates.is_admin = patch.is_admin;
    if (patch.personnel_role !== undefined) updates.personnel_role = patch.personnel_role;
    if (Object.keys(updates).length > 0) {
      const { error } = await sb().from("profiles").update(updates).eq("id", userId);
      if (error) {
        // Pre-migration / stale Data API cache: profiles.personnel_role missing.
        // Retry without it so is_admin / phone still sync; Role remains overlay-only
        // until neon/personnel-role.sql is applied and the schema cache is refreshed.
        const msg = `${error.message ?? ""} ${error.code ?? ""} ${error.details ?? ""}`;
        const missingRoleCol =
          patch.personnel_role !== undefined &&
          /personnel_role/i.test(msg) &&
          (/column|schema cache|Could not find|PGRST204/i.test(msg) || error.code === "PGRST204");
        if (!missingRoleCol) throw error;
        const { personnel_role: _drop, ...rest } = updates;
        if (Object.keys(rest).length === 0) return;
        const retry = await sb().from("profiles").update(rest).eq("id", userId);
        if (retry.error) throw retry.error;
        return;
      }
    }
    if (patch.is_admin) {
      try {
        const result = await neonBetterAuth().admin.setRole({ userId, role: "admin" });
        if (result?.error?.message) throw new Error(result.error.message);
      } catch (err) {
        throw new Error(neonAdminErrorMessage(err, "設定 Neon Auth Admin 失敗"));
      }
    }
  },

  async addProjectMember(projectId: string, userId: string, role: Role): Promise<ProjectMember> {
    const members = await cloudApi.listMembers(projectId);
    const existing = members.find((m) => m.user_id === userId);
    if (existing?.role === "leader" && role !== "leader") {
      const leaders = members.filter((m) => m.role === "leader");
      if (leaders.length <= 1) throw new Error("專案至少要有一位領導");
    }
    const { data, error } = await sb()
      .from("project_members")
      .upsert({ project_id: projectId, user_id: userId, role })
      .select()
      .single();
    if (error) throw error;
    return data as ProjectMember;
  },

  async removeProjectMember(projectId: string, userId: string) {
    const members = await cloudApi.listMembers(projectId);
    const target = members.find((m) => m.user_id === userId);
    if (!target) return;
    if (target.role === "leader") {
      const leaders = members.filter((m) => m.role === "leader");
      if (leaders.length <= 1) throw new Error("專案至少要有一位領導");
    }
    const { error } = await sb()
      .from("project_members")
      .delete()
      .eq("project_id", projectId)
      .eq("user_id", userId);
    if (error) throw error;
  },

  async inviteMembers(rows: InviteInput[]): Promise<CredentialRow[]> {
    if (hasNeonConfig()) {
      const creds = await createAccountsViaNeon(rows);
      for (const row of rows) {
        const email = row.email.trim().toLowerCase();
        if (!email || !row.project_id) continue;
        const profiles = await cloudApi.listProfiles();
        const profile = profiles.find((p) => p.email.toLowerCase() === email);
        if (!profile) continue;
        await cloudApi.addProjectMember(row.project_id, profile.id, row.role ?? "member");
      }
      return creds;
    }
    const data = await invokeInviteMembers({ rows });
    return data.credentials as CredentialRow[];
  },

  async changePassword(current: string, next: string) {
    const me = await cloudApi.currentUser();
    if (!me) throw new Error("尚未登入");
    const nextPassword = next.trim();
    if (nextPassword.length < 6) throw new Error("新密碼至少 6 碼");
    const { error: check } = await sb().auth.signInWithPassword({
      email: me.email,
      password: current,
    });
    if (check) throw new Error("目前密碼不正確");
    const { error } = await sb().auth.updateUser({ password: nextPassword });
    if (error) throw error;
  },

  async resetPassword(userId: string) {
    if (hasNeonConfig()) {
      const me = await cloudApi.currentUser();
      if (!me) throw new Error("尚未登入");
      const target = (await cloudApi.listProfiles()).find((p) => p.id === userId);
      if (!target) throw new Error("找不到這位人員");
      if (target.is_admin && !me.is_admin) throw new Error("不能重設管理員密碼");
      const canReset =
        Boolean(me.is_admin) ||
        (await cloudApi.listAllMembers()).some(
          (m) => m.user_id === me.id && m.role === "leader",
        );
      if (!canReset) throw new Error("只有專案領導或管理員可以重設密碼");
      try {
        const result = await neonBetterAuth().admin.setUserPassword({
          userId,
          newPassword: DEFAULT_PASSWORD,
        });
        if (result?.error?.message) throw new Error(result.error.message);
      } catch (err) {
        throw new Error(neonAdminErrorMessage(err, "重設密碼失敗"));
      }
      return;
    }
    await invokeInviteMembers({ reset_user_id: userId });
  },

  async deletePerson(userId: string) {
    if (hasNeonConfig()) {
      const me = await cloudApi.currentUser();
      if (!me) throw new Error("尚未登入");
      if (userId === me.id) throw new Error("不能刪除自己");
      const target = (await cloudApi.listProfiles()).find((p) => p.id === userId);
      if (!target) throw new Error("找不到這位人員");
      if (target.is_admin) throw new Error("不能刪除管理員");
      if (!me.is_admin) {
        const canDelete = (await cloudApi.listAllMembers()).some(
          (m) => m.user_id === me.id && m.role === "leader",
        );
        if (!canDelete) throw new Error("只有專案領導或管理員可以刪除人員");
      }
      const client = sb();
      await client.from("project_members").delete().eq("user_id", userId);
      await client.from("tasks").update({ assignee_id: null }).eq("assignee_id", userId);
      await client.from("projects").update({ created_by: me.id }).eq("created_by", userId);
      const removed = await client.from("profiles").delete().eq("id", userId);
      if (removed.error) throw removed.error;
      try {
        const result = await neonBetterAuth().admin.removeUser({ userId });
        if (result?.error?.message) throw new Error(result.error.message);
      } catch (err) {
        throw new Error(neonAdminErrorMessage(err, "刪除 Neon 帳號失敗"));
      }
      return;
    }
    await invokeInviteMembers({ delete_user_id: userId });
  },

  async listTasks(projectId: string): Promise<Task[]> {
    const { data, error } = await sb()
      .from("tasks")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (error) throw error;
    return (data as Task[]).map(normalizeTask);
  },

  async createTask(input: Omit<Task, "id">): Promise<Task> {
    const { data, error } = await sb().from("tasks").insert(input).select().single();
    if (error) throw error;
    return normalizeTask(data as Task);
  },

  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const { data, error } = await sb().from("tasks").update(patch).eq("id", id).select().single();
    if (error) throw error;
    return normalizeTask(data as Task);
  },

  async deleteTask(id: string) {
    const { error } = await sb().from("tasks").delete().eq("id", id);
    if (error) throw error;
  },

  async allTasksForUser(): Promise<Task[]> {
    const { data, error } = await sb()
      .from("tasks")
      .select("*")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (error) throw error;
    return (data as Task[]).map(normalizeTask);
  },

  async listNotes(): Promise<NoteItem[]> {
    // Stable order: pinned first, then created_at (not updated_at — edits must not reshuffle).
    const { data, error } = await sb()
      .from("shared_notes")
      .select("*")
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => ({
      id: row.id as string,
      title: String(row.title ?? ""),
      body: String(row.body ?? ""),
      color: (row.color as NoteColor) || "blue",
      pinned: Boolean(row.pinned),
      url: (row.url as string | null)?.trim() || undefined,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    }));
  },

  async createNote(input: {
    title: string;
    body: string;
    color: NoteColor;
    url?: string;
  }): Promise<NoteItem> {
    const me = await cloudApi.currentUser();
    const { data, error } = await sb()
      .from("shared_notes")
      .insert({
        title: input.title.trim(),
        body: input.body.trim(),
        color: input.color,
        url: input.url?.trim() || null,
        pinned: false,
        created_by: me?.id ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return {
      id: data.id as string,
      title: String(data.title ?? ""),
      body: String(data.body ?? ""),
      color: (data.color as NoteColor) || "blue",
      pinned: Boolean(data.pinned),
      url: (data.url as string | null)?.trim() || undefined,
      created_at: data.created_at as string,
      updated_at: data.updated_at as string,
    };
  },

  async updateNote(
    id: string,
    patch: Partial<{ title: string; body: string; color: NoteColor; url: string; pinned: boolean }>,
  ): Promise<NoteItem> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.title !== undefined) row.title = patch.title.trim();
    if (patch.body !== undefined) row.body = patch.body.trim();
    if (patch.color !== undefined) row.color = patch.color;
    if (patch.url !== undefined) row.url = patch.url.trim() || null;
    if (patch.pinned !== undefined) row.pinned = patch.pinned;
    const { data, error } = await sb().from("shared_notes").update(row).eq("id", id).select().single();
    if (error) throw error;
    return {
      id: data.id as string,
      title: String(data.title ?? ""),
      body: String(data.body ?? ""),
      color: (data.color as NoteColor) || "blue",
      pinned: Boolean(data.pinned),
      url: (data.url as string | null)?.trim() || undefined,
      created_at: data.created_at as string,
      updated_at: data.updated_at as string,
    };
  },

  async removeNote(id: string) {
    const { error } = await sb().from("shared_notes").delete().eq("id", id);
    if (error) throw error;
  },

  async listOtpEntries(): Promise<OtpVaultEntry[]> {
    const { data, error } = await sb().from("otp_vault_entries").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => ({
      id: String(row.id),
      label: String(row.label ?? ""),
      issuer: String(row.issuer ?? ""),
      account: String(row.account ?? ""),
      secret: String(row.secret ?? ""),
      qr_text: (row.qr_text as string | null)?.trim() || undefined,
      thumb: (row.thumb as string | null)?.trim() || undefined,
      access_password: (row.access_password as string | null)?.trim() || undefined,
      owner_id: row.created_by ? String(row.created_by) : undefined,
      created_at: Number(row.created_at) || Math.floor(Date.now() / 1000),
    }));
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
    const me = await cloudApi.currentUser();
    const issuer = (input.issuer ?? "").trim();
    const account = (input.account ?? "").trim();
    const label =
      (input.label ?? "").trim() ||
      (issuer && account ? `${issuer} · ${account}` : issuer || account || "OTP entry");
    const id = `otp_${crypto.randomUUID()}`;
    const created_at = Math.floor(Date.now() / 1000);
    const { data, error } = await sb()
      .from("otp_vault_entries")
      .insert({
        id,
        label,
        issuer,
        account,
        secret: input.secret.replace(/\s+/g, "").toUpperCase(),
        qr_text: input.qr_text?.trim() || null,
        thumb: input.thumb?.trim() || null,
        access_password: input.access_password?.trim() || null,
        created_by: me?.id ?? null,
        created_at,
      })
      .select()
      .single();
    if (error) throw error;
    return {
      id: String(data.id),
      label: String(data.label ?? ""),
      issuer: String(data.issuer ?? ""),
      account: String(data.account ?? ""),
      secret: String(data.secret ?? ""),
      qr_text: (data.qr_text as string | null)?.trim() || undefined,
      thumb: (data.thumb as string | null)?.trim() || undefined,
      access_password: (data.access_password as string | null)?.trim() || undefined,
      owner_id: data.created_by ? String(data.created_by) : input.owner_id,
      created_at: Number(data.created_at) || created_at,
    };
  },

  async removeOtpEntry(id: string) {
    const { error } = await sb().from("otp_vault_entries").delete().eq("id", id);
    if (error) throw error;
  },

  /** Upsert a local leftover note into the org-shared table (preserves id). */
  async upsertSharedNote(note: NoteItem): Promise<void> {
    const { error } = await sb().from("shared_notes").upsert(
      {
        id: note.id,
        title: note.title,
        body: note.body,
        color: note.color,
        pinned: Boolean(note.pinned),
        url: note.url?.trim() || null,
        created_at: note.created_at,
        updated_at: note.updated_at,
      },
      { onConflict: "id" },
    );
    if (error) throw error;
  },

  /** Upsert a local leftover OTP entry (preserves id; never log secret). */
  async upsertOtpEntry(entry: OtpVaultEntry): Promise<void> {
    const me = await cloudApi.currentUser();
    const ownerLooksLikeUuid = Boolean(entry.owner_id && /^[0-9a-f-]{36}$/i.test(entry.owner_id));
    const { error } = await sb().from("otp_vault_entries").upsert(
      {
        id: entry.id,
        label: entry.label,
        issuer: entry.issuer,
        account: entry.account,
        secret: entry.secret.replace(/\s+/g, "").toUpperCase(),
        qr_text: entry.qr_text?.trim() || null,
        thumb: entry.thumb?.trim() || null,
        access_password: entry.access_password?.trim() || null,
        created_by: ownerLooksLikeUuid ? entry.owner_id : me?.id ?? null,
        created_at: entry.created_at,
      },
      { onConflict: "id" },
    );
    if (error) throw error;
  },

  // —— Security Update (requires neon/security.sql) ——

  async listSecurityCycles(): Promise<SecurityCycle[]> {
    const { data, error } = await sb()
      .from("security_cycles")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => mapSecurityCycle(row as Record<string, unknown>));
  },

  async listSecurityRoster(cycleId?: string): Promise<SecurityRosterEntry[]> {
    let q = sb().from("security_roster").select("*").order("sort_order", { ascending: true });
    if (cycleId) q = q.eq("cycle_id", cycleId);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map((row) => mapSecurityRoster(row as Record<string, unknown>));
  },

  async listSecurityIssues(): Promise<SecurityIssue[]> {
    const { data, error } = await sb()
      .from("security_issues")
      .select("*")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => mapSecurityIssue(row as Record<string, unknown>));
  },

  async createSecurityCycle(input: NewCycleInput): Promise<SecurityCycle> {
    const me = await cloudApi.currentUser();
    const now = new Date().toISOString();
    const projectIds = input.projects.map((p) => p.id);
    const waves =
      input.waves && input.waves.length > 0
        ? input.waves
        : wavesFromLegacyDates(input.wave1_date, input.wave2_date, input.external_release_date);
    const legacy = legacyDatesFromWaves(waves);
    const baseRow: Record<string, unknown> = {
      name: input.name.trim(),
      cycle_type: input.cycle_type.trim() || "Quarter",
      quarter: input.quarter.trim(),
      wave1_date: legacy.wave1_date,
      wave2_date: legacy.wave2_date,
      external_release_date: legacy.external_release_date,
      project_ids: projectIds,
      created_by: me?.id ?? null,
      created_at: now,
      updated_at: now,
      waves,
    };
    const { data, error } = await sb().from("security_cycles").insert(baseRow).select().single();
    if (error) {
      const msg = String(error.message ?? error);
      if (/waves/i.test(msg) || /PGRST204|PGRST205|schema cache/i.test(msg)) {
        throw new Error(
          "Neon 尚未載入 security_cycles.waves。請在 Neon Console → Data API 按 Refresh schema cache 後重試（勿省略 waves，否則無法新增/重新命名 Wave）。",
        );
      }
      throw error;
    }
    const cycle = {
      ...mapSecurityCycle(data as Record<string, unknown>),
      waves,
      ...legacy,
    };
    if (input.projects.length > 0) {
      const rows = input.projects.map((p, i) => ({
        cycle_id: cycle.id,
        project_id: p.id,
        project_name: p.name,
        wave: "Not set",
        owner_id: null,
        reviewer_id: null,
        sa_owner: "",
        pm_owner: "",
        dqa_owner: "",
        status: "Not Started",
        sort_order: i,
      }));
      const { error: rosterError } = await sb().from("security_roster").insert(rows);
      if (rosterError) throw rosterError;
    }
    return cycle;
  },

  async updateSecurityCycle(cycleId: string, input: UpdateCycleInput): Promise<SecurityCycle> {
    const waves =
      input.waves && input.waves.length > 0
        ? input.waves
        : wavesFromLegacyDates(input.wave1_date, input.wave2_date, input.external_release_date);
    const legacy = legacyDatesFromWaves(waves);
    const projectIds = input.projects.map((p) => p.id);
    const updates: Record<string, unknown> = {
      name: input.name.trim(),
      cycle_type: input.cycle_type.trim() || "Quarter",
      quarter: input.quarter.trim(),
      waves,
      wave1_date: legacy.wave1_date,
      wave2_date: legacy.wave2_date,
      external_release_date: legacy.external_release_date,
      project_ids: projectIds,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await sb()
      .from("security_cycles")
      .update(updates)
      .eq("id", cycleId)
      .select()
      .single();
    if (error) {
      const msg = String(error.message ?? error);
      if (/waves/i.test(msg) || /PGRST204|PGRST205|schema cache/i.test(msg)) {
        throw new Error(
          "Neon 尚未載入 security_cycles.waves。請在 Neon Console → Data API 按 Refresh schema cache 後重試（勿省略 waves，否則無法新增/重新命名 Wave）。",
        );
      }
      throw error;
    }

    // Prefer the waves we just wrote — PostgREST may omit jsonb until cache refresh.
    const mapped = {
      ...mapSecurityCycle(data as Record<string, unknown>),
      waves,
      ...legacyDatesFromWaves(waves),
    };
    const allowed = new Set(mapped.waves.map((w) => w.name));
    const wanted = new Set(projectIds);

    const { data: rosterRows, error: rosterReadError } = await sb()
      .from("security_roster")
      .select("*")
      .eq("cycle_id", cycleId);
    if (rosterReadError) throw rosterReadError;

    const existing = (rosterRows ?? []).map((row) => mapSecurityRoster(row as Record<string, unknown>));
    for (const row of existing) {
      if (!wanted.has(row.project_id)) {
        const { error: delError } = await sb().from("security_roster").delete().eq("id", row.id);
        if (delError) throw delError;
        continue;
      }
      const proj = input.projects.find((p) => p.id === row.project_id);
      const wave =
        row.wave !== "Not set" && !allowed.has(row.wave) ? "Not set" : row.wave;
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (proj && proj.name !== row.project_name) patch.project_name = proj.name;
      if (wave !== row.wave) patch.wave = wave;
      if (Object.keys(patch).length > 1) {
        const { error: upError } = await sb().from("security_roster").update(patch).eq("id", row.id);
        if (upError) throw upError;
      }
    }

    const existingIds = new Set(existing.map((r) => r.project_id));
    const toAdd = input.projects.filter((p) => !existingIds.has(p.id));
    if (toAdd.length > 0) {
      const rows = toAdd.map((p, i) => ({
        cycle_id: cycleId,
        project_id: p.id,
        project_name: p.name,
        wave: "Not set",
        owner_id: null,
        reviewer_id: null,
        sa_owner: "",
        pm_owner: "",
        dqa_owner: "",
        status: "Not Started",
        sort_order: existing.length + i,
      }));
      const { error: insertError } = await sb().from("security_roster").insert(rows);
      if (insertError) throw insertError;
    }
    return mapped;
  },

  async updateSecurityCycleWaves(cycleId: string, waves: SecurityWave[]): Promise<SecurityCycle> {
    const { data: cycleRow, error } = await sb()
      .from("security_cycles")
      .select("*")
      .eq("id", cycleId)
      .single();
    if (error) throw error;
    const cycle = mapSecurityCycle(cycleRow as Record<string, unknown>);
    const { data: rosterRows, error: rosterError } = await sb()
      .from("security_roster")
      .select("project_id, project_name")
      .eq("cycle_id", cycleId);
    if (rosterError) throw rosterError;
    const projects = (rosterRows ?? []).map((r) => ({
      id: String((r as { project_id: string }).project_id),
      name: String((r as { project_name: string }).project_name),
    }));
    return cloudApi.updateSecurityCycle(cycleId, {
      name: cycle.name,
      cycle_type: cycle.cycle_type,
      quarter: cycle.quarter,
      wave1_date: "",
      wave2_date: "",
      external_release_date: "",
      waves,
      projects,
    });
  },

  async updateSecurityRosterEntry(
    id: string,
    patch: Partial<
      Pick<
        SecurityRosterEntry,
        | "wave"
        | "owner_id"
        | "reviewer_id"
        | "sa_owner"
        | "pm_owner"
        | "dqa_owner"
        | "status"
      >
    >,
  ): Promise<SecurityRosterEntry> {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.wave !== undefined) updates.wave = patch.wave;
    if (patch.owner_id !== undefined) updates.owner_id = patch.owner_id;
    if (patch.reviewer_id !== undefined) updates.reviewer_id = patch.reviewer_id;
    if (patch.sa_owner !== undefined) updates.sa_owner = patch.sa_owner.trim();
    if (patch.pm_owner !== undefined) updates.pm_owner = patch.pm_owner.trim();
    if (patch.dqa_owner !== undefined) updates.dqa_owner = patch.dqa_owner.trim();
    if (patch.status !== undefined) updates.status = normalizeSecurityStatus(patch.status);
    const { data, error } = await sb()
      .from("security_roster")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (error) {
      const msg = String(error.message ?? error);
      if (
        /sa_owner|pm_owner|dqa_owner/i.test(msg) ||
        /PGRST204|PGRST205|schema cache/i.test(msg)
      ) {
        throw new Error(
          "Neon 尚未載入 security_roster SA/PM/DQA Owner 文字欄位。請套用 neon/security-roster-role-owners.sql，並在 Neon Console → Data API 按 Refresh schema cache 後重試。",
        );
      }
      throw error;
    }
    return mapSecurityRoster(data as Record<string, unknown>);
  },

  async createSecurityIssue(input: SecurityIssueInput): Promise<SecurityIssue> {
    const me = await cloudApi.currentUser();
    const now = new Date().toISOString();
    const payload: Record<string, unknown> = {
      title: input.title.trim(),
      oem_request_id: (input.oem_request_id ?? "").trim(),
      detail: (input.detail ?? "").trim(),
      reference_path: (input.reference_path ?? "").trim(),
      cycle_ids: input.cycle_ids ?? [],
      project_ids: input.project_ids ?? [],
      project_names: (input.project_names ?? "").trim(),
      created_by: me?.id ?? null,
      created_at: now,
      updated_at: now,
    };
    let { data, error } = await sb().from("security_issues").insert(payload).select().single();
    // Older Neon schemas may lack reference_path — retry without it.
    if (error && /reference_path/i.test(String(error.message ?? ""))) {
      delete payload.reference_path;
      ({ data, error } = await sb().from("security_issues").insert(payload).select().single());
    }
    if (error) throw error;
    return mapSecurityIssue(data as Record<string, unknown>);
  },

  async updateSecurityIssue(id: string, input: SecurityIssueInput): Promise<SecurityIssue> {
    const payload: Record<string, unknown> = {
      title: input.title.trim(),
      oem_request_id: (input.oem_request_id ?? "").trim(),
      detail: (input.detail ?? "").trim(),
      reference_path: (input.reference_path ?? "").trim(),
      cycle_ids: input.cycle_ids ?? [],
      project_ids: input.project_ids ?? [],
      project_names: (input.project_names ?? "").trim(),
      updated_at: new Date().toISOString(),
    };
    let { data, error } = await sb()
      .from("security_issues")
      .update(payload)
      .eq("id", id)
      .select()
      .single();
    if (error && /reference_path/i.test(String(error.message ?? ""))) {
      delete payload.reference_path;
      ({ data, error } = await sb()
        .from("security_issues")
        .update(payload)
        .eq("id", id)
        .select()
        .single());
    }
    if (error) throw error;
    return mapSecurityIssue(data as Record<string, unknown>);
  },

  async deleteSecurityIssue(id: string): Promise<void> {
    const { error } = await sb().from("security_issues").delete().eq("id", id);
    if (error) throw error;
  },

  /** null when no row yet (first open). */
  async getSecurityCycleDetail(cycleId: string): Promise<CycleDetailDoc | null> {
    const { data, error } = await sb()
      .from("security_cycle_details")
      .select("*")
      .eq("cycle_id", cycleId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return mapSecurityCycleDetail(data as Record<string, unknown>);
  },

  async upsertSecurityCycleDetail(doc: CycleDetailDoc): Promise<CycleDetailDoc> {
    const now = new Date().toISOString();
    const payload = {
      cycle_id: doc.cycle_id,
      items: doc.items,
      release: doc.release,
      updated_at: now,
    };
    const { data, error } = await sb()
      .from("security_cycle_details")
      .upsert(payload, { onConflict: "cycle_id" })
      .select()
      .single();
    if (error) throw error;
    return mapSecurityCycleDetail(data as Record<string, unknown>);
  },

  async listWorkLogEntries(): Promise<WorkLogEntry[]> {
    const { data, error } = await sb()
      .from("work_log_entries")
      .select("*")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map((row) => mapWorkLogEntry(row as Record<string, unknown>));
  },

  async createWorkLogEntry(partial: WorkLogEntryPatch = {}): Promise<WorkLogEntry> {
    const me = await cloudApi.currentUser();
    if (!me) throw new Error("尚未登入");
    const existing = await cloudApi.listWorkLogEntries();
    const maxSort = existing.reduce((m, r) => Math.max(m, r.sort_order), -1);
    const payload = {
      entry_date: partial.entry_date ?? "",
      entry_type: normalizeWorkLogType(partial.entry_type),
      project_id: partial.project_id ?? null,
      project_name: (partial.project_name ?? "").trim(),
      product_name: (partial.product_name ?? "").trim(),
      content: partial.content ?? "",
      owner_id: partial.owner_id ?? null,
      done: Boolean(partial.done),
      sort_order: partial.sort_order ?? maxSort + 1,
      created_by: me.id,
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await sb().from("work_log_entries").insert(payload).select().single();
    if (error) throw error;
    return mapWorkLogEntry(data as Record<string, unknown>);
  },

  async updateWorkLogEntry(id: string, patch: WorkLogEntryPatch): Promise<WorkLogEntry> {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.entry_date !== undefined) updates.entry_date = patch.entry_date;
    if (patch.entry_type !== undefined) updates.entry_type = normalizeWorkLogType(patch.entry_type);
    if (patch.project_id !== undefined) updates.project_id = patch.project_id;
    if (patch.project_name !== undefined) updates.project_name = patch.project_name.trim();
    if (patch.product_name !== undefined) updates.product_name = patch.product_name.trim();
    if (patch.content !== undefined) updates.content = patch.content;
    if (patch.owner_id !== undefined) updates.owner_id = patch.owner_id;
    if (patch.done !== undefined) updates.done = Boolean(patch.done);
    if (patch.sort_order !== undefined) updates.sort_order = patch.sort_order;
    const { data, error } = await sb()
      .from("work_log_entries")
      .update(updates)
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return mapWorkLogEntry(data as Record<string, unknown>);
  },

  async deleteWorkLogEntry(id: string): Promise<void> {
    const { error } = await sb().from("work_log_entries").delete().eq("id", id);
    if (error) throw error;
  },
};

function normalizeWorkLogType(raw: unknown): WorkLogType | "" {
  const value = typeof raw === "string" ? raw.trim() : "";
  if ((WORK_LOG_TYPES as readonly string[]).includes(value)) return value as WorkLogType;
  return "";
}

function mapWorkLogEntry(row: Record<string, unknown>): WorkLogEntry {
  return {
    id: String(row.id ?? ""),
    entry_date: typeof row.entry_date === "string" ? row.entry_date : "",
    entry_type: normalizeWorkLogType(row.entry_type),
    project_id: row.project_id == null || row.project_id === "" ? null : String(row.project_id),
    project_name: typeof row.project_name === "string" ? row.project_name : "",
    product_name: typeof row.product_name === "string" ? row.product_name : "",
    content: typeof row.content === "string" ? row.content : "",
    owner_id: row.owner_id == null || row.owner_id === "" ? null : String(row.owner_id),
    done: Boolean(row.done),
    sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0,
    created_by: row.created_by == null ? null : String(row.created_by),
    created_at: typeof row.created_at === "string" ? row.created_at : undefined,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : undefined,
  };
}
