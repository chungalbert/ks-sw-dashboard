import { lazy, Suspense, useState } from "react";
import { useAuth } from "./context/AuthContext";
import { StoreProvider, useStore } from "./context/StoreContext";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { ProjectsIssuesPage } from "./pages/ProjectsIssuesPage";
import { PeoplePage } from "./pages/PeoplePage";
import { GuidesPage } from "./pages/GuidesPage";
import { NotesPage } from "./pages/NotesPage";
import { ChatPage } from "./pages/ChatPage";
import { ToolPage } from "./pages/ToolPage";
import { OtpVaultPage } from "./pages/OtpVaultPage";
import { WheaToolPage } from "./pages/WheaToolPage";
import { SecurityPage } from "./pages/SecurityPage";
import { InvPcrPage } from "./pages/InvPcrPage";
import { WorkLogPage } from "./pages/WorkLogPage";
import { AppToolbar } from "./components/AppToolbar";
import { LoadingIndicator } from "./components/LoadingIndicator";
import { PageLoadingGate, viewNeedsStoreBoot } from "./components/PageLoadingGate";
import { ReminderBanner } from "./components/ReminderBanner";
import { ChangePasswordModal } from "./components/ChangePasswordModal";
import {
  canAccessView,
  isWorkspaceLimitedRole,
  normalizePersonnelRole,
  type ViewId,
} from "./lib/types";
import { ALL_PROJECTS_ID } from "./lib/projects";
import { personnelRoleLabel } from "./lib/roles";
import { LANDING_FOOTER_LABEL } from "./lib/util";

const GanttPage = lazy(() => import("./pages/GanttPage").then((m) => ({ default: m.GanttPage })));

type NavItem = { id: ViewId; label: string; icon: string };
type NavGroup = { key: string; label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    key: "workspace",
    label: "WORKSPACE",
    items: [
      { id: "home", label: "Dashboard", icon: "grid" },
      { id: "projects", label: "Projects & Issues", icon: "folder" },
      { id: "gantt", label: "Project schedule", icon: "calendar" },
      { id: "security", label: "Security", icon: "shield" },
      { id: "inv-pcr", label: "INV&PCR", icon: "clipboard" },
      { id: "work-log", label: "Work Log", icon: "list" },
    ],
  },
  {
    key: "feature",
    label: "FEATURE",
    items: [
      { id: "guides", label: "教學", icon: "book" },
      { id: "chat", label: "Chat", icon: "chat" },
      { id: "notes", label: "Note", icon: "note" },
      { id: "tool", label: "Tool", icon: "tool" },
    ],
  },
  {
    key: "management",
    label: "MANAGEMENT",
    items: [
      { id: "people", label: "Personnel", icon: "users" },
    ],
  },
];

function NavIcon({ name }: { name: string }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  switch (name) {
    case "grid":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
          <rect x="2" y="6" width="20" height="14" rx="2" />
        </svg>
      );
    case "calendar":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M16 3v4M8 3v4M3 11h18" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      );
    case "clipboard":
      return (
        <svg {...common}>
          <rect x="8" y="2" width="8" height="4" rx="1" />
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <path d="M9 12h6M9 16h6" />
        </svg>
      );
    case "list":
      return (
        <svg {...common}>
          <path d="M8 6h13M8 12h13M8 18h13" />
          <path d="M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
      );
    case "book":
      return (
        <svg {...common}>
          <path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 0-2 2V5z" />
          <path d="M6 3v16" />
        </svg>
      );
    case "note":
      return (
        <svg {...common}>
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
          <path d="M10 9H8" />
          <path d="M16 13H8" />
          <path d="M16 17H8" />
        </svg>
      );
    case "chat":
      return (
        <svg {...common}>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "tool":
      return (
        <svg {...common}>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case "users":
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3" />
          <path d="M3 19a6 6 0 0 1 12 0" />
          <circle cx="17" cy="9" r="2.5" />
          <path d="M15.5 19a4.5 4.5 0 0 1 5.5 0" />
        </svg>
      );
    default:
      return null;
  }
}

const SIDEBAR_COLLAPSED_KEY = "kssw-sidebar-collapsed";

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function Shell() {
  const { user, signOut } = useAuth();
  const { projects, projectId, setProjectId, initialLoading, loadError } = useStore();
  const [view, setView] = useState<ViewId>("home");
  const [showPassword, setShowPassword] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    workspace: true,
    feature: true,
    management: true,
  });
  /** Open Projects detail for this id after navigating from Personnel Issues modal. */
  const [pendingProjectOpen, setPendingProjectOpen] = useState<string | null>(null);
  const personnelRole = user ? normalizePersonnelRole(user) : "DE";
  const limitedWorkspace = isWorkspaceLimitedRole(personnelRole);
  // DQA/PM/SA: only Security + INV&PCR. Admin/DM/DL/DE get full nav including Personnel.
  const groups = NAV_GROUPS.map((group) => {
    let items = group.items;
    if (limitedWorkspace) {
      items = items.filter((item) => canAccessView(personnelRole, item.id));
    }
    return { ...group, items };
  }).filter((group) => group.items.length > 0);

  const resolvedView: ViewId = view === "tasks" ? "projects" : view;
  const currentView: ViewId = limitedWorkspace
    ? canAccessView(personnelRole, resolvedView)
      ? resolvedView
      : "security"
    : resolvedView;
  const initial = (user?.display_name || user?.username || "?").trim().charAt(0).toUpperCase();
  const isProjectIssue = currentView === "projects";
  const isPersonnel = currentView === "people";
  const isNotes = currentView === "notes";
  const isChat = currentView === "chat";
  const isOtp = currentView === "otp";
  const isWhea = currentView === "whea";
  const isSecurity = currentView === "security";
  const isWorkLog = currentView === "work-log";
  const isToolChild = isOtp || isWhea;
  const hideChrome =
    isProjectIssue || isPersonnel || isNotes || isChat || isToolChild || isSecurity || isWorkLog;

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore quota / private mode */
      }
      return next;
    });
  };

  return (
    <div
      className={`app shell${isProjectIssue ? " shell-pi" : ""}${isPersonnel ? " shell-personnel" : ""}${isNotes ? " shell-note" : ""}${isChat ? " shell-chat" : ""}${isOtp ? " shell-otp" : ""}${isWhea ? " shell-tool-detail" : ""}${isSecurity ? " shell-security" : ""}${isWorkLog ? " shell-work-log" : ""}${sidebarCollapsed ? " shell-sidebar-collapsed" : ""}`}
    >
      <aside
        className={`sidebar${sidebarCollapsed ? " is-collapsed" : ""}`}
        aria-label="KSSW navigation"
      >
        <div className="sidebar-brand-row">
          {!sidebarCollapsed && (
            <a
              className="sidebar-brand"
              href="./"
              onClick={(e) => {
                e.preventDefault();
                setView("home");
              }}
            >
              <span className="sidebar-brand-name">KSSW</span>
            </a>
          )}
          <button
            type="button"
            className="sidebar-toggle"
            onClick={toggleSidebar}
            aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              {sidebarCollapsed ? (
                <path d="M9 18l6-6-6-6" />
              ) : (
                <path d="M15 18l-6-6 6-6" />
              )}
            </svg>
          </button>
        </div>

        {!sidebarCollapsed && (
          <>
            <nav className="sidebar-nav">
              {groups.map((group) => {
                const open = openGroups[group.key] !== false;
                return (
                  <div key={group.key} className="nav-group">
                    <button
                      type="button"
                      className="nav-group-label"
                      onClick={() => toggleGroup(group.key)}
                      aria-expanded={open}
                    >
                      <span>{group.label}</span>
                      <span className={`chev ${open ? "open" : ""}`} aria-hidden="true">▾</span>
                    </button>
                    {open && (
                      <ul>
                        {group.items.map((item) => (
                          <li key={item.id}>
                            <button
                              type="button"
                              className={currentView === item.id || (item.id === "tool" && isToolChild) ? "on" : ""}
                              onClick={() => setView(item.id)}
                            >
                              <NavIcon name={item.icon} />
                              <span>{item.label}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </nav>

            <div className="sidebar-footer">
              <div className="sidebar-user">
                <div className="avatar" aria-hidden="true">
                  {initial}
                  <span className="online-dot" />
                </div>
                <div className="sidebar-user-meta">
                  <span className="sidebar-user-name">{user?.display_name}</span>
                  <span className="sidebar-user-role" title="Personnel Role">
                    {personnelRoleLabel(personnelRole)}
                  </span>
                </div>
                <button
                  type="button"
                  className="bell-btn"
                  aria-label="Notifications"
                  title="Reminders & alerts"
                  onClick={() => setView("home")}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M6 9a6 6 0 1 1 12 0c0 7 3 7 3 7H3s3 0 3-7" />
                    <path d="M10 19a2 2 0 0 0 4 0" />
                  </svg>
                </button>
              </div>
              <button type="button" className="logout-btn" onClick={() => void signOut()}>
                → LOGOUT
              </button>
              <button type="button" className="sidebar-link" onClick={() => setShowPassword(true)}>
                Change password
              </button>
              <p className="sidebar-credit" title={LANDING_FOOTER_LABEL}>
                {LANDING_FOOTER_LABEL}
              </p>
            </div>
          </>
        )}
      </aside>

      <div className="shell-main">
        {!hideChrome && (
          <AppToolbar
            view={currentView}
            onGoDashboard={() => setView("home")}
            trailing={
              currentView === "home" || currentView === "gantt" ? (
                <select
                  className="proj-select"
                  value={projectId ?? ""}
                  onChange={(e) => setProjectId(e.target.value)}
                  aria-label="Project filter"
                  disabled={initialLoading}
                >
                  {initialLoading && <option value="">載入中…</option>}
                  {!initialLoading && projects.length === 0 && (
                    <option value="">{loadError ? "載入失敗" : "No projects"}</option>
                  )}
                  {!initialLoading && projects.length > 0 && (
                    <option value={ALL_PROJECTS_ID}>All Projects</option>
                  )}
                  {!initialLoading &&
                    projects.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </select>
              ) : null
            }
          />
        )}

        <main
          className={`page page-shell${isProjectIssue ? " page-pi" : ""}${isPersonnel ? " page-personnel" : ""}${isNotes ? " page-note" : ""}${isChat ? " page-chat" : ""}${isOtp ? " page-otp" : ""}${isWhea ? " page-tool-detail" : ""}${isSecurity ? " page-security" : ""}${isWorkLog ? " page-work-log" : ""}`}
        >
          {viewNeedsStoreBoot(currentView) ? (
            <PageLoadingGate>
              {!hideChrome &&
                currentView !== "guides" &&
                currentView !== "tool" &&
                currentView !== "inv-pcr" && <ReminderBanner />}
              {currentView === "home" && <DashboardPage />}
              {currentView === "projects" && (
                <ProjectsIssuesPage
                  onGoDashboard={() => setView("home")}
                  openProjectId={pendingProjectOpen}
                  onOpenProjectConsumed={() => setPendingProjectOpen(null)}
                />
              )}
              {currentView === "people" && (
                <PeoplePage
                  onGoDashboard={() => setView("home")}
                  onOpenProject={(projectId) => {
                    setPendingProjectOpen(projectId);
                    setProjectId(projectId);
                    setView("projects");
                  }}
                />
              )}
              {currentView === "security" && (
                <SecurityPage onGoDashboard={() => setView("home")} />
              )}
              {currentView === "work-log" && (
                <WorkLogPage onGoDashboard={() => setView("home")} />
              )}
              {currentView === "gantt" && (
                <Suspense
                  fallback={
                    <div className="page-loading-gate" role="status" aria-busy="true">
                      <LoadingIndicator />
                    </div>
                  }
                >
                  <GanttPage />
                </Suspense>
              )}
            </PageLoadingGate>
          ) : (
            <>
              {currentView === "inv-pcr" && <InvPcrPage />}
              {currentView === "guides" && <GuidesPage />}
              {currentView === "notes" && (
                <NotesPage onGoDashboard={() => setView("home")} />
              )}
              {currentView === "chat" && (
                <ChatPage onGoDashboard={() => setView("home")} />
              )}
              {currentView === "tool" && (
                <ToolPage
                  onOpenOtp={() => setView("otp")}
                  onOpenWhea={() => setView("whea")}
                />
              )}
              {currentView === "otp" && (
                <OtpVaultPage
                  onGoDashboard={() => setView("tool")}
                  ownerId={user?.username}
                />
              )}
              {currentView === "whea" && (
                <WheaToolPage onBack={() => setView("tool")} />
              )}
            </>
          )}
        </main>
      </div>

      {showPassword && <ChangePasswordModal onClose={() => setShowPassword(false)} />}
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="app landing-app">
        <div className="page-loading-gate" role="status" aria-busy="true">
          <LoadingIndicator />
        </div>
      </div>
    );
  }
  if (!user) return <LoginPage />;
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
