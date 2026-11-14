/** What a click on a desktop card should open in the main window. */
export type NavTarget =
  | { to: "notes" }
  | { to: "note"; id: string }
  | { to: "tasks-month" }
  | { to: "tasks-list"; list: "today" | "week7" }
  | { to: "task"; id: string };

export const NAV_EVENT = "reader:navigate";

export async function openInMain(target: NavTarget) {
  const { emit } = await import("@tauri-apps/api/event");
  await emit(NAV_EVENT, target);
}
