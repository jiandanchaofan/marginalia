/**
 * First-paragraph extraction for the inbox.
 * Two layers: generic boilerplate rules (editor's notes, bylines, follow-us prompts…) and a
 * per-source repetition check — a paragraph that appears in many items of the same feed
 * (e.g. a donation appeal at the top of every post) is boilerplate by definition.
 */
import { Readability } from "@mozilla/readability";
import { fetchPage } from "../platform";
import { prepareDocument } from "../web/adapters";

const LEAD = /^(摘要|导读|导语|内容提要|提要|summary|tl;dr)\s*[:：]\s*/i;
const SKIP =
  /^[【\[（(〔]?\s*(编者按|编者提示|编按|编注|代祷启示|作者\s*[:：/]|文\s*[/|]|编译\s*[:：]|翻译\s*[:：]|译者\s*[:：]|来源\s*[:：]|出处\s*[:：]|发稿|责编|责任编辑|校对|审校|图\s*[:：]|图片(来源)?\s*[:：]|点击(上方|蓝字)|关注|长按|扫码|本文(转载|转自|摘自|首发|节选)|原文(链接|标题)|阅读原文|版权|©|copyright|subscribe|share this|photo\s*:|image\s*:|editor'?s note)/i;
const DATE_ONLY = /^[\p{L}\s./|-]{0,12}\d{4}[./年-]\d{1,2}[./月-]\d{1,2}日?[\s\p{L}./|:-]*$/u;
const MIN_LEN = 18;
/** A lone dek/subtitle is too thin to judge an article by: keep adding paragraphs up to this length. */
const TARGET_LEN = 60;
const MAX_LEN = 160;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const key = (s: string) => norm(s).slice(0, 40);

/** Visible paragraphs of an HTML fragment (falls back to line breaks when there are no <p>). */
export function paragraphs(html: string): string[] {
  if (!html.trim()) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, figure figcaption, noscript").forEach((n) => n.remove());
  let blocks = Array.from(doc.querySelectorAll("p, li, blockquote > div"))
    .filter((el) => !el.querySelector("p"))
    .map((el) => norm(el.textContent ?? ""));
  if (!blocks.filter(Boolean).length) {
    doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    blocks = (doc.body.textContent ?? "").split(/\n+/).map(norm);
  }
  return blocks.filter(Boolean);
}

/** Paragraphs that recur across ≥3 items and ≥30% of a source's items. */
export function boilerplate(perItem: string[][]): Set<string> {
  const counts = new Map<string, number>();
  for (const ps of perItem) new Set(ps.map(key)).forEach((k) => counts.set(k, (counts.get(k) ?? 0) + 1));
  const min = Math.max(3, Math.ceil(perItem.length * 0.3));
  return new Set([...counts].filter(([, n]) => n >= min).map(([k]) => k));
}

function clip(text: string) {
  if (text.length <= MAX_LEN) return text;
  const cut = text.slice(0, MAX_LEN);
  const end = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"), cut.lastIndexOf(". "));
  return end > MAX_LEN * 0.5 ? cut.slice(0, end + 1) : `${cut}…`;
}

const squash = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "");

export function firstParagraph(paras: string[], boiler: Set<string> = new Set(), title = ""): string {
  const t = squash(title);
  const usable = paras
    .filter((p) => !boiler.has(key(p)) && !SKIP.test(p) && !DATE_ONLY.test(p))
    .map((p) => norm(p.replace(LEAD, "").replace(/\s*\[(…|&#8230;|\.\.\.)\]\s*$/, "")))
    // A paragraph that just repeats the title (common at the top of WordPress posts) says nothing new.
    .filter((p) => p && !(t && (t.includes(squash(p)) || (squash(p).includes(t) && p.length < title.length + 12))));
  const start = usable.findIndex((p) => p.length >= MIN_LEN);
  if (start < 0) return clip(usable[0] ?? "");
  let out = usable[start];
  for (let i = start + 1; i < usable.length && out.length < TARGET_LEN && i <= start + 2; i++) out += ` ${usable[i]}`;
  return clip(out);
}

/** For feeds that only carry titles (e.g. WeChat 合集): fetch the article and take its first paragraph. */
export async function fetchSummary(url: string): Promise<string> {
  const page = await fetchPage(url);
  const doc = new DOMParser().parseFromString(page.html, "text/html");
  const base = doc.createElement("base");
  base.href = page.finalUrl;
  doc.head.prepend(base);
  prepareDocument(doc, page.finalUrl);
  const article = new Readability(doc).parse();
  return firstParagraph(paragraphs(article?.content ?? ""), new Set(), article?.title ?? "");
}
