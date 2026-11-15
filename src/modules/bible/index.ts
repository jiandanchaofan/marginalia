import type { DocTocItem, Host, Module, TocNode, VirtualDoc } from "../../host/sdk";
import { BIBLE_BOOKS, bookInfo } from "./books";
import { BUNDLED, loadPack } from "./packs";
import { chapterHtml } from "./render";
import "./bible.css";

export const BIBLE_MODULE_ID = "org.marginalia.bible";
const PREFIX = "bible:";

/** "bible:cuv-hans:JHN" -> translation and book. */
export function parseDocId(docId: string): { version: string; book: string } | null {
  const [, version, book] = docId.split(":");
  return version && book && bookInfo(book) ? { version, book } : null;
}
export const docIdOf = (version: string, book: string) => `${PREFIX}${version}:${book}`;

async function openBook(docId: string): Promise<VirtualDoc> {
  const id = parseDocId(docId);
  if (!id) throw new Error(docId);
  const pack = await loadPack(id.version);
  const info = bookInfo(id.book)!;
  const rows = pack.books[id.book] ?? [];
  const zh = pack.lang.startsWith("zh");
  const toc: DocTocItem[] = Array.from({ length: info.chapters }, (_, i) => ({ label: zh ? `第 ${i + 1} 章` : `Chapter ${i + 1}`, section: i, fragment: `ch${i + 1}` }));
  return {
    title: zh ? info.zh : info.en,
    author: pack.name,
    toc,
    sectionCount: info.chapters,
    section: async (i) => ({ html: chapterHtml(id.book, i + 1, rows, pack.lang), ref: `${id.book}.${i + 1}` }),
  };
}

async function offered(): Promise<TocNode[]> {
  const version = BUNDLED[0].id;
  const book = (b: (typeof BIBLE_BOOKS)[number]): TocNode => ({ id: docIdOf(version, b.id), title: b.zh, leaf: true });
  return [
    { id: "OT", title: "旧约", children: BIBLE_BOOKS.filter((b) => b.ot).map(book) },
    { id: "NT", title: "新约", children: BIBLE_BOOKS.filter((b) => !b.ot).map(book) },
  ];
}

export const bibleModule: Module = {
  id: BIBLE_MODULE_ID,
  name: "圣经",
  activate(host: Host) {
    host.registerDoc({ prefix: PREFIX, toc: offered, open: openBook });
  },
  deactivate() {},
};
