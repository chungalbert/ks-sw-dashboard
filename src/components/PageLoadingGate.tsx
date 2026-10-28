import type { ReactNode } from "react";
import { useStore } from "../context/StoreContext";
import type { ViewId } from "../lib/types";
import { LoadingIndicator } from "./LoadingIndicator";

/** Views that read Neon/store boot data (projects, profiles, members, tasks). */
export const STORE_BOOT_VIEWS = new Set<ViewId>([
  "home",
  "projects",
  "gantt",
  "people",
  "tasks",
  "security",
  "work-log",
]);

/**
 * Hold page content until the first store fetch settles so empty / Unassigned
 * defaults are not shown as final UI during Neon hydrate.
 */
export function PageLoadingGate({ children }: { children: ReactNode }) {
  const { initialLoading } = useStore();
  if (initialLoading) {
    return (
      <div className="page-loading-gate" role="status" aria-busy="true" aria-live="polite">
        <LoadingIndicator />
      </div>
    );
  }
  return <>{children}</>;
}

export function viewNeedsStoreBoot(view: ViewId): boolean {
  return STORE_BOOT_VIEWS.has(view);
}
