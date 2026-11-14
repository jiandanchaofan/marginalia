/**
 * Dragging a todo onto the menu / a goal card, done with pointer events.
 *
 * The desktop app keeps Tauri's native file drop switched on (to import books by dropping them), and on Windows that
 * stops HTML5 drag-and-drop inside the page from working at all. So this does not use `draggable`: press on a todo,
 * move a few pixels, and a small label follows the pointer; whatever element under it has a `data-drop` attribute is
 * the target (highlighted via `data-drop-hover`), and letting go announces `reader:task-drop`.
 */
export interface TaskDrop {
  taskId: string;
  /** the target's `data-drop` value, e.g. "today", "tag:读书", "goal:<id>" */
  key: string;
}
export const TASK_DROP_EVENT = "reader:task-drop";
const DROP = "data-drop";
const HOVER = "data-drop-hover";

export function beginTaskDrag(e: { button: number; pointerType: string; clientX: number; clientY: number; target: EventTarget }, task: { id: string; title: string }) {
  if (e.button !== 0 || e.pointerType === "touch") return;
  if ((e.target as Element).closest?.("input, select, textarea, a, [data-nodrag]")) return;
  const sx = e.clientX;
  const sy = e.clientY;
  let moved = false;
  let ghost: HTMLElement | null = null;
  let hover: Element | null = null;
  const find = (x: number, y: number) => document.elementFromPoint(x, y)?.closest(`[${DROP}]`) ?? null;
  const setHover = (el: Element | null) => {
    if (el === hover) return;
    hover?.removeAttribute(HOVER);
    el?.setAttribute(HOVER, "");
    hover = el;
  };
  const move = (ev: PointerEvent) => {
    if (!moved) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      moved = true;
      ghost = document.createElement("div");
      ghost.className = "task-ghost";
      ghost.textContent = task.title.length > 28 ? task.title.slice(0, 28) + "…" : task.title;
      document.body.append(ghost);
      document.body.classList.add("task-dragging");
    }
    ghost!.style.left = `${ev.clientX + 14}px`;
    ghost!.style.top = `${ev.clientY + 10}px`;
    setHover(find(ev.clientX, ev.clientY));
  };
  const finish = (drop: boolean, ev?: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("pointercancel", cancel);
    const target = drop && moved && ev ? find(ev.clientX, ev.clientY) : null;
    setHover(null);
    ghost?.remove();
    document.body.classList.remove("task-dragging");
    if (moved) {
      // the click that follows letting go must not open the todo
      const swallow = (c: Event) => (c.stopPropagation(), c.preventDefault());
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    }
    const k = target?.getAttribute(DROP);
    if (k) window.dispatchEvent(new CustomEvent<TaskDrop>(TASK_DROP_EVENT, { detail: { taskId: task.id, key: k } }));
  };
  const up = (ev: PointerEvent) => finish(true, ev);
  const cancel = () => finish(false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") finish(false);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key, true);
}
