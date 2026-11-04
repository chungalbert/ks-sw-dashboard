import {
  FormEvent,
  type ChangeEvent,
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { SavingIndicator } from "../components/SavingIndicator";
import { SharedStoreBanner } from "../components/SharedStoreBanner";
import { copyTextToClipboard } from "../lib/clipboard";
import { decodeQrFromFile, decodeQrFromImageData } from "../lib/otpQr";
import { otpVaultStore } from "../lib/otpVaultStore";
import { formatCode, generateTotp, parseOtpInput, totpRemaining } from "../lib/totp";
import type { OtpVaultEntry } from "../lib/types";
import { useSaveStatus } from "../lib/useSaveStatus";

type AddForm = {
  paste: string;
  label: string;
  issuer: string;
  account: string;
  access_password: string;
  thumb?: string;
};

const EMPTY_FORM: AddForm = {
  paste: "",
  label: "",
  issuer: "",
  account: "",
  access_password: "",
  thumb: undefined,
};

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read image preview."));
    reader.readAsDataURL(file);
  });
}

export function OtpVaultPage({
  onGoDashboard,
  ownerId,
}: {
  onGoDashboard?: () => void;
  ownerId?: string;
}) {
  const [entries, setEntries] = useState<OtpVaultEntry[]>([]);
  const [tick, setTick] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<AddForm>(EMPTY_FORM);
  const [error, setError] = useState("");
  const [qrStatus, setQrStatus] = useState("");
  const [qrBusy, setQrBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** Session unlocks: entryId → true after correct access_password. */
  const [unlocked, setUnlocked] = useState<Record<string, boolean>>({});
  const [unlockDraft, setUnlockDraft] = useState<Record<string, string>>({});
  const { saveStatus, runSave } = useSaveStatus();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRafRef = useRef<number | null>(null);

  const refresh = async () => {
    setEntries(await otpVaultStore.list());
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const stopCamera = () => {
    if (scanRafRef.current != null) {
      cancelAnimationFrame(scanRafRef.current);
      scanRafRef.current = null;
    }
    const stream = streamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      streamRef.current = null;
    }
    const video = videoRef.current;
    if (video) video.srcObject = null;
    setScanning(false);
  };

  useEffect(() => {
    if (!showAdd) stopCamera();
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stop only when modal closes / unmount
  }, [showAdd]);

  const remaining = useMemo(() => totpRemaining(30), [tick]);

  const applyParsedQr = (raw: string, thumb?: string) => {
    const parsed = parseOtpInput(raw);
    setForm((f) => ({
      ...f,
      paste: parsed.qr_text || raw,
      issuer: f.issuer.trim() || parsed.issuer,
      account: f.account.trim() || parsed.account,
      label: f.label.trim() || parsed.label,
      thumb: thumb || f.thumb,
    }));
    setQrStatus("QR decoded — review fields and Save.");
    setError("");
  };

  const onQrFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setQrBusy(true);
    setQrStatus("Reading QR…");
    setError("");
    try {
      const [raw, thumb] = await Promise.all([decodeQrFromFile(file), fileToDataUrl(file)]);
      stopCamera();
      applyParsedQr(raw, thumb.startsWith("data:image/") ? thumb : undefined);
    } catch (err) {
      setQrStatus("");
      setError(err instanceof Error ? err.message : "Could not read QR image");
    } finally {
      setQrBusy(false);
    }
  };

  const tickScanFrame = () => {
    const video = videoRef.current;
    const canvas = scanCanvasRef.current;
    if (!video || !canvas || video.readyState < 2) {
      scanRafRef.current = requestAnimationFrame(tickScanFrame);
      return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w > 0 && h > 0) {
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        ctx.drawImage(video, 0, 0, w, h);
        const text = decodeQrFromImageData(ctx.getImageData(0, 0, w, h));
        if (text) {
          try {
            applyParsedQr(text);
            stopCamera();
            return;
          } catch (err) {
            setError(err instanceof Error ? err.message : "Invalid QR payload");
            setQrStatus("");
          }
        }
      }
    }
    scanRafRef.current = requestAnimationFrame(tickScanFrame);
  };

  const startCamera = async () => {
    setError("");
    setQrStatus("Starting camera…");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera is not available in this browser — upload a QR image or paste otpauth://.");
      }
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
      streamRef.current = stream;
      setScanning(true);
      setQrStatus("Point the camera at an otpauth QR…");
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
      scanRafRef.current = requestAnimationFrame(tickScanFrame);
    } catch (err) {
      stopCamera();
      setQrStatus("");
      setError(
        err instanceof Error
          ? err.message
          : "Camera permission denied — upload a QR image or paste otpauth://.",
      );
    }
  };

  const closeAdd = () => {
    stopCamera();
    setShowAdd(false);
    setQrStatus("");
    setForm(EMPTY_FORM);
  };

  const onAdd = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await runSave(async () => {
        const parsed = parseOtpInput(form.paste);
        await otpVaultStore.add({
          secret: parsed.secret,
          qr_text: parsed.qr_text,
          issuer: form.issuer.trim() || parsed.issuer,
          account: form.account.trim() || parsed.account,
          label: form.label.trim() || parsed.label,
          access_password: form.access_password.trim() || undefined,
          thumb: form.thumb,
          owner_id: ownerId,
        });
        setForm(EMPTY_FORM);
        setQrStatus("");
        setShowAdd(false);
        stopCamera();
        await refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add entry");
    }
  };

  const onDelete = async (id: string) => {
    const ok = window.confirm("Delete this OTP entry?");
    if (!ok) return;
    setError("");
    try {
      await runSave(async () => {
        await otpVaultStore.remove(id);
        setUnlocked((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        await refresh();
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const onCopy = async (id: string, code: string, event?: MouseEvent) => {
    event?.preventDefault();
    event?.stopPropagation();
    try {
      await copyTextToClipboard(code.replace(/\s/g, ""));
      setError("");
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch {
      setError("Clipboard copy failed — 無法複製到剪貼簿");
    }
  };

  const tryUnlock = (entry: OtpVaultEntry) => {
    const draft = (unlockDraft[entry.id] ?? "").trim();
    if (!entry.access_password) {
      setUnlocked((prev) => ({ ...prev, [entry.id]: true }));
      return;
    }
    if (draft === entry.access_password) {
      setUnlocked((prev) => ({ ...prev, [entry.id]: true }));
      setUnlockDraft((prev) => ({ ...prev, [entry.id]: "" }));
      setError("");
    } else {
      setError("Wrong access password");
    }
  };

  const isOpen = (entry: OtpVaultEntry) =>
    !entry.access_password || Boolean(unlocked[entry.id]);

  return (
    <div className="otp-page">
      <header className="otp-toolbar">
        <nav className="otp-breadcrumb" aria-label="Breadcrumb">
          <button type="button" className="otp-bc-home" onClick={onGoDashboard} aria-label="Tool">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
              <path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            </svg>
          </button>
          <button type="button" className="otp-bc-link" onClick={onGoDashboard}>
            Tool
          </button>
          <span className="otp-bc-sep" aria-hidden="true">›</span>
          <span className="otp-bc-current">OTP Vault</span>
        </nav>
        <div className="otp-toolbar-actions">
          <SavingIndicator status={saveStatus} />
          <button
            type="button"
            className="otp-add-btn"
            onClick={() => {
              setShowAdd(true);
              setError("");
              setQrStatus("");
            }}
          >
            + Add
          </button>
        </div>
      </header>

      <div className="otp-body">
        <SharedStoreBanner onMigrated={() => void refresh()} />
        {error && !showAdd && <p className="otp-error">{error}</p>}

        {entries.length === 0 ? (
          <div className="otp-empty">
            <h2>OTP Vault</h2>
            <p>共用 TOTP 密碼庫：所有登入成員看到同一份清單（雲端 Supabase；本機模式為 org store）。</p>
            <button type="button" className="otp-add-btn" onClick={() => setShowAdd(true)}>
              + Add entry
            </button>
          </div>
        ) : (
          <ul className="otp-list">
            {entries.map((entry) => {
              const open = isOpen(entry);
              let code = "••••••";
              let codeRaw = "";
              let genError = "";
              if (open) {
                try {
                  codeRaw = generateTotp(entry.secret);
                  code = formatCode(codeRaw);
                } catch {
                  genError = "Invalid secret";
                  code = "—— ——";
                }
              }
              return (
                <li key={entry.id} className="otp-card">
                  {entry.thumb ? (
                    <img className="otp-thumb" src={entry.thumb} alt="" />
                  ) : (
                    <div className="otp-thumb otp-thumb-fallback" aria-hidden="true">
                      {(entry.issuer || entry.label || "?").trim().charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="otp-card-main">
                    <div className="otp-card-head">
                      <h3 className="otp-label">{entry.label || entry.issuer || "OTP"}</h3>
                      <button
                        type="button"
                        className="otp-delete"
                        title="Delete"
                        aria-label={`Delete ${entry.label}`}
                        onClick={() => onDelete(entry.id)}
                      >
                        ×
                      </button>
                    </div>
                    <p className="otp-meta">
                      {[entry.issuer, entry.account].filter(Boolean).join(" · ") || "—"}
                    </p>

                    {!open ? (
                      <div className="otp-lock">
                        <input
                          type="password"
                          placeholder="Access password"
                          value={unlockDraft[entry.id] ?? ""}
                          onChange={(e) =>
                            setUnlockDraft((prev) => ({ ...prev, [entry.id]: e.target.value }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") tryUnlock(entry);
                          }}
                          aria-label="Access password"
                        />
                        <button type="button" className="otp-unlock-btn" onClick={() => tryUnlock(entry)}>
                          Unlock
                        </button>
                      </div>
                    ) : (
                      <div className="otp-code-row">
                        <div className="otp-code-block">
                          <span className="otp-code" aria-live="polite">
                            {genError || code}
                          </span>
                          <span className="otp-countdown" title="Seconds remaining">
                            {remaining}s
                          </span>
                          <div className="otp-bar" aria-hidden="true">
                            <span style={{ width: `${(remaining / 30) * 100}%` }} />
                          </div>
                        </div>
                        <button
                          type="button"
                          className="otp-copy-btn"
                          disabled={Boolean(genError)}
                          onClick={(e) => void onCopy(entry.id, codeRaw, e)}
                        >
                          {copiedId === entry.id ? "已複製" : "Copy"}
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {showAdd && (
        <div className="otp-modal-backdrop" onClick={closeAdd}>
          <form
            className="otp-modal"
            onSubmit={onAdd}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Add OTP</h2>
            <p className="otp-hint">
              Prefer scan or upload an otpauth:// TOTP QR. Paste a Base32 secret or otpauth URI as fallback.
            </p>

            <div className="otp-qr-actions">
              <button
                type="button"
                className="otp-btn-secondary"
                disabled={qrBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                Upload QR
              </button>
              <button
                type="button"
                className="otp-btn-secondary"
                disabled={qrBusy}
                onClick={() => void (scanning ? stopCamera() : startCamera())}
              >
                {scanning ? "Stop camera" : "Scan camera"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(e) => void onQrFile(e)}
              />
            </div>

            {scanning && (
              <div className="otp-scan-panel">
                <video ref={videoRef} className="otp-scan-video" playsInline muted autoPlay />
                <canvas ref={scanCanvasRef} className="otp-scan-canvas" aria-hidden="true" />
              </div>
            )}

            {qrStatus && <p className="otp-qr-status">{qrStatus}</p>}

            <label className="otp-field">
              <span>Secret / otpauth URI</span>
              <textarea
                rows={3}
                value={form.paste}
                onChange={(e) => setForm((f) => ({ ...f, paste: e.target.value }))}
                placeholder="otpauth://totp/… or BASE32SECRET"
                required
                autoFocus={!scanning}
              />
            </label>
            <div className="otp-field-row">
              <label className="otp-field">
                <span>Issuer</span>
                <input
                  value={form.issuer}
                  onChange={(e) => setForm((f) => ({ ...f, issuer: e.target.value }))}
                  placeholder="Microsoft"
                />
              </label>
              <label className="otp-field">
                <span>Account</span>
                <input
                  value={form.account}
                  onChange={(e) => setForm((f) => ({ ...f, account: e.target.value }))}
                  placeholder="user@example.com"
                />
              </label>
            </div>
            <label className="otp-field">
              <span>Label (optional)</span>
              <input
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="Issuer · account"
              />
            </label>
            <label className="otp-field">
              <span>Access password (optional)</span>
              <input
                type="password"
                value={form.access_password}
                onChange={(e) => setForm((f) => ({ ...f, access_password: e.target.value }))}
                placeholder="Lock viewing codes"
                autoComplete="new-password"
              />
            </label>
            {error && <p className="otp-error">{error}</p>}
            <div className="otp-modal-actions">
              <button type="button" className="otp-btn-ghost" onClick={closeAdd}>
                Cancel
              </button>
              <button type="submit" className="otp-btn-primary" disabled={qrBusy}>
                Save
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
