import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { MemoComposer } from "../components/MemoComposer";
import { TagSuggestInput } from "../components/TagSuggestInput";
import { createTask } from "../tasks/actions";
import { parseQuickAdd } from "../tasks/quick";
import { t } from "../i18n";
import "./palette.css";

export type CaptureKind = "note" | "task";

/** A small window over the current page for writing one quick note or one to-do, without leaving what you are doing. */
export function QuickCapture({ kind, onClose, notify }: { kind: CaptureKind; onClose(): void; notify(msg: string): void }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);

  return (
    <div className="pal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pal qc" role="dialog" aria-modal="true" aria-label={kind === "note" ? t("pal.newNote") : t("pal.newTask")}>
        <div className="qc-head">
          <b>{kind === "note" ? t("pal.newNote") : t("pal.newTask")}</b>
          <button className="icon-btn" onClick={onClose} title={t("common.close")}>
            <X size={16} />
          </button>
        </div>
        <div className="qc-body">
          {kind === "note" ? (
            <MemoComposer
              prefillTags={[]}
              notify={notify}
              autoFocus
              fresh
              onSent={() => {
                onClose();
                notify(t("pal.noteSaved"));
              }}
            />
          ) : (
            <TaskLine
              onDone={(msg) => {
                onClose();
                notify(msg);
              }}
              notify={notify}
            />
          )}
        </div>
        <div className="qc-foot">{kind === "note" ? t("qc.noteHint") : t("qc.taskHint")}</div>
      </div>
    </div>
  );
}

function TaskLine({ onDone, notify }: { onDone(msg: string): void; notify(msg: string): void }) {
  const [draft, setDraft] = useState("");
  const quick = useMemo(() => parseQuickAdd(draft), [draft]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = window.setTimeout(() => box.current?.querySelector("input")?.focus(), 30);
    return () => window.clearTimeout(id);
  }, []);
  const submit = async () => {
    if (!quick.title) return;
    try {
      await createTask({ title: quick.title, tags: quick.tags, plan: quick.plan ?? null, deadline: quick.deadline, priority: quick.priority });
      onDone(quick.plan ? t("qc.taskAdded") : t("qc.taskInbox"));
    } catch (e) {
      notify(String(e));
    }
  };
  return (
    <div className="task-quick qc-task" ref={box}>
      <TagSuggestInput mode="inline" value={draft} placeholder={t("tasks.quickPlaceholder", { example: t("tasks.quickExample"), def: "" })} onChange={setDraft} onEnter={() => void submit()} />
    </div>
  );
}
