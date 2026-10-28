import { api } from "./api";
import type { WorkLogEntry, WorkLogEntryPatch } from "./types";

const LOCAL_KEY = "kssw-work-log-v1";

function loadLocal(): WorkLogEntry[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WorkLogEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocal(rows: WorkLogEntry[]) {
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
    (msg.includes("work_log") && (msg.includes("schema cache") || msg.includes("does not exist") || msg.includes("could not find")))
  );
}

export const workLogStore = {
  async list(): Promise<WorkLogEntry[]> {
    try {
      return await api.listWorkLogEntries();
    } catch (err) {
      if (isTableMissing(err)) return loadLocal();
      throw err;
    }
  },

  async create(partial?: WorkLogEntryPatch): Promise<WorkLogEntry> {
    try {
      return await api.createWorkLogEntry(partial ?? {});
    } catch (err) {
      if (!isTableMissing(err)) throw err;
      const rows = loadLocal();
      const maxSort = rows.reduce((m, r) => Math.max(m, r.sort_order), -1);
      const row: WorkLogEntry = {
        id: crypto.randomUUID(),
        entry_date: partial?.entry_date ?? "",
        entry_type: partial?.entry_type ?? "",
        project_id: partial?.project_id ?? null,
        project_name: partial?.project_name ?? "",
        product_name: partial?.product_name ?? "",
        content: partial?.content ?? "",
        owner_id: partial?.owner_id ?? null,
        done: Boolean(partial?.done),
        sort_order: partial?.sort_order ?? maxSort + 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      rows.push(row);
      saveLocal(rows);
      return row;
    }
  },

  async update(id: string, patch: WorkLogEntryPatch): Promise<WorkLogEntry> {
    try {
      return await api.updateWorkLogEntry(id, patch);
    } catch (err) {
      if (!isTableMissing(err)) throw err;
      const rows = loadLocal();
      const idx = rows.findIndex((r) => r.id === id);
      if (idx < 0) throw new Error("找不到 Work Log 列");
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
      await api.deleteWorkLogEntry(id);
    } catch (err) {
      if (!isTableMissing(err)) throw err;
      saveLocal(loadLocal().filter((r) => r.id !== id));
    }
  },
};
