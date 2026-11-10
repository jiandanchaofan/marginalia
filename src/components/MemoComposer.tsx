import { useEffect, useRef, useState } from "react";
import { Hash, ImagePlus, Send } from "lucide-react";
import { DOC_ANCHOR, FREE_BOOK, type Annotation } from "../core/types";
import { notesStore } from "../notes/store";
import { parseTags, stripTags } from "../notes/tags";
import { TagTextarea, type TagTextareaHandle } from "./TagTextarea";
import { FormatBar } from "./FormatBar";

const DRAFT_KEY = "reader:memo-draft";
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const loadDraft = () => {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveDraft = (v: string) => {
  try {
    if (v) localStorage.setItem(DRAFT_KEY, v);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage unavailable */
  }
};

/**
 * Flomo-style quick capture: a standalone note (kind "free") that belongs to no book or article.
 * `#tag/sub` is typed inline with a caret-following menu; Ctrl+Enter or the send button saves it.
 */
export function MemoComposer({ prefillTags, notify }: { prefillTags: string[]; notify(msg: string): void }) {
  const [text, setText] = useState(loadDraft);
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const ref = useRef<TagTextareaHandle>(null);
  const [tagsHost, setTagsHost] = useState<HTMLElement | null>(null);
  const prefilled = useRef("");

  useEffect(() => saveDraft(text), [text]);

  // Filtering by a tag pre-fills it, so a note written there lands in that tag. Never overwrites the user's own words.
  useEffect(() => {
    const want = prefillTags.map((t) => `#${t} `).join("");
    setText((cur) => (cur === "" || cur === prefilled.current ? want : cur));
    prefilled.current = want;
  }, [prefillTags.join("\u0000")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Same tag rules as the parser (a tag ends at whitespace or punctuation), so "#读书，今天想到…" counts as having text.
  const body = stripTags(text);
  const canSend = (!!body || images.length > 0) && !busy;

  const send = async () => {
    const note = text.trim();
    if ((!note || !body) && !images.length) return;
    if (busy) return;
    setBusy(true);
    try {
      const now = Date.now();
      const a: Annotation = { id: uid(), anchor: DOC_ANCHOR, color: "amber", style: "none", note, tags: parseTags(note), side: "right", kind: "free", images, createdAt: now, updatedAt: now };
      await notesStore.add(FREE_BOOK, a);
      const want = prefillTags.map((t) => `#${t} `).join("");
      prefilled.current = want;
      setText(want);
      setImages([]);
      ref.current?.focus();
    } catch (e) {
      notify(`保存失败：${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="memo-composer">
      <TagTextarea ref={ref} className="note-editor memo-input" value={text} onChange={setText} images={images} onImages={setImages} onImageError={notify} tagsHost={tagsHost} placeholder="现在的想法是…  输入 # 添加标签；可直接粘贴截图 / 拖入图片" onSubmit={send} />
      <div className="memo-bar">
        <button className="memo-tool" title="插入标签（#）" onMouseDown={(e) => e.preventDefault()} onClick={() => ref.current?.startTag()}>
          <Hash size={16} />
        </button>
        <button className="memo-tool" title="添加图片（也可直接粘贴截图）" onMouseDown={(e) => e.preventDefault()} onClick={() => ref.current?.pickImage()}>
          <ImagePlus size={16} />
        </button>
        <FormatBar onFormat={(k) => ref.current?.format(k)} size={15} />
        <span className="memo-tags" ref={setTagsHost} />
        <span className="memo-count">{body ? `${text.trim().length} 字` : text.trim() && !images.length ? "只有标签，再写点文字才能发送" : ""}</span>
        <span className="nb-spacer" />
        <span className="memo-hint">Ctrl + Enter</span>
        <button className="memo-send" disabled={!canSend} onClick={send} title="发送（Ctrl + Enter）">
          <Send size={14} /> 发送
        </button>
      </div>
    </div>
  );
}
