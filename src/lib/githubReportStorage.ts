/**
 * Store Test Report files in the GitHub repo via the Contents API.
 * Path: public/test-reports/<reportId>/<safe-filename>
 * Link: raw.githubusercontent.com URL (available immediately after commit).
 *
 * Token resolution (first match wins):
 * 1. sessionStorage `kssw-gh-upload-token` (paste in UI — preferred for Pages)
 * 2. import.meta.env.VITE_GH_UPLOAD_TOKEN (baked at build; avoid for public Pages)
 */

export const GH_UPLOAD_TOKEN_SESSION_KEY = "kssw-gh-upload-token";

export const TEST_REPORT_UPLOAD_EXT = [".pdf", ".xlsx", ".xls", ".zip", ".csv", ".docx"] as const;
export const TEST_REPORT_MAX_BYTES = 20 * 1024 * 1024; // 20 MiB (Contents API practical browser limit)

const DEFAULT_OWNER = "chungalbert";
const DEFAULT_REPO = "ks-sw-dashboard";
const DEFAULT_BRANCH = "main";
const STORAGE_ROOT = "public/test-reports";

export type GithubUploadResult = {
  /** Repo-relative path, e.g. public/test-reports/<id>/report.pdf */
  file_path: string;
  file_name: string;
  /** Immediate raw.githubusercontent.com URL */
  link: string;
  /** GitHub HTML blob URL */
  html_url: string;
  sha: string;
};

function envOwnerRepo(): { owner: string; repo: string } {
  const raw = (import.meta.env.VITE_GITHUB_REPO ?? `${DEFAULT_OWNER}/${DEFAULT_REPO}`).trim();
  const parts = raw.split("/").filter(Boolean);
  if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
  return { owner: DEFAULT_OWNER, repo: DEFAULT_REPO };
}

export function githubUploadBranch(): string {
  return (import.meta.env.VITE_GITHUB_BRANCH ?? DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
}

export function getGithubUploadToken(): string {
  try {
    const session = sessionStorage.getItem(GH_UPLOAD_TOKEN_SESSION_KEY)?.trim() ?? "";
    if (session) return session;
  } catch {
    /* private mode */
  }
  return (import.meta.env.VITE_GH_UPLOAD_TOKEN ?? "").trim();
}

export function setGithubUploadTokenSession(token: string): void {
  const value = token.trim();
  if (!value) {
    sessionStorage.removeItem(GH_UPLOAD_TOKEN_SESSION_KEY);
    return;
  }
  sessionStorage.setItem(GH_UPLOAD_TOKEN_SESSION_KEY, value);
}

export function hasGithubUploadToken(): boolean {
  return Boolean(getGithubUploadToken());
}

export function isAllowedTestReportFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return TEST_REPORT_UPLOAD_EXT.some((ext) => name.endsWith(ext));
}

export function sanitizeReportFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "report";
  const cleaned = base
    .replace(/[^\w.\-()+ ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
  return cleaned || "report.bin";
}

function reportFilePath(reportId: string, fileName: string): string {
  const id = reportId.replace(/[^a-zA-Z0-9_-]/g, "") || "row";
  return `${STORAGE_ROOT}/${id}/${sanitizeReportFileName(fileName)}`;
}

function rawUrl(owner: string, repo: string, branch: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function githubFetch(path: string, init: RequestInit): Promise<Response> {
  const token = getGithubUploadToken();
  if (!token) {
    throw new Error(
      "缺少 GitHub upload token。在 Test Reports 貼上 fine-grained PAT（Contents: Write），或設定 VITE_GH_UPLOAD_TOKEN。",
    );
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`https://api.github.com${path}`, { ...init, headers });
}

/** GET existing file SHA (needed to overwrite). */
async function getFileSha(
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<string | undefined> {
  const res = await githubFetch(
    `/repos/${owner}/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(branch)}`,
    { method: "GET" },
  );
  if (res.status === 404) return undefined;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub 讀取失敗 (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { sha?: string };
  return typeof data.sha === "string" ? data.sha : undefined;
}

/**
 * Upload (create or overwrite) a report file under public/test-reports/.
 * Commits on VITE_GITHUB_BRANCH (default main).
 */
export async function uploadTestReportFile(input: {
  reportId: string;
  file: File;
  message?: string;
}): Promise<GithubUploadResult> {
  const { reportId, file } = input;
  if (!isAllowedTestReportFile(file)) {
    throw new Error(`不支援的檔案類型。允許：${TEST_REPORT_UPLOAD_EXT.join(", ")}`);
  }
  if (file.size <= 0) throw new Error("空檔案無法上傳");
  if (file.size > TEST_REPORT_MAX_BYTES) {
    throw new Error(`檔案太大（上限 ${Math.floor(TEST_REPORT_MAX_BYTES / (1024 * 1024))} MiB）`);
  }

  const { owner, repo } = envOwnerRepo();
  const branch = githubUploadBranch();
  const file_name = sanitizeReportFileName(file.name);
  const file_path = reportFilePath(reportId, file_name);
  const content = arrayBufferToBase64(await file.arrayBuffer());
  const sha = await getFileSha(owner, repo, file_path, branch);

  const body: Record<string, unknown> = {
    message:
      input.message ??
      `test-report: upload ${file_name} (${reportId.slice(0, 8)})`,
    content,
    branch,
  };
  if (sha) body.sha = sha;

  const res = await githubFetch(
    `/repos/${owner}/${repo}/contents/${file_path.split("/").map(encodeURIComponent).join("/")}`,
    { method: "PUT", body: JSON.stringify(body) },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub 上傳失敗 (${res.status}): ${text.slice(0, 280)}`);
  }
  const data = (await res.json()) as {
    content?: { sha?: string; html_url?: string; path?: string; name?: string };
    commit?: { sha?: string };
  };
  const link = rawUrl(owner, repo, branch, file_path);
  return {
    file_path,
    file_name: data.content?.name ?? file_name,
    link,
    html_url: data.content?.html_url ?? link,
    sha: data.content?.sha ?? data.commit?.sha ?? "",
  };
}
