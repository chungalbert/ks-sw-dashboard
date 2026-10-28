/**
 * Security Update store.
 * - Local: `awb-security-v1` (always available).
 * - Neon: `security_cycles` / `security_roster` / `security_issues` when neon/security.sql is applied.
 * Falls back to local when cloud tables are missing (PGRST205 / 42P01).
 */
import { cloudApi } from "./cloudApi";
import type {
  CycleDetailDoc,
  CycleDetailItem,
  CycleReleaseTracking,
  ItemApplyCell,
} from "./cycleDetailTypes";
import {
  deriveRosterStatusFromRelease,
  emptyCycleDetail,
  newDetailItemId,
  normalizeApplyCell,
} from "./cycleDetailTypes";
import type {
  NewCycleInput,
  SecurityCycle,
  SecurityIssue,
  SecurityIssueInput,
  SecurityRosterEntry,
  SecurityRosterPatch,
  SecurityRosterStatus,
  SecuritySnapshot,
  SecurityWave,
  UpdateCycleInput,
} from "./securityTypes";
import {
  SECURITY_STATUSES,
  legacyDatesFromWaves,
  normalizeCycleWaves,
  wavesFromLegacyDates,
} from "./securityTypes";
import { hasSupabaseConfig } from "./util";

const KEY = "awb-security-v1";
const DETAIL_KEY = "awb-security-detail-v1";
const CLOUD_PROBE_TTL_MS = 20_000;

let cloudOk: boolean | null = null;
let cloudProbedAt = 0;

function isSecurityTableMissing(err: unknown): boolean {
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
  // Only treat *missing relation / schema-cache* as "use local". Bare
  // "security_roster" in a column/RLS/permission error must NOT silent-fallback
  // (that caused Neon vs awb-security-v1 split-brain).
  const namesTable =
    msg.includes("security_cycles") ||
    msg.includes("security_roster") ||
    msg.includes("security_issues") ||
    msg.includes("security_cycle_details");
  const missingRelation =
    code === "42P01" ||
    code === "PGRST205" ||
    msg.includes("could not find the table") ||
    (msg.includes("does not exist") && namesTable) ||
    (msg.includes("schema cache") && namesTable) ||
    (namesTable && (msg.includes("not find") || msg.includes("could not find")));
  // PGRST204 = missing *column* in an existing table — still cloud; do not fall local.
  return missingRelation && code !== "PGRST204";
}

function loadLocalDetails(): Record<string, CycleDetailDoc> {
  try {
    const raw = localStorage.getItem(DETAIL_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CycleDetailDoc>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveLocalDetails(map: Record<string, CycleDetailDoc>) {
  localStorage.setItem(DETAIL_KEY, JSON.stringify(map));
}

function normalizeDetailDoc(cycleId: string, raw: Partial<CycleDetailDoc> | null | undefined): CycleDetailDoc {
  const base = emptyCycleDetail(cycleId);
  if (!raw) return base;
  const items: CycleDetailItem[] = Array.isArray(raw.items)
    ? raw.items.map((item, i) => {
        const appliesRaw =
          item && typeof item === "object" && item.applies && typeof item.applies === "object"
            ? (item.applies as Record<string, unknown>)
            : {};
        const applies: Record<string, ItemApplyCell> = {};
        for (const [pid, v] of Object.entries(appliesRaw)) {
          applies[pid] = normalizeApplyCell(v);
        }
        const issueIdRaw =
          item && typeof item === "object" && "issue_id" in item
            ? String((item as { issue_id?: unknown }).issue_id ?? "").trim()
            : "";
        return {
          id: String(item?.id || newDetailItemId()),
          ...(issueIdRaw ? { issue_id: issueIdRaw } : {}),
          title: String(item?.title ?? ""),
          detail: String(item?.detail ?? ""),
          cycle_comment: String(item?.cycle_comment ?? ""),
          applies,
          sort_order: Number(item?.sort_order) || i,
        };
      })
    : [];
  const by_project =
    raw.release && typeof raw.release === "object" && raw.release.by_project
      ? { ...raw.release.by_project }
      : {};
  return {
    cycle_id: cycleId,
    items,
    release: { by_project },
    updated_at: String(raw.updated_at ?? new Date().toISOString()),
  };
}

/** Seed matrix rows from issues already linked to this cycle (local / first open). */
export function seedDetailFromIssues(
  cycleId: string,
  issues: SecurityIssue[],
  projectIds: string[],
): CycleDetailDoc {
  const linked = issues
    .filter((i) => i.cycle_ids.includes(cycleId))
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title));
  const items: CycleDetailItem[] = linked.map((issue, i) => {
    const applies: Record<string, ItemApplyCell> = {};
    for (const pid of projectIds) {
      applies[pid] = {
        status: issue.project_ids.includes(pid) ? "Applied" : "",
        comment: "",
      };
    }
    return {
      id: newDetailItemId(),
      issue_id: issue.id,
      title: issue.title,
      detail: issue.reference_path || issue.detail || issue.oem_request_id || "",
      cycle_comment: "",
      applies,
      sort_order: i,
    };
  });
  return {
    cycle_id: cycleId,
    items,
    release: { by_project: {} },
    updated_at: new Date().toISOString(),
  };
}

function emptySnapshot(): SecuritySnapshot {
  return { cycles: [], roster: [], issues: [] };
}

function normalizeCycle(raw: Partial<SecurityCycle> & { id?: string }): SecurityCycle | null {
  if (!raw?.id) return null;
  const wave1_date = String(raw.wave1_date ?? "");
  const wave2_date = String(raw.wave2_date ?? "");
  const external_release_date = String(raw.external_release_date ?? "");
  const waves = normalizeCycleWaves({
    waves: Array.isArray(raw.waves) ? (raw.waves as SecurityWave[]) : [],
    wave1_date,
    wave2_date,
    external_release_date,
  });
  const legacy = legacyDatesFromWaves(waves);
  return {
    id: String(raw.id),
    name: String(raw.name ?? ""),
    cycle_type: String(raw.cycle_type ?? "Quarter"),
    quarter: String(raw.quarter ?? ""),
    wave1_date: waves.length ? legacy.wave1_date : wave1_date,
    wave2_date: waves.length ? legacy.wave2_date : wave2_date,
    external_release_date: waves.length ? legacy.external_release_date : external_release_date,
    waves,
    project_ids: Array.isArray(raw.project_ids) ? raw.project_ids.map(String) : [],
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? raw.created_at ?? ""),
  };
}

function seedSnapshot(): SecuritySnapshot {
  const now = new Date().toISOString();
  const q4Waves = wavesFromLegacyDates("2026-11-17", "2026-12-01", "2026-12-21");
  const q4Legacy = legacyDatesFromWaves(q4Waves);
  const q4: SecurityCycle = {
    id: "sec-cycle-2026-q4",
    name: "2026 Q4 AIO",
    cycle_type: "Quarter",
    quarter: "2026 Q4",
    ...q4Legacy,
    waves: q4Waves,
    project_ids: [],
    created_at: now,
    updated_at: now,
  };
  const q3: SecurityCycle = {
    id: "sec-cycle-2026-q3",
    name: "2026 Q3 AIO",
    cycle_type: "Quarter",
    quarter: "2026 Q3",
    wave1_date: "",
    wave2_date: "",
    external_release_date: "",
    waves: wavesFromLegacyDates("", "", ""),
    project_ids: [],
    created_at: now,
    updated_at: now,
  };
  const q2: SecurityCycle = {
    id: "sec-cycle-2026-q2",
    name: "2026 Q2 AIO",
    cycle_type: "Quarter",
    quarter: "2026 Q2",
    wave1_date: "",
    wave2_date: "",
    external_release_date: "",
    waves: wavesFromLegacyDates("", "", ""),
    project_ids: [],
    created_at: now,
    updated_at: now,
  };

  const projectNames = [
    "JOC10",
    "JOC20",
    "KOC10",
    "KOC20",
    "LOA70",
    "LOC20",
    "LOC21",
    "LOC22",
    "LOC30",
    "LOC75",
    "LOX70",
    "MOC70",
  ];
  const q4Roster: SecurityRosterEntry[] = projectNames.map((name, i) => ({
    id: `sec-roster-q4-${i}`,
    cycle_id: q4.id,
    project_id: `seed-${name}`,
    project_name: name,
    wave: "Not set",
    owner_id: null,
    reviewer_id: null,
    sa_owner: "",
    pm_owner: "",
    dqa_owner: "",
    status: "Not Started",
    sort_order: i,
  }));
  q4.project_ids = q4Roster.map((r) => r.project_id);

  // Lightweight Q3/Q2 counts to match reference pills (14 / 11) without inventing full rosters.
  const padRoster = (cycleId: string, count: number, prefix: string): SecurityRosterEntry[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `sec-roster-${prefix}-${i}`,
      cycle_id: cycleId,
      project_id: `${prefix}-${i}`,
      project_name: `P${prefix.toUpperCase()}${String(i + 1).padStart(2, "0")}`,
      wave: "Not set",
      owner_id: null,
      reviewer_id: null,
      sa_owner: "",
      pm_owner: "",
      dqa_owner: "",
      status: "Not Started" as SecurityRosterStatus,
      sort_order: i,
    }));
  const q3Roster = padRoster(q3.id, 14, "q3");
  const q2Roster = padRoster(q2.id, 11, "q2");
  q3.project_ids = q3Roster.map((r) => r.project_id);
  q2.project_ids = q2Roster.map((r) => r.project_id);

  const issueTitles = [
    "UEFIDiag & AFU",
    "CA 2023 Key在Secure Boot disable時會被清除",
    "CP20260625_0019 Commercial Vantage",
    "Deploy PTL PR3 pCode, PMC, SOC microcode update",
    "GB 46864-2025Secure Wipe Update",
    "New CSOT Panel ID",
    "Remain issue",
    "WA_ Change RETRY_CNT_MAX from 1 to 3 for WHEA",
    "wFlashGUI update for JY touch support",
    "Y26Q1 LEN-211077 Security BIOS Update",
    "Y26Q1 LEN-212211 Security BIOS Update",
    "Y26Q1 LEN-213831 Security BIOS Update",
    "Y26Q1 LEN-213835 Security BIOS Update",
    "Y26Q2 LEN-218238 Security BIOS Update",
    "Y26Q2 LEN-220290 Security BIOS Update",
    "Y26Q3 LEN-223112 Security BIOS Update",
    "Y26Q3 LEN-223492 Security BIOS Update",
    "Y26Q3 LEN-223501 Security BIOS Update",
    "Y26Q3 VRT010&VRT011 Security BIOS Update",
  ];

  const issues: SecurityIssue[] = issueTitles.map((title, i) => {
    let cycle_ids: string[] = [];
    if (i < 2) cycle_ids = [q4.id];
    else if (i < 11) cycle_ids = [q3.id];
    else cycle_ids = [q2.id];
    // Overlap a few into multiple cycles like the reference.
    if (i === 2) cycle_ids = [q4.id, q3.id];
    if (i === 7) cycle_ids = [q3.id, q2.id];
    return {
      id: `sec-issue-${i}`,
      title,
      oem_request_id: title.startsWith("CP2026") ? "CP20260625_0019" : "",
      detail: i === 2 ? "Commercial Vantage security package" : "",
      reference_path: "",
      cycle_ids,
      project_ids: q4.project_ids.slice(0, 6),
      project_names: projectNames.slice(0, 8).join(", "),
      created_at: now,
      updated_at: now,
    };
  });

  return {
    cycles: [q4, q3, q2],
    roster: [...q4Roster, ...q3Roster, ...q2Roster],
    issues,
  };
}

function loadLocal(): SecuritySnapshot {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) {
      const seeded = seedSnapshot();
      saveLocal(seeded);
      return seeded;
    }
    const parsed = JSON.parse(raw) as SecuritySnapshot;
    if (!parsed || !Array.isArray(parsed.cycles)) {
      const seeded = seedSnapshot();
      saveLocal(seeded);
      return seeded;
    }
    const cycles = (parsed.cycles ?? [])
      .map((c) => normalizeCycle(c))
      .filter((c): c is SecurityCycle => Boolean(c));
    return {
      cycles,
      roster: (parsed.roster ?? []).map((row) => normalizeRosterEntry(row)),
      issues: (parsed.issues ?? []).map((issue) => ({
        ...issue,
        reference_path: String(issue.reference_path ?? ""),
      })),
    };
  } catch {
    return seedSnapshot();
  }
}

function saveLocal(snap: SecuritySnapshot) {
  localStorage.setItem(KEY, JSON.stringify(snap));
}

function normalizeStatus(raw: string | undefined): SecurityRosterStatus {
  if (raw && (SECURITY_STATUSES as string[]).includes(raw)) return raw as SecurityRosterStatus;
  return "Not Started";
}

function personId(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  return String(raw);
}

/** Free-text owner; ignore legacy UUID profile ids left in old localStorage. */
function textOwner(raw: unknown, legacyId?: unknown): string {
  const direct = String(raw ?? "").trim();
  if (direct) return direct;
  const legacy = String(legacyId ?? "").trim();
  if (legacy && !/^[0-9a-f-]{36}$/i.test(legacy)) return legacy;
  return "";
}

function normalizeRosterEntry(
  row: (Partial<SecurityRosterEntry> & {
    sa_owner_id?: string | null;
    pm_owner_id?: string | null;
    dqa_owner_id?: string | null;
  }) | SecurityRosterEntry,
): SecurityRosterEntry {
  const legacy = row as {
    sa_owner_id?: string | null;
    pm_owner_id?: string | null;
    dqa_owner_id?: string | null;
  };
  return {
    id: String(row.id ?? ""),
    cycle_id: String(row.cycle_id ?? ""),
    project_id: String(row.project_id ?? ""),
    project_name: String(row.project_name ?? ""),
    wave: String(row.wave ?? "Not set"),
    owner_id: personId(row.owner_id),
    reviewer_id: personId(row.reviewer_id),
    sa_owner: textOwner(row.sa_owner, legacy.sa_owner_id),
    pm_owner: textOwner(row.pm_owner, legacy.pm_owner_id),
    dqa_owner: textOwner(row.dqa_owner, legacy.dqa_owner_id),
    status: normalizeStatus(row.status != null ? String(row.status) : undefined),
    sort_order: Number(row.sort_order) || 0,
  };
}

function asStringArray(value: unknown): string[] {
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

async function probeCloud(): Promise<boolean> {
  if (!hasSupabaseConfig()) {
    cloudOk = false;
    return false;
  }
  const now = Date.now();
  if (cloudOk !== null && now - cloudProbedAt < CLOUD_PROBE_TTL_MS) return cloudOk;
  try {
    await cloudApi.listSecurityCycles();
    cloudOk = true;
  } catch (err) {
    cloudOk = isSecurityTableMissing(err) ? false : false;
    if (!isSecurityTableMissing(err)) {
      // Network/auth — keep probing next time; use local for this call.
      cloudProbedAt = now;
      return false;
    }
  }
  cloudProbedAt = now;
  return Boolean(cloudOk);
}

function formatMmDd(isoOrSlash: string): string {
  const s = isoOrSlash.trim();
  if (!s) return "";
  // Accept YYYY-MM-DD or locale 年/月/日 already stored as ISO.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[2]}/${m[3]}`;
  // Legacy mm-dd → mm/dd for display consistency.
  const legacy = s.match(/^(\d{1,2})-(\d{1,2})$/);
  if (legacy) return `${legacy[1].padStart(2, "0")}/${legacy[2].padStart(2, "0")}`;
  return s;
}

export function securityDisplayDate(isoOrSlash: string): string {
  return formatMmDd(isoOrSlash);
}

export function cycleMetrics(roster: SecurityRosterEntry[], definedWaveCount?: number) {
  const total = roster.length;
  const count = (status: SecurityRosterStatus) => roster.filter((r) => r.status === status).length;
  return {
    total,
    /** Prefer cycle-defined wave count; fall back to distinct roster assignments. */
    waves:
      typeof definedWaveCount === "number"
        ? definedWaveCount
        : new Set(roster.map((r) => r.wave).filter((w) => w && w !== "Not set")).size,
    internal: count("Internal release"),
    saBvt: count("SA BVT"),
    completed: count("Completed"),
  };
}

export const securityStore = {
  async load(): Promise<SecuritySnapshot> {
    if (await probeCloud()) {
      try {
        const [cycles, roster, issues] = await Promise.all([
          cloudApi.listSecurityCycles(),
          cloudApi.listSecurityRoster(),
          cloudApi.listSecurityIssues(),
        ]);
        return { cycles, roster, issues };
      } catch (err) {
        if (!isSecurityTableMissing(err)) throw err;
        cloudOk = false;
      }
    }
    return loadLocal();
  },

  async createCycle(input: NewCycleInput): Promise<SecurityCycle> {
    const name = input.name.trim();
    if (!name) throw new Error("Canonical name is required");
    const quarter = input.quarter.trim();
    if (!quarter) throw new Error("Quarter is required");
    if (!input.projects.length) throw new Error("Select at least one project");

    const waves = (
      input.waves && input.waves.length > 0
        ? input.waves
        : wavesFromLegacyDates(input.wave1_date, input.wave2_date, input.external_release_date)
    )
      .map((w, i) => ({
        id: String(w.id || `wave-${i}`),
        name: String(w.name || "").trim() || `Wave ${i + 1}`,
        target_date: String(w.target_date || "").trim(),
      }))
      .filter((w) => w.name);
    if (waves.length === 0) throw new Error("Add at least one wave");

    if (await probeCloud()) {
      try {
        return await cloudApi.createSecurityCycle({ ...input, waves });
      } catch (err) {
        if (!isSecurityTableMissing(err)) throw err;
        cloudOk = false;
      }
    }

    const snap = loadLocal();
    const now = new Date().toISOString();
    const legacy = legacyDatesFromWaves(waves);
    const cycle: SecurityCycle = {
      id: crypto.randomUUID(),
      name,
      cycle_type: input.cycle_type.trim() || "Quarter",
      quarter,
      ...legacy,
      waves,
      project_ids: input.projects.map((p) => p.id),
      created_at: now,
      updated_at: now,
    };
    const roster: SecurityRosterEntry[] = input.projects.map((p, i) => ({
      id: crypto.randomUUID(),
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
    snap.cycles = [cycle, ...snap.cycles];
    snap.roster = [...roster, ...snap.roster];
    saveLocal(snap);
    return cycle;
  },

  async updateCycle(cycleId: string, input: UpdateCycleInput): Promise<SecurityCycle> {
    const name = input.name.trim();
    if (!name) throw new Error("Canonical name is required");
    const quarter = input.quarter.trim();
    if (!quarter) throw new Error("Quarter is required");
    if (!input.projects.length) throw new Error("Select at least one project");

    const cleanedWaves = (
      input.waves && input.waves.length > 0
        ? input.waves
        : wavesFromLegacyDates(input.wave1_date, input.wave2_date, input.external_release_date)
    )
      .map((w, i) => ({
        id: String(w.id || `wave-${i}`),
        name: String(w.name || "").trim() || `Wave ${i + 1}`,
        target_date: String(w.target_date || "").trim(),
      }))
      .filter((w) => w.name);
    if (cleanedWaves.length === 0) throw new Error("Add at least one wave");

    if (await probeCloud()) {
      try {
        return await cloudApi.updateSecurityCycle(cycleId, { ...input, waves: cleanedWaves });
      } catch (err) {
        if (!isSecurityTableMissing(err)) throw err;
        cloudOk = false;
      }
    }

    const snap = loadLocal();
    const idx = snap.cycles.findIndex((c) => c.id === cycleId);
    if (idx < 0) throw new Error("Cycle not found");
    const prev = snap.cycles[idx];
    const prevList = normalizeCycleWaves(prev);
    const prevNames = new Set(prevList.map((w) => w.name));
    const nextNames = new Set(cleanedWaves.map((w) => w.name));
    const renamed = new Map<string, string>();
    prevList.forEach((old, i) => {
      const neu = cleanedWaves[i];
      if (neu && old.name !== neu.name) renamed.set(old.name, neu.name);
    });

    const legacy = legacyDatesFromWaves(cleanedWaves);
    const projectIds = input.projects.map((p) => p.id);
    const wanted = new Set(projectIds);
    const next: SecurityCycle = {
      ...prev,
      name,
      cycle_type: input.cycle_type.trim() || "Quarter",
      quarter,
      ...legacy,
      waves: cleanedWaves,
      project_ids: projectIds,
      updated_at: new Date().toISOString(),
    };
    snap.cycles[idx] = next;

    const existing = snap.roster.filter((r) => r.cycle_id === cycleId);
    const kept = existing
      .filter((r) => wanted.has(r.project_id))
      .map((row) => {
        let wave = row.wave;
        if (wave !== "Not set") {
          if (renamed.has(wave)) wave = renamed.get(wave)!;
          else if (!nextNames.has(wave) && prevNames.has(wave)) wave = "Not set";
        }
        const proj = input.projects.find((p) => p.id === row.project_id);
        return {
          ...row,
          project_name: proj?.name ?? row.project_name,
          wave,
        };
      });
    const existingIds = new Set(kept.map((r) => r.project_id));
    const added: SecurityRosterEntry[] = input.projects
      .filter((p) => !existingIds.has(p.id))
      .map((p, i) => ({
        id: crypto.randomUUID(),
        cycle_id: cycleId,
        project_id: p.id,
        project_name: p.name,
        wave: "Not set",
        owner_id: null,
        reviewer_id: null,
        sa_owner: "",
        pm_owner: "",
        dqa_owner: "",
        status: "Not Started" as SecurityRosterStatus,
        sort_order: kept.length + i,
      }));
    snap.roster = [
      ...snap.roster.filter((r) => r.cycle_id !== cycleId),
      ...kept.map((r, i) => ({ ...r, sort_order: i })),
      ...added,
    ];
    saveLocal(snap);
    return next;
  },

  /** @deprecated Prefer updateCycle — kept for callers that only patch waves. */
  async updateCycleWaves(cycleId: string, waves: SecurityWave[]): Promise<SecurityCycle> {
    const snap = await securityStore.load();
    const cycle = snap.cycles.find((c) => c.id === cycleId);
    if (!cycle) throw new Error("Cycle not found");
    const roster = snap.roster.filter((r) => r.cycle_id === cycleId);
    return securityStore.updateCycle(cycleId, {
      name: cycle.name,
      cycle_type: cycle.cycle_type,
      quarter: cycle.quarter,
      wave1_date: "",
      wave2_date: "",
      external_release_date: "",
      waves,
      projects: roster.map((r) => ({ id: r.project_id, name: r.project_name })),
    });
  },

  async updateRosterEntry(id: string, patch: SecurityRosterPatch): Promise<SecurityRosterEntry> {
    if (await probeCloud()) {
      try {
        return await cloudApi.updateSecurityRosterEntry(id, patch);
      } catch (err) {
        if (!isSecurityTableMissing(err)) throw err;
        cloudOk = false;
      }
    }
    const snap = loadLocal();
    const idx = snap.roster.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error("Roster entry not found");
    const next = { ...snap.roster[idx] };
    if (patch.wave !== undefined) next.wave = patch.wave;
    if (patch.owner_id !== undefined) next.owner_id = patch.owner_id;
    if (patch.reviewer_id !== undefined) next.reviewer_id = patch.reviewer_id;
    if (patch.sa_owner !== undefined) next.sa_owner = patch.sa_owner.trim();
    if (patch.pm_owner !== undefined) next.pm_owner = patch.pm_owner.trim();
    if (patch.dqa_owner !== undefined) next.dqa_owner = patch.dqa_owner.trim();
    if (patch.status !== undefined) next.status = normalizeStatus(patch.status);
    snap.roster[idx] = next;
    saveLocal(snap);
    return next;
  },

  async createIssue(input: SecurityIssueInput): Promise<SecurityIssue> {
    const title = input.title.trim();
    if (!title) throw new Error("Title is required");
    if (await probeCloud()) {
      try {
        return await cloudApi.createSecurityIssue(input);
      } catch (err) {
        if (!isSecurityTableMissing(err)) throw err;
        cloudOk = false;
      }
    }
    const snap = loadLocal();
    const now = new Date().toISOString();
    const issue: SecurityIssue = {
      id: crypto.randomUUID(),
      title,
      oem_request_id: (input.oem_request_id ?? "").trim(),
      detail: (input.detail ?? "").trim(),
      reference_path: (input.reference_path ?? "").trim(),
      cycle_ids: input.cycle_ids ?? [],
      project_ids: input.project_ids ?? [],
      project_names: (input.project_names ?? "").trim(),
      created_at: now,
      updated_at: now,
    };
    snap.issues = [issue, ...snap.issues];
    saveLocal(snap);
    return issue;
  },

  async updateIssue(
    id: string,
    input: SecurityIssueInput,
    opts?: { syncLinkedCycles?: boolean },
  ): Promise<SecurityIssue> {
    const title = input.title.trim();
    if (!title) throw new Error("Title is required");
    const syncLinked = opts?.syncLinkedCycles !== false;
    if (await probeCloud()) {
      try {
        const updated = await cloudApi.updateSecurityIssue(id, input);
        if (syncLinked) await securityStore.syncIssueToLinkedCycles(updated);
        return updated;
      } catch (err) {
        if (!isSecurityTableMissing(err)) throw err;
        cloudOk = false;
      }
    }
    const snap = loadLocal();
    const idx = snap.issues.findIndex((i) => i.id === id);
    if (idx < 0) throw new Error("Issue not found");
    const prev = snap.issues[idx];
    const next: SecurityIssue = {
      ...prev,
      title,
      oem_request_id: (input.oem_request_id ?? prev.oem_request_id).trim(),
      detail: (input.detail ?? prev.detail).trim(),
      reference_path: (input.reference_path ?? prev.reference_path).trim(),
      cycle_ids: input.cycle_ids ?? prev.cycle_ids,
      project_ids: input.project_ids ?? prev.project_ids,
      project_names: (input.project_names ?? prev.project_names).trim(),
      updated_at: new Date().toISOString(),
    };
    snap.issues[idx] = next;
    saveLocal(snap);
    if (syncLinked) await securityStore.syncIssueToLinkedCycles(next);
    return next;
  },

  /** Remove a saved Issue Summary item and strip matching matrix rows from linked cycles. */
  async deleteIssue(id: string): Promise<void> {
    if (await probeCloud()) {
      try {
        const snap = await securityStore.load();
        const issue = snap.issues.find((i) => i.id === id);
        await cloudApi.deleteSecurityIssue(id);
        if (issue) await securityStore.removeIssueFromLinkedCycles(issue);
        return;
      } catch (err) {
        if (!isSecurityTableMissing(err)) throw err;
        cloudOk = false;
      }
    }
    const snap = loadLocal();
    const issue = snap.issues.find((i) => i.id === id);
    if (!issue) throw new Error("Issue not found");
    snap.issues = snap.issues.filter((i) => i.id !== id);
    saveLocal(snap);
    await securityStore.removeIssueFromLinkedCycles(issue);
  },

  /**
   * Link a saved Issue Summary item into a cycle (cycle_ids + merge projects).
   * Matrix row is added by the cycle detail UI draft / Save All.
   */
  async linkIssueToCycle(
    issueId: string,
    cycleId: string,
    projectIds: string[],
    projectNamesById: Map<string, string>,
  ): Promise<SecurityIssue> {
    const snap = await securityStore.load();
    const issue = snap.issues.find((i) => i.id === issueId);
    if (!issue) throw new Error("Issue not found");
    const cycle_ids = issue.cycle_ids.includes(cycleId)
      ? issue.cycle_ids
      : [...issue.cycle_ids, cycleId];
    const mergedIds = [...issue.project_ids];
    for (const pid of projectIds) {
      if (!mergedIds.includes(pid)) mergedIds.push(pid);
    }
    const nameSet = new Set(
      issue.project_names
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    for (const pid of mergedIds) {
      const n = projectNamesById.get(pid);
      if (n) nameSet.add(n);
    }
    return securityStore.updateIssue(
      issueId,
      {
        title: issue.title,
        oem_request_id: issue.oem_request_id,
        detail: issue.detail,
        reference_path: issue.reference_path,
        cycle_ids,
        project_ids: mergedIds,
        project_names: [...nameSet].join(", "),
      },
      { syncLinkedCycles: false },
    );
  },

  /** Push title / detail / reference into cycle detail rows that reference this issue. */
  async syncIssueToLinkedCycles(issue: SecurityIssue): Promise<void> {
    const detailLine = issue.reference_path || issue.detail || issue.oem_request_id || "";
    for (const cycleId of issue.cycle_ids) {
      const doc = await securityStore.loadCycleDetail(cycleId);
      if (!doc || doc.items.length === 0) continue;
      let changed = false;
      const items = doc.items.map((it) => {
        const linked =
          it.issue_id === issue.id || (!it.issue_id && it.title.trim() === issue.title.trim());
        if (!linked) return it;
        changed = true;
        return {
          ...it,
          issue_id: issue.id,
          title: issue.title,
          detail: detailLine || it.detail,
        };
      });
      if (changed) {
        await securityStore.saveCycleDetail({ ...doc, items });
      }
    }
  },

  async removeIssueFromLinkedCycles(issue: SecurityIssue): Promise<void> {
    for (const cycleId of issue.cycle_ids) {
      const doc = await securityStore.loadCycleDetail(cycleId);
      if (!doc || doc.items.length === 0) continue;
      const nextItems = doc.items
        .filter((it) => it.issue_id !== issue.id)
        .map((it, i) => ({ ...it, sort_order: i }));
      if (nextItems.length !== doc.items.length) {
        await securityStore.saveCycleDetail({ ...doc, items: nextItems });
      }
    }
  },

  /**
   * Load cycle detail matrix. `null` = never saved (caller may seed from issues).
   * Cloud missing table falls back to local.
   */
  async loadCycleDetail(cycleId: string): Promise<CycleDetailDoc | null> {
    if (await probeCloud()) {
      try {
        return await cloudApi.getSecurityCycleDetail(cycleId);
      } catch (err) {
        if (!isSecurityTableMissing(err)) throw err;
        cloudOk = false;
      }
    }
    const map = loadLocalDetails();
    if (map[cycleId]) return normalizeDetailDoc(cycleId, map[cycleId]);
    return null;
  },

  /** Persist full draft (Save All). Upserts cloud row or local map. */
  async saveCycleDetail(doc: CycleDetailDoc): Promise<CycleDetailDoc> {
    const normalized = normalizeDetailDoc(doc.cycle_id, {
      ...doc,
      updated_at: new Date().toISOString(),
    });
    if (await probeCloud()) {
      try {
        return await cloudApi.upsertSecurityCycleDetail(normalized);
      } catch (err) {
        if (!isSecurityTableMissing(err)) throw err;
        cloudOk = false;
      }
    }
    const map = loadLocalDetails();
    map[normalized.cycle_id] = normalized;
    saveLocalDetails(map);
    return normalized;
  },

  /**
   * Sync Project roster Status from Project Release Tracking (Done rules).
   * Returns updated roster rows (only those that changed).
   */
  async syncRosterStatusesFromRelease(
    cycleId: string,
    release: CycleReleaseTracking,
  ): Promise<SecurityRosterEntry[]> {
    const snap = await securityStore.load();
    const rows = snap.roster.filter((r) => r.cycle_id === cycleId);
    const patches = rows
      .map((row) => {
        const next = deriveRosterStatusFromRelease(release.by_project[row.project_id]);
        return next === row.status ? null : { id: row.id, status: next };
      })
      .filter((p): p is { id: string; status: SecurityRosterStatus } => Boolean(p));
    if (patches.length === 0) return [];
    return Promise.all(
      patches.map((p) => securityStore.updateRosterEntry(p.id, { status: p.status })),
    );
  },

  /** Exported for cloudApi row mapping. */
  _asStringArray: asStringArray,
  _normalizeStatus: normalizeStatus,
  _emptySnapshot: emptySnapshot,
  _normalizeDetailDoc: normalizeDetailDoc,
};
