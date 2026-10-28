import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
  CycleDetailDoc,
  CycleDetailItem,
  CycleReleaseTracking,
  ItemApplyCell,
  ItemApplyStatus,
  ReleaseTrackingKey,
} from "../lib/cycleDetailTypes";
import {
  APPLY_STATUSES,
  RELEASE_STATUS_OPTIONS,
  RELEASE_TRACKING_ROWS,
  detailDocSignature,
  emptyApplyCell,
  newDetailItemId,
  normalizeApplyCell,
  normalizeEcrHref,
} from "../lib/cycleDetailTypes";
import type { SecurityCycle, SecurityIssue, SecurityRosterEntry } from "../lib/securityTypes";
import { seedDetailFromIssues } from "../lib/securityStore";
import type { Project } from "../lib/types";
import {
  ProjectInfoPopover,
  formatMpEop,
  resolveSegment,
  type ProjectInfoData,
} from "./ProjectInfoPopover";

type ProjectCol = {
  id: string;
  name: string;
  lenovo_name: string;
  platform: string;
  blurb: string;
  info: ProjectInfoData;
};

function cloneItems(items: CycleDetailItem[]): CycleDetailItem[] {
  return items.map((it) => ({
    ...it,
    ...(it.issue_id ? { issue_id: it.issue_id } : {}),
    applies: Object.fromEntries(
      Object.entries(it.applies).map(([pid, cell]) => [pid, { ...normalizeApplyCell(cell) }]),
    ),
  }));
}

function cloneRelease(release: CycleReleaseTracking): CycleReleaseTracking {
  return {
    by_project: Object.fromEntries(
      Object.entries(release.by_project).map(([pid, cell]) => [pid, { ...cell }]),
    ),
  };
}

function cloneDoc(doc: CycleDetailDoc): CycleDetailDoc {
  return {
    cycle_id: doc.cycle_id,
    items: cloneItems(doc.items),
    release: cloneRelease(doc.release),
    updated_at: doc.updated_at,
  };
}

/** Normalize stored date strings to YYYY-MM-DD for <input type="date">. */
function toDateInputValue(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const slash = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slash) {
    const mm = slash[1].padStart(2, "0");
    const dd = slash[2].padStart(2, "0");
    return `${slash[3]}-${mm}-${dd}`;
  }
  return s;
}

function statusClass(status: ItemApplyStatus): string {
  if (status === "Applied") return "is-applied";
  if (status === "Not Applied") return "is-not-applied";
  if (status === "Not Applicable") return "is-na";
  return "is-empty";
}

export function CycleDetailPanel({
  cycle,
  roster,
  projects,
  issues,
  saved,
  busy,
  profileName,
  canManageStructure,
  onBack,
  onEditCycle,
  onSave,
  onLinkIssue,
}: {
  cycle: SecurityCycle;
  roster: SecurityRosterEntry[];
  projects: Project[];
  issues: SecurityIssue[];
  /** Persisted doc (null → seed items from issues on first paint). */
  saved: CycleDetailDoc | null;
  busy: boolean;
  profileName: (id: string | null) => string | null;
  /** Admin/DM/DL: New item, delete item, edit cycle, item title/detail. */
  canManageStructure: boolean;
  onBack: () => void;
  onEditCycle: () => void;
  /** Persist full draft (items + release) on Save All. */
  onSave: (doc: CycleDetailDoc) => Promise<void>;
  /** Persist Issue Summary ↔ cycle link (cycle_ids + projects). */
  onLinkIssue: (
    issueId: string,
    projectIds: string[],
  ) => Promise<SecurityIssue>;
}) {
  const [infoOpenId, setInfoOpenId] = useState<string | null>(null);
  const [infoAnchor, setInfoAnchor] = useState<HTMLElement | null>(null);
  const [addIssueOpen, setAddIssueOpen] = useState(false);

  const projectCols: ProjectCol[] = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const byName = new Map(projects.map((p) => [p.name, p]));
    const rows = roster
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order || a.project_name.localeCompare(b.project_name));
    return rows.map((r) => {
      const linked = byId.get(r.project_id) ?? byName.get(r.project_name);
      const platform = [linked?.platform, linked?.bios_id].filter(Boolean).join(" / ");
      const waveBlurb = r.wave && r.wave !== "Not set" ? r.wave : "";
      return {
        id: r.project_id,
        name: r.project_name,
        lenovo_name: (linked?.lenovo_name ?? "").trim(),
        platform,
        blurb: waveBlurb || platform || (linked?.description ?? "").trim().slice(0, 48),
        info: {
          name: r.project_name,
          platform: platform || (linked?.description ?? "").trim().slice(0, 48),
          mpEop: formatMpEop(linked?.ss_date, linked?.eol_date),
          segment: linked ? resolveSegment(linked) : "—",
          wave: r.wave && r.wave !== "Not set" ? r.wave : "—",
          owner: profileName(r.owner_id) ?? "—",
          reviewer: profileName(r.reviewer_id) ?? "—",
        },
      };
    });
  }, [roster, projects, profileName]);

  const projectIds = useMemo(() => projectCols.map((p) => p.id), [projectCols]);

  const initialDoc = useMemo(() => {
    if (saved && (saved.items.length > 0 || Object.keys(saved.release.by_project).length > 0)) {
      // Prefer persisted items; seed only when items empty but release exists.
      if (saved.items.length > 0) return cloneDoc(saved);
      const seeded = seedDetailFromIssues(cycle.id, issues, projectIds);
      return {
        cycle_id: cycle.id,
        items: cloneItems(seeded.items),
        release: cloneRelease(saved.release),
        updated_at: saved.updated_at,
      };
    }
    if (saved) return cloneDoc(saved);
    return seedDetailFromIssues(cycle.id, issues, projectIds);
  }, [saved, cycle.id, issues, projectIds]);

  const [baseline, setBaseline] = useState(() => detailDocSignature(initialDoc));
  const [draft, setDraft] = useState(() => cloneDoc(initialDoc));
  const [releaseOpen, setReleaseOpen] = useState(true);
  const [error, setError] = useState("");
  /** Project ids whose ECR Number cell is expanded (number + URL inputs). */
  const [ecrEditing, setEcrEditing] = useState<Set<string>>(() => new Set());
  const ecrFocusPidRef = useRef<string | null>(null);

  useEffect(() => {
    setDraft(cloneDoc(initialDoc));
    setBaseline(detailDocSignature(initialDoc));
    setEcrEditing(new Set());
    setError("");
  }, [initialDoc]);

  /** Click / focus outside an expanded ECR cell → collapse back to link view. */
  useEffect(() => {
    if (ecrEditing.size === 0) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest("[data-ecr-expand]")) return;
      setEcrEditing(new Set());
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEcrEditing(new Set());
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ecrEditing.size]);

  /** Focus the number input when a cell first expands. */
  useEffect(() => {
    const pid = ecrFocusPidRef.current;
    if (!pid || !ecrEditing.has(pid)) return;
    const root = document.querySelector(`[data-ecr-expand="${CSS.escape(pid)}"]`);
    const input = root?.querySelector<HTMLInputElement>("input.sec-ecr-input");
    input?.focus();
    ecrFocusPidRef.current = null;
  }, [ecrEditing]);

  const expandEcr = useCallback((projectId: string) => {
    ecrFocusPidRef.current = projectId;
    setEcrEditing((prev) => {
      if (prev.has(projectId)) return prev;
      const next = new Set(prev);
      next.add(projectId);
      return next;
    });
  }, []);

  const dirty = detailDocSignature(draft) !== baseline;

  const updateItem = useCallback((id: string, patch: Partial<CycleDetailItem>) => {
    setDraft((prev) => ({
      ...prev,
      items: prev.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
    }));
  }, []);

  const patchApplyCell = useCallback(
    (itemId: string, projectId: string, patch: Partial<ItemApplyCell>) => {
      setDraft((prev) => ({
        ...prev,
        items: prev.items.map((it) => {
          if (it.id !== itemId) return it;
          const cur = normalizeApplyCell(it.applies[projectId] ?? emptyApplyCell());
          return {
            ...it,
            applies: { ...it.applies, [projectId]: { ...cur, ...patch } },
          };
        }),
      }));
    },
    [],
  );

  const linkedIssueIds = useMemo(
    () => new Set(draft.items.map((it) => it.issue_id).filter((id): id is string => Boolean(id))),
    [draft.items],
  );

  const addIssueFromSaved = async (
    issue: SecurityIssue,
    problemDescription: string,
    affectedProjectIds: string[],
  ) => {
    await onLinkIssue(issue.id, affectedProjectIds);
    setDraft((prev) => {
      if (prev.items.some((it) => it.issue_id === issue.id)) return prev;
      const applies: Record<string, ItemApplyCell> = {};
      for (const pid of projectIds) {
        applies[pid] = {
          status: affectedProjectIds.includes(pid) ? "Applied" : "",
          comment: "",
        };
      }
      const detailLine =
        problemDescription.trim() ||
        issue.reference_path ||
        issue.detail ||
        issue.oem_request_id ||
        "";
      const item: CycleDetailItem = {
        id: newDetailItemId(),
        issue_id: issue.id,
        title: issue.title,
        detail: detailLine,
        cycle_comment: "",
        applies,
        sort_order: prev.items.length,
      };
      return { ...prev, items: [...prev.items, item] };
    });
    setAddIssueOpen(false);
  };

  const removeItem = (id: string) => {
    setDraft((prev) => ({
      ...prev,
      items: prev.items.filter((it) => it.id !== id).map((it, i) => ({ ...it, sort_order: i })),
    }));
  };

  const setReleaseCell = (projectId: string, key: ReleaseTrackingKey, value: string) => {
    setDraft((prev) => {
      const cell = { ...(prev.release.by_project[projectId] ?? {}), [key]: value };
      return {
        ...prev,
        release: {
          by_project: { ...prev.release.by_project, [projectId]: cell },
        },
      };
    });
  };

  const setEcrUrl = (projectId: string, url: string) => {
    setDraft((prev) => {
      const cell = { ...(prev.release.by_project[projectId] ?? {}), ecr_url: url };
      return {
        ...prev,
        release: {
          by_project: { ...prev.release.by_project, [projectId]: cell },
        },
      };
    });
  };

  const handleSave = async () => {
    setError("");
    try {
      await onSave(draft);
      setBaseline(detailDocSignature(draft));
      setEcrEditing(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleBack = () => {
    if (dirty && !window.confirm("Discard unsaved cycle detail changes?")) return;
    onBack();
  };

  const sortedItems = useMemo(
    () => draft.items.slice().sort((a, b) => a.sort_order - b.sort_order),
    [draft.items],
  );

  const colCount = 2 + projectCols.length;

  return (
    <div className="sec-detail">
      <div className="sec-detail-toolbar">
        <div className="sec-detail-heading">
          <button type="button" className="sec-detail-back" onClick={handleBack}>
            ← Back
          </button>
          <div className="sec-detail-title-row">
            <h1 className="sec-detail-title">
              {cycle.name}
              {cycle.quarter ? ` · ${cycle.quarter}` : ""}
            </h1>
            {canManageStructure ? (
              <button
                type="button"
                className="sec-detail-gear"
                onClick={onEditCycle}
                aria-label="Edit cycle"
                title="Edit cycle"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
                </svg>
              </button>
            ) : null}
          </div>
          <p className="sec-detail-sub">Security update review and project release tracking.</p>
        </div>
        <div className="sec-detail-actions">
          {dirty && <span className="sec-detail-dirty">Unsaved draft</span>}
          {canManageStructure ? (
            <button
              type="button"
              className="sec-btn-ghost sec-toolbar-action"
              onClick={() => setAddIssueOpen(true)}
              disabled={busy}
            >
              <span className="sec-toolbar-action-icon" aria-hidden="true">
                +
              </span>
              New item
            </button>
          ) : null}
          <button
            type="button"
            className="sec-btn-ghost sec-toolbar-action"
            onClick={() => void handleSave()}
            disabled={busy || !dirty}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            Save All
          </button>
        </div>
      </div>

      {error && <p className="sec-error">{error}</p>}

      {canManageStructure && addIssueOpen ? (
        <AddIssueToCycleModal
          issues={issues}
          excludeIssueIds={linkedIssueIds}
          projects={projectCols}
          busy={busy}
          onClose={() => setAddIssueOpen(false)}
          onAdd={async (issue, description, projectIds) => {
            try {
              await addIssueFromSaved(issue, description, projectIds);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              throw err;
            }
          }}
        />
      ) : null}

      {infoOpenId ? (
        <ProjectInfoPopover
          open
          data={projectCols.find((c) => c.id === infoOpenId)?.info ?? {
            name: "—",
            platform: "",
            mpEop: "—",
            segment: "—",
            wave: "—",
            owner: "—",
            reviewer: "—",
          }}
          onClose={() => {
            setInfoOpenId(null);
            setInfoAnchor(null);
          }}
          anchorEl={infoAnchor}
        />
      ) : null}

      <div className="sec-detail-matrix-wrap">
        <table className="sec-detail-matrix sec-detail-unified">
          <colgroup>
            <col className="sec-col-item" />
            <col className="sec-col-comment" />
            {projectCols.map((p) => (
              <col key={p.id} className="sec-col-proj" />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="sec-detail-sticky-col sec-detail-sticky-1">Security Update Item</th>
              <th className="sec-detail-sticky-col sec-detail-sticky-2">Cycle Comment</th>
              {projectCols.map((p) => (
                <th key={p.id} className="sec-detail-proj-col">
                  <div className="sec-detail-proj-head">
                    <div className="sec-detail-proj-title-row">
                      <strong>{p.name}</strong>
                      <button
                        type="button"
                        className="sec-proj-info-btn"
                        aria-label={`${p.name} project info`}
                        aria-expanded={infoOpenId === p.id}
                        title="Project info"
                        onClick={(e) => {
                          e.stopPropagation();
                          const btn = e.currentTarget;
                          setInfoOpenId((cur) => {
                            if (cur === p.id) {
                              setInfoAnchor(null);
                              return null;
                            }
                            setInfoAnchor(btn);
                            return p.id;
                          });
                        }}
                      >
                        i
                      </button>
                    </div>
                    {p.platform ? (
                      <span className="sec-detail-proj-blurb" title={p.platform}>
                        {p.platform}
                      </span>
                    ) : p.blurb ? (
                      <span className="sec-detail-proj-blurb">{p.blurb}</span>
                    ) : null}
                    {p.lenovo_name ? (
                      <span className="sec-detail-proj-lenovo" title="Lenovo Project Name">
                        {p.lenovo_name}
                      </span>
                    ) : null}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedItems.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="sec-roster-empty">
                  {canManageStructure
                    ? "No security items yet — click + New item"
                    : "No security items yet — ask Admin / DM / DL to add items."}
                </td>
              </tr>
            ) : (
              sortedItems.map((item, idx) => (
                <tr key={item.id}>
                  <td className="sec-detail-sticky-col sec-detail-sticky-1 sec-detail-item-cell">
                    <div className="sec-detail-item-card">
                      <div className="sec-detail-item-top">
                        <input
                          className="sec-detail-item-title"
                          value={item.title}
                          onChange={(e) => updateItem(item.id, { title: e.target.value })}
                          aria-label={`Item ${idx + 1} title`}
                          readOnly={!canManageStructure}
                          disabled={!canManageStructure}
                        />
                        {canManageStructure ? (
                          <button
                            type="button"
                            className="sec-detail-trash"
                            onClick={() => removeItem(item.id)}
                            aria-label={`Delete ${item.title || "item"}`}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-1 14H6L5 6" />
                              <path d="M10 11v6M14 11v6" />
                              <path d="M9 6V4h6v2" />
                            </svg>
                          </button>
                        ) : null}
                      </div>
                      <input
                        className="sec-detail-item-detail"
                        value={item.detail}
                        onChange={(e) => updateItem(item.id, { detail: e.target.value })}
                        placeholder="Version / path / note"
                        aria-label={`Item ${idx + 1} detail`}
                        readOnly={!canManageStructure}
                        disabled={!canManageStructure}
                      />
                      <span className="sec-detail-item-num">#{idx + 1}</span>
                    </div>
                  </td>
                  <td className="sec-detail-sticky-col sec-detail-sticky-2 sec-detail-comment-col">
                    <input
                      className="sec-detail-cell-input"
                      value={item.cycle_comment}
                      onChange={(e) => updateItem(item.id, { cycle_comment: e.target.value })}
                      placeholder="—"
                      aria-label={`Cycle comment for ${item.title || `item ${idx + 1}`}`}
                    />
                  </td>
                  {projectCols.map((p) => {
                    const cell = normalizeApplyCell(item.applies[p.id] ?? emptyApplyCell());
                    return (
                      <td
                        key={p.id}
                        className={`sec-detail-proj-col sec-apply-cell ${statusClass(cell.status)}`}
                      >
                        <div className="sec-apply-stack">
                          <select
                            className={`sec-apply-select ${statusClass(cell.status)}`}
                            value={cell.status}
                            onChange={(e) =>
                              patchApplyCell(item.id, p.id, {
                                status: e.target.value as ItemApplyStatus,
                              })
                            }
                            aria-label={`${item.title || "Item"} · ${p.name} status`}
                          >
                            {APPLY_STATUSES.map((s) => (
                              <option key={s || "empty"} value={s}>
                                {s || "—"}
                              </option>
                            ))}
                          </select>
                          <textarea
                            className="sec-apply-comment"
                            value={cell.comment}
                            onChange={(e) =>
                              patchApplyCell(item.id, p.id, { comment: e.target.value })
                            }
                            placeholder="Comment / implementation details"
                            rows={2}
                            aria-label={`${item.title || "Item"} · ${p.name} comment`}
                          />
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))
            )}

            <tr className="sec-release-section-row">
              <td colSpan={colCount} className="sec-release-section-cell">
                <button
                  type="button"
                  className="sec-release-toggle"
                  aria-expanded={releaseOpen}
                  onClick={() => setReleaseOpen((o) => !o)}
                >
                  <span className="sec-release-chevron" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      {releaseOpen ? (
                        <path d="M6 9l6 6 6-6" />
                      ) : (
                        <path d="M9 6l6 6-6 6" />
                      )}
                    </svg>
                  </span>
                  <span className="sec-release-toggle-label">Project Release Tracking</span>
                </button>
              </td>
            </tr>

            {releaseOpen &&
              RELEASE_TRACKING_ROWS.map((row) => (
                <tr
                  key={row.key}
                  className={row.kind === "status" ? "sec-release-status-row" : "sec-release-field-row"}
                >
                  <td
                    className="sec-detail-sticky-col sec-detail-sticky-1 sec-release-label"
                    colSpan={2}
                  >
                    {row.label}
                  </td>
                  {projectCols.map((p) => {
                    const cell = draft.release.by_project[p.id] ?? {};
                    const value = cell[row.key] ?? "";
                    if (row.kind === "ecr") {
                      const number = (cell.ecr_number ?? "").trim();
                      const url = (cell.ecr_url ?? "").trim();
                      const editing = ecrEditing.has(p.id);
                      if (editing) {
                        return (
                          <td
                            key={p.id}
                            className="sec-detail-proj-col sec-ecr-cell is-expanded"
                            data-ecr-expand={p.id}
                          >
                            <div className="sec-ecr-edit-stack">
                              <input
                                className="sec-detail-cell-input sec-ecr-input"
                                value={cell.ecr_number ?? ""}
                                onChange={(e) => setReleaseCell(p.id, "ecr_number", e.target.value)}
                                placeholder="ECR Number"
                                aria-label={`ECR Number · ${p.name}`}
                              />
                              <input
                                className="sec-detail-cell-input sec-ecr-input"
                                type="url"
                                value={cell.ecr_url ?? ""}
                                onChange={(e) => setEcrUrl(p.id, e.target.value)}
                                placeholder="https://…"
                                aria-label={`ECR URL · ${p.name}`}
                              />
                            </div>
                          </td>
                        );
                      }
                      const href = normalizeEcrHref(url);
                      return (
                        <td
                          key={p.id}
                          className="sec-detail-proj-col sec-ecr-cell is-collapsed"
                          tabIndex={0}
                          role="button"
                          aria-label={`Edit ECR Number · ${p.name}`}
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest("a")) return;
                            expandEcr(p.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              expandEcr(p.id);
                            }
                          }}
                        >
                          <div className="sec-ecr-view">
                            {number ? (
                              href ? (
                                <a
                                  className="sec-ecr-link"
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {number}
                                </a>
                              ) : (
                                <span className="sec-ecr-plain">{number}</span>
                              )
                            ) : (
                              <span className="sec-ecr-empty">—</span>
                            )}
                          </div>
                        </td>
                      );
                    }
                    if (row.kind === "status") {
                      return (
                        <td key={p.id} className="sec-detail-proj-col">
                          <select
                            className={`sec-release-select${value === "Ongoing" ? " is-ongoing" : ""}${
                              value === "Done" ? " is-done" : ""
                            }`}
                            value={value}
                            onChange={(e) => setReleaseCell(p.id, row.key, e.target.value)}
                            aria-label={`${row.label} · ${p.name}`}
                          >
                            {RELEASE_STATUS_OPTIONS.map((opt) => (
                              <option key={opt || "empty"} value={opt}>
                                {opt || "—"}
                              </option>
                            ))}
                          </select>
                        </td>
                      );
                    }
                    if (row.kind === "date") {
                      const dateVal = toDateInputValue(value);
                      return (
                        <td key={p.id} className="sec-detail-proj-col sec-detail-date-cell">
                          <input
                            type="date"
                            lang="en-CA"
                            className={`sec-detail-date-input${dateVal ? "" : " is-empty"}`}
                            value={dateVal}
                            onChange={(e) => setReleaseCell(p.id, row.key, e.target.value)}
                            onClick={(e) => {
                              const el = e.currentTarget;
                              // Ensure the native picker opens even when column chrome is tight.
                              const picker = (
                                el as HTMLInputElement & { showPicker?: () => void }
                              ).showPicker;
                              if (typeof picker === "function") {
                                try {
                                  picker.call(el);
                                } catch {
                                  /* NotAllowedError / unsupported — fall back to default. */
                                }
                              }
                            }}
                            aria-label={`${row.label} · ${p.name}`}
                            title={dateVal || "YYYY-MM-DD"}
                          />
                        </td>
                      );
                    }
                    return (
                      <td key={p.id} className="sec-detail-proj-col">
                        <input
                          className="sec-detail-cell-input"
                          value={value}
                          onChange={(e) => setReleaseCell(p.id, row.key, e.target.value)}
                          placeholder="—"
                          aria-label={`${row.label} · ${p.name}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddIssueToCycleModal({
  issues,
  excludeIssueIds,
  projects,
  busy,
  onClose,
  onAdd,
}: {
  issues: SecurityIssue[];
  excludeIssueIds: Set<string>;
  projects: ProjectCol[];
  busy: boolean;
  onClose: () => void;
  onAdd: (
    issue: SecurityIssue,
    description: string,
    projectIds: string[],
  ) => Promise<void>;
}) {
  const available = useMemo(
    () =>
      issues
        .filter((i) => !excludeIssueIds.has(i.id))
        .slice()
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" })),
    [issues, excludeIssueIds],
  );

  const [issueId, setIssueId] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const selectedIssue = available.find((i) => i.id === issueId) ?? null;

  const onSelectIssue = (id: string) => {
    setIssueId(id);
    const issue = available.find((i) => i.id === id);
    if (issue) {
      setDescription(issue.detail || issue.oem_request_id || "");
      const preselect = new Set(
        projects.filter((p) => issue.project_ids.includes(p.id)).map((p) => p.id),
      );
      setSelected(preselect.size > 0 ? preselect : new Set());
    } else {
      setDescription("");
      setSelected(new Set());
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(projects.map((p) => p.id)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError("");
    if (!selectedIssue) {
      setFormError("Select a saved security update item");
      return;
    }
    if (!description.trim()) {
      setFormError("Problem description is required");
      return;
    }
    if (selected.size === 0) {
      setFormError("Select at least one affected project");
      return;
    }
    setSubmitting(true);
    try {
      await onAdd(selectedIssue, description, [...selected]);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="sec-modal-backdrop" onClick={onClose}>
      <form
        className="sec-modal sec-modal-add-issue"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <div className="sec-modal-head">
          <div>
            <h2>Add Issue to Cycle</h2>
            <p>Choose a saved item and select all affected projects.</p>
          </div>
          <button type="button" className="sec-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <label className="sec-field">
          <span>Saved Security Update Item</span>
          <select
            value={issueId}
            onChange={(e) => onSelectIssue(e.target.value)}
            aria-label="Saved Security Update Item"
          >
            <option value="">Select saved item…</option>
            {available.map((issue) => (
              <option key={issue.id} value={issue.id}>
                {issue.title}
                {issue.oem_request_id ? ` (${issue.oem_request_id})` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="sec-field">
          <span>Problem description *</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="Select a saved item or enter the description…"
            required
          />
        </label>

        <div className="sec-projects-picker">
          <div className="sec-projects-picker-head">
            <span>
              Affected projects *{" "}
              <span className="sec-muted">
                Selected {selected.size} of {projects.length}
              </span>
            </span>
            <button type="button" className="sec-select-all-link" onClick={selectAll}>
              Select all
            </button>
          </div>
          <ul className="sec-project-checklist sec-project-checklist-2col">
            {projects.length === 0 ? (
              <li className="sec-muted">No projects in this cycle</li>
            ) : (
              projects.map((p) => (
                <li key={p.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggle(p.id)}
                    />
                    <span className="sec-check-name">{p.name}</span>
                    {p.blurb ? <span className="sec-check-blurb">{p.blurb}</span> : null}
                  </label>
                </li>
              ))
            )}
          </ul>
        </div>

        {available.length === 0 ? (
          <p className="sec-muted">
            No unused saved items — create one under Issue Summary, or all are already in this cycle.
          </p>
        ) : null}
        {formError ? <p className="sec-error">{formError}</p> : null}

        <div className="sec-modal-actions">
          <button type="button" className="sec-btn-ghost" onClick={onClose} disabled={submitting || busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="sec-btn-primary"
            disabled={submitting || busy || available.length === 0}
          >
            <span aria-hidden="true">+</span> Add Issue
          </button>
        </div>
      </form>
    </div>
  );
}
