import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, CalendarCheck, Target, AlertCircle, Calendar, CalendarDays, CalendarRange, CheckCircle2, ChevronLeft, ChevronRight, Flag, Hash, Inbox, ListTodo, Plus, Search, SlidersHorizontal, Sun, Trash2, X } from "lucide-react";
import { isFreeNote, type BookRecord, type Task } from "../core/types";
import type { NoteHit } from "../notes/store";
import { buildTree, type TagNode } from "../notes/tags";
import { useNotesById } from "../notes/useLinks";
import { useTasks } from "../tasks/useTasks";
import { addSubtask, createTask, updateTask, type Fields } from "../tasks/actions";
import { deleteTaskToBin } from "../trash/delete";
import { TrashPage } from "../trash/TrashPage";
import { useTrash } from "../trash/store";
import { formatPlan, planOf, shiftPlan, todayStr, type Plan } from "../tasks/date";
import { parseQuickAdd } from "../tasks/quick";
import { LISTS, childrenMap, filterTasks, groupTasks, listCounts, sortTasks, tagCounts, topLevel, type GroupKey, type ListKey, type SortKey } from "../tasks/query";
import { TaskRow, type RowCtx } from "./TaskRow";
import { TaskDetail } from "./TaskDetail";
import { reflectMuted } from "./ReflectBox";
import { TopicBar } from "./TopicBar";
import { TagSuggestInput } from "./TagSuggestInput";
import { TASK_DROP_EVENT, type TaskDrop } from "../tasks/taskDrag";
import { ArchivePage, MonthPage, YearPage } from "./GoalPages";
import { useGoals } from "../tasks/useGoals";
import { goalsOfMap, supportMap } from "../tasks/goals";
import { linkTasks, setTaskGoals } from "../tasks/goalActions";
import { shortDay, t as tr } from "../i18n";
import { useIntent } from "../palette/useIntent";
import { WeeklyPrompt, WeeklyReview } from "../reading/WeeklyReview";
import type { Key } from "../i18n/zh-Hans";

const ICONS: Record<ListKey, React.ReactNode> = {
  inbox: <Inbox size={14} />,
  today: <Sun size={14} />,
  week7: <CalendarRange size={14} />,
  week: <CalendarDays size={14} />,
  overdue: <AlertCircle size={14} />,
  all: <ListTodo size={14} />,
  done: <CheckCircle2 size={14} />,
};
type View = "list" | "year" | "month" | "archive" | "weekly" | "trash";
const LS = "reader:tasks-view";
const loadView = (): { list: ListKey; sort: SortKey; group: GroupKey; view: View } => {
  try {
    return { list: "today", sort: "plan", group: "none", view: "month", ...JSON.parse(localStorage.getItem(LS) ?? "{}") };
  } catch {
    return { list: "today", sort: "plan", group: "none", view: "month" };
  }
};

interface Props {
  books: Map<string, BookRecord>;
  notify(msg: string): void;
  onOpenNote(hit: NoteHit): void;
}

export function Tasks({ books, notify, onOpenNote }: Props) {
  const tasks = useTasks();
  const { goals, links } = useGoals();
  const today = todayStr();
  const saved = useMemo(() => {
    const v = loadView();
    return (LISTS as { key: string }[]).some((l) => l.key === v.list) ? v : { ...v, list: "today" as ListKey };
  }, []);
  const [list, setList] = useState<ListKey>(saved.list);
  /** which page the right side shows: a todo list, or one of the three goal pages */
  const [view, setView] = useState<View>(saved.view);
  const [offsets, setOffsets] = useState({ week: 0 });
  const [tags, setTags] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>(saved.sort);
  const [group, setGroup] = useState<GroupKey>(saved.group);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // a click on a desktop card: show this list / the month's goals / that task
  useEffect(() => {
    const go = () => {
      const w = window as unknown as { __tasksNav?: { to: string; list?: ListKey; id?: string } };
      const nav = w.__tasksNav;
      if (!nav) return;
      w.__tasksNav = undefined;
      setGoalSel(null);
      setTags([]);
      if (nav.to === "tasks-month") setView("month");
      else if (nav.to === "tasks-list") (setView("list"), setList(nav.list ?? "today"));
      else if (nav.to === "task") (setView("list"), setList("all"), setSelectedId(nav.id ?? null));
    };
    go();
    window.addEventListener("reader:tasks-nav", go);
    return () => window.removeEventListener("reader:tasks-nav", go);
  }, []);
  // the command palette sends us to a view / list, or to the quick-add box
  useIntent(
    (i) => i.to === "tasks",
    (i) => {
      setDrawer(false);
      setTags([]);
      if (i.to !== "tasks") return;
      if (i.view === "list") {
        if (i.list === "nogoal") (setList("all"), setGoalSel("none"));
        else (setList(i.list ?? "today"), setGoalSel(null));
      } else setGoalSel(null);
      setView(i.view);
    },
  );
  const trashCount = useTrash().filter((e) => e.kind === "task").length;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [openTags, setOpenTags] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [draft, setDraft] = useState("");
  const [focusChild, setFocusChild] = useState(0);
  const [reflect, setReflect] = useState<Task | null>(null);
  /** a goal id = only the todos supporting it; "none" = only todos that support no goal */
  const [goalSel, setGoalSel] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(LS, JSON.stringify({ list, sort, group, view }));
    } catch {
      /* storage unavailable */
    }
  }, [list, sort, group, view]);

  const periodKind = list === "week" ? list : null;
  const period: Plan | undefined = periodKind ? shiftPlan(planOf(periodKind, today), offsets[periodKind]) : undefined;
  const kids = useMemo(() => childrenMap(tasks), [tasks]);
  const counts = useMemo(() => listCounts(tasks, today), [tasks, today]);
  const tree = useMemo(() => buildTree(tagCounts(tasks)), [tasks]);
  // A todo that was just ticked stays where it was while its "what did you find" box is open.
  const rid = reflect?.id;
  const matched = useMemo(() => {
    const view = rid ? tasks.map((t) => (t.id === rid ? { ...t, done: false } : t)) : tasks;
    const real = new Map(tasks.map((t) => [t.id, t]));
    const linked = new Set(links.map((l) => l[0]));
    const mine = goalSel && goalSel !== "none" ? new Set(links.filter((l) => l[1] === goalSel).map((l) => l[0])) : null;
    return filterTasks(view, { list, period, tags, q }, today)
      .filter((t) => (goalSel === "none" ? !linked.has(t.id) : mine ? mine.has(t.id) : true))
      .map((t) => (t.id === rid ? real.get(rid)! : t));
  }, [tasks, rid, list, period?.raw, tags, q, today, links, goalSel]); // eslint-disable-line react-hooks/exhaustive-deps
  const openRows = useMemo(() => sortTasks(topLevel(matched.filter((t) => !t.done || t.id === rid)), sort), [matched, sort, rid]);
  const groups = useMemo(() => groupTasks(openRows, group, today), [openRows, group, today]);
  const doneRows = useMemo(() => topLevel(matched.filter((t) => t.done && t.id !== rid)).sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)), [matched, rid]);

  const hits = useNotesById(useMemo(() => tasks.flatMap((t) => (t.sourceNoteId ? [t.sourceNoteId] : [])), [tasks]));
  const sourceName = (t: Task) => {
    const hit = t.sourceNoteId ? hits.get(t.sourceNoteId) : undefined;
    if (!hit) return t.sourceNoteId ? tr("rc.note") : "";
    return isFreeNote(hit.note) ? tr("kind.free") : books.get(hit.bookId)?.title ?? tr("rc.note");
  };
  /** For a todo written on a passage: "p.34 “quoted words…”". */
  const sourceQuote = (t: Task) => {
    const hit = t.sourceNoteId ? hits.get(t.sourceNoteId) : undefined;
    const an = hit?.note.anchor;
    if (!hit || isFreeNote(hit.note) || !an?.exact) return "";
    const q = an.exact.replace(/\s+/g, " ").trim();
    const page = books.get(hit.bookId)?.format === "pdf" ? `p.${an.section + 1} ` : "";
    return `${page}“${q.length > 36 ? q.slice(0, 36) + "…" : q}”`;
  };
  const goalsOf = useMemo(() => goalsOfMap(links, goals), [links, goals]);
  const noGoalCount = useMemo(() => {
    const linked = new Set(links.map((l) => l[0]));
    return tasks.filter((t) => !t.done && !linked.has(t.id)).length;
  }, [tasks, links]);
  void supportMap;
  const goalCounts = useMemo(() => {
    const y = String(new Date().getFullYear());
    const m = todayStr().slice(0, 7);
    return {
      year: goals.filter((g) => g.kind === "year" && g.period === y && g.status === "doing").length,
      month: goals.filter((g) => g.kind === "month" && g.period <= m && g.status === "doing").length, // this month's, plus the ones carried over
      archive: goals.filter((g) => g.status !== "doing").length,
    };
  }, [goals]);
  const selected = selectedId ? tasks.find((t) => t.id === selectedId) : undefined;
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);

  const run = async (p: Promise<string | null>) => {
    try {
      const err = await p;
      if (err) notify(err);
    } catch (e) {
      notify(tr("tasks.opFail", { err: String(e) }));
    }
  };
  const update = (t: Task, f: Fields) => void run(updateTask(t, f));
  /** Ticking a todo that came from a note offers to write down what the doing taught. */
  const markDone = (t: Task, done: boolean) => {
    update(t, { done });
    setReflect(done && t.sourceNoteId && !reflectMuted() ? t : null);
  };
  const remove = async (t: Task) => {
    const below = (kids.get(t.id) ?? []).length;
    const err = await deleteTaskToBin(t, below);
    if (err) return notify(err);
    if (selectedId === t.id) setSelectedId(null);
  };

  const ctx: RowCtx = {
    kids,
    collapsed,
    selectedId,
    today,
    sourceName,
    sourceQuote,
    reflectId: reflect?.id ?? null,
    notify,
    onCloseReflect: () => setReflect(null),
    onSelect: setSelectedId,
    onToggleCollapse: (id) => setCollapsed((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set(s).add(id))),
    onDone: markDone,
    onPlan: (t, raw) => update(t, { plan: raw }),
    onAddChild: (t) => {
      setSelectedId(t.id);
      setFocusChild((n) => n + 1);
    },
    onDelete: remove,
    onTag: (tag) => setTags([tag]),
    goalsOf: (t) => goalsOf.get(t.id) ?? [],
    onGoal: (g) => setGoalSel(g.id),
  };

  // quick add: `写周报 #工作 @下周 截止周五 !高`
  const quick = useMemo(() => parseQuickAdd(draft), [draft]);
  const defaultPlan = list === "today" ? planOf("day", today) : period ?? null;
  const submit = async () => {
    if (!quick.title) return;
    const plan = quick.plan ?? defaultPlan;
    setDraft("");
    try {
      const t = await createTask({ title: quick.title, tags: [...new Set([...quick.tags, ...tags])], plan, deadline: quick.deadline, priority: quick.priority });
      // keep what was just added in view: if it would not appear in this list, say where it went
      if (!filterTasks([t], { list, period, tags: [], q: "" }, today).length) notify(tr("tasks.added", { where: t.plan ? tr("tasks.addedPlan", { plan: formatPlan(planOf(t.planKind || "day", t.planStart)) }) : tr("tasks.addedInbox") }));
    } catch (e) {
      notify(tr("tasks.addFail", { err: String(e) }));
    }
  };

  const renderNode = (n: TagNode, depth: number): React.ReactNode => {
    const expanded = openTags.has(n.tag);
    const on = tags.includes(n.tag);
    return (
      <div key={n.tag}>
        <div data-drop={`tag:${n.tag}`} className={`tree-row ${on ? "on" : ""}`} style={{ paddingLeft: 6 + depth * 14 }}>
          <button
            className={`tree-twisty ${n.children.length ? "" : "leaf"} ${expanded ? "open" : ""}`}
            onClick={() => setOpenTags((s) => (s.has(n.tag) ? new Set([...s].filter((x) => x !== n.tag)) : new Set(s).add(n.tag)))}
          >
            {n.children.length > 0 && <ChevronRight size={13} />}
          </button>
          <button
            className="tree-label"
            title={tr("hub.tagTip", { tag: n.tag })}
            onClick={(e) => setTags((cur) => (e.ctrlKey || e.metaKey ? (cur.includes(n.tag) ? cur.filter((t) => t !== n.tag) : [...cur, n.tag]) : cur.length === 1 && cur[0] === n.tag ? [] : [n.tag]))}
          >
            <Hash size={12} />
            <span>{n.name}</span>
          </button>
          <span className="tree-count">{n.count}</span>
        </div>
        {expanded && n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  // ---- dragging a todo onto the menu on the left does something to it
  const moveTo = async (t: Task, key: string) => {
    try {
      if (key === "inbox") await run(updateTask(t, { plan: "" })), notify(tr("tasks.drop.inbox"));
      else if (key === "today") await run(updateTask(t, { plan: planOf("day", today).raw })), notify(tr("tasks.drop.today"));
      else if (key === "week") await run(updateTask(t, { plan: planOf("week", today).raw })), notify(tr("tasks.drop.week"));
      else if (key === "done") await run(updateTask(t, { done: true })), notify(tr("tasks.drop.done"));
      else if (key.startsWith("goal:")) await linkTasks(key.slice(5), [t.id]), notify(tr("tasks.drop.goal", { title: goals.find((g) => g.id === key.slice(5))?.title ?? tr("tasks.drop.goalDefault") }));
      else if (key === "nogoal") await setTaskGoals(t.id, [], (goalsOf.get(t.id) ?? []).map((g) => g.id)), notify(tr("tasks.drop.nogoal"));
      else if (key.startsWith("tag:")) {
        const tag = key.slice(4);
        if (t.ownTags.includes(tag)) return notify(tr("tasks.drop.hasTag", { tag }));
        await run(updateTask(t, { tags: [...t.ownTags, tag] }));
        notify(tr("tasks.drop.tagged", { tag }));
      }
    } catch (e) {
      notify(tr("tasks.opFail", { err: String(e) }));
    }
  };
  // a todo was dropped (see tasks/taskDrag.ts) on a menu item, a tag, or a goal card
  const moveRef = useRef(moveTo);
  moveRef.current = moveTo;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<TaskDrop>).detail;
      const t = tasksRef.current.find((x) => x.id === d.taskId);
      if (t) void moveRef.current(t, d.key);
    };
    window.addEventListener(TASK_DROP_EVENT, on);
    return () => window.removeEventListener(TASK_DROP_EVENT, on);
  }, []);
  const DROPPABLE = new Set(["inbox", "today", "week", "done"]);

  const noGoalMode = goalSel === "none";
  const title = noGoalMode ? tr("tasks.noGoal") : LISTS.find((l) => l.key === list)!.name;
  const sidebar = (
    <aside className={`hub-side ${drawer ? "open" : ""}`}>
      <div className="side-feature">
        <button className={`side-item feature ${view === "month" ? "on" : ""}`} onClick={() => (setView("month"), setDrawer(false))} title={tr("tasks.thisMonthTip")}>
          <Calendar size={15} />
          <span className="side-label">{tr("tasks.thisMonth")}</span>
          {goalCounts.month > 0 && <span className="tree-count">{goalCounts.month}</span>}
        </button>
      </div>
      <div className="side-section">
        {LISTS.map((l) => (
          <button
            key={l.key}
            data-drop={DROPPABLE.has(l.key) ? l.key : undefined}
            title={DROPPABLE.has(l.key) ? tr("tasks.dropHere") : undefined}
            className={`side-item ${view === "list" && list === l.key && !noGoalMode ? "on" : ""} ${l.key === "overdue" && counts.overdue ? "alert" : ""}`}
            onClick={() => {
              setView("list");
              setList(l.key);
              if (goalSel === "none") setGoalSel(null);
              setDrawer(false);
            }}
          >
            {ICONS[l.key]}
            <span className="side-label">{l.name}</span>
            {counts[l.key] > 0 && <span className="tree-count">{counts[l.key]}</span>}
          </button>
        ))}
      </div>
      <div className="side-section">
        <button data-drop="nogoal" className={`side-item ${view === "list" && goalSel === "none" ? "on" : ""}`} onClick={() => (setView("list"), setList("all"), setGoalSel(view === "list" && goalSel === "none" ? null : "none"), setDrawer(false))} title={tr("tasks.noGoalTip")}>
          <Target size={14} />
          <span className="side-label">{tr("tasks.noGoal")}</span>
          {noGoalCount > 0 && <span className="tree-count">{noGoalCount}</span>}
        </button>
        <button className={`side-item ${view === "trash" ? "on" : ""}`} onClick={() => (setView("trash"), setDrawer(false))}>
          <Trash2 size={14} />
          <span className="side-label">{tr("tr.title")}</span>
          {trashCount > 0 && <span className="tree-count">{trashCount}</span>}
        </button>
      </div>
      <div className="side-title">{tr("tasks.goals")}</div>
      <div className="side-section">
        {([
          ["year", tr("tasks.yearGoals"), goalCounts.year],
          ["archive", tr("tasks.archive"), goalCounts.archive],
        ] as [View, string, number][]).map(([k, name, n]) => (
          <button key={k} className={`side-item ${view === k ? "on" : ""}`} onClick={() => (setView(k), setDrawer(false))}>
            {k === "year" ? <Flag size={14} /> : k === "month" ? <Calendar size={14} /> : <Archive size={14} />}
            <span className="side-label">{name}</span>
            {n > 0 && <span className="tree-count">{n}</span>}
          </button>
        ))}
      </div>
      <div className="side-title">{tr("wr.group")}</div>
      <div className="side-section">
        <button className={`side-item ${view === "weekly" ? "on" : ""}`} onClick={() => (setView("weekly"), setDrawer(false))}>
          <CalendarCheck size={14} />
          <span className="side-label">{tr("wr.nav")}</span>
        </button>
      </div>
      <div className="side-title">{tr("hub.tags")}</div>
      <div className="side-section tree">{tree.length ? tree.map((n) => renderNode(n, 0)) : <div className="side-empty">{tr("tasks.tagsEmpty")}</div>}</div>
    </aside>
  );

  const detail = selected ? (
          <TaskDetail
            key={selected.id}
            task={selected}
            kids={kids.get(selected.id) ?? []}
            hit={selected.sourceNoteId ? hits.get(selected.sourceNoteId) : undefined}
            sourceName={sourceName(selected)}
           
            goals={goals.filter((g) => g.status === "doing")}
            goalIds={(goalsOf.get(selected.id) ?? []).map((g) => g.id)}
            onGoals={(ids) => void setTaskGoals(selected.id, ids, (goalsOf.get(selected.id) ?? []).map((g) => g.id)).catch((e) => notify(tr("tasks.opFail", { err: String(e) })))}
            focusChild={focusChild}
            onUpdate={update}
            onDelete={remove}
            onAddChild={(t, name) => void run(addSubtask(t, name))}
            onSelect={setSelectedId}
            onToggleChild={markDone}
            onOpenSource={onOpenNote}
            onClose={() => setSelectedId(null)}
          />
  ) : null;

  const rowsFor = (rows: Task[]) => rows.map((t) => <TaskRow key={t.id} task={t} depth={0} ctx={ctx} />);
  const empty = !openRows.length && !doneRows.length;

  return (
    <div className="hub tasks-hub">
      {sidebar}
      {drawer && <div className="hub-scrim" onClick={() => setDrawer(false)} />}
      {view !== "list" ? (
        <section className="hub-main">
          <div className="tasks-bar goal-bar-mobile">
            <button className="icon-btn hub-drawer-btn" title={tr("tasks.drawer")} onClick={() => setDrawer((d) => !d)}>
              <SlidersHorizontal size={17} />
            </button>
          </div>
          {view !== "weekly" && <WeeklyPrompt onGo={() => setView("weekly")} />}
          <div className="tasks-body">
            <div className="tasks-list">
              {view === "trash" && <TrashPage kind="task" books={new Map()} />}
              {view === "weekly" && <WeeklyReview books={books} notify={notify} onOpenNote={onOpenNote} />}
              {view === "year" && <YearPage goals={goals} links={links} tasks={tasks} notify={notify} onToggleTask={(t, done) => update(t, { done })} onOpenTask={(t) => setSelectedId(t.id)} />}
              {view === "month" && <MonthPage goals={goals} links={links} tasks={tasks} notify={notify} onToggleTask={(t, done) => update(t, { done })} onOpenTask={(t) => setSelectedId(t.id)} />}
              {view === "archive" && <ArchivePage goals={goals} links={links} tasks={tasks} notify={notify} />}
            </div>
            {view !== "archive" && view !== "weekly" && detail}
          </div>
        </section>
      ) : (
      <section className="hub-main">
        <div className="tasks-bar">
          <button className="icon-btn hub-drawer-btn" title={tr("tasks.drawer")} onClick={() => setDrawer((d) => !d)}>
            <SlidersHorizontal size={17} />
          </button>
          <h2>{title}</h2>
          <span className="tasks-count">{openRows.length ? tr("unit.items", { n: matched.filter((t) => !t.done).length }) : ""}</span>
          {period && (
            <span className="period-nav">
              <button title={tr("tasks.prev")} onClick={() => setOffsets((o) => ({ ...o, [periodKind!]: o[periodKind!] - 1 }))}>
                <ChevronLeft size={15} />
              </button>
              <b>{formatPlan(period)}</b>
              <em>{period.kind === "week" ? `${shortDay(period.start)} ~ ${shortDay(period.end)}` : period.raw}</em>
              <button title={tr("tasks.next")} onClick={() => setOffsets((o) => ({ ...o, [periodKind!]: o[periodKind!] + 1 }))}>
                <ChevronRight size={15} />
              </button>
              {offsets[periodKind!] !== 0 && <button className="period-now" onClick={() => setOffsets((o) => ({ ...o, [periodKind!]: 0 }))}>{tr("tasks.backNow")}</button>}
            </span>
          )}
          {goalSel && goalSel !== "none" && goals.find((g) => g.id === goalSel) && (
            <span className="tag-chip on" title={tr("tasks.unfilter")}>
              {tr("tasks.goalFilter", { title: goals.find((g) => g.id === goalSel)!.title })}
              <button onClick={() => setGoalSel(null)}>
                <X size={10} />
              </button>
            </span>
          )}
          {tags.map((t) => (
            <span key={t} className="tag-chip on" title={tr("tasks.unfilter")}>
              #{t}
              <button onClick={() => setTags(tags.filter((x) => x !== t))}>
                <X size={10} />
              </button>
            </span>
          ))}
          <span className="nb-spacer" />
          <label className="tasks-search">
            <Search size={13} />
            <input value={q} placeholder={tr("tasks.search")} onChange={(e) => setQ(e.target.value)} />
          </label>
          <select className="graph-select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} title={tr("tasks.sort")}>
            <option value="plan">{tr("tasks.sortPlan")}</option>
            <option value="deadline">{tr("tasks.sortDeadline")}</option>
            <option value="priority">{tr("tasks.sortPriority")}</option>
            <option value="created">{tr("tasks.sortCreated")}</option>
          </select>
          <select className="graph-select" value={group} onChange={(e) => setGroup(e.target.value as GroupKey)} title={tr("tasks.group")}>
            <option value="none">{tr("tasks.groupNone")}</option>
            <option value="plan">{tr("tasks.groupPlan")}</option>
            <option value="tag">{tr("tasks.groupTag")}</option>
            <option value="priority">{tr("tasks.groupPriority")}</option>
          </select>
        </div>

        <div className="tasks-body">
          <div className="tasks-list">
            {tags.length === 1 && ["专题", "專題", "topic", "topics"].includes(tags[0].split("/")[0].toLowerCase()) && <TopicBar tasks={tasks} tag={tags[0]} />}
            {list !== "done" && (
              <div className="task-quick">
                <Plus size={16} />
                <TagSuggestInput
                  mode="inline"
                  value={draft}
                  placeholder={tr("tasks.quickPlaceholder", { example: tr("tasks.quickExample"), def: defaultPlan ? tr("tasks.quickDefault", { plan: formatPlan(defaultPlan) }) : "" })}
                  onChange={setDraft}
                  onEnter={() => void submit()}
                />
                {draft.trim() && (
                  <span className="quick-preview">
                    {(quick.plan ?? defaultPlan) && <span className="todo-chip plan">{formatPlan((quick.plan ?? defaultPlan)!)}</span>}
                    {quick.deadline && <span className="todo-chip due">{tr("todo.due", { date: shortDay(quick.deadline) })}</span>}
                    {quick.priority > 0 && <span className={`todo-chip pri p${quick.priority}`}>{tr(`todo.pri${quick.priority}` as Key)}</span>}
                    {[...new Set([...quick.tags, ...tags])].map((t) => (
                      <span key={t} className="tag-chip">
                        #{t}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            )}
            {empty && <div className="nb-empty">{noGoalMode ? tr("tasks.emptyNoGoal") : tasks.length ? tr("tasks.emptyList") : tr("tasks.emptyAll")}</div>}
            {list === "done"
              ? rowsFor(doneRows)
              : groups.map((g) => (
                  <div key={g.key} className="task-group">
                    {g.title && (
                      <div className="task-group-title">
                        {g.title} <span>{g.tasks.length}</span>
                      </div>
                    )}
                    {rowsFor(g.tasks)}
                  </div>
                ))}
            {list !== "done" && doneRows.length > 0 && (
              <div className="task-group done">
                <button className="task-group-title fold" onClick={() => setShowDone((v) => !v)}>
                  <ChevronRight size={13} className={showDone ? "open" : ""} /> {tr("tasks.doneHeader")} <span>{matched.filter((t) => t.done).length}</span>
                </button>
                {showDone && rowsFor(doneRows)}
              </div>
            )}
          </div>
          {detail}
        </div>
      </section>
      )}
    </div>
  );
}
