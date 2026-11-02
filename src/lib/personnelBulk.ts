import ExcelJS from "exceljs";
import {
  PERSONNEL_ROLES,
  type CreatePersonnelInput,
  type PersonnelRole,
  type Profile,
} from "./types";

/** Canonical template headers (row 1). */
export const PERSONNEL_BULK_HEADERS = [
  "display_name",
  "username",
  "email",
  "phone",
  "personnel_role",
] as const;

export type PersonnelBulkHeader = (typeof PERSONNEL_BULK_HEADERS)[number];

const HEADER_ALIASES: Record<string, PersonnelBulkHeader> = {
  display_name: "display_name",
  displayname: "display_name",
  name: "display_name",
  full_name: "display_name",
  fullname: "display_name",
  username: "username",
  user_name: "username",
  account: "username",
  login: "username",
  email: "email",
  mail: "email",
  phone: "phone",
  tel: "phone",
  mobile: "phone",
  unit: "phone",
  personnel_role: "personnel_role",
  personnelrole: "personnel_role",
  role: "personnel_role",
};

export type PersonnelBulkRowError = {
  row: number;
  reason: string;
  display_name?: string;
  username?: string;
  email?: string;
};

export type PersonnelBulkParsedRow = {
  row: number;
  input: CreatePersonnelInput;
};

export type PersonnelBulkParseResult = {
  valid: PersonnelBulkParsedRow[];
  errors: PersonnelBulkRowError[];
};

export type PersonnelBulkCreateResult = {
  created: Array<{ row: number; username: string; email: string; role: PersonnelRole }>;
  errors: PersonnelBulkRowError[];
  /** Rows skipped due to validation (same as parse errors) + create failures. */
  attempted: number;
};

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("result" in value && value.result != null) return String(value.result).trim();
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((p) => p.text ?? "").join("").trim();
    }
  }
  return String(value).trim();
}

function normalizeHeader(raw: string): PersonnelBulkHeader | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return HEADER_ALIASES[key] ?? null;
}

function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizeRole(raw: string): PersonnelRole | null {
  const t = raw.trim();
  if (!t) return null;
  const hit = PERSONNEL_ROLES.find((r) => r.toLowerCase() === t.toLowerCase());
  return hit ?? null;
}

function isBlankRow(cells: Record<PersonnelBulkHeader, string>): boolean {
  return PERSONNEL_BULK_HEADERS.every((h) => !cells[h]);
}

/** Build a downloadable .xlsx sample with headers, examples, and an Instructions sheet. */
export async function buildPersonnelBulkTemplate(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "KSSW";
  wb.created = new Date();

  const sheet = wb.addWorksheet("Members", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: "display_name", key: "display_name", width: 22 },
    { header: "username", key: "username", width: 18 },
    { header: "email", key: "email", width: 28 },
    { header: "phone", key: "phone", width: 16 },
    { header: "personnel_role", key: "personnel_role", width: 16 },
  ];
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.commit();

  sheet.addRow({
    display_name: "Sample DE",
    username: "sample_de",
    email: "sample_de@compal.com",
    phone: "",
    personnel_role: "DE",
  });
  sheet.addRow({
    display_name: "Sample DQA",
    username: "sample_dqa",
    email: "sample_dqa@compal.com",
    phone: "0912-000-000",
    personnel_role: "DQA",
  });

  // Role dropdown validation on personnel_role column
  for (let r = 2; r <= 200; r++) {
    sheet.getCell(r, 5).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [`"${PERSONNEL_ROLES.join(",")}"`],
      showErrorMessage: true,
      errorTitle: "Invalid role",
      error: `Use one of: ${PERSONNEL_ROLES.join(", ")}`,
    };
  }

  const help = wb.addWorksheet("Instructions");
  help.getColumn(1).width = 92;
  const lines = [
    "KSSW Personnel bulk create — Admin only",
    "",
    "1. Fill rows on the Members sheet. Keep the header row exactly as provided (aliases like Name / Role also accepted).",
    "2. Required: display_name (Name), and at least one of username or email.",
    "3. personnel_role must be one of: " + PERSONNEL_ROLES.join(", "),
    "4. Existing username or email in Neon is NOT overwritten — that row is reported as an error and skipped.",
    "5. Duplicate username/email inside the file → error for the later row(s).",
    "6. Invalid / blank role → error; missing required fields → error.",
    "7. Partial success: valid rows are created; failed rows are listed. Default login password is the app DEFAULT_PASSWORD.",
    "8. Delete the sample rows before upload (or keep them only if those accounts do not already exist).",
    "9. Project assignment is not in this template — set Projects in Personnel after create.",
  ];
  lines.forEach((text, i) => {
    help.getCell(i + 1, 1).value = text;
  });

  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

/**
 * Parse an uploaded workbook into valid create inputs + row errors.
 * Never mutates existing profiles — duplicates are errors.
 */
export function parsePersonnelBulkWorkbook(
  workbook: ExcelJS.Workbook,
  existing: Profile[],
): PersonnelBulkParseResult {
  const sheet =
    workbook.getWorksheet("Members") ??
    workbook.worksheets.find((s) => s.name.toLowerCase() !== "instructions") ??
    workbook.worksheets[0];
  if (!sheet) {
    return { valid: [], errors: [{ row: 0, reason: "Workbook has no sheets" }] };
  }

  const headerCells = sheet.getRow(1).values;
  const colMap = new Map<number, PersonnelBulkHeader>();
  if (Array.isArray(headerCells)) {
    headerCells.forEach((raw, col) => {
      if (col === 0) return; // ExcelJS is 1-based; index 0 unused
      const mapped = normalizeHeader(cellText(raw as ExcelJS.CellValue));
      if (mapped) colMap.set(col, mapped);
    });
  }

  const missingHeaders = PERSONNEL_BULK_HEADERS.filter(
    (h) => ![...colMap.values()].includes(h),
  );
  // Only require display_name + personnel_role headers present; username/email/phone optional columns
  const requiredHeaders: PersonnelBulkHeader[] = ["display_name", "personnel_role"];
  const absentRequired = requiredHeaders.filter((h) => missingHeaders.includes(h));
  if (absentRequired.length || colMap.size === 0) {
    return {
      valid: [],
      errors: [
        {
          row: 1,
          reason: `Missing required header(s): ${
            absentRequired.length ? absentRequired.join(", ") : PERSONNEL_BULK_HEADERS.join(", ")
          }. Download the sample template.`,
        },
      ],
    };
  }

  const existingUsernames = new Set(
    existing.map((p) => p.username.trim().toLowerCase()).filter(Boolean),
  );
  const existingEmails = new Set(
    existing.map((p) => p.email.trim().toLowerCase()).filter(Boolean),
  );
  const seenUsernames = new Set<string>();
  const seenEmails = new Set<string>();

  const valid: PersonnelBulkParsedRow[] = [];
  const errors: PersonnelBulkRowError[] = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells: Record<PersonnelBulkHeader, string> = {
      display_name: "",
      username: "",
      email: "",
      phone: "",
      personnel_role: "",
    };
    colMap.forEach((header, col) => {
      cells[header] = cellText(row.getCell(col).value);
    });
    if (isBlankRow(cells)) return;

    const display_name = cells.display_name.trim();
    const usernameRaw = cells.username.trim();
    const emailRaw = cells.email.trim();
    const phone = cells.phone.trim();
    const roleRaw = cells.personnel_role.trim();

    const base: Omit<PersonnelBulkRowError, "reason"> = {
      row: rowNumber,
      display_name: display_name || undefined,
      username: usernameRaw || undefined,
      email: emailRaw || undefined,
    };

    if (!display_name) {
      errors.push({ ...base, reason: "Missing required field: display_name (Name)" });
      return;
    }
    if (!usernameRaw && !emailRaw) {
      errors.push({ ...base, reason: "Missing username and email — provide at least one" });
      return;
    }

    const role = normalizeRole(roleRaw);
    if (!roleRaw) {
      errors.push({ ...base, reason: "Missing required field: personnel_role" });
      return;
    }
    if (!role) {
      errors.push({
        ...base,
        reason: `Invalid role “${roleRaw}” — use ${PERSONNEL_ROLES.join(", ")}`,
      });
      return;
    }

    const username = usernameRaw ? normalizeUsername(usernameRaw) : "";
    if (usernameRaw && !username) {
      errors.push({
        ...base,
        reason: "Username has no valid characters (a-z, 0-9, . _ -)",
      });
      return;
    }

    let email = emailRaw ? normalizeEmail(emailRaw) : "";
    if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ ...base, reason: `Invalid email “${emailRaw}”` });
      return;
    }
    if (!email && username) {
      email = `${username}@local`;
    }

    if (username) {
      if (existingUsernames.has(username) || seenUsernames.has(username)) {
        errors.push({
          ...base,
          username,
          reason: existingUsernames.has(username)
            ? `Username “${username}” already exists — skipped (no overwrite)`
            : `Duplicate username “${username}” in this file — skipped`,
        });
        return;
      }
    }
    if (email) {
      const emailKey = email.toLowerCase();
      if (existingEmails.has(emailKey) || seenEmails.has(emailKey)) {
        errors.push({
          ...base,
          email,
          reason: existingEmails.has(emailKey)
            ? `Email “${email}” already exists — skipped (no overwrite)`
            : `Duplicate email “${email}” in this file — skipped`,
        });
        return;
      }
    }

    if (username) seenUsernames.add(username);
    if (email) seenEmails.add(email.toLowerCase());

    valid.push({
      row: rowNumber,
      input: {
        display_name,
        username: username || undefined,
        email: email || undefined,
        phone,
        personnel_role: role,
      },
    });
  });

  return { valid, errors };
}

export async function loadPersonnelBulkWorkbook(file: ArrayBuffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file);
  return wb;
}
