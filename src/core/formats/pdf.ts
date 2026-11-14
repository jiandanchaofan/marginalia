import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { LoadedDoc, MountOptions, TocItem } from "../types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;

/** Random access to a stored book: the PDF is read piece by piece instead of being moved into the page whole. */
export interface ByteSource {
  size: number;
  read(offset: number, len: number): Promise<Uint8Array>;
}

/** Hands pdf.js the byte ranges it asks for (xref at the end of the file, then the objects of the pages being shown). */
class SourceTransport extends pdfjs.PDFDataRangeTransport {
  constructor(private source: ByteSource, initial: Uint8Array) {
    super(source.size, initial);
  }
  requestDataRange(begin: number, end: number) {
    this.source.read(begin, end - begin).then(
      (chunk) => this.onDataRange(begin, chunk),
      (e) => console.warn("pdf range read failed", begin, end, e),
    );
  }
}

interface PageSlot {
  el: HTMLDivElement;
  w: number; // unscaled page size (pt)
  h: number;
  /** True once the real size of this page is known (until then it is a copy of page 1's size). */
  measured: boolean;
  state: "empty" | "rendering" | "ready";
  canvas?: HTMLCanvasElement;
  text?: HTMLDivElement;
  task?: { cancel(): void };
}

/** Pages rendered at the same time, and how far from the viewport finished pages are kept (canvases are big). */
const MAX_RENDERS = 3;
const KEEP_AWAY = 8;
const MAX_DPR = 2;

const baseParams = {
  cMapUrl: `${ASSETS}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${ASSETS}standard_fonts/`,
  wasmUrl: `${ASSETS}wasm/`,
};

/** Whole file in memory (small PDFs). */
export function loadPdf(bytes: Uint8Array, fileName: string): Promise<LoadedDoc> {
  // pdf.js transfers (detaches) the buffer to its worker — give it a copy so callers keep theirs.
  return build(pdfjs.getDocument({ ...baseParams, data: bytes.slice() }), fileName);
}

/** Large PDFs (hundreds of MB of scans): open instantly, fetch only what the visible pages need. */
export async function loadPdfRanged(source: ByteSource, fileName: string): Promise<LoadedDoc> {
  const first = await source.read(0, Math.min(source.size, 1 << 20));
  const transport = new SourceTransport(source, first);
  return build(pdfjs.getDocument({ ...baseParams, range: transport, rangeChunkSize: 1 << 20, disableAutoFetch: true, disableStream: true }), fileName);
}

async function build(loadingTask: ReturnType<typeof pdfjs.getDocument>, fileName: string): Promise<LoadedDoc> {
  const pdf: PDFDocumentProxy = await loadingTask.promise;

  const meta = await pdf.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as Record<string, string>;
  const title = info.Title?.trim() || fileName.replace(/\.pdf$/i, "");

  // Outline → TOC (page index as section).
  const toc: TocItem[] = [];
  try {
    const outline = await pdf.getOutline();
    const walk = async (items: typeof outline): Promise<TocItem[]> =>
      Promise.all(
        (items ?? []).map(async (it) => {
          let section = -1;
          try {
            const dest = typeof it.dest === "string" ? await pdf.getDestination(it.dest) : it.dest;
            if (dest && dest[0]) section = await pdf.getPageIndex(dest[0]);
          } catch {
            /* unresolved destination */
          }
          return { label: it.title, section, children: await walk(it.items) };
        }),
      );
    toc.push(...(await walk(outline)));
  } catch {
    /* no outline */
  }

  let slots: PageSlot[] = [];
  let width = 800;
  let observer: IntersectionObserver | null = null;
  let opts: MountOptions | null = null;
  let scroller: HTMLElement | null = null;
  const pages = new Map<number, PDFPageProxy>();
  const getPage = async (i: number) => {
    if (!pages.has(i)) pages.set(i, await pdf.getPage(i + 1));
    return pages.get(i)!;
  };

  const scaleFor = (s: PageSlot) => width / s.w;

  const sizeSlot = (s: PageSlot) => {
    const scale = scaleFor(s);
    s.el.style.width = `${Math.floor(s.w * scale)}px`;
    s.el.style.height = `${Math.floor(s.h * scale)}px`;
    s.el.style.setProperty("--total-scale-factor", String(scale));
    s.el.style.setProperty("--scale-factor", String(scale));
  };

  /** A page turned out to differ from page 1: resize it, and keep what the reader is looking at where it is. */
  const resizeSlot = (s: PageSlot, w: number, h: number) => {
    const before = s.el.offsetHeight;
    const above = !!scroller && s.el.getBoundingClientRect().bottom <= scroller.getBoundingClientRect().top;
    s.w = w;
    s.h = h;
    sizeSlot(s);
    const delta = s.el.offsetHeight - before;
    if (above && scroller && delta) scroller.scrollTop += delta;
  };

  const release = (s: PageSlot) => {
    s.task?.cancel();
    s.canvas?.remove();
    s.text?.remove();
    s.canvas = s.text = s.task = undefined;
    s.state = "empty";
  };

  // ---- render queue: visible pages first, a few at a time, work for pages that were scrolled past is dropped
  const wanted = new Set<number>();
  let active = 0;

  const centre = () => {
    if (!wanted.size) return 0;
    const v = [...wanted].sort((a, b) => a - b);
    return v[v.length >> 1];
  };

  const pump = () => {
    while (active < MAX_RENDERS) {
      const c = centre();
      let best = -1;
      for (const i of wanted) {
        if (slots[i]?.state !== "empty") continue;
        if (best < 0 || Math.abs(i - c) < Math.abs(best - c)) best = i;
      }
      if (best < 0) return;
      void render(best);
    }
  };

  const render = async (i: number) => {
    const s = slots[i];
    if (!s || s.state !== "empty") return;
    s.state = "rendering";
    active++;
    try {
      const page = await getPage(i);
      if (!s.measured) {
        // real size of this page (the others were assumed to match page 1)
        const vp1 = page.getViewport({ scale: 1 });
        s.measured = true;
        if (Math.abs(vp1.width - s.w) > 0.5 || Math.abs(vp1.height - s.h) > 0.5) resizeSlot(s, vp1.width, vp1.height);
      }
      if (s.state !== "rendering") return; // dropped while waiting (scrolled past)
      const scale = scaleFor(s);
      const viewport = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-canvas";
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      const text = document.createElement("div");
      text.className = "textLayer";
      text.dataset.section = String(i);
      s.el.append(canvas, text);
      s.canvas = canvas;
      s.text = text;

      const task = page.render({
        canvasContext: canvas.getContext("2d")!,
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      s.task = task;
      const layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
      await Promise.all([task.promise, layer.render()]);
      if (s.text !== text) return; // released meanwhile
      s.state = "ready";
      opts?.onSectionReady(i);
    } catch (err) {
      if ((err as Error)?.name !== "RenderingCancelledException") console.warn("pdf page render failed", i, err);
      if (s.state === "rendering") release(s);
    } finally {
      active--;
      pump();
    }
  };

  const observe = () => {
    observer?.disconnect();
    wanted.clear();
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) wanted.add(i);
          else {
            wanted.delete(i);
            // scrolled past before it finished: stop working on it
            if (slots[i]?.state === "rendering") release(slots[i]);
          }
        }
        // Free canvases far away from the viewport to bound memory on long PDFs.
        if (wanted.size) {
          const mid = centre();
          slots.forEach((s, i) => {
            if (s.state === "ready" && Math.abs(i - mid) > KEEP_AWAY) release(s);
          });
        }
        pump();
      },
      { rootMargin: "150% 0px" },
    );
    slots.forEach((s) => observer!.observe(s.el));
  };

  return {
    format: "pdf",
    title,
    author: info.Author?.trim() ?? "",
    toc,
    preferredWidth: 860,

    async mount(host, o) {
      opts = o;
      width = o.width;
      scroller = host.closest<HTMLElement>(".scroller");
      const first = await getPage(0);
      const base = first.getViewport({ scale: 1 });
      slots = [];
      for (let i = 0; i < pdf.numPages; i++) {
        const el = document.createElement("div");
        el.className = "pdf-page";
        el.dataset.page = String(i);
        el.style.setProperty("--scale-round-x", "1px");
        el.style.setProperty("--scale-round-y", "1px");
        const slot: PageSlot = { el, w: base.width, h: base.height, measured: i === 0, state: "empty" };
        slots.push(slot);
        sizeSlot(slot);
        host.appendChild(el);
      }
      // Other pages are assumed to match page 1 until they are drawn (scans are almost always uniform); a page that
      // differs is corrected when it is rendered. No background pass over every page: that would read the whole file.
      observe();
    },

    async relayout(w) {
      if (Math.abs(w - width) < 1) return;
      width = w;
      slots.forEach((s) => {
        release(s);
        sizeSlot(s);
      });
      observe();
    },

    /** The text of every page, line by line (for the book-text index). A scan has none: stop early rather than read every page. */
    async extractText() {
      const out: string[][] = [];
      let seen = 0;
      for (let i = 0; i < pdf.numPages; i++) {
        let lines: string[] = [];
        try {
          const page = await pdf.getPage(i + 1);
          const content = await page.getTextContent();
          let cur = "";
          for (const it of content.items) {
            if (!("str" in it)) continue;
            cur += it.str;
            if (it.hasEOL) (lines.push(cur), (cur = ""));
          }
          if (cur) lines.push(cur);
          page.cleanup();
        } catch {
          lines = [];
        }
        out.push(lines);
        seen += lines.reduce((n, l) => n + l.trim().length, 0);
        if (i === 19 && seen < 50) return Array.from({ length: pdf.numPages }, () => []);
        if (i % 5 === 4) await new Promise((r) => setTimeout(r, 0));
      }
      return out;
    },

    sectionRoot: (i) => slots[i]?.text ?? null,
    sectionCount: () => slots.length,
    locate: (i) => slots[i]?.el ?? null,

    destroy() {
      observer?.disconnect();
      wanted.clear();
      slots.forEach(release);
      slots = [];
      void loadingTask.destroy();
    },
  };
}
