import { useEffect, useRef, useState } from "react";
import {
  buildIssueTrackingTemplate,
  ISSUE_TRACKING_FIELDS,
  ISSUE_TRACKING_LABELS,
  ISSUE_TRACKING_RD_FIELDS,
  loadIssueTrackingWorkbook,
  parseIssueTrackingWorkbook,
  type IssueTrackingBulkImportResult,
  type IssueTrackingField,
  type SecurityIssueTrackingRow,
} from "../lib/securityIssueTracking";
import { securityStore } from "../lib/securityStore";
import type { SecurityRosterEntry } from "../lib/securityTypes";

function downloadBuffer(name: string, buffer: ArrayBuffer) {
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function IssueTrackingModal({
  roster,
  cycleName,
  canManageStructure,
  canEditContent,
  busy,
  runSave,
  onClose,
}: {
  roster: SecurityRosterEntry;
  cycleName: string;
  /** Admin/DM/DL — delete rows. */
  canManageStructure: boolean;
  /** Everyone on Security can edit cells + add / Excel import. */
  canEditContent: boolean;
  busy: boolean;
  runSave: <T>(fn: () => Promise<T>) => Promise<T>;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<SecurityIssueTrackingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importResult, setImportResult] = useState<IssueTrackingBulkImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = async () => {
    setLoading(true);
    setError("");
    try {
      setRows(await securityStore.listIssueTracking(roster.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load Issue Tracking failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when roster changes
  }, [roster.id]);

  const patchCell = async (id: string, field: IssueTrackingField, value: string) => {
    if (!canEditContent) return;
    setError("");
    try {
      const updated = await runSave(() => securityStore.updateIssueTracking(id, { [field]: value }));
      setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      await reload();
    }
  };

  const onAddRow = async () => {
    if (!canEditContent) return;
    setError("");
    try {
      const created = await runSave(() =>
        securityStore.createIssueTracking({
          cycle_id: roster.cycle_id,
          roster_id: roster.id,
          project_id: roster.project_id,
          project_name: roster.project_name,
          defect_id: "",
          title: "",
        }),
      );
      setRows((prev) => [...prev, created]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add row failed");
    }
  };

  const onDelete = async (id: string) => {
    if (!canManageStructure) return;
    const ok = window.confirm("Delete this Issue Tracking row?");
    if (!ok) return;
    setError("");
    try {
      await runSave(() => securityStore.deleteIssueTracking(id));
      setRows((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const onDownloadSample = async () => {
    setError("");
    try {
      const buf = await buildIssueTrackingTemplate({
        project_name: roster.project_name,
        cycle_name: cycleName,
      });
      downloadBuffer(
        `kssw-issue-tracking-${roster.project_name.replace(/\s+/g, "_")}-sample.xlsx`,
        buf,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download sample failed");
    }
  };

  const onUpload = async (file: File | null) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file || !canEditContent) return;
    if (!/\.xlsx?$/i.test(file.name)) {
      setError("Please upload an Excel file (.xlsx)");
      return;
    }
    setError("");
    setImportResult(null);
    try {
      const buffer = await file.arrayBuffer();
      const workbook = await loadIssueTrackingWorkbook(buffer);
      const existing = await securityStore.listIssueTracking(roster.id);
      const existingIds = new Set(
        existing.map((r) => r.defect_id.trim().toLowerCase()).filter(Boolean),
      );
      const parsed = parseIssueTrackingWorkbook(workbook, existingIds);
      const created: IssueTrackingBulkImportResult["created"] = [];
      const errors = [...parsed.errors];
      const known = new Set(existingIds);

      await runSave(async () => {
        for (const item of parsed.valid) {
          const defect = item.fields.defect_id.trim();
          const key = defect.toLowerCase();
          if (known.has(key)) {
            errors.push({
              row: item.row,
              defect_id: defect,
              title: item.fields.title,
              reason: `Defect ID “${defect}” already exists — skipped (no overwrite)`,
            });
            continue;
          }
          try {
            const row = await securityStore.createIssueTracking({
              cycle_id: roster.cycle_id,
              roster_id: roster.id,
              project_id: roster.project_id,
              project_name: roster.project_name,
              ...item.fields,
            });
            known.add(key);
            created.push({ row: item.row, defect_id: row.defect_id, title: row.title });
          } catch (err) {
            errors.push({
              row: item.row,
              defect_id: defect,
              title: item.fields.title,
              reason: err instanceof Error ? err.message : "Create failed",
            });
          }
        }
      });

      setImportResult({
        created,
        errors: errors.sort((a, b) => a.row - b.row),
        attempted: parsed.valid.length + parsed.errors.length,
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Excel upload failed");
    }
  };

  return (
    <div className="sec-it-backdrop" role="presentation" onClick={onClose}>
      <div
        className="sec-it-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sec-it-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sec-it-head">
          <div>
            <h2 id="sec-it-title">Issue Tracking</h2>
            <p className="sec-it-sub">
              {roster.project_name}
              {cycleName ? ` · ${cycleName}` : ""}
            </p>
          </div>
          <div className="sec-it-head-actions">
            {canEditContent && (
              <>
                <button type="button" className="sec-it-btn" disabled={busy} onClick={() => void onDownloadSample()}>
                  Excel sample
                </button>
                <button
                  type="button"
                  className="sec-it-btn"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  Upload Excel
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="sec-it-file"
                  aria-label="Upload Issue Tracking Excel"
                  onChange={(e) => void onUpload(e.target.files?.[0] ?? null)}
                />
                <button type="button" className="sec-it-btn sec-it-btn-primary" disabled={busy} onClick={() => void onAddRow()}>
                  + Add row
                </button>
              </>
            )}
            <button type="button" className="sec-it-close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </div>
        </header>

        {error && <p className="sec-it-error">{error}</p>}

        {importResult && (
          <div className="sec-it-import-result">
            <p>
              Created <strong>{importResult.created.length}</strong>
              {importResult.errors.length > 0 ? (
                <>
                  {" "}
                  · <strong className="sec-it-err-count">{importResult.errors.length}</strong> row
                  {importResult.errors.length === 1 ? "" : "s"} skipped / failed
                </>
              ) : (
                <> · no row errors</>
              )}
              . Existing Defect IDs were not overwritten.
            </p>
            {importResult.errors.length > 0 && (
              <ul>
                {importResult.errors.map((e, i) => (
                  <li key={`${e.row}-${i}`}>
                    Row {e.row}
                    {e.defect_id ? ` (${e.defect_id})` : ""}: {e.reason}
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="sec-it-btn" onClick={() => setImportResult(null)}>
              Dismiss
            </button>
          </div>
        )}

        <div className="sec-it-table-wrap">
          {loading ? (
            <p className="sec-it-muted">Loading…</p>
          ) : (
            <table className="sec-it-table">
              <thead>
                <tr>
                  {ISSUE_TRACKING_FIELDS.map((field) => (
                    <th
                      key={field}
                      className={ISSUE_TRACKING_RD_FIELDS.includes(field) ? "is-rd" : "is-dqa"}
                    >
                      {ISSUE_TRACKING_LABELS[field]}
                    </th>
                  ))}
                  {canManageStructure && <th className="sec-it-actions-col"> </th>}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={ISSUE_TRACKING_FIELDS.length + (canManageStructure ? 1 : 0)}
                      className="sec-it-empty"
                    >
                      No Issue Tracking rows yet. Add a row or upload Excel.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id}>
                      {ISSUE_TRACKING_FIELDS.map((field) => (
                        <td key={field} className={ISSUE_TRACKING_RD_FIELDS.includes(field) ? "is-rd" : undefined}>
                          {canEditContent ? (
                            <textarea
                              className="sec-it-cell"
                              rows={field === "steps_recover" || field === "condition_text" || field === "observed_symptom" ? 3 : 1}
                              defaultValue={row[field]}
                              disabled={busy}
                              aria-label={`${ISSUE_TRACKING_LABELS[field]} for ${row.defect_id || row.no || "row"}`}
                              onBlur={(e) => {
                                const next = e.target.value;
                                if (next !== row[field]) void patchCell(row.id, field, next);
                              }}
                            />
                          ) : (
                            <span className="sec-it-readonly">{row[field] || "—"}</span>
                          )}
                        </td>
                      ))}
                      {canManageStructure && (
                        <td>
                          <button
                            type="button"
                            className="sec-it-del"
                            disabled={busy}
                            onClick={() => void onDelete(row.id)}
                          >
                            Delete
                          </button>
                        </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
