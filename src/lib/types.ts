export type Role = "leader" | "member";
export const TASK_STATUSES = [
  { id: "opening", label: "Open" },
  { id: "working", label: "Working" },
  { id: "closing", label: "Closing" },
  { id: "verify", label: "Verify" },
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number]["id"];
export type ViewId =
  | "home"
  | "projects"
  | "people"
  | "tasks"
  | "gantt"
  | "security"
  | "inv-pcr"
  | "guides"
  | "notes"
  | "chat"
  | "tool"
  | "otp"
  | "whea";

/** Shared TOTP vault entry (org-wide; secrets never committed to git). */
export interface OtpVaultEntry {
  id: string;
  label: string;
  issuer: string;
  account: string;
  /** Base32 secret — never commit real values. */
  secret: string;
  /** Optional otpauth:// URI or QR payload text. */
  qr_text?: string;
  /** Optional data-URL thumbnail. */
  thumb?: string;
  /** Creator username/id for audit only — does not filter list visibility. */
  owner_id?: string;
  /** If set, codes stay locked until unlocked this session. */
  access_password?: string;
  /** Unix seconds. */
  created_at: number;
}

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  created_at: string;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  created_at: string;
  updated_at: string;
}

export const NOTE_COLORS = ["blue", "purple", "green", "yellow", "pink", "orange"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export interface NoteItem {
  id: string;
  title: string;
  body: string;
  color: NoteColor;
  pinned: boolean;
  /** Optional link opened by the globe action. */
  url?: string;
  created_at: string;
  updated_at: string;
}

export function taskStatusLabel(status: string): string {
  return TASK_STATUSES.find((item) => item.id === status)?.label ?? status;
}

export function normalizeTaskStatus(status: string): TaskStatus {
  if (status === "todo" || status === "opening") return "opening";
  if (status === "doing" || status === "working") return "working";
  if (status === "closing") return "closing";
  if (status === "done" || status === "verify") return "verify";
  return "opening";
}

/** True for any non-closed status (Open / Working / Closing). */
export function isTaskOpen(status: string): boolean {
  return normalizeTaskStatus(status) !== "verify";
}

/** True only for the Open (opening) status — not Working / Closing / Closed. */
export function isTaskOpening(status: string): boolean {
  return normalizeTaskStatus(status) === "opening";
}

/** True for Closed (verify). */
export function isTaskClosed(status: string): boolean {
  return normalizeTaskStatus(status) === "verify";
}

export const PERSONNEL_ROLES = ["Admin", "DM", "DL", "DE", "DQA", "PM", "SA"] as const;
export type PersonnelRole = (typeof PERSONNEL_ROLES)[number];

/** Roles limited to WORKSPACE Security + INV&PCR only. */
export const WORKSPACE_LIMITED_ROLES = ["DQA", "PM", "SA"] as const;
export type WorkspaceLimitedRole = (typeof WORKSPACE_LIMITED_ROLES)[number];

export const WORKSPACE_LIMITED_VIEWS = ["security", "inv-pcr"] as const satisfies readonly ViewId[];

export interface PersonnelColumn {
  id: string;
  label: string;
}

export interface Profile {
  id: string;
  username: string;
  display_name: string;
  unit: string;
  email: string;
  is_admin: boolean;
  /** Org role shown on Personnel (Admin / DM / DL / DE / DQA / PM / SA). */
  personnel_role?: PersonnelRole;
  /** Values for user-defined Personnel columns. */
  custom?: Record<string, string>;
}

export function normalizePersonnelRole(profile: Pick<Profile, "is_admin" | "personnel_role">): PersonnelRole {
  if (profile.personnel_role && (PERSONNEL_ROLES as readonly string[]).includes(profile.personnel_role)) {
    return profile.personnel_role;
  }
  return profile.is_admin ? "Admin" : "DE";
}

export function isWorkspaceLimitedRole(role: PersonnelRole): boolean {
  return (WORKSPACE_LIMITED_ROLES as readonly string[]).includes(role);
}

export function canAccessView(role: PersonnelRole, view: ViewId): boolean {
  if (!isWorkspaceLimitedRole(role)) return true;
  return (WORKSPACE_LIMITED_VIEWS as readonly string[]).includes(view);
}

export interface ProjectColumn {
  id: string;
  label: string;
}

/** One handover checklist row on a project (Actions → CheckPoint spreadsheet). */
export interface ProjectCheckpoint {
  id: string;
  /** Category / Type column (e.g. Basic information (Lists/SPEC)). */
  type: string;
  /** Item column. */
  item: string;
  /** Description column. */
  description: string;
  checked: boolean;
  /**
   * Legacy flat-list label from #100 `{id,text,checked}`.
   * Migrated into `item` on read; kept optional for older in-memory overlays.
   */
  text?: string;
}

/** Neon `projects.checkpoints` jsonb document (v2). Legacy was a bare array. */
export interface ProjectCheckpointDoc {
  handover_date: string;
  items: ProjectCheckpoint[];
}

export interface Project {
  id: string;
  /** Compal project name (primary display name). */
  name: string;
  description: string;
  created_by: string;
  created_at: string;
  lenovo_name?: string;
  bios_id?: string;
  platform?: string;
  dis?: string;
  ss_date?: string;
  eol_date?: string;
  security_update?: string;
  talent_policy?: string;
  /** Project Leader (standard middle column; Neon `owner`; removable via Admin column defs). */
  owner?: string;
  /**
   * Owner (beside PROJECT LEADER; Neon `project_owner`).
   * Distinct from `owner` (PROJECT LEADER) and `tpe_owner` (TPE OWNER).
   */
  project_owner?: string;
  /**
   * TPE OWNER (Neon `tpe_owner`). Distinct from `owner` and `project_owner`.
   */
  tpe_owner?: string;
  /** Values for user-defined Projects columns. */
  custom?: Record<string, string>;
  /** Handover CheckPoint rows (from Neon `checkpoints` jsonb / custom fallback). */
  checkpoints?: ProjectCheckpoint[];
  /** Handover date shown above the CheckPoint sheet. */
  checkpoint_handover_date?: string;
}

export interface ProjectMember {
  project_id: string;
  user_id: string;
  role: Role;
}

export interface AnalyzedNote {
  id: string;
  text: string;
  by: string | null;
  at: string | null;
}

export interface Task {
  id: string;
  project_id: string;
  title: string;
  assignee_id: string | null;
  start_date: string;
  due_date: string;
  status: TaskStatus;
  note: string;
  analyzed: string;
  analyzed_by: string | null;
  analyzed_at: string | null;
  analyzed_notes: AnalyzedNote[];
  /** Stable display order key (DB default now()); optional on legacy local rows. */
  created_at?: string;
}

export interface AccountInput {
  display_name: string;
  unit: string;
  email: string;
}

export interface CreatePersonnelInput {
  display_name: string;
  /** Login id; if omitted, derived from email. */
  username?: string;
  /** If omitted and username is set, local mode uses username@local. */
  email?: string;
  phone?: string;
  personnel_role: PersonnelRole;
  projectIds?: string[];
}

export interface InviteInput extends AccountInput {
  role: Role;
  project_id: string;
}

export interface CredentialRow {
  display_name: string;
  username: string;
  email: string;
  password: string;
  project_name?: string;
  role?: Role;
}

export interface ReminderItem {
  kind: "overdue" | "today" | "tomorrow";
  task: Task;
}

export interface LeaderDigest {
  project_name: string;
  overdue: Task[];
  today: Task[];
  week: Task[];
}
