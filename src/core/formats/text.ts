import MarkdownIt from "markdown-it";
import { Readability } from "@mozilla/readability";
import type { LoadedDoc, TocItem } from "../types";
import { flowDoc, headingToc, sanitize, type FlowSection } from "./flow";

/** Decode text, falling back to GB18030 for the many legacy Chinese .txt files. */
export function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  const bad = (utf8.match(/�/g) ?? []).length;
  if (bad > 4 && bad / utf8.length > 0.001) {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      /* fall through */
    }
  }
  return utf8.replace(/^﻿/, "");
}

const stripExt = (name: string) => name.replace(/\.[^.]+$/, "");

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const CHAPTER = /^\s*(第[0-9０-９零〇一二三四五六七八九十百千万两]+[章节回卷集部篇幕]|序章|序言|楔子|尾声|后记|番外|Chapter\s+\d+|CHAPTER\s+\d+|Prologue|Epilogue)(\s|：|:|$).{0,40}$/;

export function loadTxt(bytes: Uint8Array, fileName: string): LoadedDoc {
  const text = decodeText(bytes).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  type Chunk = { title: string | null; lines: string[] };
  const chunks: Chunk[] = [{ title: null, lines: [] }];
  for (const line of lines) {
    if (CHAPTER.test(line) && line.trim().length <= 50) chunks.push({ title: line.trim(), lines: [] });
    else chunks[chunks.length - 1].lines.push(line);
  }
  if (!chunks[0].lines.some((l) => l.trim())) chunks.shift();

  const toc: TocItem[] = [];
  const sections: FlowSection[] = chunks.map((c, i) => {
    if (c.title) toc.push({ label: c.title, section: i, fragment: `ch-${i}`, children: [] });
    return {
      async render() {
        const html =
          (c.title ? `<h2 id="ch-${i}">${escapeHtml(c.title)}</h2>` : "") +
          c.lines
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => `<p>${escapeHtml(l)}</p>`)
            .join("");
        return sanitize(html);
      },
    };
  });
  return flowDoc({ format: "txt", title: stripExt(fileName), author: "", toc, sections });
}

export function loadMarkdown(bytes: Uint8Array, fileName: string): LoadedDoc {
  const src = decodeText(bytes);
  const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
  const frag = sanitize(md.render(src));
  const toc = headingToc(frag);
  const h1 = frag.querySelector("h1")?.textContent?.trim();
  return flowDoc({
    format: "md",
    title: h1 || stripExt(fileName),
    author: "",
    toc,
    sections: [{ render: async () => frag }],
  });
}

/** A web clipping saved by 墨边 (see src/web/clip.ts): already clean, carries its metadata. */
function loadSnapshot(doc: Document, fileName: string): LoadedDoc {
  const meta = (k: string) => doc.querySelector(`meta[name="marginalia:${k}"]`)?.getAttribute("content") ?? "";
  const title = doc.title || stripExt(fileName);
  const frag = sanitize((doc.querySelector("article") ?? doc.body).innerHTML);
  // Readability often keeps the article's own title heading; drop it when it duplicates the masthead.
  const first = frag.querySelector("h1, h2");
  if (first && first.textContent?.trim() === title.trim()) first.remove();
  const toc = headingToc(frag);

  // Masthead: outside the anchor text space (data-anchor-ignore) so notes never depend on it.
  const header = document.createElement("header");
  header.className = "article-meta";
  header.dataset.anchorIgnore = "";
  const site = document.createElement("div");
  site.className = "article-site";
  site.textContent = meta("site");
  const h = document.createElement("h1");
  h.className = "article-title";
  h.textContent = title;
  const by = document.createElement("div");
  by.className = "article-byline";
  const published = Date.parse(meta("published"));
  const parts = [meta("author"), Number.isNaN(published) ? "" : new Date(published).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" })].filter(Boolean);
  by.textContent = parts.join(" · ");
  const source = meta("source");
  if (source) {
    const a = document.createElement("a");
    a.href = source;
    a.textContent = "查看原网页";
    by.append(parts.length ? " · " : "", a);
  }
  header.append(site, h, by);
  frag.prepend(header);

  return flowDoc({ format: "html", title, author: meta("author"), toc, sections: [{ render: async () => frag }] });
}

/** Local or saved web pages: extract the readable article with Mozilla Readability. */
export function loadHtml(bytes: Uint8Array, fileName: string): LoadedDoc {
  const src = decodeText(bytes);
  const doc = new DOMParser().parseFromString(src, "text/html");
  if (doc.querySelector('meta[name="marginalia:source"]')) return loadSnapshot(doc, fileName);
  const article = new Readability(doc.cloneNode(true) as Document).parse();
  const frag = sanitize(article?.content ?? doc.body?.innerHTML ?? "");
  // Strip images that point to the network-relative paths we can't resolve.
  frag.querySelectorAll("img").forEach((img) => {
    const s = img.getAttribute("src") ?? "";
    if (!/^(https?:|data:)/.test(s)) img.remove();
  });
  return flowDoc({
    format: "html",
    title: article?.title || doc.title || stripExt(fileName),
    author: article?.byline ?? "",
    toc: headingToc(frag),
    sections: [{ render: async () => frag }],
  });
}
