import { useState } from "react";
import { Tags, X } from "lucide-react";
import { InterestChip, InterestPicker } from "./InterestPicker";
import { t } from "../i18n";

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
        <button className="icon-btn modal-close" onClick={onClose} title={t("common.close")}>
          <X size={18} />
        </button>
        <h2>
          <Tags size={19} /> {mode === "add" ? t("batch.addTitle") : t("batch.removeTitle")}
        </h2>
        <p className="modal-sub">
          {mode === "add" ? t("batch.addSub", { n: count }) : t("batch.removeSub", { n: count })}
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
          <p className="modal-sub">{t("batch.noTags")}</p>
        )}
        <div className="modal-actions">
          <span className="nb-spacer" />
          <button className="batch-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="primary-btn" onClick={apply} disabled={!chosen.length}>
            {mode === "add" ? t("batch.addBtn", { n: count }) : t("batch.removeBtn", { n: count })}
          </button>
        </div>
      </div>
    </div>
  );
}
