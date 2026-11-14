import { Bold, Italic, List, ListChecks, ListOrdered, Strikethrough, Underline } from "lucide-react";
import type { FormatKind } from "../notes/edit";
import { t } from "../i18n";

const ITEMS: { kind: FormatKind; title: string; Icon: typeof Bold }[] = [
  { kind: "b", get title() { return t("fmt.bold"); }, Icon: Bold },
  { kind: "i", get title() { return t("fmt.italic"); }, Icon: Italic },
  { kind: "u", get title() { return t("fmt.underline"); }, Icon: Underline },
  { kind: "s", get title() { return t("fmt.strike"); }, Icon: Strikethrough },
  { kind: "ul", get title() { return t("fmt.ul"); }, Icon: List },
  { kind: "ol", get title() { return t("fmt.ol"); }, Icon: ListOrdered },
  { kind: "todo", get title() { return t("fmt.todo"); }, Icon: ListChecks },
];

/** Small formatting toolbar for a note editor. Buttons keep the text selection (no focus steal). */
export function FormatBar({ onFormat, size = 14 }: { onFormat(kind: FormatKind): void; size?: number }) {
  return (
    <span className="format-bar">
      {ITEMS.map(({ kind, title, Icon }) => (
        <button key={kind} type="button" title={title} onMouseDown={(e) => e.preventDefault()} onClick={() => onFormat(kind)}>
          <Icon size={size} />
        </button>
      ))}
    </span>
  );
}
