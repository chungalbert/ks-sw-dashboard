import { FormEvent, type MouseEvent, useEffect, useMemo, useState } from "react";
import { SavingIndicator } from "../components/SavingIndicator";
import { SharedStoreBanner } from "../components/SharedStoreBanner";
import { copyTextToClipboard } from "../lib/clipboard";
import { firstUrlInText, normalizeNoteHref, notesStore } from "../lib/notesStore";
import { NOTE_COLORS, type NoteColor, type NoteItem } from "../lib/types";
import { useSaveStatus } from "../lib/useSaveStatus";

const COLOR_LABEL: Record<NoteColor, string> = {
  blue: "Blue",
  purple: "Purple",
  green: "Green",
  yellow: "Yellow",
  pink: "Pink",
  orange: "Orange",
};

function emptyForm() {
  return { title: "", body: "", color: "blue" as NoteColor, url: "" };
}

export function NotesPage({ onGoDashboard }: { onGoDashboard?: () => void }) {
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [copiedId, setCopiedId] = useState("");
  const { saveStatus, runSave } = useSaveStatus();

  const refresh = async () => {
    setNotes(await notesStore.list());
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => {
      const hay = [n.title, n.body, n.url ?? ""].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [notes, query]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm());
    setError("");
    setEditorOpen(true);
  };

  const openEdit = (note: NoteItem) => {
    setEditingId(note.id);
    setForm({
      title: note.title,
      body: note.body,
      color: note.color,
      url: note.url ?? "",
    });
    setError("");
    setEditorOpen(true);
  };

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await runSave(async () => {
        if (editingId) {
          await notesStore.update(editingId, form);
        } else {
          await notesStore.create(form);
        }
        setEditorOpen(false);
        setEditingId(null);
        setForm(emptyForm());
        await refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const onDelete = async (note: NoteItem) => {
    const ok = window.confirm(`Delete note “${note.title}”?`);
    if (!ok) return;
    setError("");
    try {
      await runSave(async () => {
        await notesStore.remove(note.id);
        await refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const onPin = async (id: string) => {
    setError("");
    try {
      await runSave(async () => {
        await notesStore.togglePin(id);
        await refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pin failed");
    }
  };

  const onCopy = async (note: NoteItem, event?: MouseEvent) => {
    event?.preventDefault();
    event?.stopPropagation();
    const text = `${note.title}\n\n${note.body}${note.url ? `\n\n${note.url}` : ""}`.trim();
    try {
      await copyTextToClipboard(text);
      setError("");
      setCopiedId(note.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === note.id ? "" : cur)), 1800);
    } catch {
      setError("Clipboard copy failed — 無法複製到剪貼簿");
    }
  };

  const onOpenLink = (note: NoteItem) => {
    const raw = note.url?.trim() || firstUrlInText(note.body) || "";
    const href = normalizeNoteHref(raw);
    if (!href) {
      setError("No link on this note");
      return;
    }
    window.open(href, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="note-page">
      <header className="note-toolbar">
        <nav className="note-breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="note-bc-home" onClick={onGoDashboard} aria-label="Dashboard">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
              <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </button>
          <button type="button" className="note-bc-link" onClick={onGoDashboard}>
            Dashboard
          </button>
          <span className="note-bc-sep" aria-hidden="true">›</span>
          <span className="note-bc-current">Note</span>
        </nav>

        <div className="note-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.34-4.34" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search notes"
          />
        </div>

        <div className="note-actions">
          <SavingIndicator status={saveStatus} />
          <button type="button" className="note-add-btn" onClick={openCreate}>
            + ADD
          </button>
        </div>
      </header>

      {error && <p className="note-error">{error}</p>}
      {copiedId && <p className="note-toast" role="status">已複製到剪貼簿</p>}

      <SharedStoreBanner onMigrated={() => void refresh()} />

      <div className="note-grid">
        {filtered.length === 0 ? (
          <p className="note-empty">
            {notes.length === 0 ? "No notes yet. Click + ADD to create one." : "No notes match this search."}
          </p>
        ) : (
          filtered.map((note) => {
            const hasLink = Boolean(note.url?.trim() || firstUrlInText(note.body));
            return (
              <article key={note.id} className={`note-card tone-${note.color}${note.pinned ? " is-pinned" : ""}`}>
                <header className="note-card-head">
                  <h2>{note.title}</h2>
                  <div className="note-card-tools">
                    <button
                      type="button"
                      className={`note-icon-btn${copiedId === note.id ? " copied" : ""}`}
                      title={copiedId === note.id ? "已複製" : "Copy"}
                      aria-label={copiedId === note.id ? "已複製" : "Copy note"}
                      onClick={(e) => void onCopy(note, e)}
                    >
                      {copiedId === note.id ? (
                        <span className="note-copied-label">已複製</span>
                      ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" />
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      className={`note-icon-btn${note.pinned ? " on" : ""}`}
                      title={note.pinned ? "Unpin" : "Pin"}
                      aria-label={note.pinned ? "Unpin note" : "Pin note"}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void onPin(note.id);
                      }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 17v5" />
                        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
                      </svg>
                    </button>
                  </div>
                </header>
                <pre className="note-card-body">{note.body || " "}</pre>
                <footer className="note-card-foot">
                  <div className="note-card-tools">
                    <button
                      type="button"
                      className="note-icon-btn"
                      title={hasLink ? "Open link" : "No link"}
                      aria-label="Open link"
                      disabled={!hasLink}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onOpenLink(note);
                      }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M2 12h20" />
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className="note-icon-btn danger"
                      title="Delete"
                      aria-label="Delete note"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void onDelete(note);
                      }}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18" />
                        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      </svg>
                    </button>
                  </div>
                  <button
                    type="button"
                    className="note-icon-btn"
                    title="Edit"
                    aria-label="Edit note"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openEdit(note);
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                  </button>
                </footer>
              </article>
            );
          })
        )}
      </div>

      {editorOpen && (
        <div
          className="note-modal-backdrop"
          role="presentation"
          onClick={() => setEditorOpen(false)}
        >
          <form
            className="note-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="note-editor-title"
            onClick={(e) => e.stopPropagation()}
            onSubmit={onSave}
          >
            <header className="note-modal-head">
              <h2 id="note-editor-title">{editingId ? "Edit note" : "Add note"}</h2>
              <button type="button" className="note-modal-close" aria-label="Close" onClick={() => setEditorOpen(false)}>
                ×
              </button>
            </header>
            <div className="note-modal-body">
              <label>
                Title
                <input
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="Note title"
                  autoFocus
                  required
                />
              </label>
              <label>
                Body
                <textarea
                  rows={8}
                  value={form.body}
                  onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                  placeholder="Note content"
                />
              </label>
              <label>
                Link (optional)
                <input
                  type="text"
                  inputMode="url"
                  value={form.url}
                  onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                  placeholder="https://… or hostname"
                />
              </label>
              <fieldset className="note-color-field">
                <legend>Color</legend>
                <div className="note-color-row">
                  {NOTE_COLORS.map((color) => (
                    <label key={color} className={`note-color-swatch tone-${color}${form.color === color ? " on" : ""}`}>
                      <input
                        type="radio"
                        name="note-color"
                        value={color}
                        checked={form.color === color}
                        onChange={() => setForm((f) => ({ ...f, color }))}
                      />
                      <span>{COLOR_LABEL[color]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <footer className="note-modal-actions">
              <button type="button" className="note-btn-ghost" onClick={() => setEditorOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="note-btn-primary" disabled={!form.title.trim()}>
                {editingId ? "Save" : "Add"}
              </button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}
