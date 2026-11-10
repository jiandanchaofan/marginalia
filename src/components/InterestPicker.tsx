import { useState } from "react";
import { Plus } from "lucide-react";
import { interestHue } from "../feeds/api";

/** Coloured chip for one interest. */
export function InterestChip({ name, on, onClick, small }: { name: string; on?: boolean; onClick?(): void; small?: boolean }) {
  const cls = `interest-chip ${on ? "on" : ""} ${small ? "small" : ""} ${onClick ? "clickable" : ""}`;
  const style = { ["--h" as string]: interestHue(name) } as React.CSSProperties;
  return onClick ? (
    <button type="button" className={cls} style={style} onClick={onClick}>
      {name}
    </button>
  ) : (
    <span className={cls} style={style}>
      {name}
    </span>
  );
}

/**
 * Multi-select of reading interests: toggle the ones already in use, or type a new one.
 * `all` = every interest known so far (so choices stay consistent across sources).
 */
export function InterestPicker({ value, all, onChange }: { value: string[]; all: string[]; onChange(v: string[]): void }) {
  const [draft, setDraft] = useState("");
  const options = [...new Set([...all, ...value])];
  const toggle = (t: string) => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t]);
  const add = () => {
    const t = draft.trim().slice(0, 24);
    setDraft("");
    if (t && !value.includes(t)) onChange([...value, t]);
  };
  return (
    <div className="interest-picker">
      <div className="interest-options">
        {options.map((t) => (
          <InterestChip key={t} name={t} on={value.includes(t)} onClick={() => toggle(t)} />
        ))}
        <span className="interest-add">
          <Plus size={12} />
          <input
            value={draft}
            placeholder={options.length ? "新增兴趣" : "如：基督教、AI、法律"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "," || e.key === "，") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={add}
          />
        </span>
      </div>
    </div>
  );
}
