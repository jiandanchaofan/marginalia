import { useEffect, useState } from "react";
import { t } from "../i18n";
import { isTauri } from "../platform";
import { SyncPane } from "./SyncPane";
import { setSyncOn, syncOn } from "./visible";

/** The cloud sync plugin in Settings → Plugins: off by default; when on, its settings appear right below. */
export function SyncSettings({ notify }: { notify(msg: string): void }) {
  const [on, setOn] = useState(syncOn());
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!isTauri || !on) return;
    let alive = true;
    let off: (() => void) | undefined;
    import("@tauri-apps/api/core").then(({ invoke }) => invoke<{ connected: boolean }>("sync_status")).then((s) => alive && setConnected(s.connected), () => {});
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ connected: boolean }>("sync-status", (e) => alive && setConnected(e.payload.connected)).then((u) => {
        if (alive) off = u;
        else u();
      }),
    );
    return () => {
      alive = false;
      off?.();
    };
  }, [on]);
  return (
    <div className="plugin-item">
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          disabled={on && connected}
          onChange={(e) => {
            setSyncOn(e.target.checked);
            setOn(e.target.checked);
          }}
        />{" "}
        {t("mod.sync")}
      </label>
      {on && connected && <p className="settings-hint sy-locked">{t("mod.syncLocked")}</p>}
      {on && (
        <div className="sy-plugin">
          <SyncPane notify={notify} bare />
        </div>
      )}
    </div>
  );
}
