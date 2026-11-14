import { useEffect, useRef } from "react";
import { INTENT_EVENT, takeIntent, type Intent } from "./intent";

/** Run `handler` for intents `match` accepts: the one already waiting when the page mounts, and the ones that come later. */
export function useIntent(match: (i: Intent) => boolean, handler: (i: Intent) => void) {
  const m = useRef(match);
  const h = useRef(handler);
  m.current = match;
  h.current = handler;
  useEffect(() => {
    const go = () => {
      const i = takeIntent((x) => m.current(x));
      if (i) h.current(i);
    };
    go();
    window.addEventListener(INTENT_EVENT, go);
    return () => window.removeEventListener(INTENT_EVENT, go);
  }, []);
}
