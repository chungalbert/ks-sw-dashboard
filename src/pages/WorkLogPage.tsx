import { useEffect, useMemo, useState } from "react";
import { SavingIndicator } from "../components/SavingIndicator";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";
import {
  canViewWorkLog,
  normalizePersonnelRole,
  WORK_LOG_TYPES,
  type WorkLogEntry,
  type WorkLogType,
} from "../lib/types";
import { useSaveStatus } from "../lib/useSaveStatus";
import { workLogStore } from "../lib/workLogStore";

export function WorkLogPage({ onGoDashboard }: { onGoDashboard?: () => void }) {
  const { user } = useAuth();
  const { projects, profiles } = useStore();
  const role = user ? normalizePersonnelRole(user) : "DE";
  const allowed = canViewWorkLog(role);
  const [rows, setRows] = useState<WorkLogEntry[]>([]);
  const [error, setError] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const { saveStatus, runSave } = useSaveStatus();

  const people = useMemo(
    () =>
      [...profiles].sort((a, b) =>
        (a.display_name || a.username).localeCompare(b.display_name || b.username, "zh-Hant"),
      ),
    [profiles],
  );

  const projectOptions = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name, "en")),
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
    return rows.filter((row) => {
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
  }, [rows, typeFilter, query, people]);

  const patchRow = async (id: string, patch: Parameters<typeof workLogStore.update>[1]) => {
    setError("");
    try {
      await runSave(async () => {
        const updated = await workLogStore.update(id, patch);
        // Merge server row with any in-flight local edits (e.g. 內容 typing) so a
        // concurrent Type/Project/Owner save does not clobber the content draft.
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
          <button type="button" className="pi-btn-primary" onClick={() => void onAdd()}>
            + Add row
          </button>
        </div>
      </div>

      {error && <p className="wl-error">{error}</p>}
      <SavingIndicator status={saveStatus} />

      <div className="wl-table-wrap">
        <table className="wl-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
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
                  No Work Log rows yet. Click + Add row.
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
                  <td>
                    <select
                      className="wl-input"
                      value={row.project_id ?? ""}
                      aria-label="Project"
                      onChange={(e) => void onProjectChange(row, e.target.value)}
                    >
                      <option value="">—</option>
                      {projectOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
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
