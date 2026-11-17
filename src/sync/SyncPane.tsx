import { useEffect, useState } from "react";
import { Cloud, Copy, KeyRound } from "lucide-react";
import { confirmDialog, isTauri } from "../platform";
import { fmtDateTime, t } from "../i18n";
import { localizeErr } from "../i18n/errors";
import "./sync.css";

export interface SyncStatus {
  connected: boolean;
  url: string;
  root: string;
  user: string;
  deviceName: string;
  deviceId: string;
  lastOkAt: number;
  lastError: string;
  running: boolean;
  last: { pulled: number; applied: number; removed: number; conflicts: number; pushedFiles: number; pushedItems: number; fromSnapshot: boolean; problems: string[] } | null;
}

const EMPTY: SyncStatus = { connected: false, url: "https://dav.jianguoyun.com/dav/", root: "我的坚果云/墨边", user: "", deviceName: "", deviceId: "", lastOkAt: 0, lastError: "", running: false, last: null };

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(0)} MB` : `${Math.round(n / 1024)} KB`);

/** Settings → General → Cloud sync. */
export function SyncPane({ notify, bare = false }: { notify(msg: string): void; bare?: boolean }) {
  const [st, setSt] = useState<SyncStatus>(EMPTY);
  const [mode, setMode] = useState<"create" | "join">("create");
  const [useRecovery, setUseRecovery] = useState(false);
  const [f, setF] = useState({ url: EMPTY.url, root: EMPTY.root, user: "", password: "", sync: "", sync2: "", recovery: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [quota, setQuota] = useState<number[] | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    let alive = true;
    call<number[]>("sync_quota").then((q) => alive && setQuota(q), () => {});
    call<SyncStatus>("sync_status").then((s) => alive && setSt(s), () => {});
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<SyncStatus>("sync-status", (e) => alive && setSt(e.payload)).then((u) => {
        if (alive) off = u;
        else u();
      }),
    );
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  if (!isTauri) {
    if (bare) return <p className="settings-hint">{t("sy.desktopOnly")}</p>;
    return (
      <div className="panel settings-panel">
        <div className="panel-title">{t("sy.title")}</div>
        <div className="settings-body">
          <p className="settings-hint">{t("sy.desktopOnly")}</p>
        </div>
      </div>
    );
  }

  const connect = async () => {
    setErr("");
    if (!f.user.trim() || !f.password) return setErr(t("sy.needAccount"));
    if (mode === "create") {
      if (f.sync.length < 8) return setErr(t("sy.shortPassword"));
      if (f.sync !== f.sync2) return setErr(t("sy.mismatch"));
    } else if (useRecovery ? !f.recovery.trim() : !f.sync) return setErr(t("sy.needSyncPassword"));
    setBusy(true);
    try {
      const key = await call<string | null>("sync_connect", {
        params: { url: f.url.trim(), root: f.root.trim(), user: f.user.trim(), password: f.password, syncPassword: f.sync, mode, recovery: mode === "join" && useRecovery ? f.recovery : null, deviceName: f.name.trim() },
      });
      setF((x) => ({ ...x, password: "", sync: "", sync2: "", recovery: "" }));
      if (key) (setSaved(false), setRecoveryKey(key));
      else notify(t("sy.joined"));
      await call("sync_now");
    } catch (e) {
      setErr(localizeErr(String(e)));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!(await confirmDialog(t("sy.disconnectConfirm")))) return;
    await call("sync_disconnect");
    notify(t("sy.disconnected"));
  };

  const last = st.last;
  const status = st.running ? t("sy.running") : st.lastError ? null : st.lastOkAt ? t("sy.lastOk", { when: fmtDateTime(st.lastOkAt, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) }) : t("sy.never");

  return (
    <div className={bare ? "sy sy-bare" : "panel settings-panel sy"}>
      {!bare && <div className="panel-title">{t("sy.title")}</div>}
      <div className={bare ? "" : "settings-body"}>
        {!st.connected ? (
          <>
            <p className="settings-hint"><b>{t("sy.offNote")}</b></p>
            <p className="settings-hint">{t("sy.intro")}</p>
            <div className="segmented">
              <button className={mode === "create" ? "on" : ""} onClick={() => setMode("create")}>
                {t("sy.modeCreate")}
              </button>
              <button className={mode === "join" ? "on" : ""} onClick={() => setMode("join")}>
                {t("sy.modeJoin")}
              </button>
            </div>
            <p className="settings-hint">{mode === "create" ? t("sy.createHint") : t("sy.joinHint")}</p>
            <label className="sy-f">
              <span>{t("sy.url")}</span>
              <input value={f.url} onChange={set("url")} spellCheck={false} />
            </label>
            <label className="sy-f">
              <span>{t("sy.root")}</span>
              <input value={f.root} onChange={set("root")} spellCheck={false} />
            </label>
            <label className="sy-f">
              <span>{t("sy.user")}</span>
              <input value={f.user} onChange={set("user")} spellCheck={false} autoComplete="off" />
            </label>
            <label className="sy-f">
              <span>{t("sy.appPassword")}</span>
              <input type="password" value={f.password} onChange={set("password")} autoComplete="new-password" />
            </label>
            <p className="settings-hint">{t("sy.appPasswordHint")}</p>
            {mode === "join" && (
              <label className="check">
                <input type="checkbox" checked={useRecovery} onChange={(e) => setUseRecovery(e.target.checked)} /> {t("sy.useRecovery")}
              </label>
            )}
            {mode === "join" && useRecovery ? (
              <label className="sy-f">
                <span>{t("sy.recoveryKey")}</span>
                <input value={f.recovery} onChange={set("recovery")} spellCheck={false} placeholder="XXXX-XXXX-XXXX-…" />
              </label>
            ) : (
              <label className="sy-f">
                <span>{t("sy.syncPassword")}</span>
                <input type="password" value={f.sync} onChange={set("sync")} autoComplete="new-password" />
              </label>
            )}
            {mode === "create" && (
              <>
                <label className="sy-f">
                  <span>{t("sy.syncPassword2")}</span>
                  <input type="password" value={f.sync2} onChange={set("sync2")} autoComplete="new-password" />
                </label>
                <p className="settings-hint sy-warn">{t("sy.passwordWarn")}</p>
              </>
            )}
            <label className="sy-f">
              <span>{t("sy.deviceName")}</span>
              <input value={f.name} onChange={set("name")} placeholder={t("sy.deviceNameHint")} />
            </label>
            {err && <p className="sy-err">{err}</p>}
            <button className="panel-btn" disabled={busy} onClick={() => void connect()}>
              <Cloud size={14} /> {busy ? t("sy.connecting") : t("sy.connect")}
            </button>
          </>
        ) : (
          <>
            <div className="sy-line">
              <b>{st.deviceName || t("sy.thisDevice")}</b>
              <span>
                {st.user} · {st.root}
              </span>
            </div>
            {status && <p className="sy-status">{status}</p>}
            {st.lastError && <p className="sy-err">{localizeErr(st.lastError)}</p>}
            {last && !st.running && (
              <p className="settings-hint">
                {t("sy.lastReport", { pulled: last.pulled, applied: last.applied, files: last.pushedFiles, items: last.pushedItems })}
                {last.conflicts > 0 && ` ${t("sy.conflicts", { n: last.conflicts })}`}
              </p>
            )}
            <div className="sy-row">
              <button className="panel-btn" disabled={st.running} onClick={() => void call("sync_now")}>
                {st.running ? t("sy.running") : t("sy.syncNow")}
              </button>
              <button className="panel-btn" onClick={() => void disconnect()}>
                {t("sy.disconnect")}
              </button>
            </div>
            {quota && (
              <p className="settings-hint">
                {t("sy.quota", { up: mb(quota[0]), upMax: mb(quota[2]), down: mb(quota[1]), downMax: mb(quota[3]) })}
              </p>
            )}
            <p className="settings-hint">{t("sy.connectedHint")}</p>
          </>
        )}
      </div>

      {recoveryKey && (
        <div className="modal-backdrop" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal sy-modal" onMouseDown={(e) => e.stopPropagation()}>
            <h3>
              <KeyRound size={16} /> {t("sy.recoveryTitle")}
            </h3>
            <p>{t("sy.recoveryText")}</p>
            <code className="sy-key">{recoveryKey}</code>
            <button className="panel-btn" onClick={() => void navigator.clipboard?.writeText(recoveryKey).then(() => notify(t("sy.copied")), () => {})}>
              <Copy size={13} /> {t("sy.copy")}
            </button>
            <label className="check">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> {t("sy.saved")}
            </label>
            <button className="primary-btn" disabled={!saved} onClick={() => setRecoveryKey(null)}>
              {t("sy.done")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
