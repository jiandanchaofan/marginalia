/**
 * Platform bridge. Tauri (desktop/mobile) talks to the Rust commands; a plain browser
 * (`npm run dev` in Chrome) falls back to memory + localStorage so the UI can be iterated quickly.
 */
import type { BookRecord } from "./core/types";
import { ACCEPTED_EXTENSIONS } from "./core/formats";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface ImportedBook {
  id: string;
  ext: string;
  fileName: string;
  size: number;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// ---------- browser fallback ----------
const memBooks = new Map<string, Uint8Array>();
const ls = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, v: string) {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* storage unavailable */
    }
  },
};

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const extOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

// ---------- data files ----------
async function readData(rel: string): Promise<string | null> {
  return isTauri ? invoke<string | null>("read_data", { rel }) : ls.get(`reader:${rel}`);
}
async function writeData(rel: string, content: string): Promise<void> {
  if (isTauri) await invoke("write_data", { rel, content });
  else ls.set(`reader:${rel}`, content);
}

export async function loadJson<T>(rel: string, fallback: T): Promise<T> {
  try {
    const raw = await readData(rel);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
export const saveJson = (rel: string, value: unknown) => writeData(rel, JSON.stringify(value, null, 1));

export async function loadLibrary(): Promise<BookRecord[]> {
  try {
    return JSON.parse((await readData("library.json")) ?? "[]");
  } catch {
    return [];
  }
}
export const saveLibrary = (books: BookRecord[]) => writeData("library.json", JSON.stringify(books, null, 1));

// ---------- books ----------
export async function importPath(path: string): Promise<ImportedBook> {
  return invoke<ImportedBook>("import_book", { path });
}

export async function importBrowserFile(file: File): Promise<ImportedBook> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const id = await sha256(bytes);
  const ext = extOf(file.name);
  memBooks.set(`${id}.${ext}`, bytes);
  return { id, ext, fileName: file.name, size: bytes.length };
}

export async function readBook(id: string, ext: string): Promise<Uint8Array> {
  if (isTauri) return new Uint8Array(await invoke<ArrayBuffer>("read_book", { id, ext }));
  const b = memBooks.get(`${id}.${ext}`);
  if (!b) throw new Error("浏览器预览模式下，书籍只保存在本次会话中，请重新导入。");
  return b;
}

export async function deleteBook(id: string, ext: string) {
  if (isTauri) await invoke("delete_book", { id, ext });
  else memBooks.delete(`${id}.${ext}`);
}

// ---------- web clipping ----------
const needsDesktop = () => new Error("网页剪藏需要在墨边桌面应用中使用（浏览器预览模式无法跨站抓取）。");

export async function fetchPage(url: string): Promise<{ finalUrl: string; html: string }> {
  if (!isTauri) throw needsDesktop();
  return invoke("fetch_page", { url });
}
export async function fetchImage(url: string, referer?: string): Promise<string> {
  if (!isTauri) throw needsDesktop();
  return invoke("fetch_image", { url, referer: referer ?? null });
}
export async function articleLookup(url: string): Promise<string | null> {
  return isTauri ? invoke<string | null>("article_lookup", { url }) : null;
}
export interface SavedArticle extends ImportedBook {
  existed: boolean;
}
export async function saveArticle(url: string, html: string): Promise<SavedArticle> {
  if (!isTauri) throw needsDesktop();
  return invoke("save_article", { url, html });
}
/** `marginalia://clip?url=…` from the browser bookmarklet: at launch, and while running. */
export async function listenForClips(onUrl: (url: string) => void) {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const startup = await invoke<string | null>("startup_clip");
  if (startup) onUrl(startup);
  return listen<string>("clip-url", (e) => onUrl(e.payload));
}

/** Native open dialog → list of paths (Tauri) or File objects (browser). */
export async function pickFiles(): Promise<(string | File)[]> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const res = await open({
      multiple: true,
      filters: [{ name: "文档", extensions: ACCEPTED_EXTENSIONS }],
    });
    return res ? (Array.isArray(res) ? res : [res]) : [];
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(",");
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

export async function confirmDialog(message: string): Promise<boolean> {
  if (isTauri) {
    const { confirm } = await import("@tauri-apps/plugin-dialog");
    return confirm(message, { title: "墨边", kind: "warning", okLabel: "确定", cancelLabel: "取消" });
  }
  return window.confirm(message);
}

export async function exportTextFile(defaultName: string, content: string, imageIds: string[] = []) {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: defaultName, filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (path) {
      await invoke("export_text", { path, content });
      if (imageIds.length) await invoke("export_images", { mdPath: path, ids: imageIds });
    }
    return !!path;
  }
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: defaultName });
  a.click();
  URL.revokeObjectURL(url);
  if (imageIds.length) {
    // Browser preview: no folder access, so the pictures download next to the .md (put them in an `attachments` folder).
    const { getImage } = await import("./notes/images");
    for (const id of imageIds) {
      const link = Object.assign(document.createElement("a"), { href: await getImage(id), download: id });
      link.click();
    }
  }
  return true;
}

let webWindows = 0;
/** Show a web page inside the app (its own window) instead of handing it to the system browser. */
export async function openWebWindow(url: string, title = "原始网页") {
  if (!isTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const w = new WebviewWindow(`web-${Date.now()}-${webWindows++}`, { url, title: `${title} · 墨边`, width: 1120, height: 860, center: true });
  w.once("tauri://error", (e) => console.error("web window failed", e));
}

export async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener");
}

/** Files to open: startup argument, second-instance/file-association events and drag-and-drop. */
export async function listenForFiles(onPaths: (paths: string[]) => void, onDragState: (over: boolean) => void) {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const startup = await invoke<string | null>("startup_file");
  if (startup) onPaths([startup]);
  const un1 = await listen<string>("open-file", (e) => onPaths([e.payload]));
  const un2 = await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") onDragState(true);
    else if (p.type === "leave") onDragState(false);
    else if (p.type === "drop") {
      onDragState(false);
      onPaths(p.paths.filter((x) => ACCEPTED_EXTENSIONS.includes(extOf(x))));
    }
  });
  return () => {
    un1();
    un2();
  };
}

export const settingsStore = {
  load<T>(fallback: T): T {
    try {
      return { ...fallback, ...JSON.parse(ls.get("reader:settings") ?? "{}") };
    } catch {
      return fallback;
    }
  },
  save(v: unknown) {
    ls.set("reader:settings", JSON.stringify(v));
  },
};

// ---------- backups (desktop only) ----------
export interface BackupConfig {
  dbDir?: string | null;
  mdDir?: string | null;
  mdEnabled: boolean;
}
export interface BackupStatus {
  config: BackupConfig;
  dbDir: string;
  mdDir: string;
  defaultDbDir: string;
  defaultMdDir: string;
  /** `YYYY-MM-DD` of the newest database backup. */
  dbLast: string | null;
  dbCount: number;
  /** `YYYY-MM-DD_HHMMSS` of the newest Markdown backup. */
  mdLast: string | null;
  mdCount: number;
}

export const backupApi = {
  available: isTauri,
  status: () => invoke<BackupStatus>("backup_status"),
  setConfig: (config: BackupConfig) => invoke<BackupStatus>("backup_config_set", { config }),
  dbNow: () => invoke<BackupStatus>("backup_db_now"),
  mdWrite: (content: string, ids: string[]) => invoke<BackupStatus>("backup_md_write", { content, ids }),
  openDir: (path: string) => invoke<void>("open_dir", { path }),
  async pickDir(title: string): Promise<string | null> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const res = await open({ directory: true, multiple: false, title });
    return typeof res === "string" ? res : null;
  },
};

export async function appVersion(): Promise<string> {
  if (!isTauri) return "网页预览";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

/** Browser-style zoom of the whole window (desktop). Layout, text, PDF pages and overlay geometry all scale together. */
export async function setViewZoom(factor: number) {
  if (!isTauri) return;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(factor);
  } catch (e) {
    console.warn("zoom failed", e);
  }
}
