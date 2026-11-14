import { useMemo, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import type { BookRecord } from "../core/types";
import { confirmDialog } from "../platform";
import { fmtDateTime, t } from "../i18n";
import { daysLeft, trashStore, useTrash } from "./store";
import { restoreNotes, type NotePayload } from "./notes";
import { restoreTasks, type TaskPayload } from "./tasks";
import { toast } from "./ui";

/** The recycle bin of one kind (notes today): what was deleted, how long it stays, restore or delete for good. */
export function TrashPage({ kind, books }: { kind: "note" | "task"; books: Map<string, BookRecord> }) {
  const all = useTrash();
  const list = useMemo(() => all.filter((e) => e.kind === kind), [all, kind]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const ids = [...picked].filter((id) => list.some((e) => e.id === id));
  const targets = ids.length ? ids : list.map((e) => e.id);

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const restore = async (which: string[]) => {
    const n = kind === "task" ? await restoreTasks(which) : await restoreNotes(which);
    setPicked(new Set());
    if (n) toast(t("tr.restored", { n }));
  };
  const forever = async (which: string[], all_: boolean) => {
    if (!which.length) return;
    if (!(await confirmDialog(all_ ? t("tr.confirmClear", { n: which.length }) : t("tr.confirmForever", { n: which.length })))) return;
    await trashStore.remove(which);
    setPicked(new Set());
  };

  return (
    <div className="trp">
      <header className="trp-head">
        <div>
          <h2>
            <Trash2 size={20} /> {t("tr.title")}
          </h2>
          <p className="trp-sub">{kind === "task" ? t("tr.taskSub") : t("tr.noteSub")}</p>
        </div>
        {list.length > 0 && (
          <div className="trp-bar">
            <button className="link" onClick={() => setPicked(picked.size === list.length ? new Set() : new Set(list.map((e) => e.id)))}>
              {picked.size === list.length ? t("tr.none") : t("tr.selectAll")}
            </button>
            {ids.length > 0 && <span className="trp-count">{t("tr.picked", { n: ids.length })}</span>}
            <button className="batch-btn" onClick={() => void restore(targets)}>
              <RotateCcw size={14} /> {ids.length ? t("tr.restore") : t("tr.restoreAll")}
            </button>
            <button className="batch-btn danger" onClick={() => void forever(targets, !ids.length)}>
              {ids.length ? t("tr.deleteForever") : t("tr.clear")}
            </button>
          </div>
        )}
      </header>
      {list.length === 0 && <p className="nr-note">{t("tr.empty")}</p>}
      <div className="trp-list">
        {list.map((e) => {
          const p = (kind === "note" ? e.payload : null) as NotePayload | null;
          const tp = (kind === "task" ? e.payload : null) as TaskPayload | null;
          const left = daysLeft(e);
          const book = p ? books.get(p.bookId) : undefined;
          const quote = p?.note && p.note.kind !== "free" && p.note.kind !== "doc" ? p.note.anchor?.exact?.trim() : "";
          const root = tp?.tasks?.[0];
          const subs = tp ? tp.tasks.length - 1 : 0;
          return (
            <div key={e.id} className={`trp-row ${picked.has(e.id) ? "on" : ""}`}>
              <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e.id)} aria-label={e.title} />
              <div className="trp-main" onClick={() => toggle(e.id)}>
                {quote && <div className="trp-quote">{quote}</div>}
                <div className="trp-title">{e.title}</div>
                <div className="trp-meta">
                  {book && <span>{t("tr.fromBook", { title: book.title })}</span>}
                  {root?.plan && <span>{root.plan}</span>}
                  {subs > 0 && <span>{t("tr.subs", { n: subs })}</span>}
                  {tp?.fromNote && <span>{t("tr.fromNote")}</span>}
                  <span>{t("tr.deletedAt", { when: fmtDateTime(e.deletedAt, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) })}</span>
                  <span className={left <= 3 ? "soon" : ""}>{left <= 0 ? t("tr.today") : t("tr.left", { n: left })}</span>
                </div>
              </div>
              <button className="trp-act" title={t("tr.restore")} onClick={() => void restore([e.id])}>
                <RotateCcw size={15} />
              </button>
              <button className="trp-act danger" title={t("tr.deleteForever")} onClick={() => void forever([e.id], false)}>
                <Trash2 size={15} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
