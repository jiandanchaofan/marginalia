import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DOC_ANCHOR, FREE_BOOK, type Annotation, type Goal, type Task } from "../core/types";
import { notesStore } from "../notes/store";
import { parseTags } from "../notes/tags";
import { updateGoal } from "../tasks/goalActions";
import { goalLabel, nextPeriod, reviewText } from "../tasks/goals";
import { t as tr } from "../i18n";

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function ReviewBar({ review, goals, tasksOf, notify }: { review: Goal[]; goals: Goal[]; tasksOf(g: Goal): Task[]; notify(msg: string): void }) {
  const [open, setOpen] = useState(false);
  void goals;
  const write = async (g: Goal) => {
    const now = Date.now();
    const note = reviewText(g, tasksOf(g));
    const a: Annotation = { id: uid(), anchor: DOC_ANCHOR, color: "amber", style: "none", note, tags: parseTags(note), side: "right", kind: "free", createdAt: now, updatedAt: now };
    try {
      await notesStore.add(FREE_BOOK, a);
      notify(tr("gr.made"));
    } catch (e) {
      notify(tr("gr.saveFail", { err: String(e) }));
    }
  };
  const decide = (g: Goal, status: Goal["status"]) => void updateGoal(g, { status }).catch((e) => notify(tr("gr.opFail", { err: String(e) })));
  const carry = (g: Goal) => void updateGoal(g, { period: nextPeriod(g), parentId: null }).catch((e) => notify(tr("gr.opFail", { err: String(e) })));
  return (
    <div className="goal-review">
      <button className="goal-review-head" onClick={() => setOpen((v) => !v)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {tr("gr.head", { n: review.length })}
      </button>
      {open &&
        review.map((g) => (
          <div key={g.id} className="goal-review-row">
            <span className="goal-review-title">
              {g.title} <em>{goalLabel(g)}</em>
            </span>
            <button className="reflect-btn" onClick={() => decide(g, "done")}>
              {tr("gr.done")}
            </button>
            <button className="reflect-btn" onClick={() => decide(g, "missed")}>
              {tr("gr.missed")}
            </button>
            <button className="reflect-btn" onClick={() => carry(g)} title={tr("gr.carryTip")}>
              {tr("gr.carry")}
            </button>
            <button className="reflect-btn" onClick={() => decide(g, "dropped")}>
              {tr("gr.drop")}
            </button>
            <button className="reflect-btn" onClick={() => void write(g)} title={tr("gr.writeTip")}>
              {tr("gr.write")}
            </button>
          </div>
        ))}
    </div>
  );
}
