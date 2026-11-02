import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ProjectInfoData = {
  name: string;
  /** Lenovo Project Name (from projects.lenovo_name). */
  lenovo_name?: string;
  platform: string;
  mpEop: string;
  segment: string;
  wave: string;
  owner: string;
  reviewer: string;
};

/** Format ISO / free dates as Mon-YY (e.g. Jan-24). */
export function formatMonthYear(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4})-(\d{2})/);
  if (iso) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const m = Number(iso[2]) - 1;
    const yy = iso[1].slice(2);
    return months[m] ? `${months[m]}-${yy}` : s;
  }
  return s;
}

/** MP from ss_date; Active unless eol_date is past. */
export function formatMpEop(ssDate?: string, eolDate?: string): string {
  const mp = formatMonthYear(ssDate ?? "");
  const eol = (eolDate ?? "").trim();
  let status = "";
  if (eol) {
    const d = Date.parse(eol);
    if (!Number.isNaN(d) && d < Date.now()) status = "EOP";
    else status = formatMonthYear(eol) || "Active";
  } else if (mp) {
    status = "Active";
  }
  if (mp && status) return `${mp} / ${status}`;
  if (mp) return mp;
  if (status) return status;
  return "—";
}

export function resolveSegment(project: {
  talent_policy?: string;
  description?: string;
  custom?: Record<string, string>;
}): string {
  const talent = (project.talent_policy ?? "").trim();
  if (talent) return talent;
  const custom = project.custom ?? {};
  for (const [k, v] of Object.entries(custom)) {
    if (!v?.trim()) continue;
    if (/segment|category|smb|commercial|consumer/i.test(k) || /commercial|smb|consumer/i.test(v)) {
      return v.trim();
    }
  }
  const desc = (project.description ?? "").trim();
  if (desc && desc.length <= 40) return desc;
  return "—";
}

export function ProjectInfoPopover({
  open,
  data,
  onClose,
  anchorEl,
}: {
  open: boolean;
  data: ProjectInfoData;
  onClose: () => void;
  anchorEl: HTMLElement | null;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorEl) {
      setPos(null);
      return;
    }
    const place = () => {
      const r = anchorEl.getBoundingClientRect();
      const width = 220;
      let left = r.left + r.width / 2 - width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      setPos({ top: r.bottom + 6, left });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorEl]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (cardRef.current?.contains(t)) return;
      if (anchorEl?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorEl]);

  if (!open || !pos) return null;

  const rows: { label: string; value: string }[] = [
    { label: "MP / EOP", value: data.mpEop || "—" },
    { label: "Segment", value: data.segment || "—" },
    { label: "Wave", value: data.wave || "—" },
    { label: "Owner", value: data.owner || "—" },
    { label: "Reviewer", value: data.reviewer || "—" },
  ];

  return createPortal(
    <div
      ref={cardRef}
      className="sec-proj-info-card"
      role="dialog"
      aria-label={`${data.name} project info`}
      style={{ top: pos.top, left: pos.left }}
    >
      <div className="sec-proj-info-title">
        <strong>{data.name}</strong>
        {data.lenovo_name?.trim() ? (
          <span className="sec-proj-info-lenovo" title="Lenovo Project Name">
            {data.lenovo_name.trim()}
          </span>
        ) : null}
        {data.platform ? <span className="sec-proj-info-platform">{data.platform}</span> : null}
      </div>
      <dl className="sec-proj-info-rows">
        {rows.map((r) => (
          <div key={r.label} className="sec-proj-info-row">
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>,
    document.body,
  );
}
