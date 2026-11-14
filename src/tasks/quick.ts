/** The quick-add box: `写周报 #工作/汇报 @下周 截止周五 !高` → a title plus tags, plan, deadline and priority. */
import { parseDay, parseWhen, type Plan } from "./date";
import { parseTags, stripTags } from "../notes/tags";
import { PRIORITY_WORDS_RE, priorityFromWord } from "./words";

export interface Quick {
  title: string;
  tags: string[];
  plan: Plan | null;
  deadline: string;
  priority: number;
}

export function parseQuickAdd(text: string, now = new Date()): Quick {
  let rest = text;
  let deadline = "";
  let plan: Plan | null = null;
  let priority = 0;
  rest = rest.replace(new RegExp(String.raw`(^|\s)(?:(?:截止|截至)[:：]?|due[:：]?\s?)(\S+)`, "i"), (m, sp: string, w: string) => {
    const d = parseDay(w, now);
    if (!d) return m;
    deadline = d;
    return sp;
  });
  rest = rest.replace(/(^|\s)@(\S+)/, (m, sp: string, w: string) => {
    const p = parseWhen(w, now);
    if (!p) return m;
    plan = p;
    return sp;
  });
  rest = rest.replace(new RegExp(String.raw`(^|\s)!(${PRIORITY_WORDS_RE})(?=\s|$)`, "i"), (_m, sp: string, w: string) => {
    priority = priorityFromWord(w);
    return sp;
  });
  return { title: stripTags(rest).replace(/\s+/g, " ").trim(), tags: parseTags(rest), plan, deadline, priority };
}
