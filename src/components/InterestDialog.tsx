import { Tags, X } from "lucide-react";
import { InterestPicker } from "./InterestPicker";

/** Edit the reading interests of a source / book / article. Changes apply immediately. */
export function InterestDialog({ title, value, all, onChange, onClose }: { title: string; value: string[]; all: string[]; onChange(v: string[]): void; onClose(): void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal interest-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose} title="完成">
          <X size={18} />
        </button>
        <h2>
          <Tags size={19} /> 阅读兴趣
        </h2>
        <p className="modal-sub">「{title}」属于哪些方向？可以多选，也可以新增。之后能按兴趣筛选。</p>
        <InterestPicker value={value} all={all} onChange={onChange} />
        <div className="modal-actions">
          <span className="nb-spacer" />
          <button className="primary-btn" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
