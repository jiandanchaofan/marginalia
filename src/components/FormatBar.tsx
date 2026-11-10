import { Bold, Italic, List, ListOrdered, Strikethrough, Underline } from "lucide-react";
import type { FormatKind } from "../notes/edit";

const ITEMS: { kind: FormatKind; title: string; Icon: typeof Bold }[] = [
  { kind: "b", title: "粗体（Ctrl + B）", Icon: Bold },
  { kind: "i", title: "斜体（Ctrl + I）", Icon: Italic },
  { kind: "u", title: "下划线（Ctrl + U）", Icon: Underline },
  { kind: "s", title: "删除线（Ctrl + Shift + X）", Icon: Strikethrough },
  { kind: "ul", title: "项目符号列表", Icon: List },
  { kind: "ol", title: "编号列表", Icon: ListOrdered },
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
