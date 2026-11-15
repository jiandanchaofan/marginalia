import { useEffect, useState } from "react";
import type { SlotContext } from "../../host/sdk";
import { bookInfo } from "./books";
import { getCompare } from "./compare";
import { parseDocId } from "./ids";
import { BUNDLED, loadPack } from "./packs";
import { altText } from "./render";

interface Where {
  docId: string;
  ref: string;
  x: number;
  y: number;
}
interface Line {
  label: string;
  text: string;
}

/** "JHN.3.16-18" -> book, chapter, verses. */
const split = (ref: string) => {
  const [book, c, v] = ref.split(".");
  const [from, to] = (v ?? "").split("-").map(Number);
  return { book, chapter: +c, from, to: to || from };
};

/** The small card that opens when a verse number is clicked: the verse in the other translations, and what can be done with it. */
export function VerseBubble({ ctx }: { ctx: SlotContext }) {
  const [at, setAt] = useState<Where | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [title, setTitle] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<Where>).detail;
      if (d.docId === ctx.docId) setAt(d);
    };
    window.addEventListener("reader:ref-click", on);
    return () => window.removeEventListener("reader:ref-click", on);
  }, [ctx.docId]);

  useEffect(() => {
    if (!at) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element)?.closest?.(".bible-bubble")) setAt(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
      document.removeEventListener("scroll", close, true);
    };
  }, [at]);

  useEffect(() => {
    setCopied(false);
    if (!at) return;
    const id = parseDocId(at.docId);
    if (!id) return;
    let alive = true;
    (async () => {
      const w = split(at.ref);
      const info = bookInfo(w.book);
      const main = BUNDLED.find((b) => b.id === id.version)!;
      const wanted = getCompare(id.version).mode === "off" ? [] : getCompare(id.version).versions;
      const out: Line[] = [];
      for (const v of [id.version, ...wanted]) {
        const pack = BUNDLED.find((b) => b.id === v);
        if (!pack) continue;
        const rows = (await loadPack(v)).books[w.book] ?? [];
        out.push({ label: pack.short, text: altText(rows, w.chapter, w.from, w.to) || "（此译本无此节）" });
      }
      if (!alive) return;
      const zh = main.lang.startsWith("zh");
      setTitle(`${zh ? info?.zh : info?.en} ${w.chapter}:${w.from}${w.to > w.from ? "-" + w.to : ""}`);
      setLines(out);
    })();
    return () => {
      alive = false;
    };
  }, [at]);

  if (!at) return null;
  const id = parseDocId(at.docId);
  const shown = lines.filter((l) => l.label !== BUNDLED.find((b) => b.id === id?.version)?.short);
  const left = Math.max(12, Math.min(at.x, window.innerWidth - 372));
  return (
    <div className="bible-bubble" style={{ left, top: Math.min(at.y + 6, window.innerHeight - 40) }} role="dialog" aria-label={title}>
      <div className="bible-bubble-h">
        <b>{title}</b>
        <button className="icon-btn" onClick={() => setAt(null)} title="关闭">
          ✕
        </button>
      </div>
      {shown.map((l) => (
        <p key={l.label} className="bible-bubble-l">
          <span>{l.label}</span>
          {l.text}
        </p>
      ))}
      {!shown.length && <p className="bible-bubble-n">要看其他译本，请在顶栏「对照」里选择。</p>}
      <div className="bible-bubble-a">
        <button
          onClick={() => {
            const text = [title, ...lines.map((l) => `${l.label}  ${l.text}`)].join("\n");
            void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {});
          }}
        >
          {copied ? "已复制" : "复制全部译本"}
        </button>
        <button
          onClick={() => {
            window.dispatchEvent(new CustomEvent("reader:make-verse-note", { detail: { docId: at.docId, ref: at.ref } }));
            setAt(null);
          }}
        >
          写整节笔记
        </button>
      </div>
    </div>
  );
}
