import type { ListKey } from "../tasks/query";

/**
 * Where the command palette (and later the shortcuts) want the app to go inside a page. The page that owns the target picks it up:
 * at once if it is on screen, otherwise when it mounts a moment later.
 */
export type Intent =
  | { to: "hub"; mode: "all" | "graph" | "free" | "books" | "articles" | "review" | "topics" | "trash" }
  | { to: "topic"; tag: string }
  | { to: "find"; q: string }
  | { to: "tasks"; view: "list" | "year" | "month" | "matrix" | "archive" | "weekly" | "trash"; list?: ListKey | "nogoal" };

export const INTENT_EVENT = "reader:intent";
type Holder = { __intent?: Intent };

export function postIntent(i: Intent) {
  (window as unknown as Holder).__intent = i;
  window.dispatchEvent(new Event(INTENT_EVENT));
}

/** Take the waiting intent if `match` accepts it. */
export function takeIntent(match: (i: Intent) => boolean): Intent | null {
  const h = window as unknown as Holder;
  const i = h.__intent;
  if (!i || !match(i)) return null;
  h.__intent = undefined;
  return i;
}
