import { useState } from "react";
import { Tags, X } from "lucide-react";
import { InterestChip, InterestPicker } from "./InterestPicker";

/**
 * Shelf batch tagging. "add": pick (or type) interests to add to every selected item.
 * "remove": pick from the interests the selected items actually carry.
 */
export function BatchTagDialog({ mode, count, all, onApply, onClose }: { mode: "add" | "remove"; count: number; all: string[]; onApply(tags: string[]): void; onClose(): void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const toggle = (t: string) => setChosen((c) => (c.includes(t) ? c.filter((x) => x !== t) : [...c, t]));
  const apply = () => {
    if (!chosen.length) return;
    onApply(chosen);
    onClose();
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal interest-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <button className="icon-btn modal-close" onClick={onClose} title="关闭">
          <X size={18} />
        </button>
        <h2>
          <Tags size={19} /> {mode === "add" ? "批量加兴趣标签" : "批量去掉兴趣标签"}
        </h2>
        <p className="modal-sub">
          {mode === "add" ? `选择要给这 ${count} 项加上的阅读兴趣（只追加，不会改动它们原有的标签）。` : `选择要从这 ${count} 项里去掉的阅读兴趣。`}
        </p>
        {mode === "add" ? (
          <InterestPicker value={chosen} all={all} onChange={setChosen} />
        ) : all.length ? (
          <div className="interest-picker">
            <div className="interest-options">
              {all.map((t) => (
                <InterestChip key={t} name={t} on={chosen.includes(t)} onClick={() => toggle(t)} />
              ))}
            </div>
          </div>
        ) : (
          <p className="modal-sub">选中的这些项目都还没有兴趣标签。</p>
        )}
        <div className="modal-actions">
          <span className="nb-spacer" />
          <button className="batch-btn" onClick={onClose}>
            取消
          </button>
          <button className="primary-btn" onClick={apply} disabled={!chosen.length}>
            {mode === "add" ? `加到 ${count} 项` : `从 ${count} 项去掉`}
          </button>
        </div>
      </div>
    </div>
  );
}
