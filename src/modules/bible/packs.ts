/**
 * The translations that come with the app, as scripture packs (see docs/bible-module-prep.md):
 * gzip-compressed JSON, loaded when first needed and kept for the rest of the session.
 */
import cuvHans from "./data/cuv-hans.json.gz?url";
import web from "./data/web.json.gz?url";

export interface Pack {
  format: string;
  id: string;
  name: string;
  lang: string;
  license: string;
  /** book id -> rows of [chapter, verse, verseEnd, text]; verse 0 is a heading some psalms carry. */
  books: Record<string, [number, number, number, string][]>;
}

export const BUNDLED: { id: string; name: string; lang: string; url: string }[] = [
  { id: "cuv-hans", name: "和合本（简体）", lang: "zh-Hans", url: cuvHans },
  { id: "web", name: "World English Bible", lang: "en", url: web },
];

const loaded = new Map<string, Promise<Pack>>();

/** A pack is gzip JSON on disk; some servers (the dev server) already undo the gzip on the way, so look at the bytes. */
async function readJson(res: Response): Promise<Pack> {
  if (!res.ok) throw new Error(`${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = gzipped ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text() : new TextDecoder().decode(bytes);
  return JSON.parse(text) as Pack;
}

export function loadPack(id: string): Promise<Pack> {
  let p = loaded.get(id);
  if (!p) {
    const src = BUNDLED.find((b) => b.id === id);
    if (!src) return Promise.reject(new Error(`unknown translation ${id}`));
    p = fetch(src.url).then(readJson);
    p.catch(() => loaded.delete(id));
    loaded.set(id, p);
  }
  return p;
}
