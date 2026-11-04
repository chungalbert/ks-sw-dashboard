import ExcelJS from "exceljs";
import {
  WORK_LOG_TYPES,
  type Profile,
  type Project,
  type WorkLogEntry,
  type WorkLogEntryPatch,
  type WorkLogType,
} from "./types";

/** Canonical template headers (row 1) — match Work Log UI columns. */
export const WORK_LOG_BULK_HEADERS = [
  "entry_date",
  "entry_type",
  "project_name",
  "product_name",
  "content",
  "owner",
  "done",
] as const;

export type WorkLogBulkHeader = (typeof WORK_LOG_BULK_HEADERS)[number];

export const WORK_LOG_BULK_LABELS: Record<WorkLogBulkHeader, string> = {
  entry_date: "Date",
  entry_type: "Type",
  project_name: "Project",
  product_name: "Product Name",
  content: "內容",
  owner: "Owner",
  done: "完成 CheckPoint",
};

const HEADER_ALIASES: Record<string, WorkLogBulkHeader> = {
  entry_date: "entry_date",
  date: "entry_date",
  日期: "entry_date",
  entry_type: "entry_type",
  type: "entry_type",
  類型: "entry_type",
  project_name: "project_name",
  project: "project_name",
  compal_project_name: "project_name",
  專案: "project_name",
  product_name: "product_name",
  product: "product_name",
  lenovo_name: "product_name",
  lenovo_project_name: "product_name",
  產品: "product_name",
  content: "content",
  內容: "content",
  description: "content",
  owner: "owner",
  owner_name: "owner",
  owner_id: "owner",
  負責人: "owner",
  done: "done",
  checkpoint: "done",
  完成: "done",
  完成_checkpoint: "done",
  完成checkpoint: "done",
};

export type WorkLogBulkRowError = {
  row: number;
  reason: string;
  entry_date?: string;
  project_name?: string;
  content?: string;
};

export type WorkLogBulkParsedRow = {
  row: number;
  patch: WorkLogEntryPatch;
  /** Fingerprint for duplicate detection (existing + in-file). */
  fingerprint: string;
};

export type WorkLogBulkParseResult = {
  valid: WorkLogBulkParsedRow[];
  errors: WorkLogBulkRowError[];
};

export type WorkLogBulkCreateResult = {
  created: Array<{ row: number; id: string; entry_date: string; content: string }>;
  errors: WorkLogBulkRowError[];
  attempted: number;
};

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (value instanceof Date) {
    return formatIsoDate(value);
  }
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("result" in value && value.result != null) return cellText(value.result as ExcelJS.CellValue);
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((p) => p.text ?? "").join("").trim();
    }
  }
  return String(value).trim();
}

function formatIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Normalize Excel / typed dates to `YYYY-MM-DD`. */
export function normalizeWorkLogDate(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  // Excel serial (days since 1899-12-30) when cell was read as number→string
  if (/^\d+(\.\d+)?$/.test(t)) {
    const serial = Number(t);
    if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      epoch.setUTCDate(epoch.getUTCDate() + Math.floor(serial));
      return formatIsoDate(
        new Date(epoch.getUTCFullYear(), epoch.getUTCMonth(), epoch.getUTCDate()),
      );
    }
  }
  const mdy = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (mdy) {
    const a = Number(mdy[1]);
    const b = Number(mdy[2]);
    const y = Number(mdy[3]);
    // Prefer M/D/Y when first > 12; else assume M/D/Y (US sheet style)
    let month: number;
    let day: number;
    if (a > 12) {
      day = a;
      month = b;
    } else {
      month = a;
      day = b;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const parsed = new Date(t);
  if (!Number.isNaN(parsed.getTime())) return formatIsoDate(parsed);
  return null;
}

function normalizeHeader(raw: string): WorkLogBulkHeader | null {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[&／]/g, " ")
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
  if (key === "完成_checkpoint" || key === "完成checkpoint" || key.includes("checkpoint")) {
    if (key.includes("完成") || key === "checkpoint" || key === "done") return "done";
  }
  return HEADER_ALIASES[key] ?? (key === "完成" ? "done" : null);
}

function normalizeType(raw: string): WorkLogType | "" | null {
  const t = raw.trim();
  if (!t) return "";
  const hit = WORK_LOG_TYPES.find((x) => x.toLowerCase() === t.toLowerCase());
  return hit ?? null;
}

function parseDone(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (!t) return false;
  return ["1", "true", "yes", "y", "v", "x", "done", "完成", "ok", "check", "checked"].includes(t);
}

function isBlankRow(cells: Record<WorkLogBulkHeader, string>): boolean {
  return WORK_LOG_BULK_HEADERS.every((h) => !cells[h]);
}

/** Stable key: Date + Type + Project + 內容 + Owner — never overwrite matches. */
export function workLogConflictFingerprint(input: {
  entry_date: string;
  entry_type: string;
  project_name: string;
  content: string;
  owner_id: string | null;
}): string {
  return [
    input.entry_date.trim().toLowerCase(),
    input.entry_type.trim().toLowerCase(),
    input.project_name.trim().toLowerCase(),
    input.content.trim().toLowerCase(),
    (input.owner_id ?? "").trim().toLowerCase(),
  ].join("\u0001");
}

export function fingerprintFromEntry(entry: WorkLogEntry): string {
  return workLogConflictFingerprint({
    entry_date: entry.entry_date,
    entry_type: entry.entry_type,
    project_name: entry.project_name,
    content: entry.content,
    owner_id: entry.owner_id,
  });
}

function resolveOwner(raw: string, profiles: Profile[]): { id: string } | { error: string } | null {
  const t = raw.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const byDisplay = profiles.find((p) => p.display_name.trim().toLowerCase() === lower);
  if (byDisplay) return { id: byDisplay.id };
  const byUser = profiles.find((p) => (p.username ?? "").trim().toLowerCase() === lower);
  if (byUser) return { id: byUser.id };
  const byEmail = profiles.find((p) => (p.email ?? "").trim().toLowerCase() === lower);
  if (byEmail) return { id: byEmail.id };
  return { error: `Owner “${t}” not found in Personnel` };
}

function resolveProject(
  raw: string,
  projects: Project[],
): { id: string; name: string; product_name: string } | { error: string } | null {
  const t = raw.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const byCompal = projects.find((p) => p.name.trim().toLowerCase() === lower);
  if (byCompal) {
    return {
      id: byCompal.id,
      name: byCompal.name,
      product_name: byCompal.lenovo_name ?? "",
    };
  }
  const byLenovo = projects.find((p) => (p.lenovo_name ?? "").trim().toLowerCase() === lower);
  if (byLenovo) {
    return {
      id: byLenovo.id,
      name: byLenovo.name,
      product_name: byLenovo.lenovo_name ?? "",
    };
  }
  return { error: `Project “${t}” not found` };
}

function ownerLabel(ownerId: string | null, profiles: Profile[]): string {
  if (!ownerId) return "";
  const p = profiles.find((x) => x.id === ownerId);
  return p ? p.display_name || p.username || "" : "";
}

/** Flat row values matching visible Work Log columns (no Actions). */
export function workLogExportCells(
  entry: WorkLogEntry,
  profiles: Profile[],
): Record<WorkLogBulkHeader, string> {
  return {
    entry_date: entry.entry_date ?? "",
    entry_type: entry.entry_type ?? "",
    project_name: entry.project_name ?? "",
    product_name: entry.product_name ?? "",
    content: entry.content ?? "",
    owner: ownerLabel(entry.owner_id, profiles),
    done: entry.done ? "TRUE" : "FALSE",
  };
}

/** Download the currently visible table as .xlsx (same headers as UI / sample). */
export async function buildWorkLogExportXlsx(
  entries: WorkLogEntry[],
  profiles: Profile[],
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "KSSW";
  wb.created = new Date();

  const sheet = wb.addWorksheet("Work Log", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  WORK_LOG_BULK_HEADERS.forEach((h, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = WORK_LOG_BULK_LABELS[h];
    cell.font = { bold: true };
    sheet.getColumn(i + 1).width = h === "content" ? 36 : h === "product_name" ? 22 : 16;
  });

  entries.forEach((entry, idx) => {
    const cells = workLogExportCells(entry, profiles);
    WORK_LOG_BULK_HEADERS.forEach((h, i) => {
      sheet.getCell(idx + 2, i + 1).value = cells[h];
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

/** CSV twin of {@link buildWorkLogExportXlsx} — same visible columns. */
export function buildWorkLogExportCsv(entries: WorkLogEntry[], profiles: Profile[]): string {
  const escape = (v: string) => {
    if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const lines = [
    WORK_LOG_BULK_HEADERS.map((h) => escape(WORK_LOG_BULK_LABELS[h])).join(","),
    ...entries.map((entry) => {
      const cells = workLogExportCells(entry, profiles);
      return WORK_LOG_BULK_HEADERS.map((h) => escape(cells[h])).join(",");
    }),
  ];
  return `\uFEFF${lines.join("\r\n")}`;
}

export async function buildWorkLogBulkTemplate(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "KSSW";
  wb.created = new Date();

  const sheet = wb.addWorksheet("Work Log", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  WORK_LOG_BULK_HEADERS.forEach((h, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = WORK_LOG_BULK_LABELS[h];
    cell.font = { bold: true };
    sheet.getColumn(i + 1).width = h === "content" ? 36 : h === "product_name" ? 22 : 16;
  });

  const sample: Record<WorkLogBulkHeader, string> = {
    entry_date: "2026-11-04",
    entry_type: "PCR",
    project_name: "SAMPLE11 N-1",
    product_name: "Sample Lenovo",
    content: "Sample Work Log row — delete or change before upload",
    owner: "",
    done: "FALSE",
  };
  WORK_LOG_BULK_HEADERS.forEach((h, i) => {
    sheet.getCell(2, i + 1).value = sample[h];
  });

  for (let r = 2; r <= 200; r++) {
    sheet.getCell(r, 2).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [`"${WORK_LOG_TYPES.join(",")}"`],
      showErrorMessage: true,
      errorTitle: "Invalid Type",
      error: `Use one of: ${WORK_LOG_TYPES.join(", ")}`,
    };
    sheet.getCell(r, 7).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"TRUE,FALSE"'],
      showErrorMessage: true,
      errorTitle: "Invalid 完成 CheckPoint",
      error: "Use TRUE or FALSE",
    };
  }

  const help = wb.addWorksheet("Instructions");
  help.getColumn(1).width = 96;
  const lines = [
    "KSSW Work Log — bulk create (Admin / DM / DL / DE)",
    "",
    "1. Fill the Work Log sheet. Headers: Date / Type / Project / Product Name / 內容 / Owner / 完成 CheckPoint.",
    "2. Required: Date and 內容.",
    "3. Type must be one of: " + WORK_LOG_TYPES.join(", ") + " (or blank).",
    "4. Project must match an existing Compal (or Lenovo) project name when set; Product Name is filled from the project when matched.",
    "5. Owner must match Personnel display name, username, or email when set.",
    "6. 完成 CheckPoint: TRUE / FALSE (also yes/no/1/0).",
    "7. Duplicate rows (same Date + Type + Project + 內容 + Owner) vs Neon or inside this file are NOT overwritten — reported as errors and skipped.",
    "8. Partial success: valid rows create; failed rows listed.",
    "9. Delete the sample row before upload unless that fingerprint is free.",
  ];
  lines.forEach((text, i) => {
    help.getCell(i + 1, 1).value = text;
  });

  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

export async function loadWorkLogBulkWorkbook(file: ArrayBuffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file);
  return wb;
}

export function parseWorkLogBulkWorkbook(
  workbook: ExcelJS.Workbook,
  existing: WorkLogEntry[],
  projects: Project[],
  profiles: Profile[],
): WorkLogBulkParseResult {
  const sheet =
    workbook.getWorksheet("Work Log") ??
    workbook.worksheets.find((s) => s.name.toLowerCase() !== "instructions") ??
    workbook.worksheets[0];
  if (!sheet) {
    return { valid: [], errors: [{ row: 0, reason: "Workbook has no sheets" }] };
  }

  const headerCells = sheet.getRow(1).values;
  const colMap = new Map<number, WorkLogBulkHeader>();
  if (Array.isArray(headerCells)) {
    headerCells.forEach((raw, col) => {
      if (col === 0) return;
      const mapped = normalizeHeader(cellText(raw as ExcelJS.CellValue));
      if (mapped) colMap.set(col, mapped);
    });
  }

  const haveDate = [...colMap.values()].includes("entry_date");
  const haveContent = [...colMap.values()].includes("content");
  if (!haveDate || !haveContent || colMap.size === 0) {
    const missing = [
      !haveDate ? "Date" : null,
      !haveContent ? "內容" : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      valid: [],
      errors: [
        {
          row: 1,
          reason: `Missing required header(s): ${missing || "Date, 內容"}. Download the sample template.`,
        },
      ],
    };
  }

  const existingFp = new Set(existing.map(fingerprintFromEntry));
  const seenFp = new Set<string>();
  const valid: WorkLogBulkParsedRow[] = [];
  const errors: WorkLogBulkRowError[] = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells = Object.fromEntries(WORK_LOG_BULK_HEADERS.map((h) => [h, ""])) as Record<
      WorkLogBulkHeader,
      string
    >;
    colMap.forEach((header, col) => {
      const cell = row.getCell(col);
      // Prefer native Date for the Date column so Excel serials stay correct.
      if (header === "entry_date" && cell.value instanceof Date) {
        cells[header] = formatIsoDate(cell.value);
      } else {
        cells[header] = cellText(cell.value);
      }
    });
    if (isBlankRow(cells)) return;

    const base: Omit<WorkLogBulkRowError, "reason"> = {
      row: rowNumber,
      entry_date: cells.entry_date || undefined,
      project_name: cells.project_name || undefined,
      content: cells.content || undefined,
    };

    if (!cells.entry_date.trim()) {
      errors.push({ ...base, reason: "Missing required field: Date" });
      return;
    }
    const entry_date = normalizeWorkLogDate(cells.entry_date);
    if (!entry_date) {
      errors.push({ ...base, reason: `Invalid Date “${cells.entry_date}” — use YYYY-MM-DD` });
      return;
    }

    if (!cells.content.trim()) {
      errors.push({ ...base, reason: "Missing required field: 內容" });
      return;
    }

    const entry_type = normalizeType(cells.entry_type);
    if (entry_type === null) {
      errors.push({
        ...base,
        reason: `Invalid Type “${cells.entry_type}” — use ${WORK_LOG_TYPES.join(", ")}`,
      });
      return;
    }

    let project_id: string | null = null;
    let project_name = "";
    let product_name = cells.product_name.trim();

    if (cells.project_name.trim()) {
      const resolved = resolveProject(cells.project_name, projects);
      if (resolved && "error" in resolved) {
        errors.push({ ...base, reason: resolved.error });
        return;
      }
      if (resolved) {
        project_id = resolved.id;
        project_name = resolved.name;
        product_name = resolved.product_name || product_name;
      }
    }

    let owner_id: string | null = null;
    if (cells.owner.trim()) {
      const resolved = resolveOwner(cells.owner, profiles);
      if (resolved && "error" in resolved) {
        errors.push({ ...base, reason: resolved.error });
        return;
      }
      if (resolved) owner_id = resolved.id;
    }

    const done = parseDone(cells.done);
    const content = cells.content.trim();
    const fingerprint = workLogConflictFingerprint({
      entry_date,
      entry_type,
      project_name,
      content,
      owner_id,
    });

    if (existingFp.has(fingerprint)) {
      errors.push({
        ...base,
        entry_date,
        project_name: project_name || undefined,
        content,
        reason:
          "Matching Work Log row already exists (Date + Type + Project + 內容 + Owner) — skipped (no overwrite)",
      });
      return;
    }
    if (seenFp.has(fingerprint)) {
      errors.push({
        ...base,
        entry_date,
        project_name: project_name || undefined,
        content,
        reason: "Duplicate row in this file (same Date + Type + Project + 內容 + Owner) — skipped",
      });
      return;
    }
    seenFp.add(fingerprint);

    valid.push({
      row: rowNumber,
      fingerprint,
      patch: {
        entry_date,
        entry_type,
        project_id,
        project_name,
        product_name,
        content,
        owner_id,
        done,
      },
    });
  });

  return { valid, errors };
}
