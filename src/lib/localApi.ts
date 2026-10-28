import { normalizeAnalyzedNotes, syncAnalyzedFields } from "./analyzed";
import { todayISO } from "./dates";
import type {
  CredentialRow,
  CreatePersonnelInput,
  InviteInput,
  AccountInput,
  NoteColor,
  NoteItem,
  OtpVaultEntry,
  PersonnelColumn,
  PersonnelRole,
  Profile,
  Project,
  ProjectCheckpoint,
  ProjectMember,
  Role,
  Task,
  WorkLogEntry,
  WorkLogEntryPatch,
  WorkLogType,
} from "./types";
import { NOTE_COLORS, normalizePersonnelRole, normalizeTaskStatus, WORK_LOG_TYPES } from "./types";
import { DEFAULT_PASSWORD, sha256, usernameFromEmail } from "./util";

const KEY = "awb-store-v1";
const LEGACY_NOTES_KEY = "awb-notes-v1";
const LEGACY_OTP_KEY = "awb-otp-vault-v1";
const WORK_LOG_KEY = "kssw-work-log-v1";
/** sha256(`admin:${DEFAULT_PASSWORD}`) — keep in sync with util.DEFAULT_PASSWORD. */
const ADMIN_HASH = "c8c09b731e0fb8d16540a7edcc47927c739c09baad3adb85bdba1ab3b4fa7120";

interface Store {
  sessionUserId: string | null;
  profiles: Profile[];
  passwordHashes: Record<string, string>;
  projects: Project[];
  members: ProjectMember[];
  tasks: Task[];
  passwordScheme?: number;
  personnelColumns?: PersonnelColumn[];
  /** Shared sticky notes — visible to every logged-in member. */
  notes?: NoteItem[];
  /** Shared OTP vault — visible to every logged-in member. */
  otpEntries?: OtpVaultEntry[];
}

const ADMIN_ID = "00000000-0000-4000-8000-000000000001";

function normalizeProfile(profile: Profile): Profile {
  const personnel_role = normalizePersonnelRole(profile);
  return {
    ...profile,
    personnel_role,
    is_admin: personnel_role === "Admin",
    custom: profile.custom ?? {},
  };
}

function emptyStore(): Store {
  const admin: Profile = {
    id: ADMIN_ID,
    username: "admin",
    display_name: "Albert",
    unit: "",
    email: "admin@local",
    is_admin: true,
    personnel_role: "Admin",
    custom: {},
  };
  return {
    sessionUserId: null,
    profiles: [admin],
    passwordHashes: { [ADMIN_ID]: ADMIN_HASH },
    projects: [],
    members: [],
    tasks: [],
    personnelColumns: [],
    notes: [],
    otpEntries: [],
  };
}

function normalizeNote(n: Partial<NoteItem> & { id?: string }): NoteItem | null {
  if (!n?.id) return null;
  return {
    id: n.id,
    title: String(n.title ?? ""),
    body: String(n.body ?? ""),
    color: (NOTE_COLORS as readonly string[]).includes(n.color as string) ? (n.color as NoteColor) : "blue",
    pinned: Boolean(n.pinned),
    url: n.url?.trim() || undefined,
    created_at: n.created_at || new Date().toISOString(),
    updated_at: n.updated_at || n.created_at || new Date().toISOString(),
  };
}

function normalizeOtp(e: Partial<OtpVaultEntry> & { id?: string; secret?: string }): OtpVaultEntry | null {
  if (!e?.id || !e.secret?.trim()) return null;
  return {
    id: e.id,
    label: String(e.label ?? ""),
    issuer: String(e.issuer ?? ""),
    account: String(e.account ?? ""),
    secret: e.secret.replace(/\s+/g, "").toUpperCase(),
    qr_text: e.qr_text?.trim() || undefined,
    thumb: e.thumb?.trim() || undefined,
    owner_id: e.owner_id?.trim() || undefined,
    access_password: e.access_password?.trim() || undefined,
    created_at: typeof e.created_at === "number" ? e.created_at : Math.floor(Date.now() / 1000),
  };
}

function migrateLegacyShared(store: Store): boolean {
  let changed = false;
  if (!Array.isArray(store.notes)) {
    store.notes = [];
    try {
      const raw = localStorage.getItem(LEGACY_NOTES_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as NoteItem[];
        if (Array.isArray(parsed)) {
          store.notes = parsed.map(normalizeNote).filter((n): n is NoteItem => Boolean(n));
        }
      }
    } catch {
      /* ignore */
    }
    changed = true;
  }
  if (!Array.isArray(store.otpEntries)) {
    store.otpEntries = [];
    try {
      const raw = localStorage.getItem(LEGACY_OTP_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { entries?: OtpVaultEntry[] };
        const list = Array.isArray(parsed) ? parsed : parsed.entries;
        if (Array.isArray(list)) {
          store.otpEntries = list.map(normalizeOtp).filter((e): e is OtpVaultEntry => Boolean(e));
        }
      }
    } catch {
      /* ignore */
    }
    changed = true;
  }
  return changed;
}

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyStore();
    const parsed = JSON.parse(raw) as Store;
    if (!parsed.profiles?.length) return emptyStore();
    parsed.profiles = parsed.profiles.map(normalizeProfile);
    if (!Array.isArray(parsed.projects)) parsed.projects = [];
    if (!Array.isArray(parsed.members)) parsed.members = [];
    if (!Array.isArray(parsed.tasks)) parsed.tasks = [];
    if (!parsed.passwordHashes || typeof parsed.passwordHashes !== "object") parsed.passwordHashes = {};
    if (!parsed.personnelColumns) parsed.personnelColumns = [];
    // Migrate legacy keys before forcing empty arrays (migrate checks !Array.isArray).
    const migrated = migrateLegacyShared(parsed);
    if (!Array.isArray(parsed.notes)) parsed.notes = [];
    if (!Array.isArray(parsed.otpEntries)) parsed.otpEntries = [];
    if (migrated) save(parsed);
    return parsed;
  } catch {
    return emptyStore();
  }
}

function save(store: Store) {
  localStorage.setItem(KEY, JSON.stringify(store));
}

function normalizeTask(task: Task): Task {
  return {
    ...task,
    status: normalizeTaskStatus(task.status),
    note: task.note ?? "",
    created_at: task.created_at || undefined,
    ...syncAnalyzedFields(normalizeAnalyzedNotes(task)),
  };
}

const PASSWORD_SCHEME = 3;

async function ensurePasswordScheme() {
  const store = load();
  if (store.passwordScheme === PASSWORD_SCHEME) return;
  for (const profile of store.profiles) {
    store.passwordHashes[profile.id] = await sha256(`${profile.username}:${DEFAULT_PASSWORD}`);
  }
  store.passwordScheme = PASSWORD_SCHEME;
  save(store);
}

async function passwordMatches(store: Store, profile: Profile, password: string) {
  const stored = store.passwordHashes[profile.id];
  if (!stored) return false;
  const byUser = await sha256(`${profile.username}:${password}`);
  const byEmail = await sha256(`${profile.email}:${password}`);
  return stored === byUser || stored === byEmail;
}

export const localApi = {
  load,
  ensurePasswordScheme,

  async signIn(identifier: string, password: string): Promise<Profile> {
    await ensurePasswordScheme();
    const store = load();
    const key = identifier.trim().toLowerCase();
    const matches = store.profiles.filter(
      (p) =>
        p.username.toLowerCase() === key ||
        p.email.toLowerCase() === key ||
        p.display_name.trim().toLowerCase() === key,
    );
    if (matches.length === 0) {
      throw new Error("找不到這個帳號。請填人員表上的「帳號」或 EMAIL，例如 lay 或 lay_zhang。");
    }
    for (const profile of matches) {
      if (await passwordMatches(store, profile, password)) {
        store.sessionUserId = profile.id;
        save(store);
        return profile;
      }
    }
    throw new Error(`密碼不正確。預設密碼是 ${DEFAULT_PASSWORD}，請管理員到人員頁按「重設為 ${DEFAULT_PASSWORD}」。`);
  },

  signOut() {
    const store = load();
    store.sessionUserId = null;
    save(store);
  },

  currentUser(): Profile | null {
    const store = load();
    return store.profiles.find((p) => p.id === store.sessionUserId) ?? null;
  },

  listProfiles(): Profile[] {
    return load().profiles.map(normalizeProfile);
  },

  listPersonnelColumns(): PersonnelColumn[] {
    return [...(load().personnelColumns ?? [])];
  },

  addPersonnelColumn(label: string): PersonnelColumn {
    const store = load();
    if (!store.sessionUserId) throw new Error("尚未登入");
    const trimmed = label.trim();
    if (!trimmed) throw new Error("欄位名稱不能空白");
    const col: PersonnelColumn = { id: crypto.randomUUID(), label: trimmed };
    store.personnelColumns = [...(store.personnelColumns ?? []), col];
    save(store);
    return col;
  },

  removePersonnelColumn(columnId: string) {
    const store = load();
    if (!store.sessionUserId) throw new Error("尚未登入");
    store.personnelColumns = (store.personnelColumns ?? []).filter((c) => c.id !== columnId);
    for (const profile of store.profiles) {
      if (profile.custom && columnId in profile.custom) {
        const next = { ...profile.custom };
        delete next[columnId];
        profile.custom = next;
      }
    }
    save(store);
  },

  updateProfile(
    userId: string,
    patch: {
      display_name?: string;
      unit?: string;
      email?: string;
      personnel_role?: PersonnelRole;
      custom?: Record<string, string>;
    },
  ): Profile {
    const store = load();
    if (!store.sessionUserId) throw new Error("尚未登入");
    const profile = store.profiles.find((p) => p.id === userId);
    if (!profile) throw new Error("找不到這位人員");

    if (patch.display_name !== undefined) {
      const name = patch.display_name.trim();
      if (!name) throw new Error("姓名不能空白");
      profile.display_name = name;
    }
    if (patch.unit !== undefined) profile.unit = patch.unit.trim();
    if (patch.email !== undefined) {
      const email = patch.email.trim().toLowerCase();
      if (!email) throw new Error("EMAIL 不能空白");
      const taken = store.profiles.some(
        (p) => p.id !== userId && p.email.toLowerCase() === email,
      );
      if (taken) throw new Error("EMAIL 已被使用");
      profile.email = email;
    }
    if (patch.personnel_role !== undefined) {
      const nextRole = patch.personnel_role;
      const wasAdmin = normalizePersonnelRole(profile) === "Admin";
      if (wasAdmin && nextRole !== "Admin") {
        const otherAdmins = store.profiles.filter(
          (p) => p.id !== userId && normalizePersonnelRole(p) === "Admin",
        );
        if (otherAdmins.length === 0) throw new Error("至少要保留一位 Admin");
      }
      profile.personnel_role = nextRole;
      profile.is_admin = nextRole === "Admin";
    }
    if (patch.custom !== undefined) {
      profile.custom = { ...(profile.custom ?? {}), ...patch.custom };
    }
    save(store);
    return normalizeProfile(profile);
  },

  async createPersonnelMember(input: CreatePersonnelInput): Promise<Profile> {
    const store = load();
    if (!store.sessionUserId) throw new Error("尚未登入");
    const me = store.profiles.find((p) => p.id === store.sessionUserId);
    if (!me || normalizePersonnelRole(me) !== "Admin") {
      throw new Error("只有 Admin 可以新增 Member");
    }

    const display_name = input.display_name.trim();
    if (!display_name) throw new Error("姓名不能空白");

    let email = (input.email ?? "").trim().toLowerCase();
    const requestedUsername = (input.username ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
    if (!email) {
      if (!requestedUsername) throw new Error("請填寫帳號或 EMAIL");
      email = `${requestedUsername}@local`;
    }

    const takenEmails = store.profiles.some((p) => p.email.toLowerCase() === email);
    if (takenEmails) throw new Error("EMAIL 已被使用");

    const taken = new Set(store.profiles.map((p) => p.username.toLowerCase()));
    let username = requestedUsername;
    if (username) {
      if (taken.has(username)) throw new Error("帳號已被使用");
    } else {
      username = usernameFromEmail(email, taken);
    }

    const id = crypto.randomUUID();
    const personnel_role = input.personnel_role;
    const profile: Profile = {
      id,
      username,
      display_name,
      unit: (input.phone ?? "").trim(),
      email,
      is_admin: personnel_role === "Admin",
      personnel_role,
      custom: {},
    };
    store.profiles.push(profile);
    store.passwordHashes[id] = await sha256(`${username}:${DEFAULT_PASSWORD}`);

    const projectIds = [...new Set((input.projectIds ?? []).filter((pid) => store.projects.some((p) => p.id === pid)))];
    for (const projectId of projectIds) {
      store.members.push({ project_id: projectId, user_id: id, role: "member" });
    }
    save(store);
    return normalizeProfile(profile);
  },

  /** Any signed-in user can reassign project memberships from Personnel. */
  setPersonProjects(userId: string, projectIds: string[]): void {
    const store = load();
    if (!store.sessionUserId) throw new Error("尚未登入");
    const profile = store.profiles.find((p) => p.id === userId);
    if (!profile) throw new Error("找不到這位人員");
    const wanted = new Set(projectIds.filter((id) => store.projects.some((p) => p.id === id)));
    const existing = store.members.filter((m) => m.user_id === userId);
    for (const m of existing) {
      if (!wanted.has(m.project_id)) {
        if (m.role === "leader") {
          const leaders = store.members.filter(
            (x) => x.project_id === m.project_id && x.role === "leader",
          );
          if (leaders.length <= 1) {
            throw new Error(`「${store.projects.find((p) => p.id === m.project_id)?.name ?? "專案"}」至少要有一位領導`);
          }
        }
      }
    }
    store.members = store.members.filter((m) => m.user_id !== userId || wanted.has(m.project_id));
    for (const projectId of wanted) {
      const found = store.members.find((m) => m.project_id === projectId && m.user_id === userId);
      if (!found) {
        store.members.push({ project_id: projectId, user_id: userId, role: "member" });
      }
    }
    save(store);
  },

  listProjects(): Project[] {
    const store = load();
    const me = store.sessionUserId;
    const user = store.profiles.find((p) => p.id === me);
    if (user?.is_admin) return store.projects;
    const ids = new Set(store.members.filter((m) => m.user_id === me).map((m) => m.project_id));
    return store.projects.filter((p) => ids.has(p.id));
  },

  createProject(name: string, description: string): Project {
    const store = load();
    if (!store.sessionUserId) throw new Error("尚未登入");
    const project: Project = {
      id: crypto.randomUUID(),
      name: name.trim(),
      description: description.trim(),
      created_by: store.sessionUserId,
      created_at: new Date().toISOString(),
      lenovo_name: "",
      bios_id: "",
      platform: "",
      dis: "",
      ss_date: "",
      eol_date: "",
      security_update: "",
      talent_policy: "",
      owner: "",
      project_owner: "",
      tpe_owner: "",
      custom: {},
    };
    store.projects.push(project);
    store.members.push({
      project_id: project.id,
      user_id: store.sessionUserId,
      role: "leader",
    });
    save(store);
    return project;
  },

  updateProject(
    projectId: string,
    patch: {
      name?: string;
      description?: string;
      lenovo_name?: string;
      bios_id?: string;
      platform?: string;
      dis?: string;
      ss_date?: string;
      eol_date?: string;
      security_update?: string;
      talent_policy?: string;
      owner?: string;
      project_owner?: string;
      tpe_owner?: string;
      custom?: Record<string, string>;
      checkpoints?: ProjectCheckpoint[];
      checkpoint_handover_date?: string;
    },
  ): Project {
    const store = load();
    if (!store.sessionUserId) throw new Error("尚未登入");
    const project = store.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("找不到專案");
    if (localApi.myRole(projectId) !== "leader") {
      throw new Error("只有專案領導或管理員可以編輯專案欄位");
    }

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) throw new Error("專案名稱不能空白");
      project.name = name;
    }
    if (patch.description !== undefined) project.description = patch.description.trim();
    if (patch.lenovo_name !== undefined) project.lenovo_name = patch.lenovo_name.trim();
    if (patch.bios_id !== undefined) project.bios_id = patch.bios_id.trim();
    if (patch.platform !== undefined) project.platform = patch.platform.trim();
    if (patch.dis !== undefined) project.dis = patch.dis.trim();
    if (patch.ss_date !== undefined) project.ss_date = patch.ss_date.trim();
    if (patch.eol_date !== undefined) project.eol_date = patch.eol_date.trim();
    if (patch.security_update !== undefined) project.security_update = patch.security_update.trim();
    if (patch.talent_policy !== undefined) project.talent_policy = patch.talent_policy.trim();
    if (patch.owner !== undefined) project.owner = patch.owner.trim();
    if (patch.project_owner !== undefined) project.project_owner = patch.project_owner.trim();
    if (patch.tpe_owner !== undefined) project.tpe_owner = patch.tpe_owner.trim();
    if (patch.custom !== undefined) {
      project.custom = { ...(project.custom ?? {}), ...patch.custom };
    }
    if (patch.checkpoints !== undefined) {
      project.checkpoints = patch.checkpoints.map((item) => ({
        id: item.id,
        type: item.type ?? "",
        item: item.item ?? item.text ?? "",
        description: item.description ?? "",
        checked: Boolean(item.checked),
      }));
    }
    if (patch.checkpoint_handover_date !== undefined) {
      project.checkpoint_handover_date = patch.checkpoint_handover_date;
    }
    save(store);
    return project;
  },

  listLeaderProjectIds(): string[] {
    const store = load();
    const me = store.sessionUserId;
    const user = store.profiles.find((p) => p.id === me);
    if (user?.is_admin) return store.projects.map((p) => p.id);
    return store.members.filter((m) => m.user_id === me && m.role === "leader").map((m) => m.project_id);
  },

  deleteProject(id: string) {
    if (localApi.myRole(id) !== "leader") {
      throw new Error("只有專案領導或管理員可以刪除專案");
    }
    const store = load();
    store.tasks = store.tasks.filter((t) => t.project_id !== id);
    store.members = store.members.filter((m) => m.project_id !== id);
    store.projects = store.projects.filter((p) => p.id !== id);
    save(store);
  },

  listMembers(projectId: string): ProjectMember[] {
    return load().members.filter((m) => m.project_id === projectId);
  },

  listAllMembers(): ProjectMember[] {
    const visible = new Set(localApi.listProjects().map((project) => project.id));
    return load().members.filter((m) => visible.has(m.project_id));
  },

  myRole(projectId: string): "leader" | "member" | null {
    const store = load();
    const user = store.profiles.find((p) => p.id === store.sessionUserId);
    if (user?.is_admin) return "leader";
    return (
      store.members.find(
        (m) => m.project_id === projectId && m.user_id === store.sessionUserId,
      )?.role ?? null
    );
  },

  async createAccounts(rows: AccountInput[]): Promise<CredentialRow[]> {
    const store = load();
    if (!store.sessionUserId) throw new Error("尚未登入");
    const me = store.profiles.find((p) => p.id === store.sessionUserId);
    if (!me || normalizePersonnelRole(me) !== "Admin") {
      throw new Error("只有 Admin 可以新增 Member");
    }

    const creds: CredentialRow[] = [];
    const taken = new Set(store.profiles.map((p) => p.username.toLowerCase()));

    for (const row of rows) {
      const email = row.email.trim().toLowerCase();
      if (!email || !row.display_name.trim()) continue;
      const existing = store.profiles.find((p) => p.email.toLowerCase() === email);
      if (existing) {
        creds.push({
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
      const id = crypto.randomUUID();
      store.profiles.push({
        id,
        username,
        display_name: row.display_name.trim(),
        unit: row.unit.trim(),
        email,
        is_admin: false,
        personnel_role: "DE",
        custom: {},
      });
      store.passwordHashes[id] = await sha256(`${username}:${password}`);
      creds.push({
        display_name: row.display_name.trim(),
        username,
        email,
        password,
      });
    }
    save(store);
    return creds;
  },

  async changePassword(current: string, next: string) {
    const store = load();
    const me = store.profiles.find((p) => p.id === store.sessionUserId);
    if (!me) throw new Error("尚未登入");
    const nextPassword = next.trim();
    if (nextPassword.length < 6) throw new Error("新密碼至少 6 碼");
    const currentHash = await sha256(`${me.username}:${current}`);
    const currentByEmail = await sha256(`${me.email}:${current}`);
    const stored = store.passwordHashes[me.id];
    if (stored !== currentHash && stored !== currentByEmail) {
      throw new Error("目前密碼不正確");
    }
    store.passwordHashes[me.id] = await sha256(`${me.username}:${nextPassword}`);
    save(store);
  },

  async resetPassword(userId: string) {
    const store = load();
    const me = store.profiles.find((p) => p.id === store.sessionUserId);
    if (!me) throw new Error("尚未登入");
    const target = store.profiles.find((p) => p.id === userId);
    if (!target) throw new Error("找不到這位人員");
    if (target.is_admin && !me.is_admin) throw new Error("不能重設管理員密碼");
    const canReset =
      Boolean(me.is_admin) ||
      store.members.some(
        (m) =>
          m.user_id === me.id &&
          m.role === "leader" &&
          store.members.some((other) => other.project_id === m.project_id && other.user_id === userId),
      );
    if (!canReset) throw new Error("只有專案領導或管理員可以重設密碼");
    store.passwordHashes[userId] = await sha256(`${target.username}:${DEFAULT_PASSWORD}`);
    save(store);
  },

  deletePerson(userId: string) {
    const store = load();
    const me = store.profiles.find((p) => p.id === store.sessionUserId);
    if (!me) throw new Error("尚未登入");
    const target = store.profiles.find((p) => p.id === userId);
    if (!target) throw new Error("找不到這位人員");
    if (target.id === me.id) throw new Error("不能刪除自己");
    if (target.is_admin) throw new Error("不能刪除管理員");
    const canDelete =
      Boolean(me.is_admin) ||
      store.members.some((m) => m.user_id === me.id && m.role === "leader");
    if (!canDelete) throw new Error("只有專案領導或管理員可以刪除人員");
    store.tasks.forEach((task) => {
      if (task.assignee_id === userId) task.assignee_id = null;
    });
    store.members = store.members.filter((m) => m.user_id !== userId);
    store.profiles = store.profiles.filter((p) => p.id !== userId);
    delete store.passwordHashes[userId];
    save(store);
  },

  addProjectMember(projectId: string, userId: string, role: Role): ProjectMember {
    const store = load();
    if (localApi.myRole(projectId) !== "leader") {
      throw new Error("只有專案領導或管理員可以把人加入專案");
    }
    const profile = store.profiles.find((p) => p.id === userId);
    if (!profile) throw new Error("找不到這位人員");
    const existing = store.members.find((m) => m.project_id === projectId && m.user_id === userId);
    if (existing) {
      if (existing.role === "leader" && role !== "leader") {
        const leaders = store.members.filter((m) => m.project_id === projectId && m.role === "leader");
        if (leaders.length <= 1) throw new Error("專案至少要有一位領導");
      }
      existing.role = role;
      save(store);
      return existing;
    }
    const member: ProjectMember = { project_id: projectId, user_id: userId, role };
    store.members.push(member);
    save(store);
    return member;
  },

  removeProjectMember(projectId: string, userId: string) {
    if (localApi.myRole(projectId) !== "leader") {
      throw new Error("只有專案領導或管理員可以把人移出專案");
    }
    const store = load();
    const target = store.members.find((m) => m.project_id === projectId && m.user_id === userId);
    if (!target) return;
    if (target.role === "leader") {
      const leaders = store.members.filter((m) => m.project_id === projectId && m.role === "leader");
      if (leaders.length <= 1) throw new Error("專案至少要有一位領導");
    }
    store.members = store.members.filter((m) => !(m.project_id === projectId && m.user_id === userId));
    save(store);
  },

  async inviteMembers(rows: InviteInput[]): Promise<CredentialRow[]> {
    const store = load();
    if (!store.sessionUserId) throw new Error("尚未登入");
    const me = store.profiles.find((p) => p.id === store.sessionUserId);
    const creds: CredentialRow[] = [];
    const taken = new Set(store.profiles.map((p) => p.username.toLowerCase()));

    for (const row of rows) {
      const email = row.email.trim().toLowerCase();
      if (!email || !row.display_name.trim()) continue;
      const project = store.projects.find((p) => p.id === row.project_id);
      if (!project) throw new Error("找不到專案");
      const role = localApi.myRole(row.project_id);
      if (role !== "leader") throw new Error("只有專案領導或管理員可以加人");

      let profile = store.profiles.find((p) => p.email.toLowerCase() === email);
      let password = "";
      let username = profile?.username ?? "";

      if (!profile) {
        if (!me || normalizePersonnelRole(me) !== "Admin") {
          throw new Error("只有 Admin 可以新增 Member");
        }
        username = usernameFromEmail(email, taken);
        taken.add(username);
        password = DEFAULT_PASSWORD;
        const id = crypto.randomUUID();
        profile = {
          id,
          username,
          display_name: row.display_name.trim(),
          unit: row.unit.trim(),
          email,
          is_admin: false,
          personnel_role: "DE",
          custom: {},
        };
        store.profiles.push(profile);
        store.passwordHashes[id] = await sha256(`${username}:${password}`);
      }

      const existing = store.members.find(
        (m) => m.project_id === row.project_id && m.user_id === profile.id,
      );
      if (existing) existing.role = row.role;
      else store.members.push({ project_id: row.project_id, user_id: profile.id, role: row.role });

      creds.push({
        display_name: profile.display_name,
        username: profile.username,
        email: profile.email,
        password: password || "(已有帳號，沿用原密碼)",
        project_name: project.name,
        role: row.role,
      });
    }
    save(store);
    return creds;
  },

  listTasks(projectId: string): Task[] {
    return load()
      .tasks.filter((t) => t.project_id === projectId)
      .map(normalizeTask)
      .sort(
        (a, b) =>
          (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id),
      );
  },

  createTask(input: Omit<Task, "id">): Task {
    const store = load();
    const task: Task = {
      ...input,
      id: crypto.randomUUID(),
      created_at: input.created_at || new Date().toISOString(),
    };
    store.tasks.push(task);
    save(store);
    return task;
  },

  updateTask(id: string, patch: Partial<Task>): Task {
    const store = load();
    const task = store.tasks.find((t) => t.id === id);
    if (!task) throw new Error("找不到任務");
    Object.assign(task, patch);
    save(store);
    return task;
  },

  deleteTask(id: string) {
    const store = load();
    store.tasks = store.tasks.filter((t) => t.id !== id);
    save(store);
  },

  allTasks(): Task[] {
    const store = load();
    const visible = new Set(localApi.listProjects().map((project) => project.id));
    return store.tasks
      .filter((task) => visible.has(task.project_id))
      .map(normalizeTask)
      .sort(
        (a, b) =>
          (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id),
      );
  },

  /** Shared notes — full list for every member (no owner filter). */
  listNotes(): NoteItem[] {
    const notes = load().notes ?? [];
    // Stable order: pinned first, then created_at (not updated_at — edits must not reshuffle).
    return [...notes].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const byCreated = (b.created_at ?? "").localeCompare(a.created_at ?? "");
      if (byCreated !== 0) return byCreated;
      return a.id.localeCompare(b.id);
    });
  },

  createNote(input: { title: string; body: string; color: NoteColor; url?: string }): NoteItem {
    const title = input.title.trim();
    if (!title) throw new Error("Title is required");
    const store = load();
    const now = new Date().toISOString();
    const note: NoteItem = {
      id: crypto.randomUUID(),
      title,
      body: input.body.trim(),
      color: input.color,
      pinned: false,
      url: input.url?.trim() || undefined,
      created_at: now,
      updated_at: now,
    };
    store.notes = [...(store.notes ?? []), note];
    save(store);
    return note;
  },

  updateNote(id: string, patch: Partial<{ title: string; body: string; color: NoteColor; url: string; pinned: boolean }>): NoteItem {
    const store = load();
    const notes = store.notes ?? [];
    const idx = notes.findIndex((n) => n.id === id);
    if (idx < 0) throw new Error("Note not found");
    const prev = notes[idx];
    if (patch.title !== undefined) {
      const title = patch.title.trim();
      if (!title) throw new Error("Title is required");
      prev.title = title;
    }
    if (patch.body !== undefined) prev.body = patch.body.trim();
    if (patch.color !== undefined) prev.color = patch.color;
    if (patch.url !== undefined) prev.url = patch.url.trim() || undefined;
    if (patch.pinned !== undefined) prev.pinned = patch.pinned;
    prev.updated_at = new Date().toISOString();
    notes[idx] = prev;
    store.notes = notes;
    save(store);
    return prev;
  },

  removeNote(id: string) {
    const store = load();
    store.notes = (store.notes ?? []).filter((n) => n.id !== id);
    save(store);
  },

  /** Shared OTP vault — full list for every member (no owner filter). */
  listOtpEntries(): OtpVaultEntry[] {
    return [...(load().otpEntries ?? [])].sort((a, b) => b.created_at - a.created_at);
  },

  addOtpEntry(input: {
    label?: string;
    issuer?: string;
    account?: string;
    secret: string;
    qr_text?: string;
    thumb?: string;
    access_password?: string;
    owner_id?: string;
  }): OtpVaultEntry {
    const store = load();
    const issuer = (input.issuer ?? "").trim();
    const account = (input.account ?? "").trim();
    const label = (input.label ?? "").trim() || (issuer && account ? `${issuer} · ${account}` : issuer || account || "OTP entry");
    const entry: OtpVaultEntry = {
      id: `otp_${crypto.randomUUID()}`,
      label,
      issuer,
      account,
      secret: input.secret.replace(/\s+/g, "").toUpperCase(),
      qr_text: input.qr_text?.trim() || undefined,
      thumb: input.thumb?.trim() || undefined,
      owner_id: input.owner_id?.trim() || undefined,
      access_password: input.access_password?.trim() || undefined,
      created_at: Math.floor(Date.now() / 1000),
    };
    store.otpEntries = [entry, ...(store.otpEntries ?? [])];
    save(store);
    return entry;
  },

  removeOtpEntry(id: string) {
    const store = load();
    store.otpEntries = (store.otpEntries ?? []).filter((e) => e.id !== id);
    save(store);
  },

  /** Clear Note/OTP arrays after successful upload to shared cloud (secrets not logged). */
  clearSharedLocal() {
    const store = load();
    store.notes = [];
    store.otpEntries = [];
    save(store);
  },

  listWorkLogEntries(): WorkLogEntry[] {
    return loadWorkLog().sort(
      (a, b) =>
        a.sort_order - b.sort_order ||
        (a.created_at ?? "").localeCompare(b.created_at ?? "") ||
        a.id.localeCompare(b.id),
    );
  },

  createWorkLogEntry(partial: WorkLogEntryPatch = {}): WorkLogEntry {
    const rows = loadWorkLog();
    const maxSort = rows.reduce((m, r) => Math.max(m, r.sort_order), -1);
    const now = new Date().toISOString();
    const row: WorkLogEntry = {
      id: crypto.randomUUID(),
      entry_date: partial.entry_date ?? "",
      entry_type: normalizeLocalWorkLogType(partial.entry_type),
      project_id: partial.project_id ?? null,
      project_name: (partial.project_name ?? "").trim(),
      product_name: (partial.product_name ?? "").trim(),
      content: partial.content ?? "",
      owner_id: partial.owner_id ?? null,
      done: Boolean(partial.done),
      sort_order: partial.sort_order ?? maxSort + 1,
      created_at: now,
      updated_at: now,
    };
    rows.push(row);
    saveWorkLog(rows);
    return row;
  },

  updateWorkLogEntry(id: string, patch: WorkLogEntryPatch): WorkLogEntry {
    const rows = loadWorkLog();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error("找不到 Work Log 列");
    const prev = rows[idx];
    const next: WorkLogEntry = {
      ...prev,
      entry_date: patch.entry_date !== undefined ? patch.entry_date : prev.entry_date,
      entry_type:
        patch.entry_type !== undefined ? normalizeLocalWorkLogType(patch.entry_type) : prev.entry_type,
      project_id: patch.project_id !== undefined ? patch.project_id : prev.project_id,
      project_name:
        patch.project_name !== undefined ? patch.project_name.trim() : prev.project_name,
      product_name:
        patch.product_name !== undefined ? patch.product_name.trim() : prev.product_name,
      content: patch.content !== undefined ? patch.content : prev.content,
      owner_id: patch.owner_id !== undefined ? patch.owner_id : prev.owner_id,
      done: patch.done !== undefined ? Boolean(patch.done) : prev.done,
      sort_order: patch.sort_order !== undefined ? patch.sort_order : prev.sort_order,
      updated_at: new Date().toISOString(),
    };
    rows[idx] = next;
    saveWorkLog(rows);
    return next;
  },

  deleteWorkLogEntry(id: string) {
    saveWorkLog(loadWorkLog().filter((r) => r.id !== id));
  },
};

function loadWorkLog(): WorkLogEntry[] {
  try {
    const raw = localStorage.getItem(WORK_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WorkLogEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveWorkLog(rows: WorkLogEntry[]) {
  localStorage.setItem(WORK_LOG_KEY, JSON.stringify(rows));
}

function normalizeLocalWorkLogType(raw: unknown): WorkLogType | "" {
  const value = typeof raw === "string" ? raw.trim() : "";
  if ((WORK_LOG_TYPES as readonly string[]).includes(value)) return value as WorkLogType;
  return "";
}

export function ensureSampleIfEmpty() {
  const store = load();
  if (store.projects.length > 0) return;
  const project: Project = {
    id: crypto.randomUUID(),
    name: "工作基地",
    description: "預設專案，可改名或再新增。",
    created_by: ADMIN_ID,
    created_at: new Date().toISOString(),
  };
  store.projects.push(project);
  store.members.push({ project_id: project.id, user_id: ADMIN_ID, role: "leader" });
  const start = todayISO();
  store.tasks.push({
    id: crypto.randomUUID(),
    project_id: project.id,
    title: "整理人員名單",
    assignee_id: ADMIN_ID,
    start_date: start,
    due_date: start,
    status: "working",
    note: "",
    analyzed: "",
    analyzed_by: null,
    analyzed_at: null,
    analyzed_notes: [],
  });
  save(store);
}
