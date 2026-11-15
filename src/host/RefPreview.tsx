import { useEffect, useRef, useState } from "react";
import { findRefs, lookupRefs } from "./registry";
import type { RefRecognizer } from "./sdk";

/** Where in the page a reference is: the mouse has to be over the words of it, not just near. */
interface Hit {
  label: string;
  ref: string;
  recognizer: RefRecognizer;
  rect: DOMRect;
}

interface Card {
  title: string;
  html: string;
  label: string;
  x: number;
  y: number;
}

const DELAY = 350;
const SKIP = "input, textarea, select, [contenteditable=true], [contenteditable=''], .ref-pop, [data-no-ref], [data-ref]";

/** The reference under the mouse (if any): looked for in the one text node the pointer is on, nothing else is touched. */
function hitAt(x: number, y: number, target: EventTarget | null): Hit | null {
  const el = target instanceof Element ? target : null;
  if (!el || el.closest(SKIP)) return null;
  const doc = document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null };
  const caret = doc.caretRangeFromPoint?.(x, y);
  const node = caret?.startContainer;
  if (!caret || !node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = (node as Text).data;
  if (text.length > 4000) return null;
  const matches = findRefs(text);
  if (!matches.length) return null;
  const at = caret.startOffset;
  const m = matches.find((k) => at >= k.start && at <= k.end);
  if (!m) return null;
  const r = document.createRange();
  r.setStart(node, m.start);
  r.setEnd(node, m.end);
  const rect = r.getBoundingClientRect();
  // the caret snaps to the nearest letter: make sure the pointer really is on the words
  const slack = 3;
  if (x < rect.left - slack || x > rect.right + slack || y < rect.top - slack || y > rect.bottom + slack) return null;
  return { label: m.label, ref: m.ref, recognizer: m.recognizer, rect };
}

export function openRef(label: string) {
  const t = lookupRefs(label)[0];
  if (t) window.dispatchEvent(new CustomEvent("reader:open-doc", { detail: { docId: t.docId, title: t.title, at: { section: t.section, fragment: t.fragment } } }));
}

/**
 * The card that appears when the mouse rests on a reference such as "约 3:16" in a note or a book. It asks the module that
 * recognised the reference for the words. Nothing in the page is changed to make this work.
 */
export function RefPreviewHost({ enabled }: { enabled: boolean }) {
  const [card, setCard] = useState<Card | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const lastKey = useRef("");
  const lastMove = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const hide = () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
      lastKey.current = "";
      setCard(null);
    };
    const move = (e: MouseEvent) => {
      if (e.buttons) return hide();
      const now = Date.now();
      if (now - lastMove.current < 90) return;
      lastMove.current = now;
      if ((e.target as Element | null)?.closest?.(".ref-pop")) return; // moving onto the card keeps it
      const h = hitAt(e.clientX, e.clientY, e.target);
      const key = h ? `${h.ref}@${Math.round(h.rect.left)},${Math.round(h.rect.top)}` : "";
      if (key === lastKey.current) return;
      hide();
      if (!h) return;
      lastKey.current = key;
      timer.current = window.setTimeout(async () => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) return; // someone is selecting text
        try {
          const p = await h.recognizer.preview?.(h.ref);
          if (!p || lastKey.current !== key) return;
          setCard({ title: p.title, html: p.html, label: h.label, x: h.rect.left, y: h.rect.bottom + 6 });
        } catch {
          /* a module that cannot preview just shows nothing */
        }
      }, DELAY);
    };
    const off = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e.target instanceof Element && e.target.closest(".ref-pop")) return;
      hide();
    };
    document.addEventListener("mousemove", move, { passive: true });
    document.addEventListener("mousedown", off, true);
    document.addEventListener("keydown", off, true);
    document.addEventListener("scroll", off, true);
    return () => {
      hide();
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mousedown", off, true);
      document.removeEventListener("keydown", off, true);
      document.removeEventListener("scroll", off, true);
    };
  }, [enabled]);

  // leaving the card (and not onto the reference again) closes it
  useEffect(() => {
    if (!card) return;
    const leave = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest(".ref-pop")) return;
      const h = hitAt(e.clientX, e.clientY, e.target);
      if (!h) {
        lastKey.current = "";
        setCard(null);
      }
    };
    document.addEventListener("mousemove", leave, { passive: true });
    return () => document.removeEventListener("mousemove", leave);
  }, [card]);

  if (!enabled || !card) return null;
  const left = Math.max(12, Math.min(card.x, window.innerWidth - 392));
  const top = card.y + 160 > window.innerHeight ? Math.max(12, card.y - 190) : card.y;
  return (
    <div className="ref-pop" style={{ left, top }} role="tooltip">
      <div className="ref-pop-t">{card.title}</div>
      <div className="ref-pop-b" dangerouslySetInnerHTML={{ __html: card.html }} />
      <div className="ref-pop-a">
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => {
            openRef(card.label);
            setCard(null);
          }}
        >
          打开
        </button>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const body = (e.currentTarget.closest(".ref-pop")?.querySelector(".ref-pop-b") as HTMLElement | null)?.innerText ?? "";
            void navigator.clipboard?.writeText(`${card.title}\n${body}`);
          }}
        >
          复制
        </button>
      </div>
    </div>
  );
}
