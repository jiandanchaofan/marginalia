import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Hash, X } from "lucide-react";
import { parseTags, removeTag as stripTag, segments, suggestTags } from "../notes/tags";
import { useGlobalTags } from "../notes/store";
import { MAX_IMAGES, imagesIn, pickImageFiles, putImage } from "../notes/images";
import { NoteImages } from "./NoteImages";
import { applyFormat, continueList, type Edit, type FormatKind } from "../notes/edit";

const MIRROR_PROPS = [
  "boxSizing",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "textTransform",
  "wordSpacing",
  "textIndent",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "wordBreak",
  "overflowWrap",
  "tabSize",
] as const;

/** Viewport position of the caret in a textarea (measured on an off-screen copy that wraps identically). */
function caretPoint(t: HTMLTextAreaElement, pos: number) {
  const cs = getComputedStyle(t);
  const div = document.createElement("div");
  for (const p of MIRROR_PROPS) div.style[p] = cs[p];
  Object.assign(div.style, { position: "absolute", visibility: "hidden", left: "-9999px", top: "0", whiteSpace: "pre-wrap", boxSizing: "border-box" });
  // Content width = the textarea's client width (excludes its scrollbar), so lines wrap at the same places.
  div.style.width = `${t.clientWidth + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)}px`;
  div.textContent = t.value.slice(0, pos);
  const mark = document.createElement("span");
  mark.textContent = "\u200b";
  div.appendChild(mark);
  document.body.appendChild(div);
  const r = t.getBoundingClientRect();
  const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  const point = { x: r.left + mark.offsetLeft - t.scrollLeft, y: r.top + mark.offsetTop - t.scrollTop, lineH };
  div.remove();
  return point;
}

const MENU_W = 244;

/** Formatting markers (`**`, `~~`, `<u>`, list prefixes) drawn faint; text widths are unchanged. */
const MARKER = /(\*\*|~~|<\/?u>|\*|(?<=^|\n)(?:[-•] |\d{1,3}\. ))/g;
function dim(text: string) {
  return text.split(MARKER).map((part, i) =>
    i % 2 ? (
      <span key={i} className="tt-mark">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

interface Props {
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onEscape?(): void;
  onSubmit?(): void; // Ctrl/⌘+Enter
  /** Fixed height set by CSS: long text scrolls inside the box instead of growing it. */
  fixed?: boolean;
  /** Attached pictures. Passing `onImages` turns on paste / drop / pick of images (screenshots etc.). */
  images?: string[];
  onImages?(ids: string[]): void;
  onImageError?(msg: string): void;
  /** Show the tag chips inside this element (e.g. a toolbar row) instead of under the box. */
  tagsHost?: HTMLElement | null;
}

export interface TagTextareaHandle {
  focus(): void;
  /** Insert '#' at the caret and open suggestions. */
  startTag(): void;
  /** Choose picture files from disk. */
  pickImage(): void;
  /** Bold / italic / underline / strikethrough on the selection, or bullet / numbered list on the selected lines. */
  format(kind: FormatKind): void;
}

/**
 * Textarea with Flomo-style `#tag/sub` support:
 * - tags are tinted inline (a mirror layer under a transparent-text textarea, so typing/IME are untouched)
 * - extracted tags are listed as chips under the field
 * - `#` opens autocomplete from the global tag list
 */
export const TagTextarea = forwardRef<TagTextareaHandle, Props>(function TagTextarea(
  { value, onChange, placeholder, className, autoFocus, onEscape, onSubmit, fixed, images, onImages, onImageError, tagsHost },
  ref,
) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const tags = useGlobalTags();
  const [query, setQuery] = useState<string | null>(null); // text after '#' at the caret, null = closed
  const [index, setIndex] = useState(0);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);

  const grow = () => {
    const t = ta.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${t.scrollHeight}px`;
  };
  useLayoutEffect(() => {
    if (!fixed) grow();
  }, [value, fixed]);
  useLayoutEffect(() => {
    const t = ta.current;
    if (!autoFocus || !t) return;
    t.focus({ preventScroll: true });
    t.setSelectionRange(t.value.length, t.value.length); // continue writing at the end
  }, [autoFocus]);

  /** Detect a `#partial` token right before the caret. */
  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = /(^|[\s，。、；：！？,.;:!?（）()【】\[\]《》“”"'‘’*])#([^\s#，。、；：！？,;:!?（）()【】\[\]《》“”"'‘’*]*)$/.exec(before);
    setQuery(m ? m[2] : null);
    setIndex(0);
  };

  const options = useMemo(() => {
    if (query === null) return [];
    const list = suggestTags(tags, query).map((t) => ({ tag: t.tag, count: t.count, isNew: false }));
    const q = query.replace(/\/+$/, "");
    if (q && !tags.some((t) => t.tag === q)) list.push({ tag: q, count: 0, isNew: true });
    return list;
  }, [query, tags]);

  /** Put the suggestion menu right under the caret (above it when there's no room below). */
  const placeMenu = () => {
    const t = ta.current;
    if (!t || !options.length) return setMenuPos(null);
    const { x, y, lineH } = caretPoint(t, t.selectionStart);
    const h = Math.min(options.length, 8) * 32 + 12;
    const below = y + lineH + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, y - h - 6) : below;
    setMenuPos({ left: Math.max(8, Math.min(x, window.innerWidth - MENU_W - 8)), top });
  };
  // Re-place whenever the list or the caret line changes.
  useLayoutEffect(placeMenu, [query, value, options.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const accept = (tag: string) => {
    const t = ta.current;
    if (!t) return;
    const caret = t.selectionStart;
    const before = value.slice(0, caret);
    const start = before.lastIndexOf("#");
    const after = value.slice(caret);
    const insert = `#${tag}${after.startsWith(" ") ? "" : " "}`;
    const next = value.slice(0, start) + insert + after;
    onChange(next);
    setQuery(null);
    requestAnimationFrame(() => {
      t.focus();
      const pos = start + insert.length;
      t.setSelectionRange(pos, pos);
    });
  };

  const imagesRef = useRef<string[]>([]);
  imagesRef.current = images ?? [];
  const addFiles = async (files: File[]) => {
    if (!onImages || !files.length) return;
    const room = MAX_IMAGES - imagesRef.current.length;
    if (room <= 0) return onImageError?.(`最多添加 ${MAX_IMAGES} 张图片`);
    try {
      const ids: string[] = [];
      for (const f of files.slice(0, room)) ids.push(await putImage(f));
      onImages([...new Set([...imagesRef.current, ...ids])]);
      if (files.length > room) onImageError?.(`最多添加 ${MAX_IMAGES} 张图片，多余的已忽略`);
    } catch (e) {
      onImageError?.(`添加图片失败：${e instanceof Error ? e.message : e}`);
    }
  };

  const applyEdit = (e: Edit) => {
    const t = ta.current;
    onChange(e.value);
    requestAnimationFrame(() => {
      t?.focus();
      t?.setSelectionRange(e.start, e.end);
    });
  };

  const found = useMemo(() => parseTags(value), [value]);
  const removeTag = (tag: string) => {
    onChange(stripTag(value, tag));
    ta.current?.focus();
  };

  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    format: (kind) => {
      const t = ta.current;
      if (t) applyEdit(applyFormat(value, t.selectionStart, t.selectionEnd, kind));
    },
    pickImage: () => void pickImageFiles().then(addFiles),
    startTag: () => {
      const t = ta.current;
      if (!t) return;
      const caret = t.selectionStart ?? value.length;
      const needsSpace = caret > 0 && !/\s/.test(value[caret - 1]);
      const ins = `${needsSpace ? " " : ""}#`;
      onChange(value.slice(0, caret) + ins + value.slice(caret));
      requestAnimationFrame(() => {
        t.focus();
        t.setSelectionRange(caret + ins.length, caret + ins.length);
        setQuery("");
        setIndex(0);
      });
    },
  }));

  return (
    <div className={`tag-textarea ${fixed ? "tt-fixed" : ""}`}>
      <div className="tt-field">
      {/* Same box & typography as the textarea; only colours differ. */}
      <div ref={mirror} className={`${className ?? ""} tt-mirror`} aria-hidden>
        {segments(value).map((s, i) =>
          s.kind === "tag" ? (
            <span key={i} className="tt-tag">
              {s.value}
            </span>
          ) : (
            <span key={i}>{dim(s.value)}</span>
          ),
        )}
        {"\u200b" /* keeps a trailing newline measurable */}
      </div>
      <textarea
        ref={ta}
        className={`${className ?? ""} tt-input`}
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onClick={(e) => detect(value, (e.target as HTMLTextAreaElement).selectionStart)}
        // Keep the tag-colouring layer under the text when the box scrolls.
        onScroll={(e) => {
          if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
          if (options.length) placeMenu();
        }}
        onBlur={() => window.setTimeout(() => setQuery(null), 120)}
        onPaste={(e) => {
          const files = imagesIn(e.clipboardData);
          if (!onImages || !files.length) return;
          e.preventDefault(); // a screenshot on the clipboard: attach it
          void addFiles(files);
        }}
        onDragOver={(e) => onImages && e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          const files = imagesIn(e.dataTransfer);
          if (!onImages || !files.length) return;
          e.preventDefault();
          void addFiles(files);
        }}
        onKeyDown={(e) => {
          if (options.length) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
              return;
            }
            // Ctrl/⌘+Enter always saves, even while the tag menu is open; plain Enter / Tab pick the highlighted tag.
            if ((e.key === "Enter" && !(e.ctrlKey || e.metaKey)) || e.key === "Tab") {
              e.preventDefault();
              accept(options[index].tag);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              setQuery(null);
              return;
            }
          }
          const mod = e.ctrlKey || e.metaKey;
          const key = e.key.toLowerCase();
          const fmt: FormatKind | null = mod && !e.altKey ? (!e.shiftKey ? ({ b: "b", i: "i", u: "u" } as Record<string, FormatKind>)[key] ?? null : key === "x" ? "s" : null) : null;
          if (fmt) {
            e.preventDefault();
            applyEdit(applyFormat(value, e.currentTarget.selectionStart, e.currentTarget.selectionEnd, fmt));
            return;
          }
          if (e.key === "Enter" && !mod && !e.shiftKey && !e.nativeEvent.isComposing && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
            const next = continueList(value, e.currentTarget.selectionStart);
            if (next) {
              e.preventDefault();
              applyEdit(next);
              return;
            }
          }
          if (e.key === "Escape") onEscape?.();
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onSubmit?.();
          }
        }}
      />
      </div>
      {onImages && <NoteImages ids={images} onRemove={(id) => onImages((images ?? []).filter((x) => x !== id))} />}
      {found.length > 0 && (() => {
        const chips = (
        <div className="tt-tags">
          {found.map((t) => (
            <span key={t} className="tt-chip" title={`#${t}`}>
              <Hash size={11} />
              {t.split("/").map((seg, i, arr) => (
                <span key={i} className={i === arr.length - 1 ? "leaf" : "path"}>
                  {seg}
                  {i < arr.length - 1 && <i>/</i>}
                </span>
              ))}
              <button title="移除这个标签" onMouseDown={(e) => e.preventDefault()} onClick={() => removeTag(t)}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
        );
        return tagsHost ? createPortal(chips, tagsHost) : chips;
      })()}
      {options.length > 0 &&
        menuPos &&
        createPortal(
        <div className="tag-suggest floating" style={{ left: menuPos.left, top: menuPos.top, width: MENU_W }} onMouseDown={(e) => e.preventDefault()}>
          {options.map((o, i) => (
            <button key={o.tag + o.isNew} className={i === index ? "on" : ""} onMouseEnter={() => setIndex(i)} onClick={() => accept(o.tag)}>
              <Hash size={12} />
              <span className="tag-suggest-path">
                {o.tag.includes("/") && <em>{o.tag.slice(0, o.tag.lastIndexOf("/") + 1)}</em>}
                {o.tag.slice(o.tag.lastIndexOf("/") + 1)}
              </span>
              <span className="tag-suggest-meta">{o.isNew ? "新建" : o.count}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
});
