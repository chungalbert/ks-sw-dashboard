/** Cycle detail matrix (security items × projects) + project release tracking. */

export type ItemApplyStatus = "Applied" | "Not Applied" | "Not Applicable" | "";

/** Per-project cell under a security update item. */
export type ItemApplyCell = {
  status: ItemApplyStatus;
  comment: string;
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
  /** Renamed from External Release - JY */
  { key: "external_release_web", label: "External Release - Web", kind: "status" },
  { key: "external_release_wu", label: "External Release - WU", kind: "status" },
] as const;

export type ReleaseTrackingKey = (typeof RELEASE_TRACKING_ROWS)[number]["key"];

/** Per-project release fields; `ecr_url` pairs with `ecr_number`. */
export type ProjectReleaseCell = Partial<Record<ReleaseTrackingKey, string>> & {
  ecr_url?: string;
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
  return (
    err instanceof CycleDetailConflictError ||
    (Boolean(err) &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === "CYCLE_DETAIL_CONFLICT" &&
      (err as { current?: unknown }).current != null)
  );
}

/** Dropdown options (AIOSW). Empty = unset / —. */
export const APPLY_STATUSES: ItemApplyStatus[] = [
  "",
  "Applied",
  "Not Applied",
  "Not Applicable",
];

export const RELEASE_STATUS_OPTIONS = ["", "Ongoing", "Done", "Blocked", "N/A"] as const;

export function emptyApplyCell(): ItemApplyCell {
  return { status: "", comment: "" };
}

export function normalizeApplyStatus(raw: unknown): ItemApplyStatus {
  const s = String(raw ?? "");
  if (s === "Applied" || s === "Not Applied" || s === "Not Applicable") return s;
  return "";
}

/** Accept legacy string status or `{ status, comment }`. */
export function normalizeApplyCell(raw: unknown): ItemApplyCell {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    return {
      status: normalizeApplyStatus(o.status ?? o.value ?? ""),
      comment: String(o.comment ?? ""),
    };
  }
  return { status: normalizeApplyStatus(raw), comment: "" };
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

export function detailDocSignature(doc: Pick<CycleDetailDoc, "items" | "release">): string {
  return JSON.stringify({ items: doc.items, release: doc.release });
}

/** Treat release dropdown as Done (exact match; Ongoing/Blocked/N/A/empty are not). */
export function isReleaseDone(value: string | undefined | null): boolean {
  return String(value ?? "").trim() === "Done";
}

/**
 * Derive Project roster Status from Project Release Tracking for one project.
 * Priority (highest first):
 * 1. Internal + SA BVT + External Web + External WU all Done → Completed
 * 2. Internal + SA BVT Done → SA BVT
 * 3. Internal Done → Internal release
 * 4. Else → Not Started
 */
export function deriveRosterStatusFromRelease(
  cell: ProjectReleaseCell | undefined | null,
): "Not Started" | "Internal release" | "SA BVT" | "Completed" {
  const ir = isReleaseDone(cell?.internal_release);
  const sa = isReleaseDone(cell?.sa_bvt_test);
  const web = isReleaseDone(cell?.external_release_web);
  const wu = isReleaseDone(cell?.external_release_wu);
  if (ir && sa && web && wu) return "Completed";
  if (ir && sa) return "SA BVT";
  if (ir) return "Internal release";
  return "Not Started";
}
