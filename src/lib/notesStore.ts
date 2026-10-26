import { api } from "./api";
import type { NoteColor, NoteItem } from "./types";

/**
 * Shared sticky notes for every authenticated member.
 * Local: stored in org `awb-store-v1` (same store as projects).
 * Cloud: Supabase `shared_notes` — RLS allows all authenticated users.
 * No owner / role filtering on list.
 */
export type NoteInput = {
  title: string;
  body: string;
  color: NoteColor;
  url?: string;
};

/**
 * Stable display order: pinned first, then created_at (newest created first), then id.
 * Must NOT use updated_at — content edits must leave position unchanged.
 */
export function compareNotesStable(a: NoteItem, b: NoteItem): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const byCreated = (b.created_at ?? "").localeCompare(a.created_at ?? "");
  if (byCreated !== 0) return byCreated;
  return a.id.localeCompare(b.id);
}

export const notesStore = {
  async list(): Promise<NoteItem[]> {
    const notes = await api.listNotes();
    return [...notes].sort(compareNotesStable);
  },

  async create(input: NoteInput): Promise<NoteItem> {
    return api.createNote(input);
  },

  async update(id: string, patch: Partial<NoteInput> & { pinned?: boolean }): Promise<NoteItem> {
    return api.updateNote(id, patch);
  },

  async remove(id: string) {
    await api.removeNote(id);
  },

  async togglePin(id: string): Promise<NoteItem> {
    const notes = await api.listNotes();
    const note = notes.find((n) => n.id === id);
    if (!note) throw new Error("Note not found");
    return api.updateNote(id, { pinned: !note.pinned });
  },
};

/** First http(s) URL in text, used when note has no explicit url. */
export function firstUrlInText(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  return match ? match[0].replace(/[.,);]+$/, "") : null;
}
