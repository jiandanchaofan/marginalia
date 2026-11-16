import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Search, X } from "lucide-react";
import { t } from "../i18n";
import { dictApi, dictAvailable, type DictFound, type DictInfo } from "./api";
import { frameDoc } from "./frame";
import "./dict.css";

const SIZE = "reader:dict-size";
const DEFAULT_W = 360;
type Size = { w: number; h: number | null };
const loadSize = (): Size => {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE) ?? "null");
    if (v && typeof v.w === "number") return { w: v.w, h: typeof v.h === "number" ? v.h : null };
  } catch {
    /* none saved */
  }
  return { w: DEFAULT_W, h: null };
};
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

const nonce = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

/** The dictionary card: one tab per dictionary that has the word, the entry in a closed frame. Opened by the `dict:lookup` event. */
export function DictHost() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [found, setFound] = useState<DictFound | null>(null);
  const [dicts, setDicts] = useState<DictInfo[] | null>(null);
  const [tab, setTab] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [bar, setBar] = useState(false);
  const seq = useRef(0);
  const [size, setSize] = useState<Size>(loadSize);
  const card = useRef<HTMLElement>(null);

  /** Drag an edge (or the corner) to resize; the card stays anchored at its top right. */
  const drag = (dx: boolean, dy: boolean) => (e: React.PointerEvent) => {
    e.preventDefault();
    const el = card.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    let last = size;
    const move = (m: PointerEvent) => {
      last = {
        w: dx ? clamp(start.w - (m.clientX - start.x), 260, Math.min(900, window.innerWidth - 36)) : size.w,
        h: dy ? clamp(start.h + (m.clientY - start.y), 160, window.innerHeight - 82) : size.h,
      };
      setSize(last);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(SIZE, JSON.stringify(last));
      } catch {
        /* storage unavailable */
      }
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const run = useCallback(async (q: string) => {
    const my = ++seq.current;
    setText(q);
    setErr("");
    setBusy(true);
    try {
      const [f, list] = await Promise.all([dictApi.lookup(q), dictApi.list()]);
      if (my !== seq.current) return;
      setFound(f);
      setDicts(list);
      setTab(0);
    } catch (e) {
      if (my === seq.current) setErr(String(e));
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const on = (e: Event) => {
      const q = String((e as CustomEvent).detail?.query ?? "").trim();
      if (!q) return;
      setOpen(true);
      setBar(false);
      void run(q);
    };
    window.addEventListener("dict:lookup", on);
    return () => window.removeEventListener("dict:lookup", on);
  }, [run]);

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && (!(e.target as HTMLElement)?.closest?.("input,textarea") || !!(e.target as HTMLElement)?.closest?.(".dict-card")) && setOpen(false);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !(e.target as Element | null)?.closest?.(".dict-card") && setOpen(false);
    document.addEventListener("mousedown", away, true);
    return () => document.removeEventListener("mousedown", away, true);
  }, [open]);

  if (!open || !dictAvailable()) return null;
  const entries = found?.entries ?? [];
  const cur = entries[Math.min(tab, entries.length - 1)];
  const noDicts = dicts !== null && dicts.length === 0;
  const enabled = (dicts ?? []).filter((d) => d.enabled);

  return (
    <aside ref={card} className="dict-card" style={{ width: size.w, ...(size.h ? { height: size.h } : {}) }} role="dialog" aria-label={t("dict.title")} data-testid="dict-card">
      <div className="dict-head">
        <BookOpen size={16} />
        <b className="dict-word">{found?.query || text}</b>
        <button className={"icon-btn" + (bar ? " on" : "")} aria-pressed={bar} onClick={() => setBar(!bar)} title={t("dict.tools")} aria-label={t("dict.tools")}>
          <Search size={16} />
        </button>
        <button className="icon-btn" onClick={() => setOpen(false)} title={t("common.close")} aria-label={t("common.close")}>
          <X size={16} />
        </button>
      </div>

      {noDicts && (
        <div className="dict-empty">
          <p>{t("dict.none")}</p>
        </div>
      )}
      {bar && (
        <form
          className="dict-q"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void run(text.trim());
          }}
        >
          <Search size={14} />
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={t("dict.title")} />
        </form>
      )}
      {bar && !noDicts && entries.length > 1 && (
        <div className="dict-tabs" role="tablist">
          {entries.map((e, i) => (
            <button key={e.dictId} role="tab" aria-selected={i === tab} className={i === tab ? "on" : ""} onClick={() => setTab(i)} title={e.title}>
              {e.title}
            </button>
          ))}
        </div>
      )}
      {cur && <EntryFrame key={cur.dictId + cur.headword + found?.query} entry={cur} onWord={(w) => void run(w)} />}
      {!noDicts && !cur && !busy && found && (
        <div className="dict-empty">
          <p>{enabled.length ? t("dict.miss", { q: found.query }) : t("dict.allOff")}</p>
          {found.suggestions.length > 0 && (
            <div className="dict-sugg">
              <span>{t("dict.similar")}</span>
              {found.suggestions.map((s) => (
                <button key={s} onClick={() => void run(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {found?.problems.map((p) => (
        <p key={p} className="dict-err">
          {p}
        </p>
      ))}
      {err && <p className="dict-err">{err}</p>}
      <div className="dict-rz l" onPointerDown={drag(true, false)} />
      <div className="dict-rz b" onPointerDown={drag(false, true)} />
      <div className="dict-rz bl" onPointerDown={drag(true, true)} />
    </aside>
  );
}

function EntryFrame({ entry, onWord }: { entry: { dictId: string; body: string; scripts: boolean }; onWord(w: string): void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const doc = useMemo(() => frameDoc(entry.body, entry.scripts, nonce()), [entry]);

  useEffect(() => {
    const on = async (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const m = e.data as { t?: string; h?: number; w?: string; n?: string } | null;
      if (!m || typeof m !== "object") return;
      if (m.t === "entry" && m.w && !m.w.startsWith("@")) onWord(m.w);
      else if (m.t === "sound" && m.n) {
        try {
          const r = await dictApi.resource(entry.dictId, m.n);
          if (!r) return;
          audio.current?.pause();
          audio.current = new Audio(`data:${r[0]};base64,${r[1]}`);
          await audio.current.play();
        } catch {
          /* no sound */
        }
      }
    };
    window.addEventListener("message", on);
    return () => {
      window.removeEventListener("message", on);
      audio.current?.pause();
    };
  }, [entry.dictId, onWord]);

  return <iframe ref={ref} className="dict-frame" title="entry" sandbox="allow-scripts" srcDoc={doc} />;
}
