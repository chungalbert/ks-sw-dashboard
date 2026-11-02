/** BIOS Security Updates — cycles, project roster, reusable issue cards. */

export type SecurityRosterStatus =
  | "Not Started"
  | "Internal release"
  | "SA BVT"
  | "Completed";

/** Named milestone / wave on a cycle (source of truth for roster Wave options). */
export type SecurityWave = {
  id: string;
  name: string;
  /** ISO YYYY-MM-DD or empty. */
  target_date: string;
};

export type SecurityCycle = {
  id: string;
  name: string;
  cycle_type: string;
  quarter: string;
  /** @deprecated Prefer `waves`; kept for Neon legacy columns / New cycle form. */
  wave1_date: string;
  /** @deprecated Prefer `waves`. */
  wave2_date: string;
  /** @deprecated Prefer `waves`. */
  external_release_date: string;
  /** Editable wave list — drives Active cycle timeline + roster Wave select. */
  waves: SecurityWave[];
  /** Project ids included in this cycle (roster rows). */
  project_ids: string[];
  created_at: string;
  updated_at: string;
};

export type SecurityRosterEntry = {
  id: string;
  cycle_id: string;
  project_id: string;
  project_name: string;
  wave: string;
  owner_id: string | null;
  reviewer_id: string | null;
  /** Free-text SA owner name (typed individually, not Personnel FK). */
  sa_owner: string;
  /** Free-text PM owner name. */
  pm_owner: string;
  /** Free-text DQA owner name. */
  dqa_owner: string;
  status: SecurityRosterStatus;
  sort_order: number;
};

/** Fields editable on a roster row (immediate Save via updateRosterEntry). */
export type SecurityRosterPatch = Partial<
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
>;

export type SecurityIssue = {
  id: string;
  title: string;
  oem_request_id: string;
  detail: string;
  /** Optional URL or UNC path shown on Issue Summary cards. */
  reference_path: string;
  cycle_ids: string[];
  project_ids: string[];
  /** Display codes (comma-joined), kept for roster-less projects. */
  project_names: string;
  created_at: string;
  updated_at: string;
};

export type SecuritySnapshot = {
  cycles: SecurityCycle[];
  roster: SecurityRosterEntry[];
  issues: SecurityIssue[];
};

export type NewCycleInput = {
  name: string;
  cycle_type: string;
  quarter: string;
  wave1_date: string;
  wave2_date: string;
  external_release_date: string;
  /** Wave list (preferred). If omitted, built from the three legacy date fields. */
  waves?: SecurityWave[];
  /** Selected projects: id + display name (+ optional platform blurb unused in roster). */
  projects: { id: string; name: string }[];
};

/** Same payload as NewCycleInput — used by Edit cycle modal Save. */
export type UpdateCycleInput = NewCycleInput;

export type SecurityIssueInput = {
  title: string;
  oem_request_id?: string;
  detail?: string;
  reference_path?: string;
  cycle_ids?: string[];
  project_ids?: string[];
  project_names?: string;
};

/**
 * Whether an Issue Summary item may appear for a cycle (filter pills / + New item).
 * Empty `cycle_ids` = unrestricted (legacy / “any cycle”).
 * Non-empty = only the checked cycles from Add/Edit Security Update Item.
 */
export function issueAllowedInCycle(
  issue: Pick<SecurityIssue, "cycle_ids">,
  cycleId: string,
): boolean {
  if (!cycleId) return false;
  if (!issue.cycle_ids.length) return true;
  return issue.cycle_ids.includes(cycleId);
}

export const SECURITY_STATUSES: SecurityRosterStatus[] = [
  "Not Started",
  "Internal release",
  "SA BVT",
  "Completed",
];

export function newWaveId(): string {
  return `wave-${crypto.randomUUID()}`;
}

/** Build default waves from the three New-cycle date fields. */
export function wavesFromLegacyDates(
  wave1_date: string,
  wave2_date: string,
  external_release_date: string,
): SecurityWave[] {
  return [
    { id: newWaveId(), name: "Wave 1", target_date: wave1_date.trim() },
    { id: newWaveId(), name: "Wave 2", target_date: wave2_date.trim() },
    {
      id: newWaveId(),
      name: "External Release",
      target_date: external_release_date.trim(),
    },
  ];
}

/** Prefer `waves`; fall back to legacy date columns. */
export function normalizeCycleWaves(
  cycle: Pick<SecurityCycle, "waves" | "wave1_date" | "wave2_date" | "external_release_date">,
): SecurityWave[] {
  if (Array.isArray(cycle.waves) && cycle.waves.length > 0) {
    return cycle.waves.map((w, i) => ({
      id: String(w.id || `wave-${i}`),
      name: String(w.name || `Wave ${i + 1}`).trim() || `Wave ${i + 1}`,
      target_date: String(w.target_date ?? "").trim(),
    }));
  }
  const w1 = (cycle.wave1_date ?? "").trim();
  const w2 = (cycle.wave2_date ?? "").trim();
  const ext = (cycle.external_release_date ?? "").trim();
  if (!w1 && !w2 && !ext) return [];
  return wavesFromLegacyDates(w1, w2, ext);
}

/** Sync legacy columns from waves[0..2] for older readers / SQL. */
export function legacyDatesFromWaves(waves: SecurityWave[]): {
  wave1_date: string;
  wave2_date: string;
  external_release_date: string;
} {
  const byName = (n: string) => waves.find((w) => w.name.toLowerCase() === n.toLowerCase());
  const w1 = byName("Wave 1") ?? waves[0];
  const w2 = byName("Wave 2") ?? waves[1];
  const ext = byName("External Release") ?? waves[2];
  return {
    wave1_date: w1?.target_date ?? "",
    wave2_date: w2?.target_date ?? "",
    external_release_date: ext?.target_date ?? "",
  };
}

/** Roster Wave select options for a cycle: Not set + each wave name. */
export function rosterWaveOptions(cycle: SecurityCycle | null | undefined): string[] {
  const names = normalizeCycleWaves(cycle ?? { waves: [], wave1_date: "", wave2_date: "", external_release_date: "" })
    .map((w) => w.name.trim())
    .filter(Boolean);
  const unique: string[] = [];
  for (const n of names) {
    if (!unique.includes(n)) unique.push(n);
  }
  return ["Not set", ...unique];
}
