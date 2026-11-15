import { useEffect, useState } from "react";
import { CalendarCheck, Trash2 } from "lucide-react";
import type { PageContext, PlannedTask } from "../../host/sdk";
import { BIBLE_BOOKS } from "./books";
import { PRESETS, PLAN_TAG, type PlanParams, buildPlan } from "./plan";
import { type PlanEntry, loadPlans, savePlans } from "./plansStore";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const niceDay = (ymd: string) => {
  const [, m, d] = ymd.split("-").map(Number);
  return `${m}月${d}日`;
};

/** "读经计划": the plans that were started, with how far each one is, and a way to start one. */
export function PlanSection({ ctx }: { ctx: PageContext }) {
  const [plans, setPlans] = useState<PlanEntry[]>(loadPlans);
  const [prog, setProg] = useState<Record<string, { done: number; total: number; next?: { title: string; day: string } }>>({});
  const [making, setMaking] = useState(false);

  useEffect(() => {
    let alive = true;
    const run = () =>
      void Promise.all(plans.map(async (p) => [p.id, await ctx.planProgress(p.taskIds)] as const)).then((rows) => alive && setProg(Object.fromEntries(rows)));
    run();
    const off = ctx.onTasksChanged(run);
    return () => {
      alive = false;
      off();
    };
  }, [plans, ctx]);

  const remove = async (p: PlanEntry) => {
    if (!window.confirm(`删除读经计划「${p.name}」？它的 ${p.taskIds.length} 条待办和目标会一起删除，已经完成的记录也会没有。`)) return;
    await ctx.removePlan({ taskIds: p.taskIds, goalIds: p.goalIds });
    const next = plans.filter((x) => x.id !== p.id);
    savePlans(next);
    setPlans(next);
  };

  return (
    <section className="bible-plans">
      <div className="bible-plans-h">
        <h3>读经计划</h3>
        <button className="batch-btn" onClick={() => setMaking(true)}>
          <CalendarCheck size={14} /> 新建读经计划
        </button>
      </div>
      {!plans.length && <p className="bible-plans-n">还没有读经计划。新建一个，每天的读经会出现在「任务」里，带 #{PLAN_TAG} 标签。</p>}
      {plans.map((p) => {
        const g = prog[p.id];
        const pct = g && g.total ? Math.round((g.done / g.total) * 100) : 0;
        return (
          <div key={p.id} className="bible-plan">
            <div className="bible-plan-t">
              <b>{p.name}</b>
              <span>
                {niceDay(p.start)} 起 · 共 {p.days} 天
              </span>
              <button className="icon-btn" title="删除这个计划" onClick={() => void remove(p)}>
                <Trash2 size={14} />
              </button>
            </div>
            <div className="continue-bar">
              <i style={{ width: `${pct}%` }} />
            </div>
            <div className="bible-plan-m">
              {g ? `已完成 ${g.done} / ${g.total}（${pct}%）` : "…"}
              {g?.next && ` · 下一项：${niceDay(g.next.day)} ${g.next.title.replace(/^读经：/, "")}`}
              {g && g.total > 0 && g.done === g.total && " · 全部读完"}
            </div>
          </div>
        );
      })}
      {making && (
        <PlanDialog
          ctx={ctx}
          onClose={() => setMaking(false)}
          onMade={(entry) => {
            const next = [entry, ...plans];
            savePlans(next);
            setPlans(next);
            setMaking(false);
          }}
        />
      )}
    </section>
  );
}

function PlanDialog({ ctx, onClose, onMade }: { ctx: PageContext; onClose(): void; onMade(e: PlanEntry): void }) {
  const [params, setParams] = useState<PlanParams>({ preset: "bible-year", start: today(), skipSunday: false, book: "JHN", from: { book: "GEN", chapter: 1 }, to: { book: "GEN", chapter: 50 } });
  const [planned, setPlanned] = useState<PlannedTask[]>([]);
  const [busy, setBusy] = useState(false);
  const preset = PRESETS.find((p) => p.id === params.preset)!;
  const set = (patch: Partial<PlanParams>) => setParams((p) => ({ ...p, ...patch }));

  useEffect(() => {
    let alive = true;
    void buildPlan(params).then((list) => alive && setPlanned(list));
    return () => {
      alive = false;
    };
  }, [params]);

  const bookSelect = (value: string, onChange: (b: string) => void) => (
    <select className="field-input" value={value} onChange={(e) => onChange(e.target.value)}>
      {BIBLE_BOOKS.map((b) => (
        <option key={b.id} value={b.id}>
          {b.zh}
        </option>
      ))}
    </select>
  );
  const chapterInput = (book: string, value: number, onChange: (n: number) => void) => (
    <input className="field-input bible-num" type="number" min={1} max={BIBLE_BOOKS.find((b) => b.id === book)?.chapters ?? 1} value={value} onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 1))} />
  );
  const lastDay = planned.length ? planned[planned.length - 1].day : "";

  const start = async () => {
    if (!planned.length) return;
    setBusy(true);
    try {
      const ids = await ctx.applyPlan(preset.name, planned);
      onMade({ id: `${Date.now()}`, name: preset.name, start: planned[0].day, days: planned.length, created: Date.now(), ...ids });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal bible-plan-dlg" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>
          <CalendarCheck size={18} /> 新建读经计划
        </h2>
        <label className="field-label">计划</label>
        <select className="field-input" value={params.preset} onChange={(e) => set({ preset: e.target.value })}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className="field-hint">{preset.about}</p>
        {preset.needs === "book" && (
          <>
            <label className="field-label">哪一卷</label>
            {bookSelect(params.book ?? "JHN", (b) => set({ book: b, days: undefined }))}
          </>
        )}
        {preset.needs === "span" && (
          <>
            <label className="field-label">从</label>
            <div className="bible-row">
              {bookSelect(params.from!.book, (b) => set({ from: { book: b, chapter: 1 } }))}
              {chapterInput(params.from!.book, params.from!.chapter, (n) => set({ from: { ...params.from!, chapter: n } }))} 章
            </div>
            <label className="field-label">到</label>
            <div className="bible-row">
              {bookSelect(params.to!.book, (b) => set({ to: { book: b, chapter: BIBLE_BOOKS.find((x) => x.id === b)?.chapters ?? 1 } }))}
              {chapterInput(params.to!.book, params.to!.chapter, (n) => set({ to: { ...params.to!, chapter: n } }))} 章
            </div>
          </>
        )}
        {preset.daysFree && (
          <>
            <label className="field-label">用几天</label>
            <input className="field-input bible-num" type="number" min={1} value={params.days ?? (planned.length || "")} onChange={(e) => set({ days: Math.max(1, Number(e.target.value) || 1) })} />
          </>
        )}
        <label className="field-label">从哪天开始</label>
        <input className="field-input" type="date" value={params.start} onChange={(e) => set({ start: e.target.value || today() })} />
        <label className="check">
          <input type="checkbox" checked={params.skipSunday} onChange={(e) => set({ skipSunday: e.target.checked })} /> 周日休息
        </label>
        <div className="bible-preview">
          {planned.length ? (
            <>
              <div className="bible-preview-h">
                共 {planned.length} 天，{niceDay(planned[0].day)} 到 {niceDay(lastDay)}
              </div>
              {planned.slice(0, 5).map((p) => (
                <div key={p.day}>
                  <span>{niceDay(p.day)}</span> {p.title.replace(/^读经：/, "")}
                </div>
              ))}
              {planned.length > 5 && <div className="bible-preview-more">……</div>}
            </>
          ) : (
            <div className="bible-preview-h">这个范围里没有章节，请检查「从」和「到」。</div>
          )}
        </div>
        <p className="field-hint">每天一条待办，带 #{PLAN_TAG} 标签，并为每个月建一个目标。没读的会留在「逾期」里，你可以顺延。</p>
        <div className="modal-actions">
          <span className="nb-spacer" />
          <button className="batch-btn" onClick={onClose}>
            取消
          </button>
          <button className="primary-btn" onClick={() => void start()} disabled={!planned.length || busy}>
            {busy ? "正在生成…" : "开始计划"}
          </button>
        </div>
      </div>
    </div>
  );
}
