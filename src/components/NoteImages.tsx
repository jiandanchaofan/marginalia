import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useImage } from "../notes/images";

function Thumb({ id, onOpen, onRemove }: { id: string; onOpen(): void; onRemove?(): void }) {
  const { url, failed } = useImage(id);
  return (
    <span className={`ni-thumb ${failed ? "failed" : ""}`}>
      {url ? <img src={url} alt="" draggable={false} onClick={onOpen} /> : <i>{failed ? "图片丢失" : ""}</i>}
      {onRemove && (
        <button className="ni-remove" title="移除图片" onMouseDown={(e) => e.preventDefault()} onClick={onRemove}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}

function Lightbox({ id, onClose }: { id: string; onClose(): void }) {
  const { url } = useImage(id);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);

  // Wheel zooms around the pointer (non-passive so the page behind never scrolls).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - (r.left + r.width / 2);
      const py = e.clientY - (r.top + r.height / 2);
      setView((v) => {
        const s = Math.min(12, Math.max(0.2, v.s * Math.exp(-e.deltaY * 0.0015)));
        const k = s / v.s;
        return { s, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  return createPortal(
    <div
      ref={box}
      className="ni-lightbox"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onMouseMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
        setView((v) => ({ ...v, x: v.x + e.movementX, y: v.y + e.movementY }));
      }}
      onMouseUp={() => (drag.current = null)}
      onMouseLeave={() => (drag.current = null)}
    >
      {url && (
        <img
          src={url}
          alt=""
          draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
          onMouseDown={(e) => {
            e.preventDefault();
            drag.current = { x: e.clientX, y: e.clientY, moved: false };
          }}
          onDoubleClick={() => setView({ s: 1, x: 0, y: 0 })}
        />
      )}
      <div className="ni-zoom-hint">{Math.round(view.s * 100)}% · 滚轮缩放 · 拖动平移 · 双击还原 · Esc 关闭</div>
    </div>,
    document.body,
  );
}

/** Picture strip under a note: thumbnails (click to enlarge), with × when editable. */
export function NoteImages({ ids, onRemove }: { ids?: string[]; onRemove?(id: string): void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!ids?.length) return null;
  return (
    <div className="ni-strip" onClick={(e) => e.stopPropagation()}>
      {ids.map((id) => (
        <Thumb key={id} id={id} onOpen={() => setOpen(id)} onRemove={onRemove && (() => onRemove(id))} />
      ))}
      {open && <Lightbox id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
