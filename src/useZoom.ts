import { useCallback, useEffect, useRef, useState } from "react";
import { ZOOM_STEP, clampZoom } from "./settings";

/**
 * Ctrl + / - / 0 and Ctrl + wheel zoom for the current page. Returns whether the little "130%" hint is showing.
 * The actual zooming (window zoom factor) is applied by the caller from the stored value.
 */
export function useZoomControls(enabled: boolean, zoom: number, setZoom: (z: number) => void) {
  const [hint, setHint] = useState(false);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const setRef = useRef(setZoom);
  setRef.current = setZoom;
  const timer = useRef(0);

  const zoomBy = useCallback((d: number | "reset") => {
    const next = d === "reset" ? 1 : clampZoom(zoomRef.current + d);
    if (next === zoomRef.current) return;
    zoomRef.current = next;
    setRef.current(next);
    setHint(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHint(false), 1400);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let acc = 0;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !(e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0")) return;
      e.preventDefault();
      zoomBy(e.key === "0" ? "reset" : e.key === "-" ? -ZOOM_STEP : ZOOM_STEP);
    };
    // Native, non-passive listener: React's wheel handlers can't cancel the browser's own default.
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      acc += e.deltaY;
      if (Math.abs(acc) < 40) return;
      zoomBy(acc < 0 ? ZOOM_STEP : -ZOOM_STEP);
      acc = 0;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
    };
  }, [enabled, zoomBy]);

  return hint;
}
