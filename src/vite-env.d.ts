/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** https://ep-....neon.tech/dbname — no user, password, or query string. */
  readonly VITE_NEON_URL?: string;
  /**
   * Optional GitHub Contents write token for Test Reports upload.
   * Prefer session paste (see docs/test-reports-github-upload.md) — VITE_ values ship in the SPA bundle.
   */
  readonly VITE_GH_UPLOAD_TOKEN?: string;
  /** `owner/repo` for Test Reports uploads (default chungalbert/ks-sw-dashboard). */
  readonly VITE_GITHUB_REPO?: string;
  /** Branch for Contents commits (default main). */
  readonly VITE_GITHUB_BRANCH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "../vendor/frappe-gantt.js" {
  const Gantt: new (
    wrapper: string | HTMLElement,
    tasks: Array<Record<string, unknown>>,
    options?: Record<string, unknown>,
  ) => {
    refresh(tasks: Array<Record<string, unknown>>): void;
    change_view_mode(mode: string): void;
  };
  export default Gantt;
}
