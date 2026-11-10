import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { LoadedDoc, MountOptions, TocItem } from "../types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const ASSETS = `${import.meta.env.BASE_URL}pdfjs/`;

interface PageSlot {
  el: HTMLDivElement;
  w: number; // unscaled page size (pt)
  h: number;
  state: "empty" | "rendering" | "ready";
  canvas?: HTMLCanvasElement;
  text?: HTMLDivElement;
  task?: { cancel(): void };
}

export async function loadPdf(bytes: Uint8Array, fileName: string): Promise<LoadedDoc> {
  const loadingTask = pdfjs.getDocument({
    // pdf.js transfers (detaches) the buffer to its worker — give it a copy so callers keep theirs.
    data: bytes.slice(),
    cMapUrl: `${ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
  });
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

  const release = (s: PageSlot) => {
    s.task?.cancel();
    s.canvas?.remove();
    s.text?.remove();
    s.canvas = s.text = s.task = undefined;
    s.state = "empty";
  };

  const render = async (i: number) => {
    const s = slots[i];
    if (!s || s.state !== "empty") return;
    s.state = "rendering";
    try {
      const page = await getPage(i);
      const scale = scaleFor(s);
      const viewport = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
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
    }
  };

  const observe = () => {
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number((e.target as HTMLElement).dataset.page);
          if (e.isIntersecting) render(i);
        }
        // Free canvases far away from the viewport to bound memory on long PDFs.
        const visible = entries.filter((e) => e.isIntersecting).map((e) => Number((e.target as HTMLElement).dataset.page));
        if (visible.length) {
          const mid = visible[0];
          slots.forEach((s, i) => {
            if (s.state === "ready" && Math.abs(i - mid) > 12) release(s);
          });
        }
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
      const first = await getPage(0);
      const base = first.getViewport({ scale: 1 });
      slots = [];
      for (let i = 0; i < pdf.numPages; i++) {
        const el = document.createElement("div");
        el.className = "pdf-page";
        el.dataset.page = String(i);
        el.style.setProperty("--scale-round-x", "1px");
        el.style.setProperty("--scale-round-y", "1px");
        const slot: PageSlot = { el, w: base.width, h: base.height, state: "empty" };
        slots.push(slot);
        sizeSlot(slot);
        host.appendChild(el);
      }
      // Correct the size of pages whose dimensions differ from page 1, in the background.
      (async () => {
        for (let i = 1; i < pdf.numPages && slots.length; i++) {
          const vp = (await getPage(i)).getViewport({ scale: 1 });
          const s = slots[i];
          if (s && (vp.width !== s.w || vp.height !== s.h)) {
            s.w = vp.width;
            s.h = vp.height;
            sizeSlot(s);
          }
        }
      })().catch(() => {});
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

    sectionRoot: (i) => slots[i]?.text ?? null,
    sectionCount: () => slots.length,
    locate: (i) => slots[i]?.el ?? null,

    destroy() {
      observer?.disconnect();
      slots.forEach(release);
      slots = [];
      void loadingTask.destroy();
    },
  };
}
