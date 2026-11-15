import { bookInfo } from "./books";

export const BIBLE_MODULE_ID = "org.marginalia.bible";
export const PREFIX = "bible:";

/** "bible:cuv-hans:JHN" -> translation and book. */
export function parseDocId(docId: string): { version: string; book: string } | null {
  const [, version, book] = docId.split(":");
  return version && book && bookInfo(book) ? { version, book } : null;
}
export const docIdOf = (version: string, book: string) => `${PREFIX}${version}:${book}`;
