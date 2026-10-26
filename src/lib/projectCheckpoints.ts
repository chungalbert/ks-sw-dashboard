import type { ProjectCheckpoint } from "./types";

/** Reserved `projects.custom` key — Neon fallback until `checkpoints` jsonb is live. */
export const PROJECT_CHECKPOINTS_CUSTOM_KEY = "__kssw_checkpoints";

export function parseProjectCheckpoints(raw: unknown): ProjectCheckpoint[] {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as { id?: unknown; text?: unknown; checked?: unknown; done?: unknown };
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const text = typeof row.text === "string" ? row.text : "";
      if (!id) return null;
      const checked = Boolean(row.checked ?? row.done);
      return { id, text, checked };
    })
    .filter((row): row is ProjectCheckpoint => Boolean(row));
}

/** Extract checkpoints from a Neon/local project row (column and/or custom fallback). */
export function checkpointsFromProjectRow(row: {
  checkpoints?: unknown;
  custom?: Record<string, unknown> | null;
}): ProjectCheckpoint[] {
  // Prefer dedicated column when present (including explicit empty array).
  if (row.checkpoints !== undefined && row.checkpoints !== null) {
    return parseProjectCheckpoints(row.checkpoints);
  }
  const custom = row.custom;
  if (custom && typeof custom === "object" && PROJECT_CHECKPOINTS_CUSTOM_KEY in custom) {
    return parseProjectCheckpoints(custom[PROJECT_CHECKPOINTS_CUSTOM_KEY]);
  }
  return [];
}

/** True when there is at least one item and every item is checked (fully handed over). */
export function areProjectCheckpointsComplete(items: ProjectCheckpoint[] | undefined | null): boolean {
  if (!items || items.length === 0) return false;
  return items.every((item) => item.checked);
}

export function serializeCheckpointsForCustom(items: ProjectCheckpoint[]): string {
  return JSON.stringify(
    items.map((item) => ({
      id: item.id,
      text: item.text,
      checked: Boolean(item.checked),
    })),
  );
}

export function stripCheckpointsCustomKey(
  custom: Record<string, string> | undefined | null,
): Record<string, string> {
  if (!custom) return {};
  if (!(PROJECT_CHECKPOINTS_CUSTOM_KEY in custom)) return { ...custom };
  const next = { ...custom };
  delete next[PROJECT_CHECKPOINTS_CUSTOM_KEY];
  return next;
}
