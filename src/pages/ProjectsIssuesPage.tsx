import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  EMPTY_ISSUE_COLUMN_FILTERS,
  IssueColumnFilter,
  type IssueColumnFilters,
} from "../components/IssueColumnFilter";
import { LoadingIndicator } from "../components/LoadingIndicator";
import { SavingIndicator } from "../components/SavingIndicator";
import {
  addAnalyzedNote,
  analyzedNoteCredit,
  makeAnalyzedNote,
  syncAnalyzedFields,
  updateAnalyzedNote,
} from "../lib/analyzed";
import { api } from "../lib/api";
import { addDaysISO, todayISO } from "../lib/dates";
import {
  isStandardProjectColumnId,
  PROJECT_LOCKED_COLUMN,
  projectsUiStore,
  standardKeyForColumn,
  type ProjectFieldPatch,
  type ProjectStandardKey,
} from "../lib/projectsUiStore";
import { areProjectCheckpointsComplete } from "../lib/projectCheckpoints";
import {
  isTaskOpen,
  normalizePersonnelRole,
  TASK_STATUSES,
  type AnalyzedNote,
  type Profile,
  type Project,
  type ProjectCheckpoint,
  type ProjectColumn,
  type Task,
  type TaskStatus,
} from "../lib/types";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";
import { useSaveStatus } from "../lib/useSaveStatus";

type StatusFilter = "all" | TaskStatus;

function compareTasksStable(a: Task, b: Task): number {
  const byCreated = (a.created_at ?? "").localeCompare(b.created_at ?? "");
  if (byCreated !== 0) return byCreated;
  return a.id.localeCompare(b.id);
}

function columnsSignature(columns: ProjectColumn[]): string {
  return columns.map((c) => `${c.id}:${c.label}`).join("|");
}

function mergeProjectDraft(project: Project, patch: ProjectFieldPatch | undefined): Project {
  if (!patch) return project;
  return {
    ...project,
    name: patch.name !== undefined ? patch.name : project.name,
    description: patch.description !== undefined ? patch.description : project.description,
    lenovo_name: patch.lenovo_name !== undefined ? patch.lenovo_name : project.lenovo_name,
    bios_id: patch.bios_id !== undefined ? patch.bios_id : project.bios_id,
    platform: patch.platform !== undefined ? patch.platform : project.platform,
    dis: patch.dis !== undefined ? patch.dis : project.dis,
    ss_date: patch.ss_date !== undefined ? patch.ss_date : project.ss_date,
    eol_date: patch.eol_date !== undefined ? patch.eol_date : project.eol_date,
    security_update:
      patch.security_update !== undefined ? patch.security_update : project.security_update,
    talent_policy: patch.talent_policy !== undefined ? patch.talent_policy : project.talent_policy,
    owner: patch.owner !== undefined ? patch.owner : project.owner,
    project_owner: patch.project_owner !== undefined ? patch.project_owner : project.project_owner,
    tpe_owner: patch.tpe_owner !== undefined ? patch.tpe_owner : project.tpe_owner,
    custom: { ...(project.custom ?? {}), ...(patch.custom ?? {}) },
    checkpoints: patch.checkpoints !== undefined ? patch.checkpoints : project.checkpoints,
  };
}

function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toUpperCase();
}

function statusTone(status: TaskStatus): string {
  return `pi-state pi-state-${status}`;
}

function AnalysisInline({
  notes,
  profiles,
  canEdit,
  userId,
  onSave,
}: {
  notes: AnalyzedNote[];
  profiles: Profile[];
  canEdit: boolean;
  userId: string | undefined;
  onSave: (next: AnalyzedNote[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const value = draft.trim();
    if (!value || !userId) return;
    setDraft("");
    onSave(addAnalyzedNote(notes, value, userId));
  };

  return (
    <div className="pi-analysis">
      {notes.map((note) => {
        const credit = analyzedNoteCredit(note, profiles);
        return (
          <div key={note.id} className="pi-analysis-note">
            <p>{note.text}</p>
            {credit && <span className="pi-muted">{credit}</span>}
            {canEdit && (
              <button
                type="button"
                className="pi-linkish"
                onClick={() => {
                  const next = window.prompt("Edit analysis", note.text);
                  if (next == null || !userId) return;
                  onSave(updateAnalyzedNote(notes, note.id, next, userId));
                }}
              >
                Edit
              </button>
            )}
          </div>
        );
      })}
      {canEdit && (
        <div className="pi-analysis-add">
          <textarea
            rows={2}
            value={draft}
            placeholder={notes.length ? "Add analysis note" : "Analysis"}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="button" disabled={!draft.trim()} onClick={add}>
            Add
          </button>
        </div>
      )}
      {!canEdit && notes.length === 0 && <span className="pi-muted">—</span>}
    </div>
  );
}

export function ProjectsIssuesPage({ onGoDashboard }: { onGoDashboard: () => void }) {
  const { user } = useAuth();
  const {
    projects,
    setProjectId,
    projectId,
    project,
    reload,
    patchProjectsLocal,
    role,
    allTasks,
    profiles,
    allMembers,
    leaderProjectIds,
    canLeadProject,
    members,
    initialLoading,
    loadError,
  } = useStore();

  const [mode, setMode] = useState<"list" | "detail">("list");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [moreOpen, setMoreOpen] = useState(false);
  const [addColOpen, setAddColOpen] = useState(false);
  const [removeColOpen, setRemoveColOpen] = useState(false);
  const [newColLabel, setNewColLabel] = useState("");
  const [removeColId, setRemoveColId] = useState("");
  /** Managed middle + custom columns (everything except Compal name + Actions). */
  const [managedColumns, setManagedColumns] = useState<ProjectColumn[]>([]);
  /** Admin edit-mode draft: column membership + display order (not persisted until Save). */
  const [editMode, setEditMode] = useState(false);
  const [draftColumns, setDraftColumns] = useState<ProjectColumn[]>([]);
  const [draftPatches, setDraftPatches] = useState<Record<string, ProjectFieldPatch>>({});
  const [columnsLoading, setColumnsLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const { saveStatus, runSave } = useSaveStatus();
  const listLoading = initialLoading || columnsLoading;
  const displayError = error || loadError;

  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState(user?.id ?? "");
  const [start, setStart] = useState(todayISO());
  const [due, setDue] = useState(addDaysISO(todayISO(), 3));
  const [newStatus, setNewStatus] = useState<TaskStatus>("opening");
  const [analyzed, setAnalyzed] = useState("");
  const [showNewIssue, setShowNewIssue] = useState(false);
  const [colFilters, setColFilters] = useState<IssueColumnFilters>(EMPTY_ISSUE_COLUMN_FILTERS);
  /** Project id whose CheckPoint handover modal is open. */
  const [checkpointProjectId, setCheckpointProjectId] = useState<string | null>(null);
  const [checkpointDraft, setCheckpointDraft] = useState<ProjectCheckpoint[]>([]);
  const [checkpointAddText, setCheckpointAddText] = useState("");

  const setColFilter = <K extends keyof IssueColumnFilters>(key: K, value: IssueColumnFilters[K]) => {
    setColFilters((prev) => ({ ...prev, [key]: value }));
  };

  /** Match Personnel: Neon overlays may set personnel_role Admin while raw is_admin lags. */
  const isAdmin = Boolean(user && normalizePersonnelRole(user) === "Admin");
  const canCreate = Boolean(isAdmin || role === "leader");
  /** Column tools (+ ADD / Remove / reorder) only while Admin is in edit mode on the list. */
  const canManageColumns = isAdmin && mode === "list" && editMode;
  const visibleColumns = editMode ? draftColumns : managedColumns;
  const editDirty =
    editMode &&
    (Object.keys(draftPatches).length > 0 ||
      columnsSignature(draftColumns) !== columnsSignature(managedColumns));

  const refreshProjectColumns = async () => {
    try {
      setManagedColumns(await api.listProjectColumns());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load columns failed");
    } finally {
      setColumnsLoading(false);
    }
  };

  useEffect(() => {
    setColumnsLoading(true);
    void refreshProjectColumns();
  }, []);

  const nameOf = (id: string | null) => profiles.find((p) => p.id === id)?.display_name ?? "Unassigned";

  /** Resolve owner cell → Personnel option value (prefer display_name; keep orphans selectable). */
  const ownerSelectValue = (raw: string | undefined): string => {
    const value = (raw ?? "").trim();
    if (!value) return "";
    const byDisplay = profiles.find(
      (p) => p.display_name.trim().toLowerCase() === value.toLowerCase(),
    );
    if (byDisplay) return byDisplay.display_name;
    const byUsername = profiles.find(
      (p) => (p.username ?? "").trim().toLowerCase() === value.toLowerCase(),
    );
    if (byUsername) return byUsername.display_name;
    return value;
  };

  const personnelOwnerOptions = useMemo(() => {
    return [...profiles].sort((a, b) =>
      a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" }),
    );
  }, [profiles]);

  const projectRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      if (!q) return true;
      const hay = [
        p.name,
        p.description,
        p.lenovo_name,
        p.bios_id,
        p.platform,
        p.dis,
        p.ss_date,
        p.eol_date,
        p.security_update,
        p.talent_policy,
        p.owner,
        p.project_owner,
        p.tpe_owner,
        ...Object.values(p.custom ?? {}),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [projects, query]);

  const standardFieldValue = (project: Project, key: ProjectStandardKey): string => {
    return (project[key] as string | undefined) ?? "";
  };

  const setDraftField = (projectId: string, patch: ProjectFieldPatch) => {
    setDraftPatches((prev) => {
      const prior = prev[projectId] ?? {};
      const next: ProjectFieldPatch = { ...prior, ...patch };
      if (patch.custom !== undefined) {
        next.custom = { ...(prior.custom ?? {}), ...patch.custom };
      }
      return { ...prev, [projectId]: next };
    });
  };

  const closeColumnPopovers = () => {
    setAddColOpen(false);
    setRemoveColOpen(false);
    setMoreOpen(false);
    setNewColLabel("");
    setRemoveColId("");
  };

  const enterEditMode = () => {
    if (!isAdmin || mode !== "list") return;
    setError("");
    closeColumnPopovers();
    setDraftColumns(managedColumns.map((c) => ({ ...c })));
    setDraftPatches({});
    setEditMode(true);
  };

  const exitEditModeLocal = () => {
    setEditMode(false);
    setDraftColumns([]);
    setDraftPatches({});
    closeColumnPopovers();
  };

  const cancelEditMode = () => {
    if (editDirty && !window.confirm("Discard unsaved project and column changes?")) return;
    setError("");
    // Drafts are local only — discard without store reload / columnsLoading so the
    // list never blanks or trips PageLoadingGate after leaving edit mode.
    exitEditModeLocal();
  };

  const saveEditMode = async () => {
    if (!isAdmin || !editMode) return;
    if (!editDirty) {
      exitEditModeLocal();
      return;
    }
    setError("");
    setBusyId("edit-save");
    const columnsChanged = columnsSignature(draftColumns) !== columnsSignature(managedColumns);
    const patches = Object.entries(draftPatches);
    const savedColumns = draftColumns.map((c) => ({ ...c }));
    const savedPatches = { ...draftPatches };
    try {
      await runSave(async () => {
        if (columnsChanged) {
          await api.replaceProjectColumns(savedColumns);
        }
        if (patches.length > 0) {
          await Promise.all(patches.map(([id, patch]) => api.updateProject(id, patch)));
        }
      });
      // Keep rows visible immediately: apply drafts locally, then soft-refresh.
      // Do not set columnsLoading / initialLoading — that was wiping the list.
      if (columnsChanged) setManagedColumns(savedColumns);
      if (Object.keys(savedPatches).length > 0) {
        patchProjectsLocal((prev) =>
          prev.map((p) => mergeProjectDraft(p, savedPatches[p.id])),
        );
      }
      exitEditModeLocal();
      try {
        await reload();
        if (columnsChanged) await refreshProjectColumns();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Reload failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusyId("");
    }
  };

  const onAddProjectColumn = (event: FormEvent) => {
    event.preventDefault();
    if (!isAdmin || !editMode) {
      setError("只有管理員可以在編輯模式新增欄位");
      return;
    }
    setError("");
    try {
      const col = projectsUiStore.buildColumn(newColLabel, draftColumns);
      setDraftColumns((prev) => [...prev, col]);
      setNewColLabel("");
      setAddColOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add column failed");
    }
  };

  const onRemoveProjectColumn = (event: FormEvent) => {
    event.preventDefault();
    if (!isAdmin || !editMode) {
      setError("只有管理員可以在編輯模式刪除欄位");
      return;
    }
    const col = draftColumns.find((c) => c.id === removeColId);
    if (!col) {
      setError("請選擇要刪除的欄位");
      return;
    }
    const keepValues = isStandardProjectColumnId(col.id);
    const ok = window.confirm(
      keepValues
        ? `Remove column “${col.label}”? You can re-add it later; existing cell values are kept.`
        : `Remove column “${col.label}”? Values will be deleted on Save.`,
    );
    if (!ok) return;
    setError("");
    setDraftColumns((prev) => prev.filter((c) => c.id !== col.id));
    if (!keepValues) {
      setDraftPatches((prev) => {
        const next: Record<string, ProjectFieldPatch> = {};
        for (const [id, patch] of Object.entries(prev)) {
          if (!patch.custom || !(col.id in patch.custom)) {
            next[id] = patch;
            continue;
          }
          const custom = { ...patch.custom };
          delete custom[col.id];
          next[id] = { ...patch, custom };
        }
        return next;
      });
    }
    setRemoveColId("");
    setRemoveColOpen(false);
    setMoreOpen(false);
    // Column membership is draft until Admin Save (same as field edits).
  };

  const moveDraftColumn = (columnId: string, delta: -1 | 1) => {
    setDraftColumns((prev) => {
      const index = prev.findIndex((c) => c.id === columnId);
      if (index < 0) return prev;
      const nextIndex = index + delta;
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return next;
    });
  };

  const listColSpan = 1 + visibleColumns.length + 1;

  const detailTasks = useMemo(() => {
    if (!project) return [] as Task[];
    const q = query.trim().toLowerCase();
    const noQ = colFilters.no.trim().toLowerCase();
    const nameQ = colFilters.name.trim().toLowerCase();
    const ownerQ = colFilters.owner.trim().toLowerCase();
    const analysisQ = colFilters.analysis.trim().toLowerCase();
    const stateQ = colFilters.state.trim();
    const startQ = colFilters.start.trim();
    const deadlineQ = colFilters.deadline.trim();

    return allTasks
      .filter((t) => t.project_id === project.id)
      .filter((t) => (statusFilter === "all" ? true : t.status === statusFilter))
      .filter((t) => {
        if (!q) return true;
        const hay = [t.title, t.note, t.analyzed, nameOf(t.assignee_id), shortId(t.id)].join(" ").toLowerCase();
        return hay.includes(q);
      })
      .filter((t) => {
        if (noQ && !shortId(t.id).toLowerCase().includes(noQ) && !t.id.toLowerCase().includes(noQ)) {
          return false;
        }
        if (stateQ && t.status !== stateQ) return false;
        if (nameQ && !t.title.toLowerCase().includes(nameQ)) return false;
        if (ownerQ) {
          if (ownerQ === "unassigned") {
            if (t.assignee_id) return false;
          } else {
            const ownerName = nameOf(t.assignee_id).toLowerCase();
            if (ownerName !== ownerQ.toLowerCase()) return false;
          }
        }
        if (startQ && t.start_date !== startQ) return false;
        if (deadlineQ && t.due_date !== deadlineQ) return false;
        if (analysisQ) {
          const text = [
            t.analyzed,
            ...(t.analyzed_notes ?? []).map((n) => n.text),
          ]
            .join(" ")
            .toLowerCase();
          if (!text.includes(analysisQ)) return false;
        }
        return true;
      })
      /* Stable order: creation/id — field edits must not reshuffle rows. */
      .slice()
      .sort(compareTasksStable);
  }, [allTasks, project, statusFilter, query, profiles, colFilters]);

  const counts = useMemo(() => {
    const tasks = project ? allTasks.filter((t) => t.project_id === project.id) : [];
    return {
      opening: tasks.filter((t) => t.status === "opening").length,
      working: tasks.filter((t) => t.status === "working").length,
      closing: tasks.filter((t) => t.status === "closing").length,
      verify: tasks.filter((t) => t.status === "verify").length,
      total: tasks.length,
      openish: tasks.filter((t) => isTaskOpen(t.status)).length,
    };
  }, [allTasks, project]);

  const people = members
    .map((m) => profiles.find((p) => p.id === m.user_id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  const openProject = (id: string) => {
    if (editMode) {
      if (editDirty && !window.confirm("Leave edit mode and discard unsaved changes?")) return;
      exitEditModeLocal();
    }
    setProjectId(id);
    setMode("detail");
    setStatusFilter("all");
    setQuery("");
    setColFilters(EMPTY_ISSUE_COLUMN_FILTERS);
    setMoreOpen(false);
    setShowNewIssue(false);
  };

  const openCheckpoints = (project: Project) => {
    setCheckpointProjectId(project.id);
    setCheckpointDraft([...(project.checkpoints ?? [])]);
    setCheckpointAddText("");
  };

  const closeCheckpoints = () => {
    setCheckpointProjectId(null);
    setCheckpointDraft([]);
    setCheckpointAddText("");
  };

  const persistCheckpoints = async (projectId: string, next: ProjectCheckpoint[]) => {
    setError("");
    try {
      await runSave(async () => {
        await api.updateProject(projectId, { checkpoints: next });
        await reload();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "CheckPoint save failed");
      throw err;
    }
  };

  const canEditCheckpoints = (projectId: string) => leaderProjectIds.includes(projectId);

  const onToggleCheckpoint = async (itemId: string) => {
    if (!checkpointProjectId || !canEditCheckpoints(checkpointProjectId)) return;
    const next = checkpointDraft.map((item) =>
      item.id === itemId ? { ...item, checked: !item.checked } : item,
    );
    setCheckpointDraft(next);
    try {
      await persistCheckpoints(checkpointProjectId, next);
    } catch {
      setCheckpointDraft([...(projects.find((p) => p.id === checkpointProjectId)?.checkpoints ?? [])]);
    }
  };

  const onDeleteCheckpoint = async (itemId: string) => {
    if (!checkpointProjectId || !canEditCheckpoints(checkpointProjectId)) return;
    const next = checkpointDraft.filter((item) => item.id !== itemId);
    setCheckpointDraft(next);
    try {
      await persistCheckpoints(checkpointProjectId, next);
    } catch {
      setCheckpointDraft([...(projects.find((p) => p.id === checkpointProjectId)?.checkpoints ?? [])]);
    }
  };

  const onAddCheckpoint = async () => {
    if (!checkpointProjectId || !canEditCheckpoints(checkpointProjectId)) return;
    const text = checkpointAddText.trim();
    if (!text) return;
    const next = [
      ...checkpointDraft,
      { id: crypto.randomUUID(), text, checked: false },
    ];
    setCheckpointDraft(next);
    setCheckpointAddText("");
    try {
      await persistCheckpoints(checkpointProjectId, next);
    } catch {
      setCheckpointDraft([...(projects.find((p) => p.id === checkpointProjectId)?.checkpoints ?? [])]);
    }
  };

  const backToList = () => {
    setMode("list");
    setQuery("");
    setStatusFilter("all");
    setColFilters(EMPTY_ISSUE_COLUMN_FILTERS);
    setShowNewIssue(false);
    setMoreOpen(false);
  };

  const onCreateProject = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await runSave(async () => {
        const created = await api.createProject(name, description);
        setName("");
        setDescription("");
        setShowCreate(false);
        setProjectId(created.id);
        await reload();
        setMode("detail");
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    }
  };

  const onDeleteProject = async (id: string, projectName: string) => {
    const ok = window.confirm(`Delete “${projectName}”? Tasks and members will be removed.`);
    if (!ok) return;
    setBusyId(id);
    setError("");
    try {
      await runSave(async () => {
        await api.deleteProject(id);
        if (mode === "detail" && projectId === id) backToList();
        // Last-project delete must be allowed to settle as a real empty list.
        await reload({ allowEmpty: true });
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusyId("");
    }
  };

  const createIssue = async (event: FormEvent) => {
    event.preventDefault();
    if (!project || !user) return;
    setError("");
    try {
      await runSave(async () => {
        await api.createTask({
          project_id: project.id,
          title: title.trim(),
          assignee_id: assignee || null,
          start_date: start,
          due_date: due < start ? start : due,
          status: newStatus,
          note: "",
          ...syncAnalyzedFields(analyzed.trim() ? [makeAnalyzedNote(analyzed, user.id)] : []),
        });
        setTitle("");
        setAnalyzed("");
        setNewStatus("opening");
        setShowNewIssue(false);
        await reload();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    }
  };

  const patchTask = async (id: string, next: Parameters<typeof api.updateTask>[1]) => {
    setError("");
    try {
      await runSave(async () => {
        await api.updateTask(id, next);
        await reload();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  };

  const canManage = Boolean(project && (isAdmin || role === "leader"));
  const canDeleteProject = Boolean(
    mode === "detail" && project && leaderProjectIds.includes(project.id),
  );
  /** ⋯ only when it has at least one action (list create/remove-col, or detail delete). */
  const showOverflowMenu =
    (mode === "list" && canCreate) || canManageColumns || canDeleteProject;

  return (
    <div className="pi-page">
      <header className="pi-toolbar">
        <nav className="pi-breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="pi-bc-home" onClick={onGoDashboard} aria-label="Dashboard">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
              <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </button>
          <button type="button" className="pi-bc-link" onClick={onGoDashboard}>
            Dashboard
          </button>
          <span className="pi-bc-sep" aria-hidden="true">›</span>
          {mode === "list" ? (
            <span className="pi-bc-current">Project</span>
          ) : (
            <>
              <button type="button" className="pi-bc-link" onClick={backToList}>
                Project
              </button>
              <span className="pi-bc-sep" aria-hidden="true">›</span>
              <span className="pi-bc-active">{project?.name ?? "Project"}</span>
            </>
          )}
        </nav>

        <div className="pi-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.34-4.34" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search"
          />
        </div>

        <div className="pi-actions">
          <div className="pi-status-slot">
            {listLoading ? <LoadingIndicator /> : <SavingIndicator status={saveStatus} />}
          </div>
          {isAdmin && mode === "list" && !editMode && (
            <button
              type="button"
              className="pi-btn-primary pi-edit-entry-btn"
              disabled={listLoading || busyId === "edit-save"}
              title="Edit project fields and columns (Admin)"
              aria-label="Edit project fields and columns"
              onClick={enterEditMode}
            >
              Edit
            </button>
          )}
          {isAdmin && mode === "list" && editMode && (
            <>
              <button
                type="button"
                className="pi-btn-ghost pi-edit-toolbar-btn"
                disabled={busyId === "edit-save"}
                onClick={cancelEditMode}
              >
                Cancel
              </button>
              <button
                type="button"
                className="pi-btn-primary pi-edit-toolbar-btn"
                disabled={busyId === "edit-save"}
                onClick={() => void saveEditMode()}
              >
                {busyId === "edit-save" ? "Saving…" : "Save"}
              </button>
            </>
          )}
          {mode === "detail" && canManage && (
            <button
              type="button"
              className="pi-btn-primary pi-edit-entry-btn"
              title="Create a new issue on this project"
              aria-label="New Issue"
              onClick={() => {
                setMoreOpen(false);
                setAddColOpen(false);
                setRemoveColOpen(false);
                setShowNewIssue(true);
              }}
            >
              + New Issue
            </button>
          )}
          {canManageColumns && (
            <div className="pi-add-col-wrap">
              <button
                type="button"
                className="pi-add-col"
                aria-expanded={addColOpen}
                onClick={() => {
                  setMoreOpen(false);
                  setRemoveColOpen(false);
                  setAddColOpen((v) => !v);
                }}
              >
                + ADD COLUMN
              </button>
              {addColOpen && (
                <form className="pi-add-popover" onSubmit={onAddProjectColumn}>
                  <label>
                    Column name
                    <input
                      value={newColLabel}
                      onChange={(e) => setNewColLabel(e.target.value)}
                      placeholder="e.g. Region or BIOS ID"
                      autoFocus
                    />
                  </label>
                  <div className="pi-add-actions">
                    <button type="button" className="pi-btn-ghost" onClick={() => setAddColOpen(false)}>
                      Cancel
                    </button>
                    <button type="submit" className="pi-btn-primary" disabled={!newColLabel.trim()}>
                      Add
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          <div className="pi-menu-wrap">
            {showOverflowMenu && (
              <button
                type="button"
                className="pi-icon-btn"
                title="More actions"
                aria-label="More actions"
                aria-expanded={moreOpen || removeColOpen}
                onClick={() => {
                  setAddColOpen(false);
                  setRemoveColOpen(false);
                  setMoreOpen((v) => !v);
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="1" />
                  <circle cx="19" cy="12" r="1" />
                  <circle cx="5" cy="12" r="1" />
                </svg>
              </button>
            )}
            {showOverflowMenu && moreOpen && (
              <div className="pi-popover pi-popover-menu">
                {mode === "list" && canCreate && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreate(true);
                      setMoreOpen(false);
                    }}
                  >
                    + New Project
                  </button>
                )}
                {canManageColumns && (
                  <button
                    type="button"
                    className="danger"
                    disabled={draftColumns.length === 0}
                    aria-disabled={draftColumns.length === 0}
                    title={
                      draftColumns.length === 0
                        ? "No removable columns. Add one with + ADD COLUMN first."
                        : "Remove a column (Compal name and Actions stay fixed)"
                    }
                    onClick={() => {
                      if (draftColumns.length === 0) return;
                      setMoreOpen(false);
                      setAddColOpen(false);
                      setRemoveColId(draftColumns[0]?.id ?? "");
                      setRemoveColOpen(true);
                    }}
                  >
                    Remove column…
                    {draftColumns.length === 0 && (
                      <span className="pi-menu-hint">No removable columns</span>
                    )}
                  </button>
                )}
                {canDeleteProject && project && (
                  <button
                    type="button"
                    className="danger"
                    disabled={busyId === project.id}
                    onClick={() => void onDeleteProject(project.id, project.name)}
                  >
                    Delete Project
                  </button>
                )}
              </div>
            )}
            {canManageColumns && removeColOpen && (
              <form className="pi-add-popover" onSubmit={onRemoveProjectColumn}>
                <label>
                  Remove column
                  <select
                    value={removeColId}
                    onChange={(e) => setRemoveColId(e.target.value)}
                    aria-label="Column to remove"
                    autoFocus
                  >
                    {draftColumns.map((col) => (
                      <option key={col.id} value={col.id}>
                        {col.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="pi-add-actions">
                  <button
                    type="button"
                    className="pi-btn-ghost"
                    onClick={() => {
                      setRemoveColOpen(false);
                      setRemoveColId("");
                    }}
                  >
                    Cancel
                  </button>
                  <button type="submit" className="pi-btn-primary" disabled={!removeColId}>
                    Remove
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </header>

      {displayError && <p className="pi-error">{displayError}</p>}

      {mode === "list" && showCreate && canCreate && (
        <form className="pi-create-card" onSubmit={onCreateProject}>
          <h2>New Project</h2>
          <label>
            Compal project name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Description
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </label>
          <div className="pi-create-actions">
            <button type="button" className="pi-btn-ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </button>
            <button type="submit" className="pi-btn-primary">
              Create (you become leader)
            </button>
          </div>
        </form>
      )}

      {mode === "list" ? (
        <div className="pi-table-wrap">
          <table className={`pi-table pi-project-table${editMode ? " pi-project-table-editing" : ""}`}>
            <thead>
              <tr>
                <th>{PROJECT_LOCKED_COLUMN.label}</th>
                {visibleColumns.map((col, index) => (
                  <th key={col.id}>
                    {editMode ? (
                      <div className="pi-col-head">
                        <span className="pi-col-head-label">{col.label.toUpperCase()}</span>
                        <span className="pi-col-reorder">
                          <button
                            type="button"
                            className="pi-col-move"
                            aria-label={`Move ${col.label} left`}
                            disabled={index === 0}
                            onClick={() => moveDraftColumn(col.id, -1)}
                          >
                            ←
                          </button>
                          <button
                            type="button"
                            className="pi-col-move"
                            aria-label={`Move ${col.label} right`}
                            disabled={index === visibleColumns.length - 1}
                            onClick={() => moveDraftColumn(col.id, 1)}
                          >
                            →
                          </button>
                        </span>
                      </div>
                    ) : (
                      col.label.toUpperCase()
                    )}
                  </th>
                ))}
                <th>ACTIONS</th>
              </tr>
            </thead>
            <tbody>
              {projectRows.length === 0 ? (
                <tr>
                  <td colSpan={listColSpan} className="pi-empty">
                    {listLoading
                      ? "\u00a0"
                      : loadError
                        ? "Failed to load projects."
                        : projects.length === 0
                          ? "No projects yet. Use More → New Project."
                          : "No projects match this search."}
                  </td>
                </tr>
              ) : (
                projectRows.map((project) => {
                  const draft = mergeProjectDraft(project, editMode ? draftPatches[project.id] : undefined);
                  const canEditFields = isAdmin && editMode;
                  const busy = busyId === project.id || busyId === "edit-save";
                  return (
                    <tr key={project.id}>
                      <td>
                        {canEditFields ? (
                          <input
                            className="pi-cell-input pi-cell-input-name"
                            value={draft.name}
                            disabled={busy}
                            aria-label="Compal project name"
                            onChange={(e) => setDraftField(project.id, { name: e.target.value })}
                          />
                        ) : (
                          <button
                            type="button"
                            className="pi-proj-link"
                            onClick={() => openProject(project.id)}
                          >
                            {draft.name || "—"}
                          </button>
                        )}
                      </td>
                      {visibleColumns.map((col) => {
                        const stdKey = standardKeyForColumn(col);
                        if (stdKey) {
                          const value = standardFieldValue(draft, stdKey);
                          const isDate = stdKey === "ss_date" || stdKey === "eol_date";
                          if (stdKey === "owner" || stdKey === "project_owner") {
                            const selected = ownerSelectValue(value);
                            const orphan =
                              selected !== "" &&
                              !personnelOwnerOptions.some(
                                (p) => p.display_name === selected,
                              );
                            const fieldKey = stdKey;
                            const aria = stdKey === "owner" ? "Project Leader" : "Owner";
                            return (
                              <td key={col.id}>
                                {canEditFields ? (
                                  <select
                                    className="pi-cell-input pi-cell-select"
                                    value={selected}
                                    disabled={busy}
                                    aria-label={aria}
                                    onChange={(e) =>
                                      setDraftField(project.id, {
                                        [fieldKey]: e.target.value,
                                      } as ProjectFieldPatch)
                                    }
                                  >
                                    <option value="">—</option>
                                    {orphan && <option value={selected}>{selected}</option>}
                                    {personnelOwnerOptions.map((p) => (
                                      <option key={p.id} value={p.display_name}>
                                        {p.display_name}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <span className="pi-cell-text">{value || "—"}</span>
                                )}
                              </td>
                            );
                          }
                          // TPE OWNER: free-text (typed individually), not Personnel dropdown.
                          return (
                            <td key={col.id}>
                              {canEditFields ? (
                                <input
                                  className="pi-cell-input"
                                  type={isDate ? "date" : "text"}
                                  value={value}
                                  disabled={busy}
                                  aria-label={col.label}
                                  onChange={(e) =>
                                    setDraftField(project.id, { [stdKey]: e.target.value } as ProjectFieldPatch)
                                  }
                                />
                              ) : (
                                <span className="pi-cell-text">{value || "—"}</span>
                              )}
                            </td>
                          );
                        }
                        const value = draft.custom?.[col.id] ?? "";
                        return (
                          <td key={col.id}>
                            {canEditFields ? (
                              <input
                                className="pi-cell-input"
                                value={value}
                                disabled={busy}
                                aria-label={col.label}
                                onChange={(e) =>
                                  setDraftField(project.id, { custom: { [col.id]: e.target.value } })
                                }
                              />
                            ) : (
                              <span className="pi-cell-text">{value || "—"}</span>
                            )}
                          </td>
                        );
                      })}
                      <td>
                        <div className="pi-row-actions">
                          <button
                            type="button"
                            className="pi-linkish pi-checkpoint-btn"
                            onClick={() => openCheckpoints(draft)}
                            title="Project handover CheckPoints"
                          >
                            CheckPoint
                            {areProjectCheckpointsComplete(draft.checkpoints) && (
                              <span className="pi-checkpoint-done" aria-label="All CheckPoints complete">
                                ✓
                              </span>
                            )}
                          </button>
                          {leaderProjectIds.includes(project.id) && (
                            <button
                              type="button"
                              className="pi-linkish danger"
                              disabled={busy}
                              onClick={() => void onDeleteProject(project.id, project.name)}
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="pi-status-bar">
            {(
              [
                ["opening", "OPEN", counts.opening],
                ["working", "WORKING", counts.working],
                ["closing", "CLOSING", counts.closing],
                ["verify", "CLOSED", counts.verify],
              ] as const
            ).map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                className={`pi-chip${statusFilter === id ? " on" : ""}`}
                onClick={() => setStatusFilter((prev) => (prev === id ? "all" : id))}
              >
                <span>{label}</span>
                <strong>{count}</strong>
              </button>
            ))}
            <button
              type="button"
              className={`pi-chip pi-chip-total${statusFilter === "all" ? " on" : ""}`}
              onClick={() => setStatusFilter("all")}
            >
              <span>TOTAL</span>
              <strong>{counts.total}</strong>
            </button>
          </div>

          {showNewIssue && canManage && (
            <form className="pi-create-card" onSubmit={createIssue}>
              <h2>New Issue · {project?.name}</h2>
              <div className="pi-create-grid">
                <label>
                  Issue name
                  <input value={title} onChange={(e) => setTitle(e.target.value)} required />
                </label>
                <label>
                  Owner
                  <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                    <option value="">Unassigned</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.display_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Start
                  <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
                </label>
                <label>
                  Deadline
                  <input type="date" value={due} onChange={(e) => setDue(e.target.value)} required />
                </label>
                <label>
                  State
                  <select value={newStatus} onChange={(e) => setNewStatus(e.target.value as TaskStatus)}>
                    {TASK_STATUSES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="span-2">
                  Analysis
                  <textarea rows={3} value={analyzed} onChange={(e) => setAnalyzed(e.target.value)} />
                </label>
              </div>
              <div className="pi-create-actions">
                <button type="button" className="pi-btn-ghost" onClick={() => setShowNewIssue(false)}>
                  Cancel
                </button>
                <button type="submit" className="pi-btn-primary">
                  Add issue
                </button>
              </div>
            </form>
          )}

          <div className="pi-table-wrap">
            <table className="pi-table pi-issue-table">
              <thead>
                <tr>
                  <th>
                    <IssueColumnFilter
                      label="NO."
                      colKey="no"
                      value={colFilters.no}
                      onChange={(v) => setColFilter("no", v)}
                      placeholder="Contains…"
                    />
                  </th>
                  <th>
                    <IssueColumnFilter
                      label="STATE"
                      colKey="state"
                      value={colFilters.state}
                      onChange={(v) => setColFilter("state", v)}
                      inputType="select"
                      options={TASK_STATUSES.map((s) => ({
                        value: s.id,
                        label: s.label.toUpperCase(),
                      }))}
                    />
                  </th>
                  <th>
                    <IssueColumnFilter
                      label="NAME"
                      colKey="name"
                      value={colFilters.name}
                      onChange={(v) => setColFilter("name", v)}
                      placeholder="Contains…"
                    />
                  </th>
                  <th>
                    <IssueColumnFilter
                      label="OWNER"
                      colKey="owner"
                      value={colFilters.owner}
                      onChange={(v) => setColFilter("owner", v)}
                      inputType="select"
                      options={[
                        { value: "unassigned", label: "Unassigned" },
                        ...people.map((p) => ({ value: p.display_name, label: p.display_name })),
                      ]}
                    />
                  </th>
                  <th>
                    <IssueColumnFilter
                      label="START"
                      colKey="start"
                      value={colFilters.start}
                      onChange={(v) => setColFilter("start", v)}
                      inputType="date"
                    />
                  </th>
                  <th>
                    <IssueColumnFilter
                      label="DEADLINE"
                      colKey="deadline"
                      value={colFilters.deadline}
                      onChange={(v) => setColFilter("deadline", v)}
                      inputType="date"
                    />
                  </th>
                  <th>
                    <IssueColumnFilter
                      label="ANALYSIS"
                      colKey="analysis"
                      value={colFilters.analysis}
                      onChange={(v) => setColFilter("analysis", v)}
                      placeholder="Contains…"
                    />
                  </th>
                  <th>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {detailTasks.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="pi-empty">
                      No issues found.
                    </td>
                  </tr>
                ) : (
                  detailTasks.map((task) => {
                    const canEdit = canLeadProject(task.project_id) || task.assignee_id === user?.id;
                    const canDelete = canLeadProject(task.project_id);
                    const assignees = profiles.filter((p) =>
                      allMembers.some((m) => m.project_id === task.project_id && m.user_id === p.id),
                    );
                    return (
                      <tr key={task.id}>
                        <td className="pi-no">{shortId(task.id)}</td>
                        <td>
                          {canEdit ? (
                            <select
                              className={statusTone(task.status)}
                              value={task.status}
                              onChange={(e) => void patchTask(task.id, { status: e.target.value as TaskStatus })}
                            >
                              {TASK_STATUSES.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.label.toUpperCase()}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className={statusTone(task.status)}>{task.status.toUpperCase()}</span>
                          )}
                        </td>
                        <td className="pi-issue-name">
                          {canEdit ? (
                            <input
                              defaultValue={task.title}
                              key={`${task.id}-${task.title}`}
                              onBlur={(e) => {
                                const next = e.target.value.trim();
                                if (next && next !== task.title) void patchTask(task.id, { title: next });
                              }}
                            />
                          ) : (
                            task.title
                          )}
                        </td>
                        <td>
                          {canEdit ? (
                            <select
                              value={task.assignee_id ?? ""}
                              onChange={(e) => void patchTask(task.id, { assignee_id: e.target.value || null })}
                            >
                              <option value="">Unassigned</option>
                              {assignees.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.display_name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            nameOf(task.assignee_id)
                          )}
                        </td>
                        <td>
                          {canEdit ? (
                            <input
                              type="date"
                              value={task.start_date}
                              onChange={(e) => void patchTask(task.id, { start_date: e.target.value })}
                            />
                          ) : (
                            task.start_date
                          )}
                        </td>
                        <td>
                          {canEdit ? (
                            <input
                              type="date"
                              value={task.due_date}
                              onChange={(e) => void patchTask(task.id, { due_date: e.target.value })}
                            />
                          ) : (
                            task.due_date
                          )}
                        </td>
                        <td>
                          <AnalysisInline
                            notes={task.analyzed_notes ?? []}
                            profiles={profiles}
                            canEdit={canEdit}
                            userId={user?.id}
                            onSave={(notes) => void patchTask(task.id, syncAnalyzedFields(notes))}
                          />
                        </td>
                        <td>
                          {canDelete && (
                            <button
                              type="button"
                              className="pi-linkish danger"
                              onClick={() => {
                                if (window.confirm("Delete this issue?")) {
                                  void api.deleteTask(task.id).then(() => reload());
                                }
                              }}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {checkpointProjectId && (() => {
        const cpProject = projects.find((p) => p.id === checkpointProjectId);
        const canEdit = canEditCheckpoints(checkpointProjectId);
        const cpBusy = saveStatus.kind === "saving";
        return (
          <div
            className="pi-modal-backdrop"
            role="presentation"
            onClick={() => !cpBusy && closeCheckpoints()}
          >
            <div
              className="pi-modal pi-checkpoint-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="pi-checkpoint-title"
              onClick={(e) => e.stopPropagation()}
            >
              <header className="pi-modal-head">
                <h2 id="pi-checkpoint-title">
                  CheckPoint
                  {cpProject?.name ? (
                    <span className="pi-checkpoint-project">{cpProject.name}</span>
                  ) : null}
                </h2>
                <button
                  type="button"
                  className="pi-modal-close"
                  aria-label="Close"
                  onClick={() => closeCheckpoints()}
                >
                  ×
                </button>
              </header>
              <div className="pi-modal-body">
                {checkpointDraft.length === 0 ? (
                  <p className="pi-checkpoint-empty">No CheckPoints yet. Add handover items below.</p>
                ) : (
                  <ul className="pi-checkpoint-list">
                    {checkpointDraft.map((item) => (
                      <li key={item.id} className="pi-checkpoint-item">
                        <label className="pi-checkpoint-check">
                          <input
                            type="checkbox"
                            checked={item.checked}
                            disabled={!canEdit || cpBusy}
                            onChange={() => void onToggleCheckpoint(item.id)}
                          />
                          <span className={item.checked ? "is-checked" : undefined}>{item.text || "—"}</span>
                        </label>
                        {canEdit && (
                          <button
                            type="button"
                            className="pi-linkish danger"
                            disabled={cpBusy}
                            aria-label="Delete CheckPoint"
                            onClick={() => void onDeleteCheckpoint(item.id)}
                          >
                            Delete
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {canEdit ? (
                  <form
                    className="pi-checkpoint-add"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void onAddCheckpoint();
                    }}
                  >
                    <input
                      type="text"
                      value={checkpointAddText}
                      onChange={(e) => setCheckpointAddText(e.target.value)}
                      placeholder="New CheckPoint item"
                      aria-label="New CheckPoint item"
                      disabled={cpBusy}
                    />
                    <button
                      type="submit"
                      className="pi-btn-primary"
                      disabled={!checkpointAddText.trim() || cpBusy}
                    >
                      Add
                    </button>
                  </form>
                ) : (
                  <p className="pi-checkpoint-hint">Only project leaders or Admin can edit CheckPoints.</p>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
