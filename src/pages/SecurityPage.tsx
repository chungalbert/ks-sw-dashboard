import { FormEvent, MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useState } from "react";
import { CycleDetailPanel } from "../components/CycleDetailPanel";
import { LoadingIndicator } from "../components/LoadingIndicator";
import { SavingIndicator } from "../components/SavingIndicator";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";
import type { CycleDetailDoc } from "../lib/cycleDetailTypes";
import {
  cycleMetrics,
  securityDisplayDate,
  securityStore,
} from "../lib/securityStore";
import type {
  SecurityCycle,
  SecurityIssue,
  SecurityRosterEntry,
  SecurityRosterPatch,
  SecuritySnapshot,
  SecurityWave,
} from "../lib/securityTypes";
import {
  newWaveId,
  normalizeCycleWaves,
  rosterWaveOptions,
} from "../lib/securityTypes";
import { useSaveStatus } from "../lib/useSaveStatus";
import { PROJECT_COLUMNS_META_NAME } from "../lib/cloudApi";
import {
  canManageSecurityStructure,
  normalizePersonnelRole,
  type Profile,
  type Project,
} from "../lib/types";

type Tab = "overview" | "issues";

const CYCLE_PILL_TONES = ["tone-teal", "tone-rose", "tone-violet", "tone-amber", "tone-sky"] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function cycleTone(index: number): string {
  return CYCLE_PILL_TONES[index % CYCLE_PILL_TONES.length];
}

function defaultQuarterLabel(): string {
  const d = new Date();
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()} Q${q}`;
}

export function SecurityPage({ onGoDashboard }: { onGoDashboard?: () => void }) {
  const { user } = useAuth();
  const { projects, profiles, initialLoading } = useStore();
  const { saveStatus, runSave } = useSaveStatus();
  const personnelRole = user ? normalizePersonnelRole(user) : "DE";
  const canManageStructure = canManageSecurityStructure(personnelRole);

  /** All Personnel members for Owner / Reviewer selects (sorted). */
  const personnelMembers = useMemo(() => {
    return [...profiles].sort((a, b) =>
      a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" }),
    );
  }, [profiles]);

  const [tab, setTab] = useState<Tab>("overview");
  const [snap, setSnap] = useState<SecuritySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [activeCycleId, setActiveCycleId] = useState<string | null>(null);
  const [issueCycleFilter, setIssueCycleFilter] = useState<string>("all");

  const [cycleModal, setCycleModal] = useState<null | { mode: "create" } | { mode: "edit"; cycle: SecurityCycle }>(
    null,
  );
  const [issueModal, setIssueModal] = useState<null | { mode: "create" | "edit"; issue?: SecurityIssue }>(
    null,
  );
  /** When set, show cycle detail matrix (AIOSW security-update?cycle=…). */
  const [detailCycleId, setDetailCycleId] = useState<string | null>(null);
  const [detailDoc, setDetailDoc] = useState<CycleDetailDoc | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const visibleProjects = useMemo(
    () => projects.filter((p) => p.name !== PROJECT_COLUMNS_META_NAME),
    [projects],
  );

  const projectPickerOptions = useMemo(
    () =>
      visibleProjects.map((p) => ({
        id: p.id,
        name: p.name,
        blurb: [p.platform, p.bios_id].filter(Boolean).join(" · "),
      })),
    [visibleProjects],
  );

  const profileName = useCallback(
    (id: string | null) => {
      if (!id) return null;
      return profiles.find((p) => p.id === id)?.display_name ?? null;
    },
    [profiles],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await securityStore.load();
      // Keep roster Status aligned with saved Project Release Tracking (Done rules).
      let roster = next.roster;
      for (const c of next.cycles) {
        const detail = await securityStore.loadCycleDetail(c.id);
        if (!detail) continue;
        const updates = await securityStore.syncRosterStatusesFromRelease(c.id, detail.release);
        if (updates.length === 0) continue;
        const byId = new Map(updates.map((r) => [r.id, r]));
        roster = roster.map((r) => byId.get(r.id) ?? r);
      }
      setSnap({ ...next, roster });
      setActiveCycleId((prev) => {
        if (prev && next.cycles.some((c) => c.id === prev)) return prev;
        return next.cycles[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSnap({ cycles: [], roster: [], issues: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const cycles = snap?.cycles ?? [];
  const activeCycle = cycles.find((c) => c.id === activeCycleId) ?? cycles[0] ?? null;
  const detailCycle = detailCycleId
    ? (cycles.find((c) => c.id === detailCycleId) ?? null)
    : null;

  const openCycleDetail = useCallback(
    async (cycleId: string) => {
      setDetailCycleId(cycleId);
      setActiveCycleId(cycleId);
      setDetailLoading(true);
      setError("");
      try {
        const doc = await securityStore.loadCycleDetail(cycleId);
        setDetailDoc(doc);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setDetailDoc(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [],
  );

  const closeCycleDetail = useCallback(() => {
    setDetailCycleId(null);
    setDetailDoc(null);
  }, []);

  const cycleRoster = useMemo(() => {
    if (!snap || !activeCycle) return [] as SecurityRosterEntry[];
    // Stable order: roster sort_order (cycle project order), then Compal name.
    // Do not re-sort by Wave when a row's Wave changes.
    const rows = snap.roster
      .filter((r) => r.cycle_id === activeCycle.id)
      .slice()
      .sort(
        (a, b) =>
          a.sort_order - b.sort_order ||
          a.project_name.localeCompare(b.project_name, undefined, { sensitivity: "base" }),
      );
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.project_name.toLowerCase().includes(q) ||
        r.wave.toLowerCase().includes(q) ||
        r.status.toLowerCase().includes(q) ||
        (profileName(r.owner_id) ?? "").toLowerCase().includes(q) ||
        (profileName(r.reviewer_id) ?? "").toLowerCase().includes(q) ||
        r.sa_owner.toLowerCase().includes(q) ||
        r.pm_owner.toLowerCase().includes(q) ||
        r.dqa_owner.toLowerCase().includes(q),
    );
  }, [snap, activeCycle, query, profileName]);

  const activeCycleWaveCount = useMemo(
    () =>
      normalizeCycleWaves(
        activeCycle ?? { waves: [], wave1_date: "", wave2_date: "", external_release_date: "" },
      ).length,
    [activeCycle],
  );
  const metrics = useMemo(
    () => cycleMetrics(cycleRoster, activeCycleWaveCount),
    [cycleRoster, activeCycleWaveCount],
  );

  const filteredCycles = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || tab !== "overview") return cycles;
    return cycles.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.quarter.toLowerCase().includes(q) ||
        snap?.roster.some(
          (r) =>
            r.cycle_id === c.id && r.project_name.toLowerCase().includes(q),
        ),
    );
  }, [cycles, query, tab, snap]);

  const filteredIssues = useMemo(() => {
    if (!snap) return [] as SecurityIssue[];
    let list = snap.issues;
    if (issueCycleFilter !== "all") {
      list = list.filter((i) => i.cycle_ids.includes(issueCycleFilter));
    }
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          i.oem_request_id.toLowerCase().includes(q) ||
          i.detail.toLowerCase().includes(q) ||
          i.project_names.toLowerCase().includes(q),
      );
    }
    return list;
  }, [snap, issueCycleFilter, query]);

  const issueCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of cycles) map.set(c.id, 0);
    for (const issue of snap?.issues ?? []) {
      for (const cid of issue.cycle_ids) {
        map.set(cid, (map.get(cid) ?? 0) + 1);
      }
    }
    return map;
  }, [cycles, snap]);

  const patchRoster = async (id: string, patch: SecurityRosterPatch) => {
    setError("");
    try {
      await runSave(async () => {
        const updated = await securityStore.updateRosterEntry(id, patch);
        setSnap((prev) =>
          prev
            ? { ...prev, roster: prev.roster.map((r) => (r.id === updated.id ? updated : r)) }
            : prev,
        );
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** Batch-assign Wave or Reviewer to many roster rows (one Saving indicator). */
  const patchRosterMany = async (ids: string[], patch: SecurityRosterPatch) => {
    if (ids.length === 0) return;
    setError("");
    try {
      await runSave(async () => {
        const updated = await Promise.all(
          ids.map((id) => securityStore.updateRosterEntry(id, patch)),
        );
        const byId = new Map(updated.map((r) => [r.id, r]));
        setSnap((prev) =>
          prev
            ? {
                ...prev,
                roster: prev.roster.map((r) => byId.get(r.id) ?? r),
              }
            : prev,
        );
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  const showBoot = initialLoading || (loading && !snap);

  return (
    <div className="sec-page">
      <header className="sec-toolbar">
        <nav className="sec-breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="sec-bc-home" onClick={onGoDashboard} aria-label="Dashboard">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
              <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </button>
          <button type="button" className="sec-bc-link" onClick={onGoDashboard}>
            Dashboard
          </button>
          <span className="sec-bc-sep" aria-hidden="true">
            /
          </span>
          {detailCycle ? (
            <>
              <button
                type="button"
                className="sec-bc-link"
                onClick={() => {
                  closeCycleDetail();
                  setTab("overview");
                }}
              >
                BIOS Security Updates
              </button>
              <span className="sec-bc-sep" aria-hidden="true">
                /
              </span>
              <span className="sec-bc-current">{detailCycle.name}</span>
            </>
          ) : tab === "issues" ? (
            <>
              <button type="button" className="sec-bc-link" onClick={() => setTab("overview")}>
                BIOS Security Updates
              </button>
              <span className="sec-bc-sep" aria-hidden="true">
                /
              </span>
              <span className="sec-bc-current">Issue Summary</span>
            </>
          ) : (
            <span className="sec-bc-current">BIOS Security Updates</span>
          )}
        </nav>

        <div className="sec-toolbar-actions">
          <SavingIndicator status={saveStatus} />
          {!detailCycle && (
          <button
            type="button"
            className="sec-toggle-btn"
            onClick={() => setTab((t) => (t === "overview" ? "issues" : "overview"))}
          >
            {tab === "overview" ? "Issue summary" : "Overview"}
          </button>
          )}
          <label className="sec-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3-3" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search cycles or projects"
              aria-label="Search cycles or projects"
            />
          </label>
          <button type="button" className="sec-icon-btn" onClick={() => void refresh()} aria-label="Refresh">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-2.6-6.2" />
              <path d="M21 3v6h-6" />
            </svg>
          </button>
        </div>
      </header>

      <div className="sec-body">
        {error && <p className="sec-error">{error}</p>}

        {showBoot ? (
          <div className="sec-loading" role="status" aria-busy="true">
            <LoadingIndicator />
            <span>Loading project roster...</span>
          </div>
        ) : detailCycle ? (
          detailLoading ? (
            <div className="sec-loading" role="status" aria-busy="true">
              <LoadingIndicator />
              <span>Loading cycle detail...</span>
            </div>
          ) : (
            <CycleDetailPanel
              cycle={detailCycle}
              roster={snap?.roster.filter((r) => r.cycle_id === detailCycle.id) ?? []}
              projects={visibleProjects as Project[]}
              issues={snap?.issues ?? []}
              saved={detailDoc}
              busy={saveStatus.kind === "saving"}
              profileName={profileName}
              canManageStructure={canManageStructure}
              onBack={closeCycleDetail}
              onEditCycle={() => setCycleModal({ mode: "edit", cycle: detailCycle })}
              onLinkIssue={async (issueId, projectIds) => {
                const names = new Map(visibleProjects.map((p) => [p.id, p.name]));
                for (const r of snap?.roster.filter((x) => x.cycle_id === detailCycle.id) ?? []) {
                  names.set(r.project_id, r.project_name);
                }
                const updated = await runSave(() =>
                  securityStore.linkIssueToCycle(issueId, detailCycle.id, projectIds, names),
                );
                setSnap((prev) =>
                  prev
                    ? {
                        ...prev,
                        issues: prev.issues.map((i) => (i.id === updated.id ? updated : i)),
                      }
                    : prev,
                );
                return updated;
              }}
              onSave={async (doc) => {
                const { saved, rosterUpdates } = await runSave(async () => {
                  const savedDoc = await securityStore.saveCycleDetail(doc);
                  const updates = await securityStore.syncRosterStatusesFromRelease(
                    savedDoc.cycle_id,
                    savedDoc.release,
                  );
                  return { saved: savedDoc, rosterUpdates: updates };
                });
                setDetailDoc(saved);
                if (rosterUpdates.length > 0) {
                  const byId = new Map(rosterUpdates.map((r) => [r.id, r]));
                  setSnap((prev) =>
                    prev
                      ? {
                          ...prev,
                          roster: prev.roster.map((r) => byId.get(r.id) ?? r),
                        }
                      : prev,
                  );
                }
              }}
            />
          )
        ) : tab === "overview" ? (
          <OverviewPanel
            cycles={filteredCycles.length ? filteredCycles : cycles}
            allCycles={cycles}
            activeCycle={activeCycle}
            roster={cycleRoster}
            metrics={metrics}
            projects={visibleProjects}
            personnel={personnelMembers}
            profileName={profileName}
            canManageStructure={canManageStructure}
            onSelectCycle={setActiveCycleId}
            onOpenDetail={() => {
              if (activeCycle) void openCycleDetail(activeCycle.id);
            }}
            onNewCycle={() => setCycleModal({ mode: "create" })}
            onEditCycle={() => {
              if (activeCycle) setCycleModal({ mode: "edit", cycle: activeCycle });
            }}
            onPatchRoster={patchRoster}
            onPatchRosterMany={patchRosterMany}
          />
        ) : (
          <IssueSummaryPanel
            cycles={cycles}
            issues={filteredIssues}
            totalIssueCount={snap?.issues.length ?? 0}
            issueCounts={issueCounts}
            filter={issueCycleFilter}
            canManageStructure={canManageStructure}
            onFilter={setIssueCycleFilter}
            onAdd={() => setIssueModal({ mode: "create" })}
            onEdit={(issue) => setIssueModal({ mode: "edit", issue })}
          />
        )}
      </div>

      {cycleModal && (
        <CycleFormModal
          mode={cycleModal.mode}
          cycle={cycleModal.mode === "edit" ? cycleModal.cycle : null}
          roster={
            cycleModal.mode === "edit"
              ? (snap?.roster.filter((r) => r.cycle_id === cycleModal.cycle.id) ?? [])
              : []
          }
          projects={projectPickerOptions}
          onClose={() => setCycleModal(null)}
          onSubmit={async (input) => {
            setError("");
            try {
              if (cycleModal.mode === "edit") {
                await runSave(() => securityStore.updateCycle(cycleModal.cycle.id, input));
                setCycleModal(null);
                await refresh();
              } else {
                const cycle = await runSave(() => securityStore.createCycle(input));
                setCycleModal(null);
                await refresh();
                setActiveCycleId(cycle.id);
                setTab("overview");
              }
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              throw err;
            }
          }}
        />
      )}

      {issueModal && (
        <IssueModal
          mode={issueModal.mode}
          issue={issueModal.issue}
          onClose={() => setIssueModal(null)}
          onSave={async (input) => {
            setError("");
            try {
              await runSave(async () => {
                if (issueModal.mode === "edit" && issueModal.issue) {
                  const prev = issueModal.issue;
                  await securityStore.updateIssue(prev.id, {
                    ...input,
                    cycle_ids: prev.cycle_ids,
                    project_ids: prev.project_ids,
                    project_names: prev.project_names,
                  });
                } else {
                  await securityStore.createIssue(input);
                }
              });
              setIssueModal(null);
              await refresh();
              if (detailCycleId) {
                const doc = await securityStore.loadCycleDetail(detailCycleId);
                setDetailDoc(doc);
              }
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              throw err;
            }
          }}
          onDelete={
            canManageStructure && issueModal.mode === "edit" && issueModal.issue
              ? async () => {
                  setError("");
                  const id = issueModal.issue!.id;
                  await runSave(() => securityStore.deleteIssue(id));
                  setIssueModal(null);
                  await refresh();
                  if (detailCycleId) {
                    const doc = await securityStore.loadCycleDetail(detailCycleId);
                    setDetailDoc(doc);
                  }
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

function OverviewPanel({
  cycles,
  allCycles,
  activeCycle,
  roster,
  metrics,
  projects,
  personnel,
  profileName,
  canManageStructure,
  onSelectCycle,
  onOpenDetail,
  onNewCycle,
  onEditCycle,
  onPatchRoster,
  onPatchRosterMany,
}: {
  cycles: SecurityCycle[];
  allCycles: SecurityCycle[];
  activeCycle: SecurityCycle | null;
  roster: SecurityRosterEntry[];
  metrics: ReturnType<typeof cycleMetrics>;
  projects: { id: string; name: string; lenovo_name?: string }[];
  personnel: Profile[];
  profileName: (id: string | null) => string | null;
  canManageStructure: boolean;
  onSelectCycle: (id: string) => void;
  onOpenDetail: () => void;
  onNewCycle: () => void;
  onEditCycle: () => void;
  onPatchRoster: (id: string, patch: SecurityRosterPatch) => void;
  onPatchRosterMany: (ids: string[], patch: SecurityRosterPatch) => Promise<void>;
}) {
  const [batchModal, setBatchModal] = useState<null | "wave" | "reviewer">(null);

  const projectById = useMemo(() => {
    const map = new Map<string, { id: string; name: string; lenovo_name?: string }>();
    for (const p of projects) map.set(p.id, p);
    // Also index by Compal name for seed/legacy roster rows whose project_id is not a UUID.
    for (const p of projects) {
      if (p.name && !map.has(p.name)) map.set(p.name, p);
    }
    return map;
  }, [projects]);

  const cycleWaves = normalizeCycleWaves(
    activeCycle ?? { waves: [], wave1_date: "", wave2_date: "", external_release_date: "" },
  );
  const waveSelectOptions = rosterWaveOptions(activeCycle);

  const waveProjectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of roster) {
      const key = (row.wave || "").trim();
      if (!key || key === "Not set") continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [roster]);

  const timeline = cycleWaves
    .map((w) => {
      const d = securityDisplayDate(w.target_date);
      const n = waveProjectCounts.get(w.name.trim()) ?? 0;
      const label = d ? `${w.name} ${d}` : w.name;
      return `${label} (${n})`;
    })
    .join(" · ");

  const otherFooter = allCycles
    .filter((c) => c.id !== activeCycle?.id)
    .map((c) => `${c.quarter} · ${c.project_ids.length} projects`)
    .join(" · ");

  return (
    <>
      <section className="sec-cycle-card" aria-label="Active cycle">
        <div className="sec-cycle-main">
          <p className="sec-cycle-label">Active cycle</p>
          {activeCycle ? (
            <button
              type="button"
              className="sec-cycle-title-btn"
              onClick={onOpenDetail}
              title="Open cycle detail"
            >
              <h1 className="sec-cycle-title">{activeCycle.name}</h1>
            </button>
          ) : (
            <h1 className="sec-cycle-title">—</h1>
          )}
          <p className="sec-cycle-sub">
            {metrics.total} projects across {metrics.waves} waves
          </p>
          {timeline ? (
            <p className="sec-cycle-timeline">{timeline}</p>
          ) : (
            <p className="sec-cycle-timeline is-empty">No waves yet</p>
          )}
        </div>
        <div className="sec-cycle-metrics" aria-label="Cycle metrics">
          <Metric label="Internal release" value={metrics.internal} total={metrics.total} tone="warn" />
          <Metric label="SA BVT" value={metrics.saBvt} total={metrics.total} tone="link" />
          <Metric label="Completed" value={metrics.completed} total={metrics.total} tone="ok" />
        </div>
        {canManageStructure ? (
          <div className="sec-cycle-actions">
            <button
              type="button"
              className="sec-edit-cycle"
              onClick={onEditCycle}
              disabled={!activeCycle}
            >
              Edit
            </button>
            <button type="button" className="sec-new-cycle" onClick={onNewCycle}>
              <span aria-hidden="true">+</span> New cycle
            </button>
          </div>
        ) : null}
      </section>

      <div className="sec-cycle-pills" role="tablist" aria-label="Cycles">
        {cycles.map((c) => {
          const count = c.project_ids.length;
          const active = c.id === activeCycle?.id;
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`sec-cycle-pill${active ? " is-active" : ""}`}
              onClick={() => onSelectCycle(c.id)}
            >
              <span>{c.quarter}</span>
              <strong>{count}</strong>
            </button>
          );
        })}
      </div>

      <section className="sec-roster" aria-label="Project roster">
        <div className="sec-roster-head">
          <h2>Project roster</h2>
          <p>
            {roster.length} {roster.length === 1 ? "entry" : "entries"}
          </p>
        </div>
        <div className="sec-roster-table-wrap">
          <table className="sec-roster-table">
            <thead>
              <tr>
                <th>Compal Project name</th>
                <th>Lenovo Project Name</th>
                <th>
                  Wave{" "}
                  {canManageStructure ? (
                    <button
                      type="button"
                      className="sec-th-affordance"
                      onClick={() => setBatchModal("wave")}
                      disabled={roster.length === 0}
                      aria-label="Batch assign Wave"
                      title="Batch assign Wave"
                    >
                      +
                    </button>
                  ) : null}
                </th>
                <th>Owner</th>
                <th>
                  Reviewer{" "}
                  {canManageStructure ? (
                    <button
                      type="button"
                      className="sec-th-affordance"
                      onClick={() => setBatchModal("reviewer")}
                      disabled={roster.length === 0}
                      aria-label="Batch assign Reviewer"
                      title="Batch assign Reviewer"
                    >
                      +
                    </button>
                  ) : null}
                </th>
                <th>SA Owner</th>
                <th>PM Owner</th>
                <th>DQA Owner</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {roster.length === 0 ? (
                <tr>
                  <td colSpan={9} className="sec-roster-empty">
                    0 entries
                  </td>
                </tr>
              ) : (
                roster.map((row) => {
                  const options =
                    row.wave !== "Not set" && !waveSelectOptions.includes(row.wave)
                      ? [...waveSelectOptions, row.wave]
                      : waveSelectOptions;
                  const linked =
                    projectById.get(row.project_id) ?? projectById.get(row.project_name);
                  const lenovoName = (linked?.lenovo_name ?? "").trim() || "—";
                  return (
                  <tr key={row.id}>
                    <td className="sec-proj-name">{row.project_name}</td>
                    <td className="sec-lenovo-name">{lenovoName}</td>
                    <td>
                      <label className="sec-wave-cell">
                        <span
                          className={`sec-dot${row.wave === "Not set" ? " is-teal" : " is-ok"}`}
                          aria-hidden="true"
                        />
                        <select
                          className="sec-roster-select"
                          value={options.includes(row.wave) ? row.wave : "Not set"}
                          onChange={(e) => onPatchRoster(row.id, { wave: e.target.value })}
                          aria-label={`Wave for ${row.project_name}`}
                        >
                          {options.map((w) => (
                            <option key={w} value={w}>
                              {w}
                            </option>
                          ))}
                        </select>
                      </label>
                    </td>
                    <td>
                      <PersonCell
                        name={profileName(row.owner_id)}
                        personnel={personnel}
                        value={row.owner_id}
                        onChange={(owner_id) => onPatchRoster(row.id, { owner_id })}
                        ariaLabel={`Owner for ${row.project_name}`}
                      />
                    </td>
                    <td>
                      <PersonCell
                        name={profileName(row.reviewer_id)}
                        personnel={personnel}
                        value={row.reviewer_id}
                        onChange={(reviewer_id) => onPatchRoster(row.id, { reviewer_id })}
                        ariaLabel={`Reviewer for ${row.project_name}`}
                      />
                    </td>
                    <td>
                      <RosterTextCell
                        value={row.sa_owner}
                        onCommit={(sa_owner) => onPatchRoster(row.id, { sa_owner })}
                        ariaLabel={`SA Owner for ${row.project_name}`}
                      />
                    </td>
                    <td>
                      <RosterTextCell
                        value={row.pm_owner}
                        onCommit={(pm_owner) => onPatchRoster(row.id, { pm_owner })}
                        ariaLabel={`PM Owner for ${row.project_name}`}
                      />
                    </td>
                    <td>
                      <RosterTextCell
                        value={row.dqa_owner}
                        onCommit={(dqa_owner) => onPatchRoster(row.id, { dqa_owner })}
                        ariaLabel={`DQA Owner for ${row.project_name}`}
                      />
                    </td>
                    <td>
                      <span
                        className="sec-status-pill sec-status-derived"
                        title="Derived from Project Release Tracking (Internal / SA BVT / External Web / WU → Done)"
                      >
                        <span
                          className={`sec-dot${
                            row.status === "Completed"
                              ? " is-ok"
                              : row.status === "Not Started"
                                ? " is-muted"
                                : " is-warn"
                          }`}
                          aria-hidden="true"
                        />
                        <span className="sec-status-derived-label">{row.status}</span>
                      </span>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {otherFooter ? <p className="sec-roster-footer">{otherFooter}</p> : null}
      </section>

      {batchModal === "wave" && (
        <BatchAssignModal
          kind="wave"
          roster={roster}
          waveOptions={waveSelectOptions}
          personnel={personnel}
          onClose={() => setBatchModal(null)}
          onApply={async (ids, patch) => {
            await onPatchRosterMany(ids, patch);
            setBatchModal(null);
          }}
        />
      )}
      {batchModal === "reviewer" && (
        <BatchAssignModal
          kind="reviewer"
          roster={roster}
          waveOptions={waveSelectOptions}
          personnel={personnel}
          onClose={() => setBatchModal(null)}
          onApply={async (ids, patch) => {
            await onPatchRosterMany(ids, patch);
            setBatchModal(null);
          }}
        />
      )}
    </>
  );
}

/** AIOSW-style batch assign: pick Wave/Reviewer, multi-select projects, Apply. */
function BatchAssignModal({
  kind,
  roster,
  waveOptions,
  personnel,
  onClose,
  onApply,
}: {
  kind: "wave" | "reviewer";
  roster: SecurityRosterEntry[];
  waveOptions: string[];
  personnel: Profile[];
  onClose: () => void;
  onApply: (ids: string[], patch: SecurityRosterPatch) => Promise<void>;
}) {
  const [wave, setWave] = useState(waveOptions[0] ?? "Not set");
  const [reviewerId, setReviewerId] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const allIds = useMemo(() => roster.map((r) => r.id), [roster]);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(allIds));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (selected.size === 0) {
      setError("Select at least one project");
      return;
    }
    if (kind === "reviewer" && !reviewerId) {
      setError("Choose a reviewer");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const ids = [...selected];
      if (kind === "wave") {
        await onApply(ids, { wave });
      } else {
        await onApply(ids, { reviewer_id: reviewerId });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const title = kind === "wave" ? "Batch assign Wave" : "Batch assign Reviewer";
  const hint =
    kind === "wave"
      ? "Choose a wave, select projects, then Apply. Row order stays fixed."
      : "Choose a reviewer, select projects, then Apply.";

  return (
    <div className="sec-modal-backdrop" onClick={onClose}>
      <form
        className="sec-modal sec-batch-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <div className="sec-modal-head">
          <div>
            <h2>{title}</h2>
            <p>{hint}</p>
          </div>
          <button type="button" className="sec-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {kind === "wave" ? (
          <label className="sec-field">
            <span>Wave</span>
            <select
              className="sec-roster-select sec-batch-select"
              value={wave}
              onChange={(e) => setWave(e.target.value)}
              disabled={busy}
            >
              {waveOptions.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="sec-field">
            <span>Reviewer</span>
            <select
              className="sec-roster-select sec-batch-select"
              value={reviewerId}
              onChange={(e) => setReviewerId(e.target.value)}
              disabled={busy}
            >
              <option value="">Select reviewer…</option>
              {personnel.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="sec-projects-picker-head">
          <span>
            Projects <strong>{selected.size}</strong> / {roster.length}
          </span>
          <button type="button" className="sec-add-wave-link" onClick={toggleAll} disabled={busy}>
            {allSelected ? "Clear all" : "Select all"}
          </button>
        </div>
        <ul className="sec-project-checklist sec-batch-checklist">
          {roster.map((row) => (
            <li key={row.id}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.has(row.id)}
                  onChange={() => toggle(row.id)}
                  disabled={busy}
                />
                <span className="sec-check-name">{row.project_name}</span>
                <span className="sec-check-blurb">
                  {kind === "wave"
                    ? row.wave
                    : row.reviewer_id
                      ? personnel.find((p) => p.id === row.reviewer_id)?.display_name ?? "—"
                      : "—"}
                </span>
              </label>
            </li>
          ))}
        </ul>

        {error && <p className="sec-error">{error}</p>}

        <div className="sec-modal-actions">
          <button type="button" className="sec-btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className="sec-btn-primary"
            disabled={busy || selected.size === 0}
          >
            {busy ? "Applying…" : `Apply to ${selected.size || "…"}`}
          </button>
        </div>
      </form>
    </div>
  );
}

function Metric({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: "warn" | "link" | "ok";
}) {
  return (
    <div className={`sec-metric sec-metric-${tone}`}>
      <span className="sec-metric-label">{label}</span>
      <span className="sec-metric-value">
        <strong>{value}</strong>
        <span> of {total}</span>
      </span>
    </div>
  );
}

function PersonCell({
  name,
  personnel,
  value,
  onChange,
  ariaLabel,
}: {
  name: string | null;
  personnel: Profile[];
  value: string | null;
  onChange: (id: string | null) => void;
  ariaLabel: string;
}) {
  return (
    <label className="sec-person-cell">
      <span className="sec-avatar" aria-hidden="true">
        {name ? initials(name) : "—"}
      </span>
      <select
        className="sec-roster-select"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={ariaLabel}
      >
        <option value="">—</option>
        {personnel.map((p) => (
          <option key={p.id} value={p.id}>
            {p.display_name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Free-text SA/PM/DQA Owner — type individually; Save on blur / Enter. */
function RosterTextCell({
  value,
  onCommit,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    const next = draft.trim();
    if (next !== (value ?? "").trim()) onCommit(next);
    else if (draft !== value) setDraft(value);
  };

  return (
    <input
      type="text"
      className="sec-roster-text-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      aria-label={ariaLabel}
      placeholder="—"
    />
  );
}

function IssueSummaryPanel({
  cycles,
  issues,
  totalIssueCount,
  issueCounts,
  filter,
  canManageStructure,
  onFilter,
  onAdd,
  onEdit,
}: {
  cycles: SecurityCycle[];
  issues: SecurityIssue[];
  totalIssueCount: number;
  issueCounts: Map<string, number>;
  filter: string;
  canManageStructure: boolean;
  onFilter: (id: string) => void;
  onAdd: () => void;
  onEdit: (issue: SecurityIssue) => void;
}) {
  return (
    <section className="sec-issues" aria-label="Issue Summary">
      <div className="sec-issues-head">
        <div>
          <h1>Issue Summary</h1>
          <p>Create each security update item once, then reuse it in any cycle.</p>
        </div>
        {canManageStructure ? (
          <button type="button" className="sec-add-issue" onClick={onAdd} aria-label="Add issue">
            +
          </button>
        ) : null}
      </div>

      <div className="sec-issue-filters" role="tablist" aria-label="Filter by cycle">
        <button
          type="button"
          className={`sec-issue-filter${filter === "all" ? " is-active" : ""}`}
          onClick={() => onFilter("all")}
        >
          All <strong>{totalIssueCount}</strong>
        </button>
        {cycles.map((c, i) => (
          <button
            key={c.id}
            type="button"
            className={`sec-issue-filter ${cycleTone(i)}${filter === c.id ? " is-active" : ""}`}
            onClick={() => onFilter(c.id)}
          >
            {c.quarter} <strong>{issueCounts.get(c.id) ?? 0}</strong>
          </button>
        ))}
      </div>

      <ul className="sec-issue-list">
        {issues.length === 0 ? (
          <li className="sec-issue-empty">No security update items yet.</li>
        ) : (
          issues.map((issue) => (
            <li key={issue.id} className="sec-issue-card">
              <div className="sec-issue-card-top">
                <h3>{issue.title}</h3>
                <button type="button" className="sec-edit-btn" onClick={() => onEdit(issue)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                  Edit
                </button>
              </div>
              <dl className="sec-issue-meta">
                <div>
                  <dt>OEM Request ID</dt>
                  <dd>{issue.oem_request_id || "—"}</dd>
                </div>
                {issue.detail ? (
                  <div className="sec-issue-detail">
                    <dd>{issue.detail}</dd>
                  </div>
                ) : null}
                {issue.reference_path ? (
                  <div className="sec-issue-reference">
                    <dt>Reference</dt>
                    <dd>{issue.reference_path}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Cycles</dt>
                  <dd className="sec-issue-cycles">
                    {issue.cycle_ids.length === 0
                      ? "—"
                      : issue.cycle_ids.map((cid) => {
                          const idx = cycles.findIndex((c) => c.id === cid);
                          const c = cycles[idx];
                          if (!c) return null;
                          return (
                            <span key={cid} className={`sec-mini-pill ${cycleTone(Math.max(0, idx))}`}>
                              {c.quarter}
                            </span>
                          );
                        })}
                  </dd>
                </div>
                <div>
                  <dt>Projects</dt>
                  <dd className="sec-issue-projects">{issue.project_names || "—"}</dd>
                </div>
              </dl>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

function CycleFormModal({
  mode,
  cycle,
  roster,
  projects,
  onClose,
  onSubmit,
}: {
  mode: "create" | "edit";
  cycle: SecurityCycle | null;
  roster: SecurityRosterEntry[];
  projects: { id: string; name: string; blurb: string }[];
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    cycle_type: string;
    quarter: string;
    wave1_date: string;
    wave2_date: string;
    external_release_date: string;
    waves: SecurityWave[];
    projects: { id: string; name: string }[];
  }) => Promise<void>;
}) {
  const isEdit = mode === "edit";
  const quarterDefault = defaultQuarterLabel();

  const [name, setName] = useState(isEdit && cycle ? cycle.name : `${quarterDefault} AIO`);
  const [cycleType, setCycleType] = useState(isEdit && cycle ? cycle.cycle_type : "Quarter");
  const [quarter, setQuarter] = useState(isEdit && cycle ? cycle.quarter : quarterDefault);
  const [waves, setWaves] = useState<SecurityWave[]>(() => {
    if (isEdit && cycle) {
      const w = normalizeCycleWaves(cycle);
      if (w.length > 0) return w.map((x) => ({ ...x, id: x.id || newWaveId() }));
      return [
        { id: newWaveId(), name: "Wave 1", target_date: "" },
        { id: newWaveId(), name: "Wave 2", target_date: "" },
      ];
    }
    return [
      { id: newWaveId(), name: "Wave 1", target_date: "" },
      { id: newWaveId(), name: "Wave 2", target_date: "" },
      { id: newWaveId(), name: "External Release", target_date: "" },
    ];
  });
  const [selected, setSelected] = useState<Set<string>>(() => {
    if (isEdit) return new Set(roster.map((r) => r.project_id));
    return new Set();
  });
  /** Freeze project id order when the modal opens so checking boxes never reorders the list. */
  const [projectOrder] = useState(() => projects.map((p) => p.id));
  const [projQuery, setProjQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const filtered = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const ordered: { id: string; name: string; blurb: string }[] = [];
    for (const id of projectOrder) {
      const p = byId.get(id);
      if (p) ordered.push(p);
    }
    for (const p of projects) {
      if (!projectOrder.includes(p.id)) ordered.push(p);
    }
    const q = projQuery.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.blurb.toLowerCase().includes(q),
    );
  }, [projects, projectOrder, projQuery]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateWave = (id: string, patch: Partial<Pick<SecurityWave, "name" | "target_date">>) => {
    setWaves((prev) => prev.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  };

  const addWave = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setWaves((prev) => [
      ...prev,
      { id: newWaveId(), name: `Wave ${prev.length + 1}`, target_date: "" },
    ]);
  };

  const removeWave = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setWaves((prev) => (prev.length <= 1 ? prev : prev.filter((w) => w.id !== id)));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError("");
    if (!name.trim() || !quarter.trim()) {
      setFormError("Name and quarter are required");
      return;
    }
    const cleanedWaves = waves
      .map((w, i) => ({
        ...w,
        name: w.name.trim() || `Wave ${i + 1}`,
        target_date: w.target_date.trim(),
      }))
      .filter((w) => w.name);
    if (cleanedWaves.length === 0) {
      setFormError("Add at least one wave");
      return;
    }
    if (selected.size === 0) {
      setFormError("Select at least one project");
      return;
    }
    setBusy(true);
    try {
      await onSubmit({
        name,
        cycle_type: cycleType,
        quarter,
        wave1_date: cleanedWaves[0]?.target_date ?? "",
        wave2_date: cleanedWaves[1]?.target_date ?? "",
        external_release_date: cleanedWaves[2]?.target_date ?? "",
        waves: cleanedWaves,
        projects: projectOrder
          .map((id) => projects.find((p) => p.id === id))
          .filter((p): p is { id: string; name: string; blurb: string } => Boolean(p) && selected.has(p!.id))
          .map((p) => ({ id: p.id, name: p.name })),
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sec-modal-backdrop" onClick={onClose}>
      <form
        className="sec-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <div className="sec-modal-head">
          <div>
            <h2>{isEdit ? "Edit Security Update Cycle" : "Add Security Update Cycle"}</h2>
            <p>Define release targets and choose the projects needed for this update</p>
          </div>
          <button type="button" className="sec-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <label className="sec-field">
          <span>Canonical name *</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>

        <div className="sec-field-row">
          <label className="sec-field">
            <span>Cycle type *</span>
            <select value={cycleType} onChange={(e) => setCycleType(e.target.value)}>
              <option value="Quarter">Quarter</option>
              <option value="Custom">Custom</option>
            </select>
          </label>
          <label className="sec-field">
            <span>Quarter *</span>
            <input value={quarter} onChange={(e) => setQuarter(e.target.value)} required placeholder="2026 Q4" />
          </label>
        </div>

        <div className="sec-waves-fields">
          <div className="sec-waves-fields-head">
            <span>Waves *</span>
            <button type="button" className="sec-add-wave-link" onClick={addWave}>
              + Add wave
            </button>
          </div>
          <div className="sec-waves-grid">
            {waves.map((w, i) => (
              <div key={w.id} className="sec-wave-field">
                <div className="sec-wave-field-label">
                  <input
                    type="text"
                    className="sec-wave-name-input"
                    value={w.name}
                    onChange={(e) => updateWave(w.id, { name: e.target.value })}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Wave ${i + 1} name`}
                    placeholder="Wave name"
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="sec-wave-remove"
                    onClick={(e) => removeWave(e, w.id)}
                    disabled={waves.length <= 1}
                    aria-label={`Remove ${w.name || `wave ${i + 1}`}`}
                  >
                    ×
                  </button>
                </div>
                <input
                  type="date"
                  className="sec-wave-date-input"
                  value={w.target_date}
                  onChange={(e) => updateWave(w.id, { target_date: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`${w.name || `Wave ${i + 1}`} target date`}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="sec-projects-picker">
          <div className="sec-projects-picker-head">
            <span>Update Projects *</span>
            <span className="sec-muted">
              Selected {selected.size} of {projects.length}
            </span>
          </div>
          <label className="sec-search sec-search-block">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3-3" />
            </svg>
            <input
              value={projQuery}
              onChange={(e) => setProjQuery(e.target.value)}
              placeholder="Search project code, name, platform or BIOS ID..."
            />
          </label>
          <ul className="sec-project-checklist">
            {filtered.length === 0 ? (
              <li className="sec-muted">No projects match</li>
            ) : (
              filtered.map((p) => (
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

        {formError ? <p className="sec-error">{formError}</p> : null}

        <div className="sec-modal-actions">
          <button type="button" className="sec-btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="sec-btn-primary" disabled={busy}>
            {busy ? (isEdit ? "Saving…" : "Creating…") : isEdit ? "Save" : "Create cycle"}
          </button>
        </div>
      </form>
    </div>
  );
}

function IssueModal({
  mode,
  issue,
  onClose,
  onSave,
  onDelete,
}: {
  mode: "create" | "edit";
  issue?: SecurityIssue;
  onClose: () => void;
  onSave: (input: {
    title: string;
    oem_request_id?: string;
    detail?: string;
    reference_path?: string;
  }) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const isEdit = mode === "edit";
  const [title, setTitle] = useState(issue?.title ?? "");
  const [oem, setOem] = useState(issue?.oem_request_id ?? "");
  const [detail, setDetail] = useState(issue?.detail ?? "");
  const [referencePath, setReferencePath] = useState(issue?.reference_path ?? "");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setFormError("Title is required");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      await onSave({
        title,
        oem_request_id: oem,
        detail,
        reference_path: referencePath,
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    if (!window.confirm("Delete this security update item? It will be removed from linked cycles.")) {
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      await onDelete();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sec-modal-backdrop" onClick={onClose}>
      <form
        className="sec-modal sec-modal-issue"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <div className="sec-modal-head">
          <div>
            <h2>{isEdit ? "Edit Security Update Item" : "Add Security Update Item"}</h2>
            <p>
              {isEdit
                ? "Changes are synchronized to every linked cycle."
                : "Create once, then reuse in any cycle via + New item."}
            </p>
          </div>
          <button type="button" className="sec-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <label className="sec-field">
          <span>Title *</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
        </label>
        <label className="sec-field">
          <span>OEM Request ID</span>
          <input value={oem} onChange={(e) => setOem(e.target.value)} />
        </label>
        <label className="sec-field">
          <span>Issue Details (Optional)</span>
          <textarea value={detail} onChange={(e) => setDetail(e.target.value)} rows={3} />
        </label>
        <label className="sec-field">
          <span>Reference Path (Optional)</span>
          <input
            value={referencePath}
            onChange={(e) => setReferencePath(e.target.value)}
            placeholder={"https://... or \\\\server\\share\\..."}
          />
        </label>

        {formError ? <p className="sec-error">{formError}</p> : null}

        <div className={`sec-modal-actions${isEdit && onDelete ? " sec-modal-actions-split" : ""}`}>
          {isEdit && onDelete ? (
            <button
              type="button"
              className="sec-btn-danger"
              onClick={() => void handleDelete()}
              disabled={busy}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14H6L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4h6v2" />
              </svg>
              Delete
            </button>
          ) : (
            <button type="button" className="sec-btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          )}
          <button type="submit" className="sec-btn-primary sec-btn-save-changes" disabled={busy}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
              <polyline points="17 21 17 13 7 13 7 21" />
              <polyline points="7 3 7 8 15 8" />
            </svg>
            {busy ? "Saving…" : isEdit ? "Save changes" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}
