import { matchTodo, parseTodoText } from "./parse";
import { reflectMuted } from "../components/ReflectBox";

/**
 * Ticking a todo line of a note asks what the doing taught. This is the todo's title when line `line` of `note` is
 * about to go from open to done (and the question is switched on), otherwise "".
 */
export function reflectTitleOnTick(note: string, line: number): string {
  if (reflectMuted()) return "";
  const t = matchTodo(note.split("\n")[line] ?? "");
  return t && !t.done ? parseTodoText(t.text).title : "";
}
