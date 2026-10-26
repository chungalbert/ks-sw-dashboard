import type { ProjectCheckpoint, ProjectCheckpointDoc } from "./types";

/** Reserved `projects.custom` key — Neon fallback until `checkpoints` jsonb is live. */
export const PROJECT_CHECKPOINTS_CUSTOM_KEY = "__kssw_checkpoints";

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Normalize one row; migrates legacy `{id,text,checked|done}` → Type/Item/Description. */
export function normalizeCheckpointRow(raw: unknown): ProjectCheckpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = asTrimmedString(row.id).trim();
  if (!id) return null;

  const legacyText = asTrimmedString(row.text);
  const type = asTrimmedString(row.type);
  const item = asTrimmedString(row.item) || legacyText;
  const description = asTrimmedString(row.description);
  const checked = Boolean(row.checked ?? row.done);

  return { id, type, item, description, checked };
}

export function parseCheckpointItems(raw: unknown): ProjectCheckpoint[] {
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
  return parsed.map(normalizeCheckpointRow).filter((row): row is ProjectCheckpoint => Boolean(row));
}

/**
 * Accepts:
 * - legacy array of items
 * - v2 doc `{ handover_date, items }`
 * - JSON string of either
 */
export function parseCheckpointDoc(raw: unknown): ProjectCheckpointDoc {
  let parsed: unknown = raw;
  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) return { handover_date: "", items: [] };
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return { handover_date: "", items: [] };
    }
  }

  if (Array.isArray(parsed)) {
    return { handover_date: "", items: parseCheckpointItems(parsed) };
  }

  if (parsed && typeof parsed === "object") {
    const doc = parsed as Record<string, unknown>;
    // Some clients may nest under `items`; otherwise treat object values as non-doc.
    if (Array.isArray(doc.items) || "handover_date" in doc || "handoverDate" in doc) {
      return {
        handover_date: asTrimmedString(doc.handover_date ?? doc.handoverDate),
        items: parseCheckpointItems(doc.items ?? []),
      };
    }
  }

  return { handover_date: "", items: [] };
}

/** @deprecated Prefer parseCheckpointDoc — kept for call sites that only need items. */
export function parseProjectCheckpoints(raw: unknown): ProjectCheckpoint[] {
  return parseCheckpointDoc(raw).items;
}

/** Extract checkpoint doc from a Neon/local project row (column and/or custom fallback). */
export function checkpointDocFromProjectRow(row: {
  checkpoints?: unknown;
  custom?: Record<string, unknown> | null;
}): ProjectCheckpointDoc {
  if (row.checkpoints !== undefined && row.checkpoints !== null) {
    return parseCheckpointDoc(row.checkpoints);
  }
  const custom = row.custom;
  if (custom && typeof custom === "object" && PROJECT_CHECKPOINTS_CUSTOM_KEY in custom) {
    return parseCheckpointDoc(custom[PROJECT_CHECKPOINTS_CUSTOM_KEY]);
  }
  return { handover_date: "", items: [] };
}

export function checkpointsFromProjectRow(row: {
  checkpoints?: unknown;
  custom?: Record<string, unknown> | null;
}): ProjectCheckpoint[] {
  return checkpointDocFromProjectRow(row).items;
}

/** True when there is at least one item and every item is checked (fully handed over). */
export function areProjectCheckpointsComplete(items: ProjectCheckpoint[] | undefined | null): boolean {
  if (!items || items.length === 0) return false;
  return items.every((item) => item.checked);
}

export function toCheckpointDoc(
  items: ProjectCheckpoint[],
  handoverDate = "",
): ProjectCheckpointDoc {
  return {
    handover_date: handoverDate,
    items: items.map((item) => ({
      id: item.id,
      type: item.type ?? "",
      item: item.item ?? item.text ?? "",
      description: item.description ?? "",
      checked: Boolean(item.checked),
    })),
  };
}

/** Persist shape written to Neon `checkpoints` jsonb / custom fallback. */
export function serializeCheckpointDoc(doc: ProjectCheckpointDoc): ProjectCheckpointDoc {
  return toCheckpointDoc(doc.items, doc.handover_date);
}

export function serializeCheckpointsForCustom(doc: ProjectCheckpointDoc | ProjectCheckpoint[]): string {
  const normalized = Array.isArray(doc)
    ? toCheckpointDoc(doc)
    : serializeCheckpointDoc(doc);
  return JSON.stringify(normalized);
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
