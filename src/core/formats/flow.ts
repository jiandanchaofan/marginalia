import DOMPurify from "dompurify";
import type { BookFormat, LoadedDoc, MountOptions, TocItem } from "../types";

/** Sanitize untrusted book/web HTML into a fragment. Book stylesheets are dropped on purpose: the reader owns typography. */
export function sanitize(html: string): DocumentFragment {
  return DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["style", "link", "script", "iframe", "frame", "object", "embed", "form", "input", "button", "select", "textarea", "meta", "base"],
    FORBID_ATTR: ["style", "class", "width", "height", "align", "bgcolor", "color", "face"],
    ADD_ATTR: ["epub:type"],
  }) as DocumentFragment;
}

export interface FlowSection {
  /** Produce the section's content (may be async, e.g. reading from a zip). */
  render(): Promise<DocumentFragment>;
  /** Path/key used to resolve internal links to this section (EPUB). */
  href?: string;
}

export interface FlowSpec {
  format: BookFormat;
  title: string;
  author: string;
  toc: TocItem[];
  sections: FlowSection[];
  /** Map an <a href> inside section `from` to a target section + fragment. */
  resolveLink?(from: number, href: string): { section: number; fragment?: string } | null;
  cleanup?(): void;
}

/** A reflowable document rendered as one continuous column of <section> elements. */
export function flowDoc(spec: FlowSpec): LoadedDoc {
  let host: HTMLElement | null = null;
  let roots: HTMLElement[] = [];
  let destroyed = false;
  let onClick: ((e: MouseEvent) => void) | null = null;

  return {
    format: spec.format,
    title: spec.title,
    author: spec.author,
    toc: spec.toc,
    preferredWidth: 680,

    async mount(el: HTMLElement, opts: MountOptions) {
      host = el;
      roots = spec.sections.map((_, i) => {
        const s = document.createElement("section");
        s.className = "doc-section";
        s.dataset.section = String(i);
        el.appendChild(s);
        return s;
      });
      onClick = (e) => {
        const a = (e.target as Element).closest?.("a[href]") as HTMLAnchorElement | null;
        if (!a || !el.contains(a)) return;
        const href = a.getAttribute("href") ?? "";
        e.preventDefault();
        if (/^[a-z]+:/i.test(href)) {
          window.dispatchEvent(new CustomEvent("reader:external-link", { detail: href }));
          return;
        }
        const from = Number(a.closest<HTMLElement>("[data-section]")?.dataset.section ?? 0);
        const target = href.startsWith("#")
          ? { section: from, fragment: decodeURIComponent(href.slice(1)) }
          : spec.resolveLink?.(from, href);
        if (target) opts.onNavigate(target.section, target.fragment);
      };
      el.addEventListener("click", onClick);
      // Render sequentially so the first chapters appear immediately.
      for (let i = 0; i < spec.sections.length; i++) {
        if (destroyed) return;
        try {
          roots[i].appendChild(await spec.sections[i].render());
        } catch (err) {
          roots[i].innerHTML = `<p class="doc-error">本章节无法解析：${String(err)}</p>`;
        }
        opts.onSectionReady(i);
        if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
      }
    },

    sectionRoot: (i) => roots[i] ?? null,
    sectionCount: () => spec.sections.length,

    locate(section, fragment) {
      const root = roots[section];
      if (!root) return null;
      if (fragment) {
        const t = root.querySelector<HTMLElement>(`[id="${CSS.escape(fragment)}"], [name="${CSS.escape(fragment)}"]`);
        if (t) return t;
      }
      return root;
    },

    destroy() {
      destroyed = true;
      if (host && onClick) host.removeEventListener("click", onClick);
      host?.replaceChildren();
      spec.cleanup?.();
    },
  };
}

/** Collect h1–h3 into a flat TOC for single-section documents, assigning ids as needed. */
export function headingToc(frag: DocumentFragment, section = 0): TocItem[] {
  const items: TocItem[] = [];
  let n = 0;
  frag.querySelectorAll("h1, h2, h3").forEach((h) => {
    if (!h.id) h.id = `h-${section}-${n++}`;
    const label = h.textContent?.trim();
    if (label) items.push({ label, section, fragment: h.id, children: [] });
  });
  return items;
}
