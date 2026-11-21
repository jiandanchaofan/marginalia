import { useEffect, useState } from "react";
import { isTauri } from "../platform";
import { setSyncOn, syncOn } from "./visible";

/**
 * The cloud sync plugin's switch for Settings → Plugins: off by default; while connected it cannot be switched off
 * (disconnect first, in its settings — the SyncPane behind its gear).
 */
export function useSyncPlugin() {
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
  const set = (v: boolean) => {
    setSyncOn(v);
    setOn(v);
  };
  return { on, connected, set };
}
