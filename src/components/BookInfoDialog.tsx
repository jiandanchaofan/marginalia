import { useState } from "react";
import { Pencil, RotateCcw, Star, X } from "lucide-react";
import type { BookRecord } from "../core/types";

/** Rename an imported document / web article and add a free-text remark (附注) to it. */
export function BookInfoDialog({ book, onSave, onClose }: { book: BookRecord; onSave(p: Partial<BookRecord>): void; onClose(): void }) {
  const [title, setTitle] = useState(book.title);
  const [remark, setRemark] = useState(book.remark ?? "");
  const [rating, setRating] = useState(book.rating ?? 0);
  const name = title.trim();

  const save = () => {
    if (!name) return;
    // The first rename remembers the original title so it can be restored; renaming back clears it.
    const orig = book.origTitle ?? book.title;
    onSave({ title: name, origTitle: name === orig ? undefined : orig, remark: remark.trim() || undefined, rating: rating || undefined });
    onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal book-info"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
          if (e.key === "Escape") onClose();
        }}
      >
        <button className="icon-btn modal-close" onClick={onClose} title="关闭">
          <X size={18} />
        </button>
        <h2>
          <Pencil size={18} /> 名称、评分与附注
        </h2>
        <p className="modal-sub">只改在墨边里显示的名称和说明，不会改动原文件。</p>
        <label className="field-label">名称</label>
        <input
          className="field-input"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") onClose();
          }}
        />
        {book.origTitle && (
          <button className="link restore" onClick={() => setTitle(book.origTitle!)} title={book.origTitle}>
            <RotateCcw size={12} /> 恢复原名称：{book.origTitle}
          </button>
        )}
        <label className="field-label">评分</label>
        <div className="stars big" role="radiogroup" aria-label="评分">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" className={n <= rating ? "on" : ""} title={`${n} 星${n === rating ? "（再点一次清除）" : ""}`} onClick={() => setRating(n === rating ? 0 : n)}>
              <Star size={24} fill={n <= rating ? "currentColor" : "none"} />
            </button>
          ))}
          {rating > 0 && <span className="stars-text">{rating} 星</span>}
        </div>
        <label className="field-label">附注</label>
        <textarea
          className="field-input"
          rows={5}
          value={remark}
          placeholder="为什么收藏它、在哪里看到的、想用来做什么……（显示在书架上，可留空）"
          onChange={(e) => setRemark(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="modal-actions">
          <span className="field-hint">Ctrl + Enter 保存</span>
          <span className="nb-spacer" />
          <button className="batch-btn" onClick={onClose}>
            取消
          </button>
          <button className="primary-btn" onClick={save} disabled={!name}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
