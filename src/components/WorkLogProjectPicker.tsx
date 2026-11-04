import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type WorkLogProjectOption = {
  id: string;
  name: string;
  lenovo_name?: string;
};

type Props = {
  value: string;
  options: WorkLogProjectOption[];
  onChange: (projectId: string) => void;
  disabled?: boolean;
  /** Accessible name for the trigger (defaults to Project). */
  "aria-label"?: string;
};

type MenuPos = { top: number; left: number; width: number; maxHeight: number };

/**
 * Compact Project combobox for Work Log rows.
 * In-dropdown search matches Compal (`name`) and Lenovo (`lenovo_name`) names.
 * Menu portals to document.body so table overflow does not clip it.
 */
export function WorkLogProjectPicker({
  value,
  options,
  onChange,
  disabled,
  "aria-label": ariaLabel = "Project",
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);

  const selected = useMemo(
    () => options.find((p) => p.id === value) ?? null,
    [options, value],
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((p) => {
      const compal = p.name.toLowerCase();
      const lenovo = (p.lenovo_name ?? "").toLowerCase();
      return compal.includes(q) || lenovo.includes(q);
    });
  }, [options, filter]);

  const placeMenu = () => {
    const trigger = rootRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const gap = 4;
    const preferredHeight = 260;
    const spaceBelow = window.innerHeight - rect.bottom - gap - 8;
    const spaceAbove = rect.top - gap - 8;
    const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(preferredHeight, openUp ? spaceAbove : spaceBelow));
    const width = Math.max(rect.width, 220);
    const left = Math.min(rect.left, Math.max(8, window.innerWidth - width - 8));
    const top = openUp ? rect.top - gap - maxHeight : rect.bottom + gap;
    setMenuPos({ top, left, width, maxHeight });
  };

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    placeMenu();
    const onReposition = () => placeMenu();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const root = rootRef.current;
      const menu = menuRef.current;
      const target = event.target as Node;
      if (root?.contains(target) || menu?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  const pick = (projectId: string) => {
    onChange(projectId);
    setOpen(false);
  };

  const menu =
    open && menuPos
      ? createPortal(
          <div
            ref={menuRef}
            className="wl-project-menu"
            role="listbox"
            aria-label="Project list"
            style={{
              top: menuPos.top,
              left: menuPos.left,
              width: menuPos.width,
              maxHeight: menuPos.maxHeight,
            }}
          >
            <label className="wl-project-search">
              <span className="sr-only">Search projects</span>
              <input
                ref={searchRef}
                type="search"
                value={filter}
                placeholder="Search Compal / Lenovo…"
                aria-label="Search Compal or Lenovo project name"
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const first = filtered[0];
                    if (first) pick(first.id);
                  }
                }}
              />
            </label>
            <button
              type="button"
              role="option"
              className={`wl-project-option${value === "" ? " is-selected" : ""}`}
              aria-selected={value === ""}
              onClick={() => pick("")}
            >
              —
            </button>
            {filtered.length === 0 ? (
              <p className="wl-project-empty">No matching projects</p>
            ) : (
              filtered.map((p) => {
                const lenovo = (p.lenovo_name ?? "").trim();
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    className={`wl-project-option${value === p.id ? " is-selected" : ""}`}
                    aria-selected={value === p.id}
                    title={lenovo ? `${p.name} / ${lenovo}` : p.name}
                    onClick={() => pick(p.id)}
                  >
                    <span className="wl-project-option-compal">{p.name}</span>
                    {lenovo ? (
                      <span className="wl-project-option-lenovo">{lenovo}</span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={`wl-project-picker${open ? " is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="wl-project-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          selected
            ? [selected.name, selected.lenovo_name].filter(Boolean).join(" / ")
            : undefined
        }
        onClick={() => setOpen((v) => !v)}
      >
        <span className="wl-project-trigger-label">{selected?.name || "—"}</span>
        <span className="wl-project-trigger-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {menu}
    </div>
  );
}
