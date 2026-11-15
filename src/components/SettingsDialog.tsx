import { Fragment, useEffect, useState } from "react";
import { DatabaseBackup, FileText, FolderOpen, Info, Keyboard, Mail, Palette, SlidersHorizontal, Tag, X } from "lucide-react";
import type { BookRecord } from "../core/types";
import type { Settings } from "../settings";
import { appVersion, backupApi, confirmDialog, isTauri, openExternal, type BackupStatus } from "../platform";
import { runMdBackup } from "../notes/backup";
import { SettingsPanel } from "./Panels";
import { reflectMuted, setReflectMuted } from "./ReflectBox";
import { LANGS, brandName, t, type LangPref } from "../i18n";
import type { Key } from "../i18n/zh-Hans";
import { reviewTag } from "../tasks/words";
import { readingStore } from "../reading/store";
import { reviewStore } from "../review/store";
import { syncIndex, useIndexState } from "../search/indexer";
import { KeysPane } from "../palette/KeysPane";
import { SyncPane } from "../sync/SyncPane";
import { failureOf, knownModules, recognizers, useRegistry } from "../host/registry";
import { SYNC_VISIBLE } from "../sync/visible";
import { DEFAULT_WEEK_TAG } from "../settings";
import { normalizeTag } from "../notes/tags";
import { CARDS_CHANGED, resetCards, toggleCard } from "../cards/windows";
import { CARD_KINDS, cardOn } from "../cards/state";
import { autostartState, setAutostart } from "../cards/tray";
import { AppLogo } from "./AppLogo";

export type Tab = "look" | "general" | "keys" | "backup" | "about";

interface Props {
  settings: Settings;
  books: BookRecord[];
  onChange(p: Partial<Settings>): void;
  onClose(): void;
  notify(msg: string): void;
  initialTab?: Tab;
}

const stampText = (s: string | null) => (s ? s.replace("_", " ").replace(/(\d\d)(\d\d)(\d\d)$/, "$1:$2:$3") : t("common.none"));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SettingsDialog({ settings, books, onChange, onClose, notify, initialTab }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "look");
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose} title={t("common.close")}>
          <X size={18} />
        </button>
        <h2>{t("settings.title")}</h2>
        <div className="segmented settings-tabs">
          <button className={tab === "look" ? "on" : ""} onClick={() => setTab("look")}>
            <Palette size={14} /> {t("settings.tab.look")}
          </button>
          <button className={tab === "general" ? "on" : ""} onClick={() => setTab("general")}>
            <SlidersHorizontal size={14} /> {t("settings.tab.general")}
          </button>
          <button className={tab === "keys" ? "on" : ""} onClick={() => setTab("keys")}>
            <Keyboard size={14} /> {t("settings.tab.keys")}
          </button>
          <button className={tab === "backup" ? "on" : ""} onClick={() => setTab("backup")}>
            <DatabaseBackup size={14} /> {t("settings.tab.backup")}
          </button>
          <button className={tab === "about" ? "on" : ""} onClick={() => setTab("about")}>
            <Info size={14} /> {t("settings.tab.about")}
          </button>
        </div>
        <div className={`settings-pane ${tab === "general" || tab === "backup" ? "cards" : ""}`}>
          {tab === "look" && <LangPane s={settings} onChange={onChange} />}
          {tab === "look" && <SettingsPanel s={settings} onChange={onChange} isPdf={false} canZoom={isTauri} libZoom />}
          {tab === "look" && <TodoPane />}
          {tab === "general" && isTauri && <CardsPane notify={notify} />}
          {tab === "general" && <ReadingPane s={settings} onChange={onChange} notify={notify} />}
          {tab === "general" && <BookSearchPane s={settings} onChange={onChange} books={books} />}
          {tab === "general" && <ModulesPane s={settings} onChange={onChange} />}
          {tab === "general" && <DeletePane s={settings} onChange={onChange} />}
          {tab === "keys" && <KeysPane s={settings} onChange={onChange} />}
          {tab === "backup" && SYNC_VISIBLE && <SyncPane notify={notify} />}
          {tab === "backup" && <BackupPane books={books} notify={notify} />}
          {tab === "about" && <AboutPane />}
        </div>
      </div>
    </div>
  );
}

/** The question that follows ticking a todo: "what did you find?" */
function TodoPane() {
  const [ask, setAsk] = useState(() => !reflectMuted());
  return (
    <div className="panel settings-panel">
      <div className="panel-title">{t("settings.todo.title")}</div>
      <div className="settings-body">
      <label className="check">
        <input
          type="checkbox"
          checked={ask}
          onChange={(e) => {
            setAsk(e.target.checked);
            setReflectMuted(!e.target.checked);
          }}
        />{" "}
        {t("settings.todo.ask")}
      </label>
      <p className="settings-hint">{t("settings.todo.hint", { tag: reviewTag() })}</p>
      </div>
    </div>
  );
}

function BackupPane({ books, notify }: { books: BookRecord[]; notify(msg: string): void }) {
  const [st, setSt] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState<"db" | "md" | null>(null);

  useEffect(() => {
    if (backupApi.available) backupApi.status().then(setSt, (e) => notify(t("backup.status.fail", { err: errText(e) })));
  }, [notify]);

  if (!backupApi.available) return <p className="settings-hint">{t("backup.desktopOnly")}</p>;
  if (!st) return <p className="settings-hint">{t("common.loading")}</p>;

  const save = async (patch: Partial<BackupStatus["config"]>) => {
    try {
      setSt(await backupApi.setConfig({ ...st.config, ...patch }));
    } catch (e) {
      notify(errText(e));
    }
  };
  const choose = async (key: "dbDir" | "mdDir", title: string) => {
    const dir = await backupApi.pickDir(title);
    if (dir) await save({ [key]: dir });
  };
  const run = async (kind: "db" | "md") => {
    setBusy(kind);
    try {
      setSt(kind === "db" ? await backupApi.dbNow() : await runMdBackup(books));
      notify(kind === "db" ? t("backup.dbDone") : t("backup.mdDone"));
    } catch (e) {
      notify(t("backup.fail", { err: errText(e) }));
    } finally {
      setBusy(null);
    }
  };

  const folder = (key: "dbDir" | "mdDir", dir: string, def: string, title: string) => (
    <div className="backup-folder">
      <div className="backup-path" title={dir}>
        {dir}
      </div>
      <div className="backup-folder-btns">
        <button className="panel-btn" onClick={() => choose(key, title)}>
          {t("backup.change")}
        </button>
        {st.config[key] && (
          <button className="panel-btn" onClick={() => save({ [key]: null })} title={def}>
            {t("backup.default")}
          </button>
        )}
        <button className="panel-btn" onClick={() => backupApi.openDir(dir).catch((e) => notify(errText(e)))}>
          <FolderOpen size={13} /> {t("backup.open")}
        </button>
      </div>
    </div>
  );

  return (
    <>
      <div className="panel settings-panel">
        <div className="panel-title">
          <DatabaseBackup size={15} /> {t("backup.db.title")}
        </div>
        <div className="settings-body">
        <p className="settings-hint">{t("backup.db.hint")}</p>
        {folder("dbDir", st.dbDir, st.defaultDbDir, t("backup.db.pick"))}
        <div className="backup-line">
          <span>
            {t("backup.last", { when: st.dbLast ?? t("common.none"), count: st.dbCount })}
          </span>
          <button className="panel-btn" disabled={busy !== null} onClick={() => run("db")}>
            {busy === "db" ? t("backup.db.busy") : t("backup.db.run")}
          </button>
        </div>
        </div>
      </div>

      <div className="panel settings-panel">
        <div className="panel-title">
          <FileText size={15} /> {t("backup.md.title")}
        </div>
        <div className="settings-body">
        <p className="settings-hint">{t("backup.md.hint")}</p>
        <label className="check">
          <input type="checkbox" checked={st.config.mdEnabled} onChange={(e) => save({ mdEnabled: e.target.checked })} /> {t("backup.md.enable")}
        </label>
        {folder("mdDir", st.mdDir, st.defaultMdDir, t("backup.md.pick"))}
        <div className="backup-line">
          <span>
            {t("backup.last", { when: stampText(st.mdLast), count: st.mdCount })}
          </span>
          <button className="panel-btn" disabled={busy !== null} onClick={() => run("md")}>
            {busy === "md" ? t("backup.md.busy") : t("backup.md.run")}
          </button>
        </div>
        </div>
      </div>
      <p className="settings-hint backup-note">{t("backup.note")}</p>
    </>
  );
}

const CONTACT = "shengminjiang@hotmail.com";

const FEATURES = [1, 2, 3, 4, 5, 6];

function AboutPane() {
  const [v, setV] = useState("");
  useEffect(() => {
    appVersion().then(setV, () => setV(""));
  }, []);
  return (
    <div className="about-pane">
      <div className="about-brand">
        <AppLogo />
        <div>
          <div className="brand-name">{brandName()}</div>
          <div className="brand-sub">{t("about.slogan")}</div>
        </div>
      </div>
      <p className="about-name">{t("about.name")}</p>
      <p className="about-contact">
        <Tag size={14} /> {t("about.version", { v })}
      </p>
      <p className="about-contact">
        <Mail size={14} /> {t("about.contact")}
        <a
          href={`mailto:${CONTACT}`}
          onClick={(e) => {
            e.preventDefault();
            void openExternal(`mailto:${CONTACT}`);
          }}
        >
          {CONTACT}
        </a>
      </p>
      <section className="about-features">
        <h3>{t("about.features")}</h3>
        <ul className="about-list">
          {FEATURES.map((n) => (
            <li key={n}>
              <b>{t(`about.f${n}.t` as Key)}</b>
              <span>{t(`about.f${n}.d` as Key)}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Interface language: follow the system or pick one. */
function LangPane({ s, onChange }: { s: Settings; onChange(p: Partial<Settings>): void }) {
  const cur = s.lang ?? "auto";
  const opts: [LangPref, string][] = [["auto", t("settings.lang.auto")], ...LANGS.map((l): [LangPref, string] => [l.key, l.name])];
  return (
    <div className="panel settings-panel">
      <div className="panel-title">{t("settings.lang.title")}</div>
      <div className="settings-body">
        <div className="segmented">
          {opts.map(([k, name]) => (
            <button key={k} className={k === cur ? "on" : ""} onClick={() => onChange({ lang: k })}>
              {name}
            </button>
          ))}
        </div>
        <p className="settings-hint">{t("settings.lang.hint")}</p>
      </div>
    </div>
  );
}

/** Desktop cards and starting with the system (desktop app only). */
function CardsPane({ notify }: { notify(msg: string): void }) {
  const [, again] = useState(0);
  const [auto, setAuto] = useState(false);
  useEffect(() => {
    const on = () => again((n) => n + 1);
    window.addEventListener(CARDS_CHANGED, on);
    void autostartState().then(setAuto);
    return () => window.removeEventListener(CARDS_CHANGED, on);
  }, []);
  return (
    <div className="panel settings-panel">
      <div className="panel-title">{t("cs.title")}</div>
      <div className="settings-body">
        {CARD_KINDS.map((k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={cardOn(k)} onChange={() => void toggleCard(k)} /> {t(k === "notes" ? "cs.notes" : "cs.todo")}
          </label>
        ))}
        <label className="check">
          <input
            type="checkbox"
            checked={auto}
            onChange={async (e) => {
              setAuto(e.target.checked);
              await setAutostart(e.target.checked).catch((err) => notify(String(err)));
              setAuto(await autostartState());
            }}
          />{" "}
          {t("cs.autostart")}
        </label>
        <p className="settings-hint">{t("cs.hint")}</p>
        <button
          className="panel-btn"
          onClick={async () => {
            await resetCards();
            notify(t("cs.resetDone"));
          }}
        >
          {t("cs.reset")}
        </button>
      </div>
    </div>
  );
}

/** Reading log and the weekly review. */
function ReadingPane({ s, onChange, notify }: { s: Settings; onChange(p: Partial<Settings>): void; notify(msg: string): void }) {
  return (
    <>
    <div className="panel settings-panel">
      <div className="panel-title">{t("rset.title")}</div>
      <div className="settings-body">
        <label className="check">
          <input type="checkbox" checked={s.readingTrack !== false} onChange={(e) => onChange({ readingTrack: e.target.checked })} /> {t("rset.track")}
        </label>
        <label>{t("rset.idle")}</label>
        <div className="segmented">
          {[60, 90, 180].map((n) => (
            <button key={n} className={(s.readingIdle ?? 90) === n ? "on" : ""} onClick={() => onChange({ readingIdle: n })}>
              {n < 120 ? t("rset.idleSecs", { n }) : t("rset.idleMin", { n: n / 60 })}
            </button>
          ))}
        </div>
        <p className="settings-hint">{t("rset.hint")}</p>
        <button
          className="panel-btn"
          onClick={async () => {
            if (!(await confirmDialog(t("rset.clearConfirm")))) return;
            await readingStore.clear();
            notify(t("rset.cleared"));
          }}
        >
          {t("rset.clear")}
        </button>
      </div>
    </div>
    <div className="panel settings-panel">
      <div className="panel-title">{t("wset.title")}</div>
      <div className="settings-body">
        <label>{t("wset.weekStart")}</label>
        <div className="segmented">
          <button className={s.weekStart !== 0 ? "on" : ""} onClick={() => onChange({ weekStart: 1 })}>
            {t("wset.mon")}
          </button>
          <button className={s.weekStart === 0 ? "on" : ""} onClick={() => onChange({ weekStart: 0 })}>
            {t("wset.sun")}
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.weekPrompt !== false} onChange={(e) => onChange({ weekPrompt: e.target.checked })} /> {t("wset.prompt")}
        </label>
        <label>{t("wset.tag")}</label>
        <WeekTagInput value={s.weekTag ?? DEFAULT_WEEK_TAG} onSave={(v) => onChange({ weekTag: v })} />
        <p className="settings-hint">{t("wset.tagHint")}</p>
      </div>
    </div>
    <div className="panel settings-panel">
      <div className="panel-title">{t("rv.title")}</div>
      <div className="settings-body">
        <label className="check">
          <input type="checkbox" checked={s.reviewOn !== false} onChange={(e) => onChange({ reviewOn: e.target.checked })} /> {t("rv.on")}
        </label>
        <label>{t("rv.cap")}</label>
        <div className="segmented">
          {[3, 5, 10, 20, 0].map((n) => (
            <button key={n} className={(s.reviewCap ?? 5) === n ? "on" : ""} onClick={() => onChange({ reviewCap: n })}>
              {n === 0 ? t("rv.capAll") : t("rv.capOpt", { n })}
            </button>
          ))}
        </div>
        <label>{t("rv.exclude")}</label>
        <ExcludeInput value={(s.reviewExclude ?? []).join(" ")} onSave={(v) => onChange({ reviewExclude: v.split(/[\s,，]+/).map((x) => normalizeTag(x.replace(/^#/, ""))).filter(Boolean) })} />
        <label>{t("rv.dayStart")}</label>
        <select value={s.reviewDayStart ?? 4} onChange={(e) => onChange({ reviewDayStart: Number(e.target.value) })}>
          {[0, 1, 2, 3, 4, 5, 6].map((h) => (
            <option key={h} value={h}>
              {t("rv.hour", { n: h })}
            </option>
          ))}
        </select>
        <p className="settings-hint">{t("rv.hint")}</p>
        <button
          className="panel-btn"
          onClick={async () => {
            if (!(await confirmDialog(t("rv.resetConfirm")))) return;
            await reviewStore.reset();
            notify(t("rv.resetDone"));
          }}
        >
          {t("rv.reset")}
        </button>
      </div>
    </div>
    </>
  );
}

/** Modules built into this edition, each switched on or off. Shows nothing when the build has none. */
function ModulesPane({ s, onChange }: { s: Settings; onChange(p: Partial<Settings>): void }) {
  useRegistry();
  const list = knownModules();
  if (!list.length) return null;
  const on = new Set(s.modules ?? []);
  const flip = (id: string, v: boolean) => {
    if (v) on.add(id);
    else on.delete(id);
    onChange({ modules: [...on] });
  };
  return (
    <div className="panel settings-panel">
      <div className="panel-title">{t("mod.title")}</div>
      <div className="settings-body">
        <p className="settings-hint">{t("mod.hint")}</p>
        {list.map((m) => (
          <Fragment key={m.id}>
            <label className="check">
              <input type="checkbox" checked={on.has(m.id)} onChange={(e) => flip(m.id, e.target.checked)} /> {m.name}
            </label>
            {on.has(m.id) && failureOf(m.id) && <p className="sy-err">{t("mod.failed", { err: failureOf(m.id)! })}</p>}
          </Fragment>
        ))}
        {recognizers().length > 0 && (
          <label className="check sub-option">
            <input type="checkbox" checked={s.refPreview !== false} onChange={(e) => onChange({ refPreview: e.target.checked })} /> {t("mod.refPreview")}
          </label>
        )}
      </div>
    </div>
  );
}

/** The index of the books' text: on / off, how far it is, how much room it takes, rebuild. */
function BookSearchPane({ s, onChange, books }: { s: Settings; onChange(p: Partial<Settings>): void; books: BookRecord[] }) {
  const ix = useIndexState();
  const on = s.bookSearch !== false;
  const pct = ix.total ? Math.round((ix.done / ix.total) * 100) : 100;
  return (
    <div className="panel settings-panel">
      <div className="panel-title">{t("bs.title")}</div>
      <div className="settings-body">
        <label className="check">
          <input type="checkbox" checked={on} onChange={(e) => onChange({ bookSearch: e.target.checked })} /> {t("bs.on")}
        </label>
        {on && (
          <>
            <p className="settings-hint">
              {ix.running ? t("bs.running", { done: ix.done, total: ix.total, title: ix.current }) : t("bs.status", { n: ix.indexed, total: ix.eligible, size: (ix.size / 1048576).toFixed(1) })}
              {ix.noText > 0 && ` ${t("bs.noText", { n: ix.noText })}`}
              {ix.failed > 0 && ` ${t("bs.failed", { n: ix.failed })}`}
            </p>
            {ix.running && (
              <div className="ix-bar">
                <i style={{ width: `${pct}%` }} />
              </div>
            )}
            <button className="panel-btn" disabled={ix.running} onClick={() => void syncIndex(books, { force: true })}>
              {t("bs.rebuild")}
            </button>
          </>
        )}
        <p className="settings-hint">{t("bs.hint")}</p>
      </div>
    </div>
  );
}

/** Whether deleting asks first. */
function DeletePane({ s, onChange }: { s: Settings; onChange(p: Partial<Settings>): void }) {
  return (
    <div className="panel settings-panel">
      <div className="panel-title">{t("tr.setTitle")}</div>
      <div className="settings-body">
        <label className="check">
          <input type="checkbox" checked={s.confirmDelete !== false} onChange={(e) => onChange({ confirmDelete: e.target.checked })} /> {t("tr.setConfirm")}
        </label>
        <p className="settings-hint">{t("tr.setHint")}</p>
      </div>
    </div>
  );
}

function ExcludeInput({ value, onSave }: { value: string; onSave(v: string): void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <div className="week-tag">
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onSave(text)} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), e.preventDefault())} placeholder="#tag" spellCheck={false} />
    </div>
  );
}

/** The tag written on weekly reviews: typed with or without #, saved when the box is left or Enter is pressed. */
function WeekTagInput({ value, onSave }: { value: string; onSave(v: string): void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const v = normalizeTag(text.replace(/^#/, "")) || DEFAULT_WEEK_TAG;
    setText(v);
    if (v !== value) onSave(v);
  };
  return (
    <div className="week-tag">
      <span>#</span>
      <input value={text.replace(/^#/, "")} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), e.preventDefault())} placeholder={DEFAULT_WEEK_TAG} spellCheck={false} />
      {text !== DEFAULT_WEEK_TAG && (
        <button className="zoom-reset" onClick={() => (setText(DEFAULT_WEEK_TAG), onSave(DEFAULT_WEEK_TAG))}>
          {t("common.reset")}
        </button>
      )}
    </div>
  );
}
