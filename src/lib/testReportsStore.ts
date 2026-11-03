import { api } from "./api";
import type { TestReport, TestReportPatch } from "./types";

const LOCAL_KEY = "kssw-test-reports-v1";

function loadLocal(): TestReport[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TestReport[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocal(rows: TestReport[]) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(rows));
}

function isTableMissing(err: unknown): boolean {
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
  return (
    code === "PGRST205" ||
    code === "42P01" ||
    (msg.includes("test_report") &&
      (msg.includes("schema cache") || msg.includes("does not exist") || msg.includes("could not find")))
  );
}

export const testReportsStore = {
  async list(): Promise<TestReport[]> {
    try {
      return await api.listTestReports();
    } catch (err) {
      if (isTableMissing(err)) return loadLocal();
      throw err;
    }
  },

  async create(partial?: TestReportPatch): Promise<TestReport> {
    try {
      return await api.createTestReport(partial ?? {});
    } catch (err) {
      if (!isTableMissing(err)) throw err;
      const rows = loadLocal();
      const maxSort = rows.reduce((m, r) => Math.max(m, r.sort_order), -1);
      const row: TestReport = {
        id: crypto.randomUUID(),
        project_id: partial?.project_id ?? null,
        project_name: partial?.project_name ?? "",
        bios: partial?.bios ?? "",
        os_image: partial?.os_image ?? "",
        report_type: partial?.report_type ?? "",
        link: partial?.link ?? "",
        report_date: partial?.report_date ?? "",
        owner: partial?.owner ?? "",
        result: partial?.result ?? "",
        sort_order: partial?.sort_order ?? maxSort + 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      rows.push(row);
      saveLocal(rows);
      return row;
    }
  },

  async update(id: string, patch: TestReportPatch): Promise<TestReport> {
    try {
      return await api.updateTestReport(id, patch);
    } catch (err) {
      if (!isTableMissing(err)) throw err;
      const rows = loadLocal();
      const idx = rows.findIndex((r) => r.id === id);
      if (idx < 0) throw new Error("找不到 Test Report 列");
      const next = {
        ...rows[idx],
        ...patch,
        updated_at: new Date().toISOString(),
      };
      rows[idx] = next;
      saveLocal(rows);
      return next;
    }
  },

  async remove(id: string): Promise<void> {
    try {
      await api.deleteTestReport(id);
    } catch (err) {
      if (!isTableMissing(err)) throw err;
      saveLocal(loadLocal().filter((r) => r.id !== id));
    }
  },
};
