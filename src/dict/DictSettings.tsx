import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { t } from "../i18n";
import { dictApi, dictOn, pickDictionary, setDictOn, type DictInfo } from "./api";

/** The dictionary plugin in Settings → Plugins: off by default; when on, load / order / switch off dictionaries. */
export function DictSettings() {
  const [on, setOn] = useState(dictOn());
  const [list, setList] = useState<DictInfo[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (on) dictApi.list().then(setList, (e) => setErr(String(e)));
  }, [on]);
  const act = async (f: () => Promise<DictInfo[]>) => {
    setErr("");
    try {
      setList(await f());
    } catch (e) {
      setErr(String(e));
    }
  };
  const add = async () => {
    const p = await pickDictionary();
    if (p) await act(() => dictApi.add(p));
  };
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setDictOn(e.target.checked);
            setOn(e.target.checked);
          }}
        />{" "}
        {t("mod.dict")}
      </label>
      {on && (
        <div className="dict-set">
          {list.length === 0 && <p className="settings-hint">{t("dict.set.empty")}</p>}
          {list.map((d, i) => (
            <div key={d.id} className="dict-row">
              <input type="checkbox" checked={d.enabled} onChange={(e) => act(() => dictApi.setEnabled(d.id, e.target.checked))} />
              <span className="dict-row-t" title={d.path}>
                <b>{d.title}</b>
                <small className={d.error ? "sy-err" : ""}>{d.error ?? t("dict.set.info", { n: d.entries, r: d.resourceFiles })}</small>
              </span>
              <button className="icon-btn" disabled={i === 0} title={t("dict.set.up")} onClick={() => act(() => dictApi.shift(d.id, -1))}>
                <ArrowUp size={14} />
              </button>
              <button className="icon-btn" disabled={i === list.length - 1} title={t("dict.set.down")} onClick={() => act(() => dictApi.shift(d.id, 1))}>
                <ArrowDown size={14} />
              </button>
              <button className="icon-btn" title={t("dict.set.remove")} onClick={() => act(() => dictApi.remove(d.id))}>
                <X size={14} />
              </button>
            </div>
          ))}
          <button className="btn" onClick={add}>
            <Plus size={14} /> {t("dict.add")}
          </button>
          <p className="settings-hint">{t("dict.set.hint")}</p>
          {err && <p className="sy-err">{err}</p>}
        </div>
      )}
    </>
  );
}
