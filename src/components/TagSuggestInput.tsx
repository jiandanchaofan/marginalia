import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Hash } from "lucide-react";
import { suggestTags } from "../notes/tags";
import { useAllTags } from "../notes/allTags";
import { t } from "../i18n";

const MENU_W = 260;
const TOKEN = /(^|[\s，。、；：！？,.;:!?（）()【】\[\]《》“”"'‘’*])#([^\s#，。、；：！？,;:!?（）()【】\[\]《》“”"'‘’*]*)$/;

interface Props {
  value: string;
  onChange(v: string): void;
  /** Enter (when no suggestion is highlighted / the menu is closed). */
  onEnter(): void;
  /** "inline": `#tag` words inside a sentence (quick add). "plain": the whole box is a tag name (detail panel). */
  mode: "inline" | "plain";
  /** plain mode: a suggestion was chosen. */
  onPick?(tag: string): void;
  placeholder?: string;
  className?: string;
}

/** A one-line input with the same tag completion as the note editor: type `#` (or, in plain mode, any letters), pick with ↑ ↓ Enter / Tab / click. */
export function TagSuggestInput({ value, onChange, onEnter, mode, onPick, placeholder, className }: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const tags = useAllTags();
  const [query, setQuery] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [at, setAt] = useState<{ left: number; top: number; width: number } | null>(null);

  const detect = (text: string, caret: number) => {
    if (mode === "plain") setQuery(text.replace(/^#/, ""));
    else setQuery(TOKEN.exec(text.slice(0, caret))?.[2] ?? null);
    setIndex(0);
  };
  const options = useMemo(() => {
    if (query === null) return [];
    const list = suggestTags(tags, query).map((t) => ({ tag: t.tag, count: t.count, isNew: false }));
    const q = query.replace(/\/+$/, "");
    if (q && !tags.some((t) => t.tag === q)) list.push({ tag: q, count: 0, isNew: true });
    return list;
  }, [query, tags]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !options.length) return setAt(null);
    const r = el.getBoundingClientRect();
    const h = Math.min(options.length, 8) * 32 + 12;
    const below = r.bottom + 4;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 4) : below;
    const width = Math.max(MENU_W, Math.min(r.width, 360));
    setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top, width });
  }, [options.length, query]);

  const accept = (tag: string) => {
    const el = ref.current;
    if (mode === "plain") {
      setQuery(null);
      onPick?.(tag);
      return;
    }
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const start = before.lastIndexOf("#");
    const after = value.slice(caret);
    const insert = `#${tag}${after.startsWith(" ") ? "" : " "}`;
    onChange(value.slice(0, start) + insert + after);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + insert.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const open = options.length > 0 && !!at;
  return (
    <>
      <input
        ref={ref}
        className={className}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyUp={(e) => ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && detect(value, e.currentTarget.selectionStart ?? value.length)}
        onClick={(e) => detect(value, e.currentTarget.selectionStart ?? value.length)}
        onFocus={(e) => mode === "plain" && detect(value, e.currentTarget.selectionStart ?? value.length)}
        onBlur={() => setQuery(null)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              accept(options[Math.min(index, options.length - 1)].tag);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setQuery(null);
              return;
            }
          }
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      {open &&
        createPortal(
          <div className="tag-suggest floating" style={{ left: at!.left, top: at!.top, width: at!.width }} onMouseDown={(e) => e.preventDefault()}>
            {options.map((o, i) => (
              <button key={o.tag + o.isNew} className={i === index ? "on" : ""} onMouseEnter={() => setIndex(i)} onClick={() => accept(o.tag)}>
                <Hash size={12} />
                <span className="tag-suggest-path">
                  {o.tag.includes("/") && <em>{o.tag.slice(0, o.tag.lastIndexOf("/") + 1)}</em>}
                  {o.tag.slice(o.tag.lastIndexOf("/") + 1)}
                </span>
                <span className="tag-suggest-meta">{o.isNew ? t("tag.new") : o.count}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
