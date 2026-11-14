import { Tags, X } from "lucide-react";
import { InterestPicker } from "./InterestPicker";
import { t } from "../i18n";

/** Edit the reading interests of a source / book / article. Changes apply immediately. */
export function InterestDialog({ title, value, all, onChange, onClose }: { title: string; value: string[]; all: string[]; onChange(v: string[]): void; onClose(): void }) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal interest-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose} title={t("common.done")}>
          <X size={18} />
        </button>
        <h2>
          <Tags size={19} /> {t("interest.title")}
        </h2>
        <p className="modal-sub">{t("interest.sub", { title })}</p>
        <InterestPicker value={value} all={all} onChange={onChange} />
        <div className="modal-actions">
          <span className="nb-spacer" />
          <button className="primary-btn" onClick={onClose}>
            {t("common.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
