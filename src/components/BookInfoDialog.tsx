import { useEffect, useState } from "react";
import { Pencil, RotateCcw, Star, X } from "lucide-react";
import type { BookRecord } from "../core/types";
import { t } from "../i18n";
import { confirmDialog, isTauri } from "../platform";
import { SYNC_VISIBLE } from "../sync/visible";

/** Rename an imported document / web article and add a free-text remark (附注) to it. */
export function BookInfoDialog({ book, onSave, onClose }: { book: BookRecord; onSave(p: Partial<BookRecord>): void; onClose(): void }) {
  const [title, setTitle] = useState(book.title);
  const [remark, setRemark] = useState(book.remark ?? "");
  const [rating, setRating] = useState(book.rating ?? 0);
  const name = title.trim();
  const [cloud, setCloud] = useState(!!book.cloud);
  const [present, setPresent] = useState(true);
  const [dl, setDl] = useState<"" | "busy" | "done" | "none" | "budget">("");
  const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  useEffect(() => {
    if (!isTauri || !book.cloud) return;
    void import("@tauri-apps/api/core").then(({ invoke }) => invoke<string[]>("files_present", { books: [[book.id, book.ext]] })).then((l) => setPresent(l.includes(book.id)), () => {});
  }, [book.id, book.ext, book.cloud]);
  const toggleCloud = async (on: boolean) => {
    if (on && book.size > 50 * 1048576 && !(await confirmDialog(t("cl.big", { size: mb(book.size) })))) return;
    setCloud(on);
  };
  const download = async () => {
    setDl("busy");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const r = await invoke<string>("sync_download_book", { id: book.id, ext: book.ext });
      setDl(r as "done" | "none" | "budget");
      if (r === "done") setPresent(true);
    } catch {
      setDl("none");
    }
  };

  const save = () => {
    if (!name) return;
    // The first rename remembers the original title so it can be restored; renaming back clears it.
    const orig = book.origTitle ?? book.title;
    onSave({ title: name, origTitle: name === orig ? undefined : orig, remark: remark.trim() || undefined, rating: rating || undefined, cloud: cloud || undefined });
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
        <button className="icon-btn modal-close" onClick={onClose} title={t("common.close")}>
          <X size={18} />
        </button>
        <h2>
          <Pencil size={18} /> {t("book.title")}
        </h2>
        <p className="modal-sub">{t("book.sub")}</p>
        <label className="field-label">{t("book.name")}</label>
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
            <RotateCcw size={12} /> {t("book.restore", { name: book.origTitle })}
          </button>
        )}
        <label className="field-label">{t("book.rating")}</label>
        <div className="stars big" role="radiogroup" aria-label={t("book.rating")}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" className={n <= rating ? "on" : ""} title={n === rating ? t("book.starTipClear", { n }) : t("book.starTip", { n })} onClick={() => setRating(n === rating ? 0 : n)}>
              <Star size={24} fill={n <= rating ? "currentColor" : "none"} />
            </button>
          ))}
          {rating > 0 && <span className="stars-text">{t("unit.stars", { n: rating })}</span>}
        </div>
        <label className="field-label">{t("book.remark")}</label>
        <textarea
          className="field-input"
          rows={5}
          value={remark}
          placeholder={t("book.remarkHint")}
          onChange={(e) => setRemark(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save();
            if (e.key === "Escape") onClose();
          }}
        />
        {isTauri && SYNC_VISIBLE && (
          <>
            <label className="check">
              <input type="checkbox" checked={cloud} onChange={(e) => void toggleCloud(e.target.checked)} /> {t("cl.label")}
            </label>
            <span className="field-hint">{t("cl.hint", { size: mb(book.size) })}</span>
            {book.cloud && !present && (
              <span className="field-hint">
                {t("cl.missing")}{" "}
                <button className="link" disabled={dl === "busy"} onClick={() => void download()}>
                  {dl === "busy" ? t("cl.downloading") : t("cl.download")}
                </button>
                {dl && dl !== "busy" && ` ${t(("cl." + dl) as "cl.done")}`}
              </span>
            )}
          </>
        )}
        <div className="modal-actions">
          <span className="field-hint">{t("book.saveHint")}</span>
          <span className="nb-spacer" />
          <button className="batch-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="primary-btn" onClick={save} disabled={!name}>
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
