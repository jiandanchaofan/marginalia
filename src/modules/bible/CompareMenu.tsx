import { useEffect, useRef, useState } from "react";
import { Columns2 } from "lucide-react";
import type { SlotContext } from "../../host/sdk";
import { type CompareMode, getCompare, setCompare } from "./compare";
import { parseDocId } from "./ids";
import { BUNDLED } from "./packs";

const MODES: [CompareMode, string][] = [
  ["off", "关"],
  ["bubble", "节号气泡"],
  ["inline", "行间"],
];

/** The "对照" button of the reader's top bar: how other translations are shown, and which ones. */
export function CompareMenu({ ctx }: { ctx: SlotContext }) {
  const id = ctx.docId ? parseDocId(ctx.docId) : null;
  const [open, setOpen] = useState(false);
  const [, bump] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", off);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", off);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!id) return null;
  const cur = getCompare(id.version);
  const apply = (patch: Partial<typeof cur>) => {
    setCompare(patch);
    bump((n) => n + 1);
    // the page is drawn again so the choice shows (in place: the position is kept)
    window.dispatchEvent(new CustomEvent("reader:reload-doc", { detail: { docId: ctx.docId } }));
  };
  const others = BUNDLED.filter((b) => b.id !== id.version);
  return (
    <div className="bible-cmp" ref={box}>
      <button className={`icon-btn ${cur.mode !== "off" ? "on" : ""}`} title="对照译本" onClick={() => setOpen((v) => !v)}>
        <Columns2 size={18} />
      </button>
      {open && (
        <div className="bible-cmp-pop" role="dialog" aria-label="对照译本">
          <div className="bible-cmp-h">对照方式</div>
          <div className="segmented small">
            {MODES.map(([m, name]) => (
              <button key={m} className={cur.mode === m ? "on" : ""} onClick={() => apply({ mode: m })}>
                {name}
              </button>
            ))}
          </div>
          <div className="bible-cmp-h">对照译本</div>
          {others.map((b) => (
            <label key={b.id} className="check">
              <input
                type="checkbox"
                checked={cur.versions.includes(b.id)}
                onChange={(e) => apply({ versions: e.target.checked ? [...cur.versions, b.id] : cur.versions.filter((v) => v !== b.id) })}
              />{" "}
              {b.name}
            </label>
          ))}
          {!others.length && <p className="bible-cmp-n">没有其他译本可对照。</p>}
        </div>
      )}
    </div>
  );
}
