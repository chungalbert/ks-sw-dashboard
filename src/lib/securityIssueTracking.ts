import ExcelJS from "exceljs";

/** Spreadsheet columns matching the Compal Issue Tracking template.
 * Status is first (before Task) on per-project + 總表 UI. */
export const ISSUE_TRACKING_FIELDS = [
  "status",
  "task",
  "issue_date",
  "no",
  "defect_id",
  "title",
  "fr",
  "fail_unit",
  "condition_text",
  "steps_recover",
  "observed_symptom",
  "dqa_owner",
  "dqa_verify_data",
  "dqa_comments",
  "pm",
  "rd_owner",
  "rd_comments",
  "conclusion",
] as const;

export type IssueTrackingField = (typeof ISSUE_TRACKING_FIELDS)[number];

/** Excel / UI header labels (order matches ISSUE_TRACKING_FIELDS). */
export const ISSUE_TRACKING_LABELS: Record<IssueTrackingField, string> = {
  status: "Status",
  task: "Task",
  issue_date: "Date",
  no: "No",
  defect_id: "Defect ID",
  title: "Title",
  fr: "F/R",
  fail_unit: "Fail Unit",
  condition_text: "Condition",
  steps_recover: "Steps & How to recover",
  observed_symptom: "Observed symptom",
  dqa_owner: "DQA Owner",
  dqa_verify_data: "DQA Verify Data",
  dqa_comments: "DQA Comments",
  pm: "PM",
  rd_owner: "RD Owner",
  rd_comments: "RD Comments",
  conclusion: "Conclusion",
};

/**
 * Canonical Issue Tracking Status values shown in the 總表 / per-project select.
 * Cover/report PASS → PASS; Albert marks Fail / Fixed / Cancelled.
 */
export const ISSUE_TRACKING_STATUS_OPTIONS = [
  "",
  "Fail",
  "Fixed",
  "PASS",
  "Cancelled",
] as const;

export type IssueTrackingStatusOption = (typeof ISSUE_TRACKING_STATUS_OPTIONS)[number];

/** Normalize free-text / casing variants to a canonical option (or trimmed original). */
export function normalizeIssueTrackingStatus(raw: unknown): string {
  if (raw == null) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  const key = trimmed.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (key === "pass" || key === "passed" || key === "ok") return "PASS";
  if (key === "fail" || key === "failed" || key === "failure") return "Fail";
  if (key === "fixed" || key === "fix" || key === "resolved") return "Fixed";
  if (key === "cancelled" || key === "canceled" || key === "cancel") return "Cancelled";
  return trimmed;
}

/** Select options = canonical list + current value when it is a custom leftover. */
export function issueTrackingStatusOptionsFor(value: string): string[] {
  const normalized = normalizeIssueTrackingStatus(value);
  return Array.from(new Set([...ISSUE_TRACKING_STATUS_OPTIONS, normalized]));
}

/** RD block — visually distinct (orange) in UI / template. */
export const ISSUE_TRACKING_RD_FIELDS: IssueTrackingField[] = [
  "rd_owner",
  "rd_comments",
  "conclusion",
];

export type SecurityIssueTrackingRow = {
  id: string;
  cycle_id: string;
  roster_id: string;
  project_id: string;
  project_name: string;
  status: string;
  task: string;
  issue_date: string;
  no: string;
  defect_id: string;
  title: string;
  fr: string;
  fail_unit: string;
  condition_text: string;
  steps_recover: string;
  observed_symptom: string;
  dqa_owner: string;
  dqa_verify_data: string;
  dqa_comments: string;
  pm: string;
  rd_owner: string;
  rd_comments: string;
  conclusion: string;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
};

export type SecurityIssueTrackingInput = Partial<
  Pick<SecurityIssueTrackingRow, IssueTrackingField>
> & {
  cycle_id: string;
  roster_id: string;
  project_id?: string;
  project_name?: string;
  sort_order?: number;
};

export type IssueTrackingBulkError = {
  row: number;
  reason: string;
  defect_id?: string;
  title?: string;
};

export type IssueTrackingBulkParseResult = {
  valid: Array<{ row: number; fields: Record<IssueTrackingField, string> }>;
  errors: IssueTrackingBulkError[];
};

export type IssueTrackingBulkImportResult = {
  created: Array<{ row: number; defect_id: string; title: string }>;
  errors: IssueTrackingBulkError[];
  attempted: number;
};

const HEADER_ALIASES: Record<string, IssueTrackingField> = {
  status: "status",
  task: "task",
  date: "issue_date",
  issue_date: "issue_date",
  no: "no",
  number: "no",
  defect_id: "defect_id",
  defectid: "defect_id",
  defect: "defect_id",
  title: "title",
  "f/r": "fr",
  fr: "fr",
  fail_rate: "fr",
  fail_unit: "fail_unit",
  failunit: "fail_unit",
  condition: "condition_text",
  condition_text: "condition_text",
  steps: "steps_recover",
  steps_recover: "steps_recover",
  "steps_&_how_to_recover": "steps_recover",
  steps_how_to_recover: "steps_recover",
  observed_symptom: "observed_symptom",
  observed: "observed_symptom",
  symptom: "observed_symptom",
  dqa_owner: "dqa_owner",
  dqaowner: "dqa_owner",
  dqa_verify_data: "dqa_verify_data",
  dqa_verify: "dqa_verify_data",
  dqa_comments: "dqa_comments",
  dqacomments: "dqa_comments",
  pm: "pm",
  rd_owner: "rd_owner",
  rdowner: "rd_owner",
  rd_comments: "rd_comments",
  rdcomments: "rd_comments",
  conclusion: "conclusion",
};

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (value instanceof Date) {
    const m = value.getMonth() + 1;
    const d = value.getDate();
    const y = value.getFullYear();
    return `${m}/${d}/${y}`;
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

function normalizeHeader(raw: string): IssueTrackingField | null {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[&]/g, " ")
    .replace(/[\s-]+/g, "_")
    .replace(/_+/g, "_");
  return HEADER_ALIASES[key] ?? null;
}

function emptyFields(): Record<IssueTrackingField, string> {
  return Object.fromEntries(ISSUE_TRACKING_FIELDS.map((f) => [f, ""])) as Record<
    IssueTrackingField,
    string
  >;
}

function isBlank(fields: Record<IssueTrackingField, string>): boolean {
  return ISSUE_TRACKING_FIELDS.every((f) => !fields[f]);
}

/** Sample Excel with blue DQA headers + orange RD headers. */
export async function buildIssueTrackingTemplate(
  meta?: { project_name?: string; cycle_name?: string },
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "KSSW";
  const sheet = wb.addWorksheet("Issue Tracking", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  ISSUE_TRACKING_FIELDS.forEach((field, i) => {
    const col = i + 1;
    const cell = sheet.getCell(1, col);
    cell.value = ISSUE_TRACKING_LABELS[field];
    cell.font = { bold: true, color: { argb: "FF1F2937" } };
    const isRd = ISSUE_TRACKING_RD_FIELDS.includes(field);
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: isRd ? "FFF4B183" : "FFBDD7EE" },
    };
    sheet.getColumn(col).width = field === "steps_recover" || field === "condition_text" ? 36 : 16;
  });

  // Example row (same spirit as the screenshot template)
  const example = emptyFields();
  example.task = "stress_MS";
  example.issue_date = "9/18/2026";
  example.no = "P01";
  example.defect_id = "XXXXXX";
  example.title = "system show Bsod:0xEF w/o dump file when run MS.";
  example.fr = "1/24u, 1/5,000c";
  example.fail_unit = "7-1#08";
  example.condition_text = "OS:Windows 11 24H2\nBIOS:EC:R6CN30WW:R6CET30W\nImage:Preload R6CETA0W";
  example.steps_recover =
    "1. Power on unit into Windows.\n2. Follow test case to run MS.\n3. Check system behavior.";
  example.observed_symptom = "system show Bsod:0xEF w/o dump file when run MS.";
  example.dqa_owner = "vera_xu";
  example.rd_owner = "irene_li;jane_cao";
  ISSUE_TRACKING_FIELDS.forEach((field, i) => {
    sheet.getCell(2, i + 1).value = example[field];
  });

  const help = wb.addWorksheet("Instructions");
  help.getColumn(1).width = 96;
  const lines = [
    "KSSW Security — Issue Tracking Excel",
    meta?.project_name ? `Project: ${meta.project_name}` : "",
    meta?.cycle_name ? `Cycle: ${meta.cycle_name}` : "",
    "",
    "1. Keep header row labels (Status, Task, Date, No, Defect ID, …). Aliases accepted on import.",
    "2. Status is optional (Fail / Fixed / PASS / Cancelled / blank). Cover/report PASS sets Status=PASS but never drops prior rows.",
    "3. Required for each data row: Defect ID and Title.",
    "4. Existing Defect ID on this project is NOT overwritten — that row is reported as an error and skipped.",
    "5. Duplicate Defect ID inside the file → later row(s) error.",
    "6. Blank rows are ignored. Partial success: valid rows create; failed rows listed.",
    "7. RD Owner / RD Comments / Conclusion headers are orange in the sample (visually distinct).",
    "8. Delete the sample row before upload unless you intend to create Defect ID XXXXXX.",
  ].filter(Boolean);
  lines.forEach((text, i) => {
    help.getCell(i + 1, 1).value = text;
  });

  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

export async function loadIssueTrackingWorkbook(file: ArrayBuffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file);
  return wb;
}

/**
 * Parse Issue Tracking workbook. `existingDefectIds` = Defect IDs already on this roster
 * (lowercase). Never treats existing IDs as updates — they become row errors.
 */
export function parseIssueTrackingWorkbook(
  workbook: ExcelJS.Workbook,
  existingDefectIds: Set<string>,
): IssueTrackingBulkParseResult {
  const sheet =
    workbook.getWorksheet("Issue Tracking") ??
    workbook.worksheets.find((s) => s.name.toLowerCase() !== "instructions") ??
    workbook.worksheets[0];
  if (!sheet) {
    return { valid: [], errors: [{ row: 0, reason: "Workbook has no sheets" }] };
  }

  const headerCells = sheet.getRow(1).values;
  const colMap = new Map<number, IssueTrackingField>();
  if (Array.isArray(headerCells)) {
    headerCells.forEach((raw, col) => {
      if (col === 0) return;
      const mapped = normalizeHeader(cellText(raw as ExcelJS.CellValue));
      if (mapped) colMap.set(col, mapped);
    });
  }
  if (![...colMap.values()].includes("defect_id") || ![...colMap.values()].includes("title")) {
    return {
      valid: [],
      errors: [
        {
          row: 1,
          reason: "Missing required headers Defect ID and/or Title. Download the sample template.",
        },
      ],
    };
  }

  const seen = new Set<string>();
  const valid: IssueTrackingBulkParseResult["valid"] = [];
  const errors: IssueTrackingBulkError[] = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const fields = emptyFields();
    colMap.forEach((header, col) => {
      fields[header] = cellText(row.getCell(col).value);
    });
    fields.status = normalizeIssueTrackingStatus(fields.status);
    if (isBlank(fields)) return;

    const defect = fields.defect_id.trim();
    const title = fields.title.trim();
    if (!defect) {
      errors.push({
        row: rowNumber,
        title: title || undefined,
        reason: "Missing required field: Defect ID",
      });
      return;
    }
    if (!title) {
      errors.push({
        row: rowNumber,
        defect_id: defect,
        reason: "Missing required field: Title",
      });
      return;
    }
    const key = defect.toLowerCase();
    if (existingDefectIds.has(key)) {
      errors.push({
        row: rowNumber,
        defect_id: defect,
        title,
        reason: `Defect ID “${defect}” already exists on this project — skipped (no overwrite)`,
      });
      return;
    }
    if (seen.has(key)) {
      errors.push({
        row: rowNumber,
        defect_id: defect,
        title,
        reason: `Duplicate Defect ID “${defect}” in this file — skipped`,
      });
      return;
    }
    seen.add(key);
    valid.push({ row: rowNumber, fields });
  });

  return { valid, errors };
}
