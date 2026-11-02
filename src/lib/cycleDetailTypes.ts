/** Cycle detail matrix (security items × projects) + project release tracking. */

export type ItemApplyStatus = "Applied" | "Not Applied" | "Not Applicable" | "";

/** Per-project cell under a security update item. */
export type ItemApplyCell = {
  status: ItemApplyStatus;
  comment: string;
  /** Last local/remote edit time for this matrix cell (status + comment). */
  updated_at?: string;
};

export type ItemFieldUpdatedAt = {
  title?: string;
  detail?: string;
  cycle_comment?: string;
  sort_order?: string;
};

export type CycleDetailItem = {
  id: string;
  /** Linked Issue Summary item id when row came from a saved security update item. */
  issue_id?: string;
  title: string;
  /** Secondary line under title (version / path / note). */
  detail: string;
  cycle_comment: string;
  /** project_id → status + comment */
  applies: Record<string, ItemApplyCell>;
  sort_order: number;
  /** Per scalar field stamps for concurrent merge. */
  field_updated_at?: ItemFieldUpdatedAt;
};

/** Release tracking row keys — labels in UI. */
export const RELEASE_TRACKING_ROWS = [
  { key: "pcr_request_date", label: "PCR Request Date", kind: "date" },
  { key: "ec_release_date", label: "EC Release Date", kind: "date" },
  { key: "bios_release_date", label: "BIOS Release Date", kind: "date" },
  { key: "bios_version", label: "BIOS Version", kind: "text" },
  { key: "release_comment", label: "Release Comment", kind: "text" },
  /** Label + URL pair; URL stored in companion `ecr_url` on the same project cell. */
  { key: "ecr_number", label: "ECR Number", kind: "ecr" },
  { key: "internal_release", label: "Internal Release", kind: "status" },
  { key: "sa_bvt_test", label: "SA BVT Test", kind: "status" },
  /** Renamed from External Release - Web (key kept for Neon/local persistence). */
  { key: "external_release_web", label: "DQA Test Complete", kind: "status" },
  /** Renamed from External Release - WU (key kept for Neon/local persistence). */
  { key: "external_release_wu", label: "Sign off", kind: "status" },
] as const;

export type ReleaseTrackingKey = (typeof RELEASE_TRACKING_ROWS)[number]["key"];

export type ReleaseFieldKey = ReleaseTrackingKey | "ecr_url";

/** Per-project release fields; `ecr_url` pairs with `ecr_number`. */
export type ProjectReleaseCell = Partial<Record<ReleaseTrackingKey, string>> & {
  ecr_url?: string;
  /** Per release-tracking field stamps for concurrent merge. */
  field_updated_at?: Partial<Record<ReleaseFieldKey, string>>;
};

/** Normalize link href for display (add https:// when scheme missing). */
export function normalizeEcrHref(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return `https://${s}`;
}

export type CycleReleaseTracking = {
  /** project_id → field values */
  by_project: Record<string, ProjectReleaseCell>;
};

export type CycleDetailDoc = {
  cycle_id: string;
  items: CycleDetailItem[];
  release: CycleReleaseTracking;
  updated_at: string;
};

/** Thrown when Save All would overwrite a newer server revision (optimistic lock). */
export class CycleDetailConflictError extends Error {
  readonly code = "CYCLE_DETAIL_CONFLICT" as const;
  readonly current: CycleDetailDoc;

  constructor(current: CycleDetailDoc) {
    super(
      "This cycle was saved by someone else since you opened it. Save All would overwrite their changes.",
    );
    this.name = "CycleDetailConflictError";
    this.current = current;
  }
}

export function isCycleDetailConflictError(err: unknown): err is CycleDetailConflictError {
  if (err instanceof CycleDetailConflictError) return true;
  if (!err || typeof err !== "object") return false;
  const o = err as { code?: unknown; current?: unknown };
  return o.code === "CYCLE_DETAIL_CONFLICT" && o.current != null && typeof o.current === "object";
}

/** Dropdown options (AIOSW). Empty = unset / —. */
export const APPLY_STATUSES: ItemApplyStatus[] = [
  "",
  "Applied",
  "Not Applied",
  "Not Applicable",
];

export const RELEASE_STATUS_OPTIONS = ["", "Ongoing", "Done", "Blocked", "N/A"] as const;

/**
 * DQA Test Complete (`external_release_web`) also offers **Test Complete**
 * (Issue Clarification chip / roster status). Other release status rows keep the base list.
 */
export const DQA_TEST_COMPLETE_OPTIONS = [
  "",
  "Ongoing",
  "Test Complete",
  "Done",
  "Blocked",
  "N/A",
] as const;

export function releaseStatusOptionsForKey(
  key: ReleaseTrackingKey,
): readonly string[] {
  return key === "external_release_web" ? DQA_TEST_COMPLETE_OPTIONS : RELEASE_STATUS_OPTIONS;
}

export function emptyApplyCell(): ItemApplyCell {
  return { status: "", comment: "" };
}

/**
 * Project ids that count toward Issue Summary → Projects.
 * Includes Applied / Not Applied; excludes blank and Not Applicable.
 */
export function projectIdsWithApplyStatus(
  applies: Record<string, ItemApplyCell | undefined> | null | undefined,
): string[] {
  if (!applies || typeof applies !== "object") return [];
  const out: string[] = [];
  for (const [pid, cell] of Object.entries(applies)) {
    const s = normalizeApplyStatus(cell?.status);
    if (s === "Applied" || s === "Not Applied") out.push(pid);
  }
  return out;
}

export function normalizeApplyStatus(raw: unknown): ItemApplyStatus {
  const s = String(raw ?? "");
  if (s === "Applied" || s === "Not Applied" || s === "Not Applicable") return s;
  return "";
}

/** Accept legacy string status or `{ status, comment, updated_at }`. */
export function normalizeApplyCell(raw: unknown): ItemApplyCell {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const stamp = typeof o.updated_at === "string" && o.updated_at.trim() ? o.updated_at : undefined;
    return {
      status: normalizeApplyStatus(o.status ?? o.value ?? ""),
      comment: String(o.comment ?? ""),
      ...(stamp ? { updated_at: stamp } : {}),
    };
  }
  return { status: normalizeApplyStatus(raw), comment: "" };
}

function normalizeItemFieldUpdatedAt(raw: unknown): ItemFieldUpdatedAt | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: ItemFieldUpdatedAt = {};
  for (const key of ["title", "detail", "cycle_comment", "sort_order"] as const) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeProjectReleaseCell(raw: unknown): ProjectReleaseCell {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const cell: ProjectReleaseCell = {};
  for (const row of RELEASE_TRACKING_ROWS) {
    if (o[row.key] != null) cell[row.key] = String(o[row.key] ?? "");
  }
  if (o.ecr_url != null) cell.ecr_url = String(o.ecr_url ?? "");
  const stampsRaw = o.field_updated_at;
  if (stampsRaw && typeof stampsRaw === "object" && !Array.isArray(stampsRaw)) {
    const stamps: Partial<Record<ReleaseFieldKey, string>> = {};
    for (const [k, v] of Object.entries(stampsRaw as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) stamps[k as ReleaseFieldKey] = v;
    }
    if (Object.keys(stamps).length > 0) cell.field_updated_at = stamps;
  }
  return cell;
}

export function normalizeCycleDetailItem(
  raw: unknown,
  index: number,
  fallbackStamp?: string,
): CycleDetailItem {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const appliesRaw =
    o.applies && typeof o.applies === "object" ? (o.applies as Record<string, unknown>) : {};
  const applies: Record<string, ItemApplyCell> = {};
  for (const [pid, v] of Object.entries(appliesRaw)) {
    const cell = normalizeApplyCell(v);
    if (!cell.updated_at && fallbackStamp) cell.updated_at = fallbackStamp;
    applies[pid] = cell;
  }
  const issueId = String(o.issue_id ?? "").trim();
  let field_updated_at = normalizeItemFieldUpdatedAt(o.field_updated_at);
  if (fallbackStamp) {
    field_updated_at = {
      title: field_updated_at?.title ?? fallbackStamp,
      detail: field_updated_at?.detail ?? fallbackStamp,
      cycle_comment: field_updated_at?.cycle_comment ?? fallbackStamp,
      sort_order: field_updated_at?.sort_order ?? fallbackStamp,
    };
  }
  return {
    id: String(o.id ?? `cdi-${index}`),
    ...(issueId ? { issue_id: issueId } : {}),
    title: String(o.title ?? ""),
    detail: String(o.detail ?? ""),
    cycle_comment: String(o.cycle_comment ?? ""),
    applies,
    sort_order: Number(o.sort_order) || index,
    ...(field_updated_at ? { field_updated_at } : {}),
  };
}

export function emptyCycleDetail(cycleId: string): CycleDetailDoc {
  return {
    cycle_id: cycleId,
    items: [],
    release: { by_project: {} },
    updated_at: new Date().toISOString(),
  };
}

export function newDetailItemId(): string {
  return `cdi-${crypto.randomUUID()}`;
}

function stripApplyCell(cell: ItemApplyCell): Pick<ItemApplyCell, "status" | "comment"> {
  return { status: cell.status, comment: cell.comment };
}

function stripReleaseCell(cell: ProjectReleaseCell): Omit<ProjectReleaseCell, "field_updated_at"> {
  const { field_updated_at: _stamp, ...rest } = cell;
  return rest;
}

function stripItem(item: CycleDetailItem): Omit<CycleDetailItem, "field_updated_at"> & {
  applies: Record<string, Pick<ItemApplyCell, "status" | "comment">>;
} {
  const { field_updated_at: _stamp, applies, ...rest } = item;
  return {
    ...rest,
    applies: Object.fromEntries(
      Object.entries(applies).map(([pid, cell]) => [pid, stripApplyCell(cell)]),
    ),
  };
}

/** Content-only signature (ignores per-cell timestamps) for Unsaved draft detection. */
export function detailDocSignature(doc: Pick<CycleDetailDoc, "items" | "release">): string {
  return JSON.stringify({
    items: doc.items.map(stripItem),
    release: {
      by_project: Object.fromEntries(
        Object.entries(doc.release.by_project).map(([pid, cell]) => [pid, stripReleaseCell(cell)]),
      ),
    },
  });
}

export function nowStamp(): string {
  return new Date().toISOString();
}

function stampCmp(a: string | undefined, b: string | undefined): number {
  const as = (a ?? "").trim();
  const bs = (b ?? "").trim();
  if (as === bs) return 0;
  if (!as) return -1;
  if (!bs) return 1;
  return as < bs ? -1 : 1;
}

function pickByStamp<T>(
  local: T,
  remote: T,
  localStamp: string | undefined,
  remoteStamp: string | undefined,
): T {
  // Prefer newer; on equal/missing-both, prefer remote (already persisted).
  return stampCmp(localStamp, remoteStamp) > 0 ? local : remote;
}

function applyContentEqual(a: ItemApplyCell | undefined, b: ItemApplyCell | undefined): boolean {
  const aa = a ?? emptyApplyCell();
  const bb = b ?? emptyApplyCell();
  return aa.status === bb.status && aa.comment === bb.comment;
}

function releaseFieldValue(cell: ProjectReleaseCell | undefined, key: ReleaseFieldKey): string {
  if (!cell) return "";
  return String(cell[key] ?? "");
}

/**
 * Three-way merge for concurrent Save All — **細格子 (per-cell / per-field)**, NOT whole item.
 * - Item add/delete resolved against `baseline` (doc when editor opened / last clean save).
 * - Each matrix apply cell, each item scalar field, and each release-tracking field merges
 *   independently: if only one side changed vs baseline, take that side; if both changed,
 *   take the newer `updated_at` / field stamp (tie → prefer remote).
 * - Missing stamps treated as older than any real stamp (legacy rows lose to stamped edits).
 */
export function mergeCycleDetailDocs(args: {
  baseline: CycleDetailDoc;
  local: CycleDetailDoc;
  remote: CycleDetailDoc;
}): CycleDetailDoc {
  const { baseline, local, remote } = args;
  const baseById = new Map(baseline.items.map((it) => [it.id, it]));
  const localById = new Map(local.items.map((it) => [it.id, it]));
  const remoteById = new Map(remote.items.map((it) => [it.id, it]));
  const ids = new Set<string>([...baseById.keys(), ...localById.keys(), ...remoteById.keys()]);

  const mergedItems: CycleDetailItem[] = [];
  for (const id of ids) {
    const b = baseById.get(id);
    const l = localById.get(id);
    const r = remoteById.get(id);

    if (b && !l && !r) continue;
    if (b && !l && r) continue; // local deleted
    if (b && l && !r) continue; // remote deleted
    if (!b && l && !r) {
      mergedItems.push(l);
      continue;
    }
    if (!b && !l && r) {
      mergedItems.push(r);
      continue;
    }
    if (!b && l && r) {
      mergedItems.push(mergeItemFields(l, r, emptyItemSkeleton(l)));
      continue;
    }
    if (b && l && r) {
      mergedItems.push(mergeItemFields(l, r, b));
      continue;
    }
  }

  mergedItems.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));

  const projectIds = new Set<string>([
    ...Object.keys(baseline.release.by_project),
    ...Object.keys(local.release.by_project),
    ...Object.keys(remote.release.by_project),
  ]);
  const by_project: Record<string, ProjectReleaseCell> = {};
  for (const pid of projectIds) {
    by_project[pid] = mergeReleaseCell(
      baseline.release.by_project[pid],
      local.release.by_project[pid],
      remote.release.by_project[pid],
    );
  }

  return {
    cycle_id: local.cycle_id || remote.cycle_id || baseline.cycle_id,
    items: mergedItems,
    release: { by_project },
    updated_at: nowStamp(),
  };
}

function emptyItemSkeleton(from: CycleDetailItem): CycleDetailItem {
  return {
    id: from.id,
    ...(from.issue_id ? { issue_id: from.issue_id } : {}),
    title: "",
    detail: "",
    cycle_comment: "",
    applies: {},
    sort_order: from.sort_order,
  };
}

function mergeItemFields(
  local: CycleDetailItem,
  remote: CycleDetailItem,
  baseline: CycleDetailItem,
): CycleDetailItem {
  const pickField = <K extends "title" | "detail" | "cycle_comment">(key: K): string => {
    const lv = local[key];
    const rv = remote[key];
    const bv = baseline[key];
    if (lv === bv && rv === bv) return lv;
    if (lv === bv) return rv;
    if (rv === bv) return lv;
    return pickByStamp(
      lv,
      rv,
      local.field_updated_at?.[key],
      remote.field_updated_at?.[key],
    );
  };

  const title = pickField("title");
  const detail = pickField("detail");
  const cycle_comment = pickField("cycle_comment");

  let sort_order = local.sort_order;
  if (local.sort_order === baseline.sort_order && remote.sort_order !== baseline.sort_order) {
    sort_order = remote.sort_order;
  } else if (remote.sort_order === baseline.sort_order && local.sort_order !== baseline.sort_order) {
    sort_order = local.sort_order;
  } else if (local.sort_order !== baseline.sort_order && remote.sort_order !== baseline.sort_order) {
    sort_order =
      stampCmp(local.field_updated_at?.sort_order, remote.field_updated_at?.sort_order) > 0
        ? local.sort_order
        : remote.sort_order;
  }

  const field_updated_at: ItemFieldUpdatedAt = {
    title:
      title === local.title
        ? local.field_updated_at?.title ?? remote.field_updated_at?.title
        : remote.field_updated_at?.title ?? local.field_updated_at?.title,
    detail:
      detail === local.detail
        ? local.field_updated_at?.detail ?? remote.field_updated_at?.detail
        : remote.field_updated_at?.detail ?? local.field_updated_at?.detail,
    cycle_comment:
      cycle_comment === local.cycle_comment
        ? local.field_updated_at?.cycle_comment ?? remote.field_updated_at?.cycle_comment
        : remote.field_updated_at?.cycle_comment ?? local.field_updated_at?.cycle_comment,
    sort_order:
      sort_order === local.sort_order
        ? local.field_updated_at?.sort_order ?? remote.field_updated_at?.sort_order
        : remote.field_updated_at?.sort_order ?? local.field_updated_at?.sort_order,
  };

  const pids = new Set([
    ...Object.keys(baseline.applies),
    ...Object.keys(local.applies),
    ...Object.keys(remote.applies),
  ]);
  const applies: Record<string, ItemApplyCell> = {};
  for (const pid of pids) {
    const bc = baseline.applies[pid];
    const lc = local.applies[pid];
    const rc = remote.applies[pid];
    if (applyContentEqual(lc, bc) && applyContentEqual(rc, bc)) {
      applies[pid] = normalizeApplyCell(lc ?? rc ?? bc ?? emptyApplyCell());
      continue;
    }
    if (applyContentEqual(lc, bc) && !applyContentEqual(rc, bc)) {
      applies[pid] = normalizeApplyCell(rc ?? emptyApplyCell());
      continue;
    }
    if (applyContentEqual(rc, bc) && !applyContentEqual(lc, bc)) {
      applies[pid] = normalizeApplyCell(lc ?? emptyApplyCell());
      continue;
    }
    // Both changed (or no baseline): newer stamp wins.
    const chosen = pickByStamp(
      lc ?? emptyApplyCell(),
      rc ?? emptyApplyCell(),
      lc?.updated_at,
      rc?.updated_at,
    );
    applies[pid] = normalizeApplyCell(chosen);
  }

  const issue_id = local.issue_id || remote.issue_id || baseline.issue_id;
  return {
    id: local.id,
    ...(issue_id ? { issue_id } : {}),
    title,
    detail,
    cycle_comment,
    applies,
    sort_order,
    field_updated_at,
  };
}

function mergeReleaseCell(
  baseline: ProjectReleaseCell | undefined,
  local: ProjectReleaseCell | undefined,
  remote: ProjectReleaseCell | undefined,
): ProjectReleaseCell {
  const keys = new Set<ReleaseFieldKey>([
    ...RELEASE_TRACKING_ROWS.map((r) => r.key),
    "ecr_url",
  ]);
  const out: ProjectReleaseCell = {};
  const stamps: Partial<Record<ReleaseFieldKey, string>> = {};
  for (const key of keys) {
    const bv = releaseFieldValue(baseline, key);
    const lv = releaseFieldValue(local, key);
    const rv = releaseFieldValue(remote, key);
    let chosen = lv;
    let stamp = local?.field_updated_at?.[key] ?? remote?.field_updated_at?.[key];
    if (lv === bv && rv === bv) {
      chosen = lv;
    } else if (lv === bv) {
      chosen = rv;
      stamp = remote?.field_updated_at?.[key] ?? stamp;
    } else if (rv === bv) {
      chosen = lv;
      stamp = local?.field_updated_at?.[key] ?? stamp;
    } else {
      chosen = pickByStamp(lv, rv, local?.field_updated_at?.[key], remote?.field_updated_at?.[key]);
      stamp =
        chosen === lv
          ? local?.field_updated_at?.[key] ?? remote?.field_updated_at?.[key]
          : remote?.field_updated_at?.[key] ?? local?.field_updated_at?.[key];
    }
    if (chosen) {
      if (key === "ecr_url") out.ecr_url = chosen;
      else out[key] = chosen;
    }
    if (stamp) stamps[key] = stamp;
  }
  if (Object.keys(stamps).length > 0) out.field_updated_at = stamps;
  return out;
}

/** Backfill missing per-cell stamps from document `updated_at` (legacy rows). */
export function ensureDetailTimestamps(doc: CycleDetailDoc): CycleDetailDoc {
  const fallback = doc.updated_at || nowStamp();
  return {
    ...doc,
    items: doc.items.map((item, i) => normalizeCycleDetailItem(item, i, fallback)),
    release: {
      by_project: Object.fromEntries(
        Object.entries(doc.release.by_project).map(([pid, cell]) => {
          const normalized = normalizeProjectReleaseCell(cell);
          const stamps = { ...(normalized.field_updated_at ?? {}) };
          for (const row of RELEASE_TRACKING_ROWS) {
            if ((normalized[row.key] ?? "") !== "" && !stamps[row.key]) stamps[row.key] = fallback;
          }
          if ((normalized.ecr_url ?? "") !== "" && !stamps.ecr_url) stamps.ecr_url = fallback;
          return [
            pid,
            Object.keys(stamps).length > 0
              ? { ...normalized, field_updated_at: stamps }
              : normalized,
          ];
        }),
      ),
    },
  };
}

/** Treat release dropdown as Done (exact match; Ongoing/Blocked/N/A/empty are not). */
export function isReleaseDone(value: string | undefined | null): boolean {
  return String(value ?? "").trim() === "Done";
}

/** DQA Test Complete value that drives the Issue Clarification chip / row Status. */
export function isReleaseTestComplete(value: string | undefined | null): boolean {
  return String(value ?? "").trim() === "Test Complete";
}

/**
 * Derive Project roster Status from Project Release Tracking for one project.
 * Milestone fields (UI labels): Internal Release, SA BVT Test, DQA Test Complete, Sign off.
 *
 * Row Status is exclusive (one label per project). Overview chips use independent
 * milestone counts via `cycleMetrics` and may overlap:
 * Internal / SA BVT / Issue Clarification (`Test Complete`) / Test Pass (`Done`) /
 * Completed (DQA Done AND Sign off Done).
 *
 * Priority (highest first) — same five labels as overview chips, plus Not Started:
 * 1. DQA Test Complete = Done AND Sign off = Done → Completed
 * 2. DQA Test Complete = Done (Sign off not Done) → Test Pass
 * 3. DQA Test Complete = Test Complete → Issue Clarification
 * 4. SA BVT Test Done → SA BVT
 * 5. Internal Release Done → Internal release
 * 6. Else → Not Started
 */
export function deriveRosterStatusFromRelease(
  cell: ProjectReleaseCell | undefined | null,
):
  | "Not Started"
  | "Internal release"
  | "SA BVT"
  | "Issue Clarification"
  | "Test Pass"
  | "Completed" {
  const ir = isReleaseDone(cell?.internal_release);
  const sa = isReleaseDone(cell?.sa_bvt_test);
  const dqaDone = isReleaseDone(cell?.external_release_web);
  const dqaTestComplete = isReleaseTestComplete(cell?.external_release_web);
  const signOff = isReleaseDone(cell?.external_release_wu);

  if (dqaDone && signOff) return "Completed";
  if (dqaDone) return "Test Pass";
  if (dqaTestComplete) return "Issue Clarification";
  if (sa) return "SA BVT";
  if (ir) return "Internal release";
  return "Not Started";
}
