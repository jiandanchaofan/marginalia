import type { Task } from "../core/types";
import { parsePlan } from "../tasks/date";
import { topicSummary } from "../tasks/focus";
import { t } from "../i18n";

/** Shown when one 专题 tag is chosen: overall progress and which periods its work sits in. */
export function TopicBar({ tasks, tag }: { tasks: Task[]; tag: string }) {
  const s = topicSummary(tasks, tag);
  if (!s.total) return null;
  const pct = Math.round((s.done / s.total) * 100);
  return (
    <div className="topic-bar">
      <b>#{tag}</b>
      <span className="goal-bar wide">
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="topic-num">
        {t("topic.progress", { done: s.done, total: s.total, pct })}
      </span>
      {s.periods.length > 0 && (
        <span className="topic-periods">
          {t("topic.spread")}
          {s.periods.map((p) => (
            <span key={p.raw} className="todo-chip plan" title={parsePlan(p.raw)?.raw}>
              {p.name} · {p.count}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
