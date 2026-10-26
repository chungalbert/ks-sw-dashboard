import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { SavingIndicator } from "../components/SavingIndicator";
import { api } from "../lib/api";
import {
  isTaskOpen,
  normalizePersonnelRole,
  normalizeTaskStatus,
  PERSONNEL_ROLES,
  TASK_STATUSES,
  taskStatusLabel,
  type PersonnelColumn,
  type PersonnelRole,
  type Profile,
  type Task,
  type TaskStatus,
} from "../lib/types";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";
import { useSaveStatus } from "../lib/useSaveStatus";
import { DEFAULT_PASSWORD } from "../lib/util";

function sameProjectIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((id, i) => id === right[i]);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function avatarTone(name: string): string {
  const tones = ["tone-a", "tone-b", "tone-c", "tone-d", "tone-e", "tone-f"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash + name.charCodeAt(i) * (i + 1)) % tones.length;
  return tones[hash];
}

function possessiveName(name: string): string {
  const trimmed = name.trim() || "Member";
  return /s$/i.test(trimmed) ? `${trimmed}'` : `${trimmed}'s`;
}

function shortIssueId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8).toUpperCase();
}

export function PeoplePage({
  onGoDashboard,
  onOpenProject,
}: {
  onGoDashboard?: () => void;
  /** Navigate to Projects & Issues detail for this project. */
  onOpenProject?: (projectId: string) => void;
}) {
  const { user } = useAuth();
  const { profiles, allMembers, allTasks, projects, reload } = useStore();
  const isAdmin = Boolean(user && normalizePersonnelRole(user) === "Admin");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [columns, setColumns] = useState<PersonnelColumn[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [newColLabel, setNewColLabel] = useState("");
  const [memberOpen, setMemberOpen] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const { saveStatus, runSave } = useSaveStatus();
  const [memberForm, setMemberForm] = useState({
    display_name: "",
    username: "",
    email: "",
    phone: "",
    personnel_role: "DE" as PersonnelRole,
    projectIds: [] as string[],
  });
  const [projectPickerId, setProjectPickerId] = useState<string | null>(null);
  const [issuesProfileId, setIssuesProfileId] = useState<string | null>(null);

  const refreshColumns = async () => {
    setColumns(await api.listPersonnelColumns());
  };

  useEffect(() => {
    void refreshColumns();
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setMemberOpen(false);
      setMemberBusy(false);
      setAddOpen(false);
    }
  }, [isAdmin]);

  const rows = useMemo(() => {
    return profiles.map((profile) => {
      const memberships = allMembers.filter((m) => m.user_id === profile.id);
      const projectIds = [...new Set(memberships.map((m) => m.project_id))];
      const projectNames = projectIds
        .map((id) => projects.find((p) => p.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      const issues = allTasks.filter(
        (t) => t.assignee_id === profile.id && isTaskOpen(t.status),
      ).length;
      return {
        profile,
        projectIds,
        projectNames,
        // Count memberships, not resolved names — a transient empty projects list
        // must not paint every row as Unassigned when allMembers is already populated.
        projectCount: projectIds.length,
        role: normalizePersonnelRole(profile),
        issues,
      };
    });
  }, [profiles, allMembers, allTasks, projects]);

  const issuesProfile = issuesProfileId
    ? profiles.find((p) => p.id === issuesProfileId) ?? null
    : null;
  const issuesForModal = useMemo(() => {
    if (!issuesProfileId) return [] as Task[];
    return allTasks.filter((t) => t.assignee_id === issuesProfileId && isTaskOpen(t.status));
  }, [allTasks, issuesProfileId]);

  const patchProfile = async (
    userId: string,
    patch: Parameters<typeof api.updateProfile>[1],
  ) => {
    setError("");
    setBusyId(userId);
    try {
      await runSave(async () => {
        await api.updateProfile(userId, patch);
        await reload();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusyId("");
    }
  };

  const setProjects = async (userId: string, projectIds: string[]) => {
    setError("");
    setBusyId(userId);
    try {
      await runSave(async () => {
        await api.setPersonProjects(userId, projectIds);
        await reload();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Project update failed");
    } finally {
      setBusyId("");
    }
  };

  const onAddColumn = async (event: FormEvent) => {
    event.preventDefault();
    if (!isAdmin) {
      setError("只有 Admin 可以新增欄位");
      setAddOpen(false);
      return;
    }
    setError("");
    try {
      await runSave(async () => {
        await api.addPersonnelColumn(newColLabel);
        setNewColLabel("");
        setAddOpen(false);
        await refreshColumns();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add column failed");
    }
  };

  const resetMemberForm = () => {
    setMemberForm({
      display_name: "",
      username: "",
      email: "",
      phone: "",
      personnel_role: "DE",
      projectIds: [],
    });
  };

  const onAddMember = async (event: FormEvent) => {
    event.preventDefault();
    if (!isAdmin) {
      setError("只有 Admin 可以新增 Member");
      setMemberOpen(false);
      return;
    }
    setError("");
    setMemberBusy(true);
    try {
      await runSave(async () => {
        await api.createPersonnelMember({
          display_name: memberForm.display_name,
          username: memberForm.username || undefined,
          email: memberForm.email,
          phone: memberForm.phone,
          personnel_role: memberForm.personnel_role,
          projectIds: memberForm.projectIds,
        });
        resetMemberForm();
        setMemberOpen(false);
        await reload();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add member failed");
    } finally {
      setMemberBusy(false);
    }
  };

  const onRemoveColumn = async (columnId: string, label: string) => {
    if (!isAdmin) return;
    const ok = window.confirm(`Remove column “${label}”? Values will be deleted.`);
    if (!ok) return;
    setError("");
    try {
      await runSave(async () => {
        await api.removePersonnelColumn(columnId);
        await refreshColumns();
        await reload();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove column failed");
    }
  };

  const resetPassword = async (userId: string, name: string) => {
    if (!isAdmin) return;
    const ok = window.confirm(`Reset password for “${name}” to ${DEFAULT_PASSWORD}?`);
    if (!ok) return;
    setError("");
    setBusyId(userId);
    try {
      await runSave(async () => {
        await api.resetPassword(userId);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setBusyId("");
    }
  };

  const deletePerson = async (userId: string, name: string) => {
    if (!isAdmin) return;
    const ok = window.confirm(`Delete “${name}”? This removes the account from all projects.`);
    if (!ok) return;
    setError("");
    setBusyId(userId);
    try {
      await runSave(async () => {
        await api.deletePerson(userId);
        await reload();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusyId("");
    }
  };

  const colSpan = (isAdmin ? 7 : 6) + columns.length;

  return (
    <div className="personnel-page">
      <header className="personnel-toolbar">
        <nav className="personnel-breadcrumb" aria-label="Breadcrumb">
          <button
            type="button"
            className="personnel-bc-home"
            onClick={onGoDashboard}
            aria-label="Dashboard"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
              <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </button>
          <button type="button" className="personnel-bc-link" onClick={onGoDashboard}>
            Dashboard
          </button>
          <span className="personnel-bc-sep" aria-hidden="true">›</span>
          <span className="personnel-bc-current">Personnel</span>
        </nav>

        <div className="personnel-toolbar-actions">
          <SavingIndicator status={saveStatus} />
          {isAdmin && (
            <button
              type="button"
              className="personnel-add-col personnel-add-member"
              onClick={() => {
                setAddOpen(false);
                setMemberOpen(true);
              }}
            >
              + ADD MEMBER
            </button>
          )}
          {isAdmin && (
            <div className="personnel-add-wrap">
              <button
                type="button"
                className="personnel-add-col"
                aria-expanded={addOpen}
                onClick={() => {
                  setMemberOpen(false);
                  setAddOpen((v) => !v);
                }}
              >
                + ADD COLUMN
              </button>
              {addOpen && (
                <form className="personnel-add-popover" onSubmit={onAddColumn}>
                  <label>
                    Column name
                    <input
                      value={newColLabel}
                      onChange={(e) => setNewColLabel(e.target.value)}
                      placeholder="e.g. Team"
                      autoFocus
                    />
                  </label>
                  <div className="personnel-add-actions">
                    <button type="button" className="personnel-btn-ghost" onClick={() => setAddOpen(false)}>
                      Cancel
                    </button>
                    <button type="submit" className="personnel-btn-primary" disabled={!newColLabel.trim()}>
                      Add
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      </header>

      {isAdmin && memberOpen && (
        <div className="personnel-modal-backdrop" role="presentation" onClick={() => !memberBusy && setMemberOpen(false)}>
          <form
            className="personnel-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="personnel-add-member-title"
            onClick={(e) => e.stopPropagation()}
            onSubmit={onAddMember}
          >
            <header className="personnel-modal-head">
              <h2 id="personnel-add-member-title">新增 Member</h2>
              <button
                type="button"
                className="personnel-modal-close"
                aria-label="Close"
                disabled={memberBusy}
                onClick={() => setMemberOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="personnel-modal-body">
              <label>
                Name
                <input
                  value={memberForm.display_name}
                  onChange={(e) => setMemberForm((f) => ({ ...f, display_name: e.target.value }))}
                  placeholder="Display name"
                  autoFocus
                  required
                />
              </label>
              <label>
                Username
                <input
                  value={memberForm.username}
                  onChange={(e) => setMemberForm((f) => ({ ...f, username: e.target.value }))}
                  placeholder="Login id (optional if email set)"
                />
              </label>
              <label>
                Email
                <input
                  type="email"
                  value={memberForm.email}
                  onChange={(e) => setMemberForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="email@example.com"
                />
              </label>
              <label>
                Phone
                <input
                  value={memberForm.phone}
                  onChange={(e) => setMemberForm((f) => ({ ...f, phone: e.target.value }))}
                  placeholder="Optional"
                />
              </label>
              <label>
                Role
                <select
                  className="personnel-select"
                  value={memberForm.personnel_role}
                  onChange={(e) =>
                    setMemberForm((f) => ({ ...f, personnel_role: e.target.value as PersonnelRole }))
                  }
                >
                  {PERSONNEL_ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </label>
              <fieldset className="personnel-modal-projects">
                <legend>Projects</legend>
                {projects.length === 0 ? (
                  <p className="personnel-muted">No projects yet.</p>
                ) : (
                  projects.map((p) => {
                    const checked = memberForm.projectIds.includes(p.id);
                    return (
                      <label key={p.id} className="personnel-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setMemberForm((f) => ({
                              ...f,
                              projectIds: checked
                                ? f.projectIds.filter((id) => id !== p.id)
                                : [...f.projectIds, p.id],
                            }));
                          }}
                        />
                        {p.name}
                      </label>
                    );
                  })
                )}
              </fieldset>
            </div>
            <footer className="personnel-add-actions">
              <button
                type="button"
                className="personnel-btn-ghost"
                disabled={memberBusy}
                onClick={() => {
                  resetMemberForm();
                  setMemberOpen(false);
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="personnel-btn-primary"
                disabled={
                  memberBusy ||
                  !memberForm.display_name.trim() ||
                  (!memberForm.username.trim() && !memberForm.email.trim())
                }
              >
                {memberBusy ? "Saving…" : "Save member"}
              </button>
            </footer>
          </form>
        </div>
      )}

      {error && <p className="personnel-error">{error}</p>}

      <div className="personnel-table-wrap">
        <table className="personnel-table">
          <thead>
            <tr>
              <th>MEMBER</th>
              <th>ID</th>
              <th>PHONE</th>
              <th>ROLE</th>
              <th>PROJECTS</th>
              {columns.map((col) => (
                <th key={col.id}>
                  <span className="personnel-col-head">
                    {col.label.toUpperCase()}
                    {isAdmin && (
                      <button
                        type="button"
                        className="personnel-col-remove"
                        title={`Remove ${col.label}`}
                        onClick={() => void onRemoveColumn(col.id, col.label)}
                      >
                        ×
                      </button>
                    )}
                  </span>
                </th>
              ))}
              <th>ISSUES</th>
              {isAdmin && <th>ACTIONS</th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="personnel-empty">No personnel found.</td>
              </tr>
            ) : (
              rows.map(({ profile, projectIds, projectNames, projectCount, role, issues }) => (
                <PersonRow
                  key={profile.id}
                  profile={profile}
                  role={role}
                  projectIds={projectIds}
                  projectNames={projectNames}
                  projectCount={projectCount}
                  issues={issues}
                  columns={columns}
                  projects={projects}
                  busy={busyId === profile.id}
                  isAdmin={isAdmin}
                  pickerOpen={projectPickerId === profile.id}
                  onTogglePicker={() =>
                    setProjectPickerId((id) => (id === profile.id ? null : profile.id))
                  }
                  onClosePicker={() => setProjectPickerId(null)}
                  onPatch={(patch) => void patchProfile(profile.id, patch)}
                  onSetProjects={(ids) => void setProjects(profile.id, ids)}
                  onOpenIssues={() => setIssuesProfileId(profile.id)}
                  onReset={() => void resetPassword(profile.id, profile.display_name)}
                  onDelete={() => void deletePerson(profile.id, profile.display_name)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {issuesProfile && (
        <MemberIssuesModal
          profile={issuesProfile}
          tasks={issuesForModal}
          projects={projects}
          onClose={() => setIssuesProfileId(null)}
          onOpenProject={(projectId) => {
            setIssuesProfileId(null);
            onOpenProject?.(projectId);
          }}
        />
      )}
    </div>
  );
}

function PersonRow({
  profile,
  role,
  projectIds,
  projectNames,
  projectCount,
  issues,
  columns,
  projects,
  busy,
  isAdmin,
  pickerOpen,
  onTogglePicker,
  onClosePicker,
  onPatch,
  onSetProjects,
  onOpenIssues,
  onReset,
  onDelete,
}: {
  profile: Profile;
  role: PersonnelRole;
  projectIds: string[];
  projectNames: string[];
  projectCount: number;
  issues: number;
  columns: PersonnelColumn[];
  projects: { id: string; name: string }[];
  busy: boolean;
  isAdmin: boolean;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onClosePicker: () => void;
  onPatch: (patch: Parameters<typeof api.updateProfile>[1]) => void;
  onSetProjects: (ids: string[]) => void;
  onOpenIssues: () => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  const projectsEditRef = useRef<HTMLDivElement>(null);
  const [draftProjectIds, setDraftProjectIds] = useState(projectIds);
  const draftProjectIdsRef = useRef(projectIds);
  const baselineProjectIdsRef = useRef(projectIds);
  const wasPickerOpenRef = useRef(false);
  const onSetProjectsRef = useRef(onSetProjects);
  const onClosePickerRef = useRef(onClosePicker);
  onSetProjectsRef.current = onSetProjects;
  onClosePickerRef.current = onClosePicker;

  useEffect(() => {
    draftProjectIdsRef.current = draftProjectIds;
  }, [draftProjectIds]);

  // Seed draft on open; on close persist if changed, then realign to saved props.
  useEffect(() => {
    if (pickerOpen) {
      if (!wasPickerOpenRef.current) {
        setDraftProjectIds(projectIds);
        draftProjectIdsRef.current = projectIds;
        baselineProjectIdsRef.current = projectIds;
        wasPickerOpenRef.current = true;
      }
      return;
    }
    if (wasPickerOpenRef.current) {
      wasPickerOpenRef.current = false;
      const next = draftProjectIdsRef.current;
      if (!sameProjectIds(next, baselineProjectIdsRef.current)) {
        onSetProjectsRef.current(next);
      }
    }
    setDraftProjectIds(projectIds);
    draftProjectIdsRef.current = projectIds;
    baselineProjectIdsRef.current = projectIds;
  }, [pickerOpen, projectIds]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClosePickerRef.current();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const root = projectsEditRef.current;
      if (root && !root.contains(event.target as Node)) {
        onClosePickerRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [pickerOpen]);

  return (
    <tr>
      <td>
        <div className="personnel-member">
          <span className={`personnel-avatar ${avatarTone(profile.display_name)}`} aria-hidden="true">
            {initials(profile.display_name)}
          </span>
          <div className="personnel-member-fields">
            <input
              className="personnel-input name"
              defaultValue={profile.display_name}
              key={`${profile.id}-name-${profile.display_name}`}
              disabled={busy}
              aria-label="Display name"
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next && next !== profile.display_name) onPatch({ display_name: next });
              }}
            />
            <input
              className="personnel-input email"
              defaultValue={profile.email}
              key={`${profile.id}-email-${profile.email}`}
              disabled={busy}
              aria-label="Email"
              onBlur={(e) => {
                const next = e.target.value.trim().toLowerCase();
                if (next && next !== profile.email) onPatch({ email: next });
              }}
            />
          </div>
        </div>
      </td>
      <td className="personnel-mono">{profile.username}</td>
      <td>
        <input
          className="personnel-input"
          defaultValue={profile.unit}
          key={`${profile.id}-phone-${profile.unit}`}
          placeholder="—"
          disabled={busy}
          aria-label="Phone"
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next !== (profile.unit ?? "")) onPatch({ unit: next });
          }}
        />
      </td>
      <td>
        <select
          className="personnel-select"
          value={role}
          disabled={busy}
          aria-label="Role"
          onChange={(e) => onPatch({ personnel_role: e.target.value as PersonnelRole })}
        >
          {PERSONNEL_ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </td>
      <td>
        <div className="personnel-projects-edit" ref={projectsEditRef}>
          <button type="button" className="personnel-projects-btn" onClick={onTogglePicker} disabled={busy}>
            {projectCount === 0 ? (
              <em className="personnel-unassigned">Unassigned</em>
            ) : (
              <>
                <span>{projectCount} project{projectCount === 1 ? "" : "s"}</span>
                {projectNames.length > 0 && (
                  <span className="personnel-project-names">{projectNames.join(", ")}</span>
                )}
              </>
            )}
            <span className="personnel-edit-icon" aria-hidden="true">✎</span>
          </button>
          {pickerOpen && (
            <div className="personnel-project-picker" role="dialog" aria-label="Project assignment">
              {projects.length === 0 ? (
                <p className="personnel-muted">No projects yet.</p>
              ) : (
                projects.map((p) => {
                  const checked = draftProjectIds.includes(p.id);
                  return (
                    <label key={p.id} className="personnel-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={() => {
                          setDraftProjectIds((ids) =>
                            checked ? ids.filter((id) => id !== p.id) : [...ids, p.id],
                          );
                        }}
                      />
                      {p.name}
                    </label>
                  );
                })
              )}
            </div>
          )}
        </div>
      </td>
      {columns.map((col) => (
        <td key={col.id}>
          <input
            className="personnel-input"
            defaultValue={profile.custom?.[col.id] ?? ""}
            key={`${profile.id}-${col.id}-${profile.custom?.[col.id] ?? ""}`}
            disabled={busy}
            aria-label={col.label}
            onBlur={(e) => {
              const next = e.target.value;
              if (next !== (profile.custom?.[col.id] ?? "")) {
                onPatch({ custom: { [col.id]: next } });
              }
            }}
          />
        </td>
      ))}
      <td>
        <button
          type="button"
          className={`personnel-issue-badge${
            issues === 0 ? " zero" : issues >= 5 ? " high" : " mid"
          }`}
          title={`${profile.display_name}'s open issues`}
          aria-label={`Open ${profile.display_name}'s issues (${issues})`}
          onClick={onOpenIssues}
        >
          {issues}
        </button>
      </td>
      {isAdmin && (
        <td>
          <div className="personnel-actions">
            <button type="button" className="personnel-link" disabled={busy} onClick={onReset}>
              Reset pw
            </button>
            <button type="button" className="personnel-link danger" disabled={busy} onClick={onDelete}>
              Delete
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}

function MemberIssuesModal({
  profile,
  tasks,
  projects,
  onClose,
  onOpenProject,
}: {
  profile: Profile;
  tasks: Task[];
  projects: { id: string; name: string }[];
  onClose: () => void;
  onOpenProject: (projectId: string) => void;
}) {
  const [projectFilter, setProjectFilter] = useState<string>("all");

  const projectOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      counts.set(task.project_id, (counts.get(task.project_id) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, count]) => ({
        id,
        name: projects.find((p) => p.id === id)?.name ?? id.slice(0, 8),
        count,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tasks, projects]);

  const filtered = useMemo(
    () => (projectFilter === "all" ? tasks : tasks.filter((t) => t.project_id === projectFilter)),
    [tasks, projectFilter],
  );

  const statusCounts = useMemo(() => {
    const counts: Record<TaskStatus, number> = {
      opening: 0,
      working: 0,
      closing: 0,
      verify: 0,
    };
    for (const task of filtered) {
      counts[normalizeTaskStatus(task.status)] += 1;
    }
    return counts;
  }, [filtered]);

  const totalOpen = filtered.length;
  const maxBar = Math.max(1, ...TASK_STATUSES.map((s) => statusCounts[s.id]));
  const filterLabel =
    projectFilter === "all"
      ? "All projects"
      : projectOptions.find((p) => p.id === projectFilter)?.name ?? "Project";

  return (
    <div className="personnel-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="personnel-issues-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="personnel-issues-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="personnel-issues-head">
          <div className="personnel-issues-identity">
            <span className={`personnel-avatar ${avatarTone(profile.display_name)}`} aria-hidden="true">
              {initials(profile.display_name)}
            </span>
            <div>
              <h2 id="personnel-issues-title">{possessiveName(profile.display_name)} Issues</h2>
              <p className="personnel-issues-sub">
                {totalOpen} ISSUE{totalOpen === 1 ? "" : "S"}
                {projectFilter !== "all" ? ` · ${filterLabel}` : ""}
              </p>
            </div>
          </div>
          <button type="button" className="personnel-modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="personnel-issues-grid">
          <section className="personnel-issues-list-panel" aria-label="Open issue list">
            <div className="personnel-issues-list-head">
              <div>
                <h3>OPEN ISSUE LIST</h3>
                <p className="personnel-issues-hint">Click an issue to open project detail</p>
              </div>
              <label className="personnel-issues-filter">
                <span className="sr-only">Filter by project</span>
                <select
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  aria-label="Filter by project"
                >
                  <option value="all">All projects ({tasks.length})</option>
                  {projectOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.count})
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {filtered.length === 0 ? (
              <p className="personnel-issues-empty">No open issues.</p>
            ) : (
              <ul className="personnel-issues-cards">
                {filtered.map((task) => {
                  const projectName =
                    projects.find((p) => p.id === task.project_id)?.name ?? "Project";
                  const status = normalizeTaskStatus(task.status);
                  return (
                    <li key={task.id}>
                      <button
                        type="button"
                        className="personnel-issue-card"
                        onClick={() => onOpenProject(task.project_id)}
                      >
                        <div className="personnel-issue-card-top">
                          <span className={`personnel-issue-dot status-${status}`} aria-hidden="true" />
                          <span className="personnel-issue-id">{shortIssueId(task.id)}</span>
                          <span className={`personnel-issue-status status-${status}`}>
                            {taskStatusLabel(status).toUpperCase()}
                          </span>
                        </div>
                        <p className="personnel-issue-title">{task.title}</p>
                        <div className="personnel-issue-tags">
                          <span className="personnel-issue-tag project">{projectName}</span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="personnel-issues-showing">
              Showing {filtered.length} of {tasks.length} issue{tasks.length === 1 ? "" : "s"}
            </p>
          </section>

          <aside className="personnel-issues-stats" aria-label="Status histogram">
            <h3>STATUS HISTOGRAM</h3>
            <ul className="personnel-issues-histogram">
              {TASK_STATUSES.map((status) => {
                const count = statusCounts[status.id];
                const width = Math.round((count / maxBar) * 100);
                return (
                  <li key={status.id}>
                    <div className="personnel-hist-row">
                      <span className={`personnel-hist-label status-${status.id}`}>
                        {status.label.toUpperCase()}
                      </span>
                      <span className="personnel-hist-count">{count}</span>
                    </div>
                    <div className="personnel-hist-track" aria-hidden="true">
                      <span
                        className={`personnel-hist-fill status-${status.id}`}
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="personnel-issues-total">
              <span>TOTAL OPEN ISSUES</span>
              <strong>{totalOpen}</strong>
            </div>
          </aside>
        </div>

        <footer className="personnel-issues-footer">
          <button type="button" className="personnel-btn-ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
