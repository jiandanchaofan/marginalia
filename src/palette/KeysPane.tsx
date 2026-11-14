import { useEffect, useMemo, useState } from "react";
import { isTauri } from "../platform";
import type { Settings } from "../settings";
import { t } from "../i18n";
import { allCommands } from "./commands";
import { DEFAULT_KEYS, LISTED_IDS, PALETTE_ID, check, chips, comboOf, eventCombo, ownerOf, pauseShortcuts, type Overrides } from "./shortcuts";
import "./palette.css";

/** The new value of one command's shortcut, keeping only what differs from the default. */
function setCombo(over: Overrides, id: string, combo: string): Overrides {
  const next = { ...over };
  if ((DEFAULT_KEYS[id] ?? "") === combo) delete next[id];
  else next[id] = combo;
  return next;
}

type Pending = { id: string; combo: string; owner: string };

/** Settings → Shortcuts: one row per command; click the box and press the new keys. */
export function KeysPane({ s, onChange }: { s: Settings; onChange(p: Partial<Settings>): void }) {
  const over = s.shortcuts ?? {};
  const [rec, setRec] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
  const cmds = useMemo(() => allCommands(isTauri), []);
  const name = (id: string) => (id === PALETTE_ID ? t("ks.palette") : cmds.find((c) => c.id === id)?.title ?? id);
  const save = (next: Overrides) => onChange({ shortcuts: next });

  useEffect(() => {
    if (!rec) return;
    pauseShortcuts(true);
    const on = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isComposing) return;
      if (e.key === "Escape") return setRec(null);
      if (e.key === "Backspace" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (rec === PALETTE_ID) setProblem({ id: rec, text: t("ks.keepPalette") });
        else save(setCombo(over, rec, ""));
        return setRec(null);
      }
      const combo = eventCombo(e);
      if (!combo) return;
      const c = check(combo);
      if (c !== "ok") {
        setProblem({ id: rec, text: c === "reserved" ? t("ks.reserved", { combo }) : t("ks.needMod") });
        return setRec(null);
      }
      const owner = ownerOf(combo, over, rec);
      setRec(null);
      if (owner) return setPending({ id: rec, combo, owner });
      setProblem(null);
      save(setCombo(over, rec, combo));
    };
    window.addEventListener("keydown", on, true);
    return () => {
      window.removeEventListener("keydown", on, true);
      pauseShortcuts(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec, over]);

  const extra = Object.keys(over).filter((id) => !LISTED_IDS.includes(id));
  const ids = [...LISTED_IDS.filter((id) => id === PALETTE_ID || id !== "card-notes" || isTauri), ...extra];
  const addable = cmds.filter((c) => !ids.includes(c.id));

  const row = (id: string) => {
    const combo = comboOf(id, over);
    const changed = id in over;
    return (
      <div key={id}>
        <div className="ks-row">
          <span className="ks-name">
            {name(id)}
            {id === PALETTE_ID && <small>{t("ks.paletteNote")}</small>}
          </span>
          <button className={`ks-slot ${rec === id ? "rec" : ""} ${combo ? "" : "empty"}`} onClick={() => (setProblem(null), setPending(null), setRec(rec === id ? null : id))}>
            {rec === id ? (
              t("ks.press")
            ) : combo ? (
              <span className="ks-keys">
                {chips(combo).map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
            ) : (
              t("ks.none")
            )}
          </button>
          <button className={`ks-reset ${changed ? "" : "off"}`} disabled={!changed} onClick={() => (setProblem(null), save(((n) => (delete n[id], n))({ ...over })))}>
            {t("ks.reset")}
          </button>
        </div>
        {pending?.id === id && (
          <div className="ks-warn">
            <span>{t("ks.taken", { combo: pending.combo, name: name(pending.owner) })}</span>
            <button
              className="ks-btn p"
              onClick={() => {
                save(setCombo(setCombo(over, pending.owner, ""), id, pending.combo));
                setPending(null);
              }}
            >
              {t("ks.moveHere", { name: name(id) })}
            </button>
            <button className="ks-btn" onClick={() => setPending(null)}>
              {t("ks.cancel")}
            </button>
          </div>
        )}
        {problem?.id === id && (
          <div className="ks-warn">
            <span>{problem.text}</span>
            <button className="ks-btn" onClick={() => setProblem(null)}>
              {t("ks.ok")}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="panel settings-panel ks">
      <div className="panel-title">{t("settings.tab.keys")}</div>
      <div className="settings-body">
        {ids.map(row)}
        {addable.length > 0 && (
          <select
            className="ks-add"
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id) (save({ ...over, [id]: "" }), setRec(id));
            }}
          >
            <option value="">{t("ks.add")}</option>
            {addable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        )}
        <p className="settings-hint">{t("ks.hint")}</p>
        <button className="panel-btn" disabled={!Object.keys(over).length} onClick={() => (setPending(null), setProblem(null), save({}))}>
          {t("ks.resetAll")}
        </button>
      </div>
    </div>
  );
}
