import { useEffect, useMemo, useRef, useState } from "react";
import { SavingIndicator } from "../components/SavingIndicator";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";
import {
  getGithubUploadToken,
  hasGithubUploadToken,
  setGithubUploadTokenSession,
  TEST_REPORT_UPLOAD_EXT,
  uploadTestReportFile,
} from "../lib/githubReportStorage";
import { normalizeNoteHref } from "../lib/notesStore";
import {
  canViewTestReports,
  normalizePersonnelRole,
  TEST_REPORT_RESULTS,
  TEST_REPORT_TYPES,
  type TestReport,
  type TestReportResult,
  type TestReportType,
} from "../lib/types";
import { useSaveStatus } from "../lib/useSaveStatus";
import { testReportsStore } from "../lib/testReportsStore";

const UNASSIGNED_ID = "__unassigned__";

export function TestReportsPage({ onGoDashboard }: { onGoDashboard?: () => void }) {
  const { user } = useAuth();
  const { projects, initialLoading } = useStore();
  const role = user ? normalizePersonnelRole(user) : "DE";
  const allowed = canViewTestReports(role);
  const [rows, setRows] = useState<TestReport[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenSaved, setTokenSaved] = useState(() => hasGithubUploadToken());
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const { saveStatus, runSave } = useSaveStatus();

  const projectOptions = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name, "en")),
    [projects],
  );

  const acceptAttr = TEST_REPORT_UPLOAD_EXT.join(",");

  const refresh = async () => {
    setRows(await testReportsStore.list());
    setLoaded(true);
  };

  useEffect(() => {
    if (!allowed) return;
    void refresh().catch((err) => {
      setError(err instanceof Error ? err.message : "Load Test Reports failed");
      setLoaded(true);
    });
  }, [allowed]);

  const reportCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = row.project_id || UNASSIGNED_ID;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [rows]);

  const projectCards = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    const cards: { id: string; compal: string; lenovo: string; count: number }[] =
      projectOptions
        .map((project) => ({
          id: project.id,
          compal: project.name,
          lenovo: project.lenovo_name?.trim() || "",
          count: reportCountByProject.get(project.id) ?? 0,
        }))
        .filter((card) => {
          if (!q) return true;
          return (
            card.compal.toLowerCase().includes(q) ||
            card.lenovo.toLowerCase().includes(q)
          );
        });

    const unassignedCount = reportCountByProject.get(UNASSIGNED_ID) ?? 0;
    if (unassignedCount > 0 && (!q || "unassigned".includes(q) || "未指定".includes(q))) {
      cards.push({
        id: UNASSIGNED_ID,
        compal: "Unassigned",
        lenovo: "No project linked",
        count: unassignedCount,
      });
    }
    return cards;
  }, [projectOptions, projectSearch, reportCountByProject]);

  const selectedProject = useMemo(() => {
    if (!selectedProjectId || selectedProjectId === UNASSIGNED_ID) return null;
    return projectOptions.find((p) => p.id === selectedProjectId) ?? null;
  }, [selectedProjectId, projectOptions]);

  const selectedLabel = useMemo(() => {
    if (!selectedProjectId) return "";
    if (selectedProjectId === UNASSIGNED_ID) return "Unassigned";
    if (!selectedProject) return "Project";
    const lenovo = selectedProject.lenovo_name?.trim();
    return lenovo ? `${selectedProject.name} · ${lenovo}` : selectedProject.name;
  }, [selectedProjectId, selectedProject]);

  const projectRows = useMemo(() => {
    if (!selectedProjectId) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (selectedProjectId === UNASSIGNED_ID) {
        if (row.project_id) return false;
      } else if (row.project_id !== selectedProjectId) {
        return false;
      }
      if (typeFilter !== "all" && row.report_type !== typeFilter) return false;
      if (!q) return true;
      const hay = [
        row.project_name,
        row.bios,
        row.os_image,
        row.report_type,
        row.link,
        row.file_path,
        row.file_name,
        row.report_date,
        row.owner,
        row.result,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [rows, selectedProjectId, typeFilter, query]);

  const patchRow = async (id: string, patch: Parameters<typeof testReportsStore.update>[1]) => {
    setError("");
    try {
      await runSave(async () => {
        const updated = await testReportsStore.update(id, patch);
        setRows((prev) =>
          prev.map((r) => {
            if (r.id !== id) return r;
            const merged = { ...updated };
            if (patch.bios === undefined) merged.bios = r.bios;
            if (patch.os_image === undefined) merged.os_image = r.os_image;
            if (patch.report_type === undefined) merged.report_type = r.report_type;
            if (patch.link === undefined) merged.link = r.link;
            if (patch.file_path === undefined) merged.file_path = r.file_path;
            if (patch.file_name === undefined) merged.file_name = r.file_name;
            if (patch.report_date === undefined) merged.report_date = r.report_date;
            if (patch.owner === undefined) merged.owner = r.owner;
            if (patch.result === undefined) merged.result = r.result;
            if (patch.project_id === undefined) {
              merged.project_id = r.project_id;
              merged.project_name = r.project_name;
            }
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
    if (!selectedProjectId || selectedProjectId === UNASSIGNED_ID) return;
    setError("");
    try {
      await runSave(async () => {
        const created = await testReportsStore.create({
          report_date: new Date().toISOString().slice(0, 10),
          owner: user?.display_name || user?.username || "",
          project_id: selectedProjectId,
          project_name: selectedProject?.name ?? "",
        });
        setRows((prev) => [...prev, created]);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add failed");
    }
  };

  const onDelete = async (row: TestReport) => {
    if (!window.confirm("Delete this Test Report row?")) return;
    setError("");
    try {
      await runSave(async () => {
        await testReportsStore.remove(row.id);
        setRows((prev) => prev.filter((r) => r.id !== row.id));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const openLink = (raw: string) => {
    const href = normalizeNoteHref(raw);
    if (!href) return;
    window.open(href, "_blank", "noopener,noreferrer");
  };

  const saveToken = () => {
    setGithubUploadTokenSession(tokenDraft);
    setTokenSaved(hasGithubUploadToken());
    setTokenDraft("");
    setError("");
  };

  const clearToken = () => {
    setGithubUploadTokenSession("");
    setTokenSaved(hasGithubUploadToken());
    setTokenDraft("");
  };

  const onUploadFile = async (row: TestReport, file: File | null | undefined) => {
    if (!file) return;
    setError("");
    setUploadingId(row.id);
    try {
      await runSave(async () => {
        const uploaded = await uploadTestReportFile({ reportId: row.id, file });
        const updated = await testReportsStore.update(row.id, {
          link: uploaded.link,
          file_path: uploaded.file_path,
          file_name: uploaded.file_name,
        });
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...updated } : r)));
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadingId(null);
      const input = fileInputRefs.current[row.id];
      if (input) input.value = "";
    }
  };

  const backToProjects = () => {
    setSelectedProjectId(null);
    setTypeFilter("all");
    setQuery("");
    setError("");
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
            <span className="wl-bc-current">Test Reports</span>
          </nav>
        </div>
        <p className="wl-denied">Only Admin / DM / DL / DE can open Test Reports.</p>
      </section>
    );
  }

  if (initialLoading || !loaded) {
    return (
      <section className="wl-page">
        <div className="wl-toolbar">
          <nav className="wl-breadcrumb" aria-label="Breadcrumb">
            <button type="button" className="wl-bc-home" onClick={onGoDashboard}>
              DASHBOARD
            </button>
            <span className="wl-bc-sep">›</span>
            <span className="wl-bc-current">Test Reports</span>
          </nav>
        </div>
        <p className="wl-denied" role="status" aria-busy="true">
          載入中…
        </p>
      </section>
    );
  }

  /* —— Project cards (primary) —— */
  if (!selectedProjectId) {
    return (
      <section className="wl-page">
        <div className="wl-toolbar">
          <nav className="wl-breadcrumb" aria-label="Breadcrumb">
            <button type="button" className="wl-bc-home" onClick={onGoDashboard}>
              DASHBOARD
            </button>
            <span className="wl-bc-sep">›</span>
            <span className="wl-bc-current">Test Reports</span>
          </nav>
          <div className="wl-toolbar-actions">
            <label className="wl-search">
              <span className="sr-only">Search projects</span>
              <input
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                placeholder="Search projects…"
                aria-label="Search projects"
              />
            </label>
          </div>
        </div>

        {error && <p className="wl-error">{error}</p>}
        <SavingIndicator status={saveStatus} />

        <p className="tr-grid-hint">Select a project to add or manage its test reports.</p>

        {projectCards.length === 0 ? (
          <p className="wl-empty tr-grid-empty">No projects yet. Create one under Projects &amp; Issues.</p>
        ) : (
          <div className="tr-project-grid" role="list">
            {projectCards.map((card) => (
              <button
                key={card.id}
                type="button"
                className="tr-project-card"
                role="listitem"
                onClick={() => setSelectedProjectId(card.id)}
              >
                <span className="tr-project-compal">{card.compal}</span>
                {card.lenovo ? <span className="tr-project-lenovo">{card.lenovo}</span> : null}
                <span className="tr-project-count">
                  {card.count === 0 ? "No reports" : `${card.count} report${card.count === 1 ? "" : "s"}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    );
  }

  /* —— Per-project report list —— */
  return (
    <section className="wl-page">
      <div className="wl-toolbar">
        <nav className="wl-breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="wl-bc-home" onClick={onGoDashboard}>
            DASHBOARD
          </button>
          <span className="wl-bc-sep">›</span>
          <button type="button" className="wl-bc-link" onClick={backToProjects}>
            Test Reports
          </button>
          <span className="wl-bc-sep">›</span>
          <span className="wl-bc-current">{selectedLabel}</span>
        </nav>
        <div className="wl-toolbar-actions">
          <label className="wl-filter">
            <span>Type</span>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">All</option>
              {TEST_REPORT_TYPES.map((type) => (
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
              aria-label="Search Test Reports"
            />
          </label>
          {selectedProjectId !== UNASSIGNED_ID ? (
            <button type="button" className="pi-btn-primary" onClick={() => void onAdd()}>
              + Add Report
            </button>
          ) : null}
        </div>
      </div>

      <div className="tr-token-bar" aria-label="GitHub upload token">
        <span className="tr-token-label">
          GitHub token {tokenSaved || getGithubUploadToken() ? "(ready)" : "(needed for Upload)"}
        </span>
        <input
          type="password"
          className="tr-token-input"
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
          placeholder="Fine-grained PAT · Contents Write"
          aria-label="GitHub upload token"
          autoComplete="off"
        />
        <button type="button" className="pi-linkish" onClick={saveToken}>
          Save for tab
        </button>
        {(tokenSaved || getGithubUploadToken()) && (
          <button type="button" className="pi-linkish danger" onClick={clearToken}>
            Clear
          </button>
        )}
        <span className="tr-token-hint">Stores under public/test-reports/ via Contents API</span>
      </div>

      {error && <p className="wl-error">{error}</p>}
      <SavingIndicator status={saveStatus} />

      <div className="wl-table-wrap">
        <table className="wl-table">
          <thead>
            <tr>
              <th scope="col">BIOS</th>
              <th scope="col">OS / Image</th>
              <th scope="col">Report Type</th>
              <th scope="col">File / Link</th>
              <th scope="col">Date</th>
              <th scope="col">Owner</th>
              <th scope="col">Result</th>
              <th scope="col" className="wl-col-actions" />
            </tr>
          </thead>
          <tbody>
            {projectRows.length === 0 ? (
              <tr>
                <td colSpan={8} className="wl-empty">
                  {selectedProjectId === UNASSIGNED_ID
                    ? "No unassigned reports."
                    : "No reports for this project yet. Click + Add Report."}
                </td>
              </tr>
            ) : (
              projectRows.map((row) => (
                <tr key={row.id} className={row.result === "PASS" ? "is-done" : undefined}>
                  <td>
                    <input
                      className="wl-input"
                      value={row.bios}
                      aria-label="BIOS"
                      placeholder="BIOS"
                      onChange={(e) => {
                        const value = e.target.value;
                        setRows((prev) =>
                          prev.map((r) => (r.id === row.id ? { ...r, bios: value } : r)),
                        );
                      }}
                      onBlur={(e) => void patchRow(row.id, { bios: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="wl-input"
                      value={row.os_image}
                      aria-label="OS / Image"
                      placeholder="OS / Image"
                      onChange={(e) => {
                        const value = e.target.value;
                        setRows((prev) =>
                          prev.map((r) => (r.id === row.id ? { ...r, os_image: value } : r)),
                        );
                      }}
                      onBlur={(e) => void patchRow(row.id, { os_image: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="wl-input"
                      value={row.report_type}
                      aria-label="Report Type"
                      onChange={(e) =>
                        void patchRow(row.id, {
                          report_type: e.target.value as TestReportType | "",
                        })
                      }
                    >
                      <option value="">—</option>
                      {TEST_REPORT_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                      {row.report_type &&
                        !(TEST_REPORT_TYPES as readonly string[]).includes(row.report_type) && (
                          <option value={row.report_type}>{row.report_type}</option>
                        )}
                    </select>
                  </td>
                  <td className="tr-link-cell">
                    <div className="tr-file-stack">
                      <div className="tr-link-row">
                        <input
                          className="wl-input wl-content"
                          value={row.link}
                          aria-label="Link"
                          placeholder="URL or upload"
                          onChange={(e) => {
                            const value = e.target.value;
                            setRows((prev) =>
                              prev.map((r) => (r.id === row.id ? { ...r, link: value } : r)),
                            );
                          }}
                          onBlur={(e) => void patchRow(row.id, { link: e.target.value })}
                        />
                        {row.link.trim() ? (
                          <button
                            type="button"
                            className="pi-linkish tr-open-link"
                            aria-label="Open link"
                            onClick={() => openLink(row.link)}
                          >
                            Open
                          </button>
                        ) : null}
                      </div>
                      <div className="tr-upload-row">
                        <input
                          ref={(el) => {
                            fileInputRefs.current[row.id] = el;
                          }}
                          type="file"
                          className="tr-file-input"
                          accept={acceptAttr}
                          aria-label="Upload report file"
                          disabled={uploadingId === row.id}
                          onChange={(e) => void onUploadFile(row, e.target.files?.[0])}
                        />
                        <button
                          type="button"
                          className="pi-btn-primary tr-upload-btn"
                          disabled={uploadingId === row.id}
                          onClick={() => fileInputRefs.current[row.id]?.click()}
                        >
                          {uploadingId === row.id ? "Uploading…" : "Upload"}
                        </button>
                        {row.file_name ? (
                          <span className="tr-file-name" title={row.file_path || row.file_name}>
                            {row.file_name}
                          </span>
                        ) : (
                          <span className="tr-file-hint">pdf / xlsx / zip</span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    <input
                      type="date"
                      className="wl-input"
                      value={row.report_date}
                      aria-label="Date"
                      onChange={(e) => void patchRow(row.id, { report_date: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="wl-input"
                      value={row.owner}
                      aria-label="Owner"
                      placeholder="Owner"
                      onChange={(e) => {
                        const value = e.target.value;
                        setRows((prev) =>
                          prev.map((r) => (r.id === row.id ? { ...r, owner: value } : r)),
                        );
                      }}
                      onBlur={(e) => void patchRow(row.id, { owner: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="wl-input"
                      value={row.result}
                      aria-label="Result"
                      onChange={(e) =>
                        void patchRow(row.id, {
                          result: e.target.value as TestReportResult | "",
                        })
                      }
                    >
                      <option value="">—</option>
                      {TEST_REPORT_RESULTS.map((result) => (
                        <option key={result} value={result}>
                          {result}
                        </option>
                      ))}
                    </select>
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
