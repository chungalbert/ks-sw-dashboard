# Test Reports — GitHub file storage

Report files (pdf / xlsx / zip / …) are committed into this repo with the **GitHub Contents API**, not only as an external URL.

## Paths

| What | Value |
|------|--------|
| Repo path | `public/test-reports/<report-row-id>/<safe-filename>` |
| Neon `file_path` | same repo-relative path |
| Neon `file_name` | sanitized original name |
| Neon `link` | `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/public/test-reports/...` (immediate) |
| Pages URL (after deploy) | `https://chungalbert.github.io/ks-sw-dashboard/test-reports/...` (strips `public/`) |

Default owner/repo/branch: `chungalbert/ks-sw-dashboard` @ `main`.  
Override with `VITE_GITHUB_REPO` (`owner/name`) and `VITE_GITHUB_BRANCH`.

## Access

Same as Work Log: **Admin / DM / DL / DE** only. DQA / PM / SA cannot open Test Reports (nav + RLS).

## Token / secrets (production)

The SPA calls `api.github.com` from the browser. Prefer **not** baking a write token into the Pages bundle:

1. **Recommended:** In Test Reports, paste a **fine-grained PAT** into the “GitHub token” field (stored in `sessionStorage` key `kssw-gh-upload-token` for this tab only).
   - Permissions: **Contents: Read and write** on `chungalbert/ks-sw-dashboard` only.
   - Cloud Agent / Albert PAT `GH_TOKEN` works for demos if pasted/exported locally.
2. **Optional build secret:** `VITE_GH_UPLOAD_TOKEN` — if set in GitHub Actions / `.env.local`, it is used when session token is empty.
   - **Warning:** Any `VITE_*` value is public in the JS bundle. Use only a least-privilege fine-grained PAT, and rotate if exposed. Prefer session paste for production Pages.
3. Wire optional secret into Pages deploy (`.github/workflows/pages.yml`):

```yaml
VITE_GH_UPLOAD_TOKEN: ${{ secrets.VITE_GH_UPLOAD_TOKEN }}
VITE_GITHUB_REPO: ${{ vars.VITE_GITHUB_REPO || 'chungalbert/ks-sw-dashboard' }}
VITE_GITHUB_BRANCH: ${{ vars.VITE_GITHUB_BRANCH || 'main' }}
```

Repo settings → Secrets → Actions: add `VITE_GH_UPLOAD_TOKEN` only if you accept client exposure.

## Neon

- Fresh install: `neon/test-reports.sql` (includes `file_path` / `file_name`).
- Existing table: apply `neon/test-reports-file-path.sql`, then **refresh Data API schema cache**.

## Limits

- Extensions: `.pdf`, `.xlsx`, `.xls`, `.zip`, `.csv`, `.docx`
- Max size: 20 MiB
