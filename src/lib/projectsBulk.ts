import ExcelJS from "exceljs";
import { PROJECT_COLUMNS_META_NAME } from "./cloudApi";
import type { ProjectFieldPatch } from "./projectsUiStore";
import type { Project } from "./types";

/** Canonical template headers (row 1). */
export const PROJECT_BULK_HEADERS = [
  "name",
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
  "description",
] as const;

export type ProjectBulkHeader = (typeof PROJECT_BULK_HEADERS)[number];

export const PROJECT_BULK_LABELS: Record<ProjectBulkHeader, string> = {
  name: "Compal Project Name",
  lenovo_name: "Lenovo Project Name",
  bios_id: "MTCODE",
  platform: "PLATFORM",
  dis: "DIS",
  ss_date: "SS DATE",
  eol_date: "EOL DATE",
  security_update: "SECURITY UPDATE",
  talent_policy: "TALENT POLICY",
  owner: "PROJECT LEADER",
  project_owner: "OWNER",
  tpe_owner: "TPE OWNER",
  description: "Description",
};

const HEADER_ALIASES: Record<string, ProjectBulkHeader> = {
  name: "name",
  compal_project_name: "name",
  compal_name: "name",
  project_name: "name",
  lenovo_name: "lenovo_name",
  lenovo_project_name: "lenovo_name",
  bios_id: "bios_id",
  biosid: "bios_id",
  bios: "bios_id",
  mtcode: "bios_id",
  mt_code: "bios_id",
  platform: "platform",
  dis: "dis",
  ss_date: "ss_date",
  ssdate: "ss_date",
  eol_date: "eol_date",
  eoldate: "eol_date",
  security_update: "security_update",
  securityupdate: "security_update",
  talent_policy: "talent_policy",
  talentpolicy: "talent_policy",
  owner: "owner",
  project_leader: "owner",
  projectleader: "owner",
  project_owner: "project_owner",
  projectowner: "project_owner",
  tpe_owner: "tpe_owner",
  tpeowner: "tpe_owner",
  description: "description",
  desc: "description",
};

export type ProjectBulkRowError = {
  row: number;
  reason: string;
  name?: string;
};

export type ProjectBulkParsedRow = {
  row: number;
  name: string;
  description: string;
  patch: ProjectFieldPatch;
};

export type ProjectBulkParseResult = {
  valid: ProjectBulkParsedRow[];
  errors: ProjectBulkRowError[];
};

export type ProjectBulkCreateResult = {
  created: Array<{ row: number; name: string; id: string }>;
  errors: ProjectBulkRowError[];
  attempted: number;
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

function normalizeHeader(raw: string): ProjectBulkHeader | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return HEADER_ALIASES[key] ?? null;
}

function isBlankRow(cells: Record<ProjectBulkHeader, string>): boolean {
  return PROJECT_BULK_HEADERS.every((h) => !cells[h]);
}

export async function buildProjectsBulkTemplate(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "KSSW";
  const sheet = wb.addWorksheet("Projects", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  PROJECT_BULK_HEADERS.forEach((h, i) => {
    const cell = sheet.getCell(1, i + 1);
    cell.value = PROJECT_BULK_LABELS[h];
    cell.font = { bold: true };
    sheet.getColumn(i + 1).width = h === "description" ? 28 : 18;
  });
  const sample: Record<ProjectBulkHeader, string> = {
    name: "SAMPLE11 N-1",
    lenovo_name: "Sample Lenovo",
    bios_id: "R6CN00WW",
    platform: "Alder Lake",
    dis: "",
    ss_date: "1/15/2026",
    eol_date: "12/31/2027",
    security_update: "",
    talent_policy: "",
    owner: "",
    project_owner: "",
    tpe_owner: "",
    description: "Sample row — delete or rename before upload",
  };
  PROJECT_BULK_HEADERS.forEach((h, i) => {
    sheet.getCell(2, i + 1).value = sample[h];
  });

  const help = wb.addWorksheet("Instructions");
  help.getColumn(1).width = 96;
  const lines = [
    "KSSW Projects & Issues — bulk create (Admin / DM / DL)",
    "",
    "1. Fill the Projects sheet. Keep headers (Compal Project Name is required).",
    "2. Existing Compal project names are NOT overwritten — duplicate rows are reported and skipped.",
    "3. Duplicate names inside this file → later row(s) error.",
    "4. Blank Compal name or reserved name __kssw_meta__ → error.",
    "5. Partial success: valid rows create; failed rows listed.",
    "6. After create, other columns are applied via update (Lenovo name, MTCODE, dates, owners, …).",
    "7. Delete the sample row before upload unless that project name is free.",
  ];
  lines.forEach((text, i) => {
    help.getCell(i + 1, 1).value = text;
  });

  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

export async function loadProjectsBulkWorkbook(file: ArrayBuffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file);
  return wb;
}

export function parseProjectsBulkWorkbook(
  workbook: ExcelJS.Workbook,
  existing: Project[],
): ProjectBulkParseResult {
  const sheet =
    workbook.getWorksheet("Projects") ??
    workbook.worksheets.find((s) => s.name.toLowerCase() !== "instructions") ??
    workbook.worksheets[0];
  if (!sheet) {
    return { valid: [], errors: [{ row: 0, reason: "Workbook has no sheets" }] };
  }

  const headerCells = sheet.getRow(1).values;
  const colMap = new Map<number, ProjectBulkHeader>();
  if (Array.isArray(headerCells)) {
    headerCells.forEach((raw, col) => {
      if (col === 0) return;
      const mapped = normalizeHeader(cellText(raw as ExcelJS.CellValue));
      if (mapped) colMap.set(col, mapped);
    });
  }
  if (![...colMap.values()].includes("name")) {
    return {
      valid: [],
      errors: [
        {
          row: 1,
          reason: "Missing required header Compal Project Name (name). Download the sample template.",
        },
      ],
    };
  }

  const existingNames = new Set(
    existing.map((p) => p.name.trim().toLowerCase()).filter(Boolean),
  );
  const seen = new Set<string>();
  const valid: ProjectBulkParsedRow[] = [];
  const errors: ProjectBulkRowError[] = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells = Object.fromEntries(PROJECT_BULK_HEADERS.map((h) => [h, ""])) as Record<
      ProjectBulkHeader,
      string
    >;
    colMap.forEach((header, col) => {
      cells[header] = cellText(row.getCell(col).value);
    });
    if (isBlankRow(cells)) return;

    const name = cells.name.trim();
    if (!name) {
      errors.push({ row: rowNumber, reason: "Missing required field: Compal Project Name" });
      return;
    }
    if (name === PROJECT_COLUMNS_META_NAME) {
      errors.push({
        row: rowNumber,
        name,
        reason: `Reserved project name “${PROJECT_COLUMNS_META_NAME}” — skipped`,
      });
      return;
    }
    const key = name.toLowerCase();
    if (existingNames.has(key)) {
      errors.push({
        row: rowNumber,
        name,
        reason: `Project “${name}” already exists — skipped (no overwrite)`,
      });
      return;
    }
    if (seen.has(key)) {
      errors.push({
        row: rowNumber,
        name,
        reason: `Duplicate project name “${name}” in this file — skipped`,
      });
      return;
    }
    seen.add(key);

    const patch: ProjectFieldPatch = {};
    if (cells.lenovo_name) patch.lenovo_name = cells.lenovo_name;
    if (cells.bios_id) patch.bios_id = cells.bios_id;
    if (cells.platform) patch.platform = cells.platform;
    if (cells.dis) patch.dis = cells.dis;
    if (cells.ss_date) patch.ss_date = cells.ss_date;
    if (cells.eol_date) patch.eol_date = cells.eol_date;
    if (cells.security_update) patch.security_update = cells.security_update;
    if (cells.talent_policy) patch.talent_policy = cells.talent_policy;
    if (cells.owner) patch.owner = cells.owner;
    if (cells.project_owner) patch.project_owner = cells.project_owner;
    if (cells.tpe_owner) patch.tpe_owner = cells.tpe_owner;

    valid.push({
      row: rowNumber,
      name,
      description: cells.description,
      patch,
    });
  });

  return { valid, errors };
}
