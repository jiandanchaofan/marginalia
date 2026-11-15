import type { DocTocItem, Host, Module, TocNode, VirtualDoc } from "../../host/sdk";
import { BIBLE_BOOKS, bookInfo } from "./books";
import { BUNDLED, loadPack } from "./packs";
import { chapterHtml } from "./render";
import { BiblePage } from "./BiblePage";
import { recognizer } from "./refs";
import { BIBLE_MODULE_ID, PREFIX, docIdOf, parseDocId } from "./ids";
import "./bible.css";

export { BIBLE_MODULE_ID };

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

/** ["JHN.3.16", "JHN.3.17-18"] -> "JHN.3.16-18"; across chapters "JHN.3.36-JHN.4.2". */
export function joinRefs(refs: string[]): string {
  const parse = (r: string) => {
    const [book, c, v] = r.split(".");
    const [from, to] = v.split("-");
    return { book, c: +c, from: +from, to: +(to ?? from) };
  };
  const a = parse(refs[0]);
  const b = parse(refs[refs.length - 1]);
  const start = `${a.book}.${a.c}.${a.from}`;
  if (a.book === b.book && a.c === b.c) return b.to > a.from ? `${start}-${b.to}` : start;
  return `${start}-${b.book}.${b.c}.${b.to}`;
}

export const bibleModule: Module = {
  id: BIBLE_MODULE_ID,
  name: "圣经",
  activate(host: Host) {
    host.registerDoc({ prefix: PREFIX, toc: offered, open: openBook, joinRefs });
    host.registerRecognizer(recognizer);
    host.registerPage({ id: "bible", title: "圣经", component: BiblePage });
  },
  deactivate() {},
};
