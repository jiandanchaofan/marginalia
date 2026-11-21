import { useEffect, useState } from "react";
import { t } from "../i18n";
import type { BookRecord } from "../core/types";
import { CHANGED, clearStop, flomoApi, flomoAvailable, flomoOpts, flomoStatus, flushFlomo, outboxSize, sendTest, setFlomoOpts, type FlomoState } from "./flomo";

const when = (ts?: number) => (ts ? new Date(ts).toLocaleString() : t("common.none"));

/** The flomo plugin's settings (Settings → Plugins → its gear): the API address, what to send, how it is going. */
export function FlomoPanel({ books }: { books: BookRecord[] }) {
  const [st, setSt] = useState<FlomoState | null>(null);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [, setRev] = useState(0);
  const opts = flomoOpts();
  const status = flomoStatus();
  const waiting = outboxSize();
  const [tag, setTag] = useState(opts.tag);

  useEffect(() => {
    flomoApi.state().then(setSt, () => setSt({ configured: false, hint: null }));
    const on = () => setRev((r) => r + 1);
    window.addEventListener(CHANGED, on);
    window.addEventListener("storage", on);
    const tick = window.setInterval(on, 5000);
    return () => {
      window.removeEventListener(CHANGED, on);
      window.removeEventListener("storage", on);
      window.clearInterval(tick);
    };
  }, []);

  const save = async () => {
    setErr("");
    setBusy(true);
    try {
      setSt(await flomoApi.setApi(url));
      setEditing(false);
      setUrl("");
      clearStop();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setMsg("");
    setErr("");
    setBusy(true);
    try {
      await f();
      setMsg(ok);
    } catch (e) {
      setErr(String(e).replace(/^(api|net):/, ""));
    } finally {
      setBusy(false);
    }
  };

  if (!flomoAvailable()) return <p className="settings-hint">{t("flomo.desktopOnly")}</p>;
  const showForm = st && (!st.configured || editing);
  return (
    <div className="flomo-set">
      <div className="flomo-sec">
        <b>{t("flomo.api")}</b>
        {showForm ? (
          <>
            <div className="flomo-api">
              <input type="password" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && url.trim() && void save()} placeholder="https://flomoapp.com/iwh/…" spellCheck={false} autoComplete="off" aria-label={t("flomo.api")} />
              <button className="btn" disabled={busy || !url.trim()} onClick={() => void save()}>
                {t("flomo.save")}
              </button>
              {editing && (
                <button className="btn ghost" onClick={() => (setEditing(false), setUrl(""), setErr(""))}>
                  {t("common.cancel")}
                </button>
              )}
            </div>
            <p className="settings-hint">{t("flomo.apiHint")}</p>
          </>
        ) : st ? (
          <div className="flomo-api">
            <code className="flomo-hint">{st.hint}</code>
            <button className="btn" onClick={() => setEditing(true)}>
              {t("flomo.change")}
            </button>
            <button className="btn ghost" onClick={() => void flomoApi.clearApi().then(setSt)}>
              {t("flomo.clear")}
            </button>
          </div>
        ) : null}
      </div>

      <div className="flomo-sec">
        <b>{t("flomo.what")}</b>
        <p className="settings-hint flomo-plain">{t("flomo.whatHint")}</p>
        <label className="check">
          <input type="checkbox" checked={opts.highlights} onChange={(e) => setFlomoOpts({ highlights: e.target.checked })} /> {t("flomo.highlights")}
        </label>
        <div className="dict-tagrow">
          <span>{t("flomo.tag")}</span>
          <div className="week-tag">
            <span>#</span>
            <input value={tag} onChange={(e) => setTag(e.target.value)} onBlur={() => setFlomoOpts({ tag: tag.trim().replace(/^#+/, "") })} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), e.preventDefault())} placeholder={t("flomo.tagPh")} spellCheck={false} aria-label={t("flomo.tag")} />
          </div>
        </div>
      </div>

      <div className="flomo-sec">
        <b>{t("flomo.state")}</b>
        <p className="flomo-stat">{t("flomo.stateLine", { waiting, sent: status.sent, last: when(status.lastAt) })}</p>
        {status.error && <p className="sy-err">{status.stopped ? t("flomo.stopped", { err: status.error }) : t("flomo.willRetry", { err: status.error })}</p>}
        <div className="flomo-api">
          <button className="btn" disabled={busy || !st?.configured || !waiting} onClick={() => void run(() => flushFlomo(() => books, { now: true }), t("flomo.flushed"))}>
            {status.stopped ? t("flomo.retry") : t("flomo.sendNow")}
          </button>
          <button className="btn ghost" disabled={busy || !st?.configured} onClick={() => void run(sendTest, t("flomo.testOk"))}>
            {t("flomo.test")}
          </button>
        </div>
        {msg && <p className="settings-hint flomo-ok">{msg}</p>}
        {err && <p className="sy-err">{err}</p>}
      </div>

      <p className="settings-hint flomo-plain">{t("flomo.picsHint")}</p>
    </div>
  );
}
