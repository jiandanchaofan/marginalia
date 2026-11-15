import { bookInfo } from "./books";

export const BIBLE_MODULE_ID = "org.marginalia.bible";
export const PREFIX = "bible:";

/** "bible:cuv-hans:JHN" -> translation and book. */
export function parseDocId(docId: string): { version: string; book: string } | null {
  const [, version, book] = docId.split(":");
  return version && book && bookInfo(book) ? { version, book } : null;
}
const VERSION_KEY = "reader:bible:version";
/** The translation the person reads in (the one picked on the Bible page), as an id of a bundled pack. */
export function currentVersion(ids: string[] = ["cuv-hans", "web"]): string {
  try {
    const v = localStorage.getItem(VERSION_KEY);
    return v && ids.includes(v) ? v : ids[0];
  } catch {
    return ids[0];
  }
}
export const VERSION_STORAGE_KEY = VERSION_KEY;
export const docIdOf = (version: string, book: string) => `${PREFIX}${version}:${book}`;
