/**
 * The modules that are built into the app and which of them are switched on. Nothing here knows about any
 * particular module; with none registered (or none enabled) the app behaves exactly as before.
 */
import { useSyncExternalStore } from "react";
import type { DocProvider, Host, Module, PageItem, PlanProvider, RefRecognizer, SlotItem, SlotName } from "./sdk";

interface Provided {
  docs: DocProvider[];
  recognizers: RefRecognizer[];
  slots: SlotItem[];
  pages: PageItem[];
  plans: PlanProvider[];
  refListeners: Set<(ref: string, docId: string) => void>;
}

const modules = new Map<string, Module>();
const active = new Map<string, Provided>();
const failed = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  listeners.forEach((l) => l());
};

/** Make a module known to the app (it is not running until it is enabled). */
export function registerModule(m: Module) {
  modules.set(m.id, m);
}

export const knownModules = (): { id: string; name: string }[] => [...modules.values()].map((m) => ({ id: m.id, name: m.name }));
export const isActive = (id: string) => active.has(id);
/** Why a module that was asked to start did not (its error message), for the settings page. */
export const failureOf = (id: string) => failed.get(id);
/** The name to show for a module id, also for modules this build does not have. */
export const moduleName = (id: string) => modules.get(id)?.name ?? id;

function hostFor(provided: Provided): Host {
  return {
    registerDoc: (p) => void provided.docs.push(p),
    registerRecognizer: (r) => void provided.recognizers.push(r),
    registerSlot: (s) => void provided.slots.push(s),
    registerPage: (p) => void provided.pages.push(p),
    registerPlan: (p) => void provided.plans.push(p),
    onActiveRef: (cb) => {
      provided.refListeners.add(cb);
      return () => void provided.refListeners.delete(cb);
    },
  };
}

function start(m: Module) {
  const provided: Provided = { docs: [], recognizers: [], slots: [], pages: [], plans: [], refListeners: new Set() };
  try {
    m.activate(hostFor(provided));
    active.set(m.id, provided);
    failed.delete(m.id);
  } catch (e) {
    // a module that cannot start must not stop the app: leave it off and say why
    failed.set(m.id, e instanceof Error ? e.message : String(e));
    try {
      m.deactivate();
    } catch {
      /* nothing more to undo */
    }
  }
}

function stop(id: string) {
  const m = modules.get(id);
  active.delete(id);
  try {
    m?.deactivate();
  } catch {
    /* it is off either way */
  }
}

/** Run exactly the modules in `ids` (unknown ids are ignored, so a setting from another edition does no harm). */
export function setEnabled(ids: string[]) {
  const want = new Set(ids.filter((id) => modules.has(id)));
  let changed = false;
  for (const id of [...active.keys()]) {
    if (!want.has(id)) {
      stop(id);
      changed = true;
    }
  }
  for (const id of want) {
    if (!active.has(id)) {
      start(modules.get(id)!);
      changed = true;
    }
  }
  if (changed) bump();
}

const all = <K extends keyof Provided>(k: K): Provided[K] extends (infer T)[] ? T[] : never =>
  [...active.values()].flatMap((p) => p[k] as unknown[]) as never;

export const docProviders = (): DocProvider[] => all("docs");
export const recognizers = (): RefRecognizer[] => all("recognizers");
export const planProviders = (): PlanProvider[] => all("plans");
export const slotItems = (slot: SlotName): SlotItem[] => all("slots").filter((s: SlotItem) => s.slot === slot);
/** The provider that owns a document id (virtual documents have ids that start with the provider's prefix). */
export const pageItems = (): PageItem[] => all("pages");
/** The module that provides a document, by its id. */
export const moduleOfDoc = (docId: string): string | undefined => [...active].find(([, p]) => p.docs.some((d) => docId.startsWith(d.prefix)))?.[0];
export const docProvider = (id: string) => docProviders().find((d) => id.startsWith(d.prefix));

// ---- the reading position, passed on to modules at a calm pace

let lastSent = 0;
let pending: { ref: string; docId: string } | null = null;
let timer: number | undefined;
const GAP = 250;

function deliver(ref: string, docId: string) {
  lastSent = Date.now();
  for (const p of active.values()) {
    for (const cb of p.refListeners) {
      try {
        cb(ref, docId);
      } catch {
        /* one module's mistake stays its own */
      }
    }
  }
}

/** The reader calls this whenever the canonical position at the reading cursor changes. */
export function emitActiveRef(ref: string, docId: string) {
  if (!active.size) return;
  const wait = GAP - (Date.now() - lastSent);
  if (wait <= 0 && timer === undefined) return deliver(ref, docId);
  pending = { ref, docId };
  if (timer === undefined) {
    timer = window.setTimeout(() => {
      timer = undefined;
      if (pending) {
        const p = pending;
        pending = null;
        deliver(p.ref, p.docId);
      }
    }, Math.max(wait, 0));
  }
}

/** Re-renders a component when modules start, stop or change what they provide. */
export function useRegistry() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    () => version,
  );
}

/** For tests: forget everything. */
export function resetRegistry() {
  for (const id of [...active.keys()]) stop(id);
  modules.clear();
  failed.clear();
  pending = null;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  lastSent = 0;
  bump();
}
