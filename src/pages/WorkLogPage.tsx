import { useEffect, useMemo, useRef, useState } from "react";
import { SavingIndicator } from "../components/SavingIndicator";
import { WorkLogProjectPicker } from "../components/WorkLogProjectPicker";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";
import { PROJECT_COLUMNS_META_NAME } from "../lib/cloudApi";
import {
  canViewWorkLog,
  normalizePersonnelRole,
  WORK_LOG_TYPES,
  type WorkLogEntry,
  type WorkLogType,
} from "../lib/types";
import { useSaveStatus } from "../lib/useSaveStatus";
import {
  buildWorkLogBulkTemplate,
  buildWorkLogExportCsv,
  buildWorkLogExportXlsx,
  fingerprintFromEntry,
  loadWorkLogBulkWorkbook,
  parseWorkLogBulkWorkbook,
  type WorkLogBulkCreateResult,
  type WorkLogBulkRowError,
} from "../lib/workLogBulk";
import { workLogStore } from "../lib/workLogStore";

type DateSort = "asc" | "desc";

/** Stable display order: incomplete first, then Date, then sort_order, then id. */
function compareWorkLogRows(a: WorkLogEntry, b: WorkLogEntry, dateSort: DateSort): number {
  const byDone = Number(a.done) - Number(b.done);
  if (byDone !== 0) return byDone;
  const dir = dateSort === "asc" ? 1 : -1;
  const byDate = a.entry_date.localeCompare(b.entry_date) * dir;
  if (byDate !== 0) return byDate;
  const bySort = (a.sort_order ?? 0) - (b.sort_order ?? 0);
  if (bySort !== 0) return bySort;
  return a.id.localeCompare(b.id);
}

function downloadBuffer(
  name: string,
  buffer: ArrayBuffer,
  mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
) {
  const blob = new Blob([buffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadText(name: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function WorkLogPage({ onGoDashboard }: { onGoDashboard?: () => void }) {
  const { user } = useAuth();
  const { projects, profiles } = useStore();
  const role = user ? normalizePersonnelRole(user) : "DE";
  const allowed = canViewWorkLog(role);
  const [rows, setRows] = useState<WorkLogEntry[]>([]);
  const [error, setError] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [dateSort, setDateSort] = useState<DateSort>("desc");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<WorkLogBulkCreateResult | null>(null);
  const bulkFileRef = useRef<HTMLInputElement>(null);
  const { saveStatus, runSave } = useSaveStatus();

  const people = useMemo(
    () =>
      [...profiles].sort((a, b) =>
        (a.display_name || a.username).localeCompare(b.display_name || b.username, "zh-Hant"),
      ),
    [profiles],
  );

  const projectOptions = useMemo(
    () =>
      [...projects]
        .filter((p) => p.name !== PROJECT_COLUMNS_META_NAME)
        .sort((a, b) => a.name.localeCompare(b.name, "en")),
    [projects],
  );

  const refresh = async () => {
    setRows(await workLogStore.list());
  };

  useEffect(() => {
    if (!allowed) return;
    void refresh().catch((err) => {
      setError(err instanceof Error ? err.message : "Load Work Log failed");
    });
  }, [allowed]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (typeFilter !== "all" && row.entry_type !== typeFilter) return false;
      if (!q) return true;
      const hay = [
        row.entry_date,
        row.entry_type,
        row.project_name,
        row.product_name,
        row.content,
        people.find((p) => p.id === row.owner_id)?.display_name ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    // Incomplete (unchecked) rows stay on top; done below. Within each group,
    // Date + sort_order + id keep a stable order so field saves do not reshuffle.
    return [...filtered].sort((a, b) => compareWorkLogRows(a, b, dateSort));
  }, [rows, typeFilter, query, people, dateSort]);

  const patchRow = async (id: string, patch: Parameters<typeof workLogStore.update>[1]) => {
    setError("");
    try {
      await runSave(async () => {
        const updated = await workLogStore.update(id, patch);
        // Merge server row with any in-flight local edits (e.g. 內容 typing) so a
        // concurrent Type/Project/Owner save does not clobber the content draft.
        // Keep array identity order (map) — never re-sort `rows` on save.
        setRows((prev) =>
          prev.map((r) => {
            if (r.id !== id) return r;
            const merged = { ...updated };
            for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
              if (patch[key] !== undefined) {
                (merged as Record<string, unknown>)[key as string] = updated[key as keyof typeof updated];
              }
            }
            // Keep local fields that were not part of this patch (still being edited).
            if (patch.content === undefined) merged.content = r.content;
            if (patch.entry_date === undefined) merged.entry_date = r.entry_date;
            if (patch.entry_type === undefined) merged.entry_type = r.entry_type;
            if (patch.project_id === undefined) {
              merged.project_id = r.project_id;
              merged.project_name = r.project_name;
              merged.product_name = r.product_name;
            }
            if (patch.owner_id === undefined) merged.owner_id = r.owner_id;
            if (patch.done === undefined) merged.done = r.done;
            // Never let a field save rewrite display order keys.
            if (patch.sort_order === undefined) merged.sort_order = r.sort_order;
            return merged;
          }),
        );
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      await refresh();
    }
  };

  const onAdd = async () => {
    setError("");
    try {
      await runSave(async () => {
        const created = await workLogStore.create({
          entry_date: new Date().toISOString().slice(0, 10),
          owner_id: user?.id ?? null,
        });
        setRows((prev) => [...prev, created]);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add failed");
    }
  };

  const onDelete = async (row: WorkLogEntry) => {
    if (!window.confirm("Delete this Work Log row?")) return;
    setError("");
    try {
      await runSave(async () => {
        await workLogStore.remove(row.id);
        setRows((prev) => prev.filter((r) => r.id !== row.id));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const onProjectChange = async (row: WorkLogEntry, projectId: string) => {
    if (!projectId) {
      await patchRow(row.id, {
        project_id: null,
        project_name: "",
        product_name: "",
      });
      return;
    }
    const project = projectOptions.find((p) => p.id === projectId);
    await patchRow(row.id, {
      project_id: projectId,
      project_name: project?.name ?? "",
      product_name: project?.lenovo_name ?? "",
    });
  };

  const onDownloadBulkSample = async () => {
    if (!allowed) return;
    setError("");
    try {
      downloadBuffer("kssw-work-log-bulk-sample.xlsx", await buildWorkLogBulkTemplate());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download sample failed");
    }
  };

  const onDownloadTableExcel = async () => {
    if (!allowed) return;
    setError("");
    try {
      downloadBuffer(
        "kssw-work-log-export.xlsx",
        await buildWorkLogExportXlsx(visible, profiles),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download Excel failed");
    }
  };

  const onDownloadTableCsv = () => {
    if (!allowed) return;
    setError("");
    try {
      downloadText(
        "kssw-work-log-export.csv",
        buildWorkLogExportCsv(visible, profiles),
        "text/csv;charset=utf-8",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download CSV failed");
    }
  };

  const toggleDateSort = () => {
    setDateSort((prev) => (prev === "asc" ? "desc" : "asc"));
  };

  const onBulkExcelSelected = async (file: File | null) => {
    if (bulkFileRef.current) bulkFileRef.current.value = "";
    if (!allowed || !file) return;
    if (!/\.xlsx?$/i.test(file.name)) {
      setError("Please upload an Excel file (.xlsx)");
      return;
    }
    setError("");
    setBulkBusy(true);
    setBulkResult(null);
    try {
      const workbook = await loadWorkLogBulkWorkbook(await file.arrayBuffer());
      const latest = await workLogStore.list();
      const parsed = parseWorkLogBulkWorkbook(workbook, latest, projects, profiles);
      const created: WorkLogBulkCreateResult["created"] = [];
      const errors: WorkLogBulkRowError[] = [...parsed.errors];
      const known = new Set(latest.map(fingerprintFromEntry));

      await runSave(async () => {
        for (const item of parsed.valid) {
          if (known.has(item.fingerprint)) {
            errors.push({
              row: item.row,
              entry_date: item.patch.entry_date,
              project_name: item.patch.project_name,
              content: item.patch.content,
              reason:
                "Matching Work Log row already exists (Date + Type + Project + 內容 + Owner) — skipped (no overwrite)",
            });
            continue;
          }
          try {
            const row = await workLogStore.create(item.patch);
            known.add(item.fingerprint);
            created.push({
              row: item.row,
              id: row.id,
              entry_date: row.entry_date,
              content: row.content,
            });
          } catch (err) {
            errors.push({
              row: item.row,
              entry_date: item.patch.entry_date,
              project_name: item.patch.project_name,
              content: item.patch.content,
              reason: err instanceof Error ? err.message : "Create failed",
            });
          }
        }
        await refresh();
      });

      setBulkResult({
        created,
        errors: errors.sort((a, b) => a.row - b.row),
        attempted: parsed.valid.length + parsed.errors.length,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Excel upload failed");
    } finally {
      setBulkBusy(false);
    }
  };

  if (!allowed) {
    return (
      <section className="wl-page">
        <div className="wl-toolbar">
          <nav className="wl-breadcrumb" aria-label="Breadcrumb">
            <button type="button" className="wl-bc-home" onClick={onGoDashboard}>
              DASHBOARD
            </button>
            <span className="wl-bc-sep">›</span>
            <span className="wl-bc-current">Work Log</span>
          </nav>
        </div>
        <p className="wl-denied">Only Admin / DM / DL / DE can open Work Log.</p>
      </section>
    );
  }

  return (
    <section className="wl-page">
      <div className="wl-toolbar">
        <nav className="wl-breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="wl-bc-home" onClick={onGoDashboard}>
            DASHBOARD
          </button>
          <span className="wl-bc-sep">›</span>
          <span className="wl-bc-current">Work Log</span>
        </nav>
        <div className="wl-toolbar-actions">
          <SavingIndicator status={saveStatus} />
          <label className="wl-filter">
            <span>Type</span>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">All</option>
              {WORK_LOG_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="wl-search">
            <span className="sr-only">Search</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              aria-label="Search Work Log"
            />
          </label>
          <button
            type="button"
            className="pi-add-col"
            disabled={bulkBusy || visible.length === 0}
            title="Download visible Work Log rows as Excel (same columns as table)"
            onClick={() => void onDownloadTableExcel()}
          >
            Download Excel
          </button>
          <button
            type="button"
            className="pi-add-col"
            disabled={bulkBusy || visible.length === 0}
            title="Download visible Work Log rows as CSV (same columns as table)"
            onClick={onDownloadTableCsv}
          >
            Download CSV
          </button>
          <button
            type="button"
            className="pi-add-col"
            disabled={bulkBusy}
            title="Download Excel sample for bulk create"
            onClick={() => void onDownloadBulkSample()}
          >
            Excel sample
          </button>
          <button
            type="button"
            className="pi-add-col"
            disabled={bulkBusy}
            title="Upload Excel to create Work Log rows (Admin / DM / DL / DE)"
            onClick={() => bulkFileRef.current?.click()}
          >
            {bulkBusy ? "Uploading…" : "Upload Excel"}
          </button>
          <input
            ref={bulkFileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="wl-bulk-file"
            aria-label="Upload Work Log Excel"
            onChange={(e) => void onBulkExcelSelected(e.target.files?.[0] ?? null)}
          />
          <button type="button" className="pi-btn-primary" onClick={() => void onAdd()}>
            + Add row
          </button>
        </div>
      </div>

      {error && <p className="wl-error">{error}</p>}

      {bulkResult && (
        <div className="pi-bulk-backdrop" role="presentation" onClick={() => setBulkResult(null)}>
          <div
            className="pi-bulk-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wl-bulk-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="pi-bulk-head">
              <h2 id="wl-bulk-title">Excel bulk create</h2>
              <button
                type="button"
                className="pi-bulk-close"
                aria-label="Close"
                onClick={() => setBulkResult(null)}
              >
                ×
              </button>
            </header>
            <div className="pi-bulk-body">
              <p>
                Created <strong>{bulkResult.created.length}</strong>
                {bulkResult.errors.length > 0 ? (
                  <>
                    {" "}
                    · <strong className="pi-bulk-err">{bulkResult.errors.length}</strong> row
                    {bulkResult.errors.length === 1 ? "" : "s"} skipped / failed
                  </>
                ) : (
                  <> · no row errors</>
                )}
                . Existing Work Log rows were not overwritten.
              </p>
              {bulkResult.created.length > 0 && (
                <ul className="pi-bulk-list">
                  {bulkResult.created.map((c) => (
                    <li key={c.id}>
                      Row {c.row}: {c.entry_date}
                      {c.content ? ` — ${c.content.slice(0, 60)}${c.content.length > 60 ? "…" : ""}` : ""}
                    </li>
                  ))}
                </ul>
              )}
              {bulkResult.errors.length > 0 && (
                <ul className="pi-bulk-list is-errors">
                  {bulkResult.errors.map((e, i) => (
                    <li key={`${e.row}-${i}`}>
                      Row {e.row}
                      {e.entry_date ? ` (${e.entry_date})` : ""}: {e.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <footer className="pi-bulk-foot">
              <button type="button" className="pi-btn-primary" onClick={() => setBulkResult(null)}>
                Close
              </button>
            </footer>
          </div>
        </div>
      )}

      <div className="wl-table-wrap">
        <table className="wl-table">
          <thead>
            <tr>
              <th scope="col" aria-sort={dateSort === "asc" ? "ascending" : "descending"}>
                <button
                  type="button"
                  className="wl-sort-btn"
                  onClick={toggleDateSort}
                  title={
                    dateSort === "asc"
                      ? "Sorted by Date ascending — click for descending"
                      : "Sorted by Date descending — click for ascending"
                  }
                  aria-label={
                    dateSort === "asc"
                      ? "Date, sorted ascending. Activate to sort descending"
                      : "Date, sorted descending. Activate to sort ascending"
                  }
                >
                  Date
                  <span className="wl-sort-ind" aria-hidden="true">
                    {dateSort === "asc" ? " ↑" : " ↓"}
                  </span>
                </button>
              </th>
              <th scope="col">Type</th>
              <th scope="col">Project</th>
              <th scope="col">Product Name</th>
              <th scope="col">內容</th>
              <th scope="col">Owner</th>
              <th scope="col">完成 CheckPoint</th>
              <th scope="col" className="wl-col-actions" />
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={8} className="wl-empty">
                  No Work Log rows yet. Click + Add row or upload Excel.
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr key={row.id} className={row.done ? "is-done" : undefined}>
                  <td>
                    <input
                      type="date"
                      className="wl-input"
                      value={row.entry_date}
                      aria-label="Date"
                      onChange={(e) => void patchRow(row.id, { entry_date: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="wl-input"
                      value={row.entry_type}
                      aria-label="Type"
                      onChange={(e) =>
                        void patchRow(row.id, {
                          entry_type: e.target.value as WorkLogType | "",
                        })
                      }
                    >
                      <option value="">—</option>
                      {WORK_LOG_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="wl-col-project">
                    <WorkLogProjectPicker
                      value={row.project_id ?? ""}
                      options={projectOptions}
                      aria-label="Project"
                      onChange={(projectId) => void onProjectChange(row, projectId)}
                    />
                  </td>
                  <td className="wl-product" title={row.product_name || undefined}>
                    {row.product_name || "—"}
                  </td>
                  <td>
                    <input
                      className="wl-input wl-content"
                      value={row.content}
                      aria-label="內容"
                      placeholder="內容"
                      onChange={(e) => {
                        const value = e.target.value;
                        setRows((prev) =>
                          prev.map((r) => (r.id === row.id ? { ...r, content: value } : r)),
                        );
                      }}
                      onBlur={(e) => void patchRow(row.id, { content: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="wl-input"
                      value={row.owner_id ?? ""}
                      aria-label="Owner"
                      onChange={(e) =>
                        void patchRow(row.id, {
                          owner_id: e.target.value || null,
                        })
                      }
                    >
                      <option value="">—</option>
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.display_name || p.username}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="wl-done">
                    <input
                      type="checkbox"
                      checked={row.done}
                      aria-label="完成 CheckPoint"
                      onChange={(e) => void patchRow(row.id, { done: e.target.checked })}
                    />
                  </td>
                  <td className="wl-col-actions">
                    <button
                      type="button"
                      className="pi-linkish danger"
                      aria-label="Delete row"
                      onClick={() => void onDelete(row)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
