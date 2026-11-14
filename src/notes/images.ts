/**
 * Pictures in notes. Desktop: saved as content-addressed files by the Rust side (`image_put` / `image_get`).
 * Plain browser (`npm run dev`): kept in localStorage so the UI still works.
 */
import { useEffect, useState } from "react";
import { isTauri } from "../platform";
import { t } from "../i18n";

export const MAX_IMAGES = 9;
const MAX_SIDE = 2000;
const LS = "reader:img:";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const readAsDataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

/** Screenshots can be 4K+; shrink anything wider/taller than MAX_SIDE (PNG stays PNG, photos become JPEG). */
async function shrink(file: Blob): Promise<{ blob: Blob; ext: string }> {
  const type = file.type;
  const ext = type === "image/png" ? "png" : type === "image/gif" ? "gif" : type === "image/webp" ? "webp" : type === "image/bmp" ? "bmp" : "jpg";
  if (type === "image/gif") return { blob: file, ext }; // keep animation
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1) {
      bmp.close();
      return { blob: file, ext };
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const outType = ext === "png" ? "image/png" : "image/jpeg";
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, outType, 0.9));
    return blob ? { blob, ext: ext === "png" ? "png" : "jpg" } : { blob: file, ext };
  } catch {
    return { blob: file, ext };
  }
}

const cache = new Map<string, Promise<string>>();

/** Store a picture and return its id. */
export async function putImage(file: Blob): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error(t("err.notImage"));
  const { blob, ext } = await shrink(file);
  const url = await readAsDataUrl(blob);
  let id: string;
  if (isTauri) {
    id = await invoke<string>("image_put", { data: url.slice(url.indexOf(",") + 1), ext });
  } else {
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    id = `${[...new Uint8Array(hash)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("")}.${ext}`;
    try {
      localStorage.setItem(LS + id, url);
    } catch {
      throw new Error(t("err.storageFull"));
    }
  }
  cache.set(id, Promise.resolve(url));
  return id;
}

/** The picture as a `data:` URI (cached). */
export function getImage(id: string): Promise<string> {
  let p = cache.get(id);
  if (!p) {
    p = isTauri
      ? invoke<string>("image_get", { id })
      : new Promise<string>((resolve, reject) => {
          const v = localStorage.getItem(LS + id);
          v ? resolve(v) : reject(new Error(t("err.imageMissing")));
        });
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

export function useImage(id: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);
    getImage(id).then((u) => alive && setUrl(u), () => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [id]);
  return { url, failed };
}

/** Open the system picture chooser. */
export function pickImageFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export const imagesIn = (data: DataTransfer | null): File[] => [...(data?.files ?? [])].filter((f) => f.type.startsWith("image/"));
