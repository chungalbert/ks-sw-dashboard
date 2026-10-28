import type { ReactNode } from "react";
import type { ViewId } from "../lib/types";

const VIEW_CRUMB: Partial<Record<ViewId, string>> = {
  home: "Dashboard",
  gantt: "Project schedule",
  security: "BIOS Security Updates",
  "inv-pcr": "INV&PCR",
  "work-log": "Work Log",
  guides: "教學",
  notes: "Note",
  chat: "Chat",
  tool: "Tool",
  otp: "OTP Vault",
  tasks: "Tasks",
};

export function AppToolbar({
  view,
  onGoDashboard,
  trailing,
}: {
  view: ViewId;
  onGoDashboard: () => void;
  trailing?: ReactNode;
}) {
  const crumb = VIEW_CRUMB[view] ?? "Dashboard";
  const isHome = view === "home";

  return (
    <header className="app-toolbar">
      <nav className="app-breadcrumb" aria-label="Breadcrumb">
        <button
          type="button"
          className="app-bc-home"
          onClick={onGoDashboard}
          aria-label="Dashboard"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
            <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
        </button>
        {isHome ? (
          <span className="app-bc-current">Dashboard</span>
        ) : (
          <>
            <button type="button" className="app-bc-link" onClick={onGoDashboard}>
              Dashboard
            </button>
            <span className="app-bc-sep" aria-hidden="true">›</span>
            <span className="app-bc-current">{crumb}</span>
          </>
        )}
      </nav>
      {trailing ? <div className="app-toolbar-trailing">{trailing}</div> : null}
    </header>
  );
}
