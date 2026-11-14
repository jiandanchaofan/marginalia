import { useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, normalizeSettings } from "../settings";
import { settingsStore } from "../platform";
import { t } from "../i18n";
import "./trash.css";

// ---------------------------------------------------------------- toast

export interface ToastOptions {
  /** "Undo" button; the toast stays a little longer while it is there. */
  undo?: () => void | Promise<void>;
  ms?: number;
}
const TOAST_EVENT = "reader:toast";

/** A light message at the bottom of the window that goes away by itself after a second or two. */
export function toast(msg: string, opts: ToastOptions = {}) {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { msg, ...opts } }));
}

export function ToastHost() {
  const [cur, setCur] = useState<({ msg: string; id: number } & ToastOptions) | null>(null);
  const timer = useRef(0);
  const hover = useRef(false);
  const id = useRef(0);

  const arm = (ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => (hover.current ? arm(800) : setCur(null)), ms);
  };
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ msg: string } & ToastOptions>).detail;
      id.current++;
      setCur({ ...d, id: id.current });
      arm(d.ms ?? (d.undo ? 3200 : 2000));
    };
    window.addEventListener(TOAST_EVENT, on);
    return () => {
      window.removeEventListener(TOAST_EVENT, on);
      window.clearTimeout(timer.current);
    };
  }, []);
  if (!cur) return null;
  return (
    <div className="tr-toast" key={cur.id} role="status" onMouseEnter={() => (hover.current = true)} onMouseLeave={() => (hover.current = false)}>
      <span>{cur.msg}</span>
      {cur.undo && (
        <button
          onClick={() => {
            const f = cur.undo;
            setCur(null);
            void f?.();
          }}
        >
          {t("tr.undo")}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- confirm

const CONFIRM_EVENT = "reader:confirm-trash";
export const confirmDeleteOn = () => normalizeSettings(settingsStore.load(DEFAULT_SETTINGS)).confirmDelete !== false;

/** Asks before moving something to the recycle bin, unless the user turned asking off. */
export function confirmTrash(message: string): Promise<boolean> {
  if (!confirmDeleteOn()) return Promise.resolve(true);
  return new Promise((res) => window.dispatchEvent(new CustomEvent(CONFIRM_EVENT, { detail: { message, res } })));
}

export function ConfirmHost({ onNeverAsk }: { onNeverAsk(): void }) {
  const [ask, setAsk] = useState<{ message: string; res(ok: boolean): void } | null>(null);
  const [never, setNever] = useState(false);
  useEffect(() => {
    const on = (e: Event) => {
      setNever(false);
      setAsk((e as CustomEvent<{ message: string; res(ok: boolean): void }>).detail);
    };
    window.addEventListener(CONFIRM_EVENT, on);
    return () => window.removeEventListener(CONFIRM_EVENT, on);
  }, []);
  const done = (ok: boolean) => {
    if (!ask) return;
    if (ok && never) onNeverAsk();
    ask.res(ok);
    setAsk(null);
  };
  useEffect(() => {
    if (!ask) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") (e.preventDefault(), done(false));
      else if (e.key === "Enter") (e.preventDefault(), done(true));
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  });
  if (!ask) return null;
  return (
    <div className="pal-wrap tr-wrap" onMouseDown={(e) => e.target === e.currentTarget && done(false)}>
      <div className="tr-confirm" role="alertdialog" aria-modal="true">
        <p>{ask.message}</p>
        <label className="check">
          <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} /> {t("tr.dontAsk")}
        </label>
        <div className="tr-btns">
          <button className="batch-btn" onClick={() => done(false)}>
            {t("common.cancel")}
          </button>
          <button className="batch-btn danger" autoFocus onClick={() => done(true)}>
            {t("tr.moveBtn")}
          </button>
        </div>
      </div>
    </div>
  );
}
