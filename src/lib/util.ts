export function hasNeonConfig(): boolean {
  return Boolean(import.meta.env.VITE_NEON_URL);
}

export function hasSupabaseCredentials(): boolean {
  return Boolean(
    import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
  );
}

/** Cloud mode. On this branch a Neon URL takes the place of Supabase. */
export function hasSupabaseConfig(): boolean {
  return hasNeonConfig() || hasSupabaseCredentials();
}

export function usernameFromEmail(email: string, taken: Set<string>): string {
  const base = email
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 24) || "user";
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}${n}`;
    n += 1;
  }
  return candidate;
}

export const DEFAULT_PASSWORD = "abcd1234";

/**
 * Footer version from GitHub PR number (rollover every 100 PRs).
 * `major = floor((pr - 1) / 100) + 1`, `minor = padStart(pr % 100, 2)` (`00` when divisible by 100).
 * Examples: #94 → `1.94`, #100 → `1.00`, #101 → `2.01`, #102 → `2.02`.
 */
export function appVersionFromPr(pr: number): string {
  const n = Math.max(1, Math.floor(pr));
  const major = Math.floor((n - 1) / 100) + 1;
  const minor = String(n % 100).padStart(2, "0");
  return `${major}.${minor}`;
}

/**
 * App version for the landing/sidebar footer. Bump to `appVersionFromPr(<this PR#>)`
 * when that feature PR lands (see preferences.md).
 */
export const APP_VERSION = appVersionFromPr(104);

/**
 * Author + version label for landing footer and logged-in sidebar credit.
 * Format: `KSSW_Albert <major>.<minor>` (brand + author Albert + APP_VERSION).
 */
export const LANDING_FOOTER_LABEL = `KSSW_Albert ${APP_VERSION}`;

export function randomPassword(): string {
  return DEFAULT_PASSWORD;
}

export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function toCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (/[",\n]/.test(cell)) return `"${cell.replaceAll('"', '""')}"`;
          return cell;
        })
        .join(","),
    )
    .join("\n");
}
