import { useEffect, useRef } from "react";
import { todayStr } from "../tasks/date";
import { readingStore } from "./store";

const TICK = 5_000;
const FLUSH_AT = 15; // seconds collected before they are written
const EVENTS = ["scroll", "wheel", "keydown", "mousedown", "mousemove", "pointerdown", "touchstart"] as const;

/**
 * Counts the seconds a book is really being read. A second counts when the window is in front and has focus and
 * something was done (scrolling, a key, the mouse) within the last `idleSecs` seconds. Time is collected and written
 * to the reading log every few seconds, when the day changes, and when the reader closes.
 */
export function useReadingTracker(bookId: string, progress: number, enabled: boolean, idleSecs: number) {
  const prog = useRef(progress);
  prog.current = progress;

  useEffect(() => {
    if (!enabled) return;
    let acc = 0;
    let day = todayStr();
    let lastTick = Date.now();
    let lastActivity = Date.now();
    const touch = () => (lastActivity = Date.now());
    const flush = () => {
      const secs = Math.round(acc);
      if (secs >= 1) {
        acc = 0;
        void readingStore.add(day, bookId, secs, prog.current);
      }
    };
    const tick = () => {
      const now = Date.now();
      const dt = Math.min(10, (now - lastTick) / 1000); // a long gap is sleep or a frozen app, not reading
      lastTick = now;
      if (todayStr() !== day) {
        flush();
        day = todayStr();
      }
      if (document.hasFocus() && !document.hidden && now - lastActivity <= idleSecs * 1000) acc += dt;
      if (acc >= FLUSH_AT) flush();
    };
    const id = window.setInterval(tick, TICK);
    for (const e of EVENTS) window.addEventListener(e, touch, { capture: true, passive: true });
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.clearInterval(id);
      for (const e of EVENTS) window.removeEventListener(e, touch, { capture: true });
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [bookId, enabled, idleSecs]);
}
