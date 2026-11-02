import { useEffect, useMemo, useRef, useState } from "react";
import {
  ISSUE_TRACKING_FIELDS,
  ISSUE_TRACKING_LABELS,
  ISSUE_TRACKING_RD_FIELDS,
  ISSUE_TRACKING_STATUS_OPTIONS,
  type IssueTrackingField,
  type SecurityIssueTrackingRow,
} from "../lib/securityIssueTracking";
import { securityStore } from "../lib/securityStore";
import type { SecurityRosterEntry } from "../lib/securityTypes";

const LONG_FIELDS = new Set<IssueTrackingField>([
  "steps_recover",
  "condition_text",
  "observed_symptom",
  "dqa_comments",
  "rd_comments",
  "conclusion",
]);

type DraftMap = Record<string, Partial<Record<IssueTrackingField, string>>>;

/**
 * Cycle-wide Issue Tracking 總表 — same editable cells as per-project Issue Tracking,
 * with an extra Project column and optional project filter.
 */
export function IssueTrackingSummaryPanel({
  cycleId,
  cycleName,
  roster,
  canManageStructure,
  canEditContent,
  busy,
  runSave,
  onBack,
}: {
  cycleId: string;
  cycleName: string;
  roster: SecurityRosterEntry[];
  /** Admin/DM/DL — delete rows. */
  canManageStructure: boolean;
  /** Admin/DM/DL/DE/DQA/PM/SA — edit cells + add row. */
  canEditContent: boolean;
  busy: boolean;
  runSave: <T>(fn: () => Promise<T>) => Promise<T>;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<SecurityIssueTrackingRow[]>([]);
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [addRosterId, setAddRosterId] = useState("");
  const [savingCell, setSavingCell] = useState<string | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const rosterSorted = useMemo(
    () =>
      [...roster].sort((a, b) =>
        a.project_name.localeCompare(b.project_name, undefined, { sensitivity: "base" }),
      ),
    [roster],
  );

  const reload = async () => {
    setLoading(true);
    setError("");
    try {
      const next = await securityStore.listIssueTrackingByCycle(cycleId);
      setRows(next);
      setDrafts({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load Issue Tracking 總表 failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when cycle changes
  }, [cycleId]);

  useEffect(() => {
    if (!addRosterId && rosterSorted[0]) setAddRosterId(rosterSorted[0].id);
  }, [addRosterId, rosterSorted]);

  const filteredRows = useMemo(() => {
    const q = projectFilter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => (r.project_name || "").toLowerCase().includes(q));
  }, [rows, projectFilter]);

  const cellValue = (row: SecurityIssueTrackingRow, field: IssueTrackingField): string => {
    const draft = drafts[row.id]?.[field];
    return draft !== undefined ? draft : (row[field] ?? "");
  };

  const setCellDraft = (rowId: string, field: IssueTrackingField, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [rowId]: { ...prev[rowId], [field]: value },
    }));
  };

  const clearCellDraft = (rowId: string, field: IssueTrackingField) => {
    setDrafts((prev) => {
      const rowDraft = prev[rowId];
      if (!rowDraft || rowDraft[field] === undefined) return prev;
      const nextRow = { ...rowDraft };
      delete nextRow[field];
      const next = { ...prev };
      if (Object.keys(nextRow).length === 0) delete next[rowId];
      else next[rowId] = nextRow;
      return next;
    });
  };

  const patchCell = async (id: string, field: IssueTrackingField, value: string) => {
    if (!canEditContent) return;
    const current = rowsRef.current.find((r) => r.id === id);
    if (!current || value === (current[field] ?? "")) {
      clearCellDraft(id, field);
      return;
    }
    setError("");
    const cellKey = `${id}:${field}`;
    setSavingCell(cellKey);
    try {
      const updated = await runSave(() => securityStore.updateIssueTracking(id, { [field]: value }));
      setRows((prev) => prev.map((r) => (r.id === id ? updated : r)));
      clearCellDraft(id, field);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingCell((prev) => (prev === cellKey ? null : prev));
    }
  };

  const onAddRow = async () => {
    if (!canEditContent) return;
    const target = rosterSorted.find((r) => r.id === addRosterId) ?? rosterSorted[0];
    if (!target) {
      setError("No project in this cycle to attach a row.");
      return;
    }
    setError("");
    try {
      const created = await runSave(() =>
        securityStore.createIssueTracking({
          cycle_id: target.cycle_id,
          roster_id: target.id,
          project_id: target.project_id,
          project_name: target.project_name,
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
      setDrafts((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const colCount = ISSUE_TRACKING_FIELDS.length + 1 + (canManageStructure ? 1 : 0);

  return (
    <section className="sec-it-page sec-it-summary-page" aria-label="Issue Tracking 總表">
      <div className="sec-it-page-toolbar">
        <div className="sec-it-page-heading">
          <button type="button" className="sec-detail-back" onClick={onBack}>
            ← Back
          </button>
          <div>
            <h1 id="sec-it-summary-title" className="sec-it-page-title">
              Issue Tracking 總表
            </h1>
            <p className="sec-it-sub">
              {cycleName || "Current cycle"}
              {` · ${rows.length} row${rows.length === 1 ? "" : "s"} · all projects`}
              {canEditContent ? " · editable" : " · view only"}
            </p>
          </div>
        </div>
        <div className="sec-it-head-actions">
          <label className="sec-it-filter">
            <span className="sec-it-filter-label">Filter project</span>
            <input
              type="search"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              placeholder="Search project…"
              aria-label="Filter Issue Tracking by project name"
            />
          </label>
          {canEditContent && (
            <>
              <label className="sec-it-filter">
                <span className="sec-it-filter-label">Add to</span>
                <select
                  value={addRosterId}
                  onChange={(e) => setAddRosterId(e.target.value)}
                  disabled={rosterSorted.length === 0 || busy}
                  aria-label="Project for new Issue Tracking row"
                >
                  {rosterSorted.length === 0 ? (
                    <option value="">No projects</option>
                  ) : (
                    rosterSorted.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.project_name}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <button
                type="button"
                className="sec-it-btn sec-it-btn-primary"
                disabled={busy || rosterSorted.length === 0}
                onClick={() => void onAddRow()}
              >
                + Add row
              </button>
            </>
          )}
        </div>
      </div>

      {error && <p className="sec-it-error">{error}</p>}

      <div className="sec-it-table-wrap sec-it-page-table-wrap">
        {loading ? (
          <p className="sec-it-muted">Loading…</p>
        ) : (
          <table className="sec-it-table">
            <thead>
              <tr>
                <th className="is-project">Project</th>
                {ISSUE_TRACKING_FIELDS.map((field) => (
                  <th
                    key={field}
                    className={
                      field === "status"
                        ? "is-status"
                        : ISSUE_TRACKING_RD_FIELDS.includes(field)
                          ? "is-rd"
                          : "is-dqa"
                    }
                  >
                    {ISSUE_TRACKING_LABELS[field]}
                  </th>
                ))}
                {canManageStructure && <th className="sec-it-actions-col"> </th>}
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="sec-it-empty">
                    {rows.length === 0
                      ? "No Issue Tracking rows in this cycle yet. Open a project’s Issue Tracking or add a row here."
                      : "No rows match this project filter."}
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => (
                  <tr key={row.id}>
                    <td className="sec-it-project-cell" title={row.project_name}>
                      <span className="sec-it-project-name">{row.project_name || "—"}</span>
                    </td>
                    {ISSUE_TRACKING_FIELDS.map((field) => {
                      const value = cellValue(row, field);
                      const cellKey = `${row.id}:${field}`;
                      const isSaving = savingCell === cellKey;
                      const statusOptions = Array.from(
                        new Set([...ISSUE_TRACKING_STATUS_OPTIONS, value].filter((v) => v !== undefined)),
                      );
                      return (
                        <td
                          key={field}
                          className={
                            field === "status"
                              ? "is-status"
                              : ISSUE_TRACKING_RD_FIELDS.includes(field)
                                ? "is-rd"
                                : undefined
                          }
                        >
                          {canEditContent ? (
                            field === "status" ? (
                              <select
                                className={`sec-it-cell sec-it-status-select${isSaving ? " is-saving" : ""}${
                                  value.toUpperCase() === "PASS" ? " is-pass" : ""
                                }`}
                                value={value}
                                aria-label={`Status · ${row.project_name} · ${row.defect_id || row.no || "row"}`}
                                onChange={(e) => {
                                  setCellDraft(row.id, field, e.target.value);
                                  void patchCell(row.id, field, e.target.value);
                                }}
                              >
                                {statusOptions.map((opt) => (
                                  <option key={opt || "(blank)"} value={opt}>
                                    {opt || "—"}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <textarea
                                className={`sec-it-cell${isSaving ? " is-saving" : ""}`}
                                rows={LONG_FIELDS.has(field) ? 3 : 2}
                                value={value}
                                readOnly={false}
                                aria-readonly={false}
                                aria-label={`${ISSUE_TRACKING_LABELS[field]} · ${row.project_name} · ${row.defect_id || row.no || "row"}`}
                                onChange={(e) => setCellDraft(row.id, field, e.target.value)}
                                onBlur={(e) => {
                                  void patchCell(row.id, field, e.target.value);
                                }}
                              />
                            )
                          ) : (
                            <span
                              className={`sec-it-readonly${
                                field === "status" && value.toUpperCase() === "PASS" ? " is-pass" : ""
                              }`}
                            >
                              {row[field] || "—"}
                            </span>
                          )}
                        </td>
                      );
                    })}
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
    </section>
  );
}
