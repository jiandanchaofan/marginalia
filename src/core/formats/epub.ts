import JSZip from "jszip";
import type { LoadedDoc, TocItem } from "../types";
import { flowDoc, sanitize, type FlowSection } from "./flow";
import { t } from "../../i18n";

const DC = "http://purl.org/dc/elements/1.1/";

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");

/** Resolve `href` relative to directory `base` inside the zip (handles ./ and ../, strips fragments). */
function resolvePath(base: string, href: string): { path: string; fragment?: string } {
  const [raw, fragment] = href.split("#");
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    path = raw;
  }
  const parts = (path.startsWith("/") ? path.slice(1) : base + path).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return { path: out.join("/"), fragment: fragment || undefined };
}

function parseXml(text: string, type: DOMParserSupportedType = "application/xhtml+xml"): Document {
  const doc = new DOMParser().parseFromString(text, type);
  if (doc.getElementsByTagName("parsererror").length && type !== "text/html") {
    return new DOMParser().parseFromString(text, "text/html");
  }
  return doc;
}

const byTag = (root: Document | Element, tag: string) => Array.from(root.getElementsByTagNameNS("*", tag));

export async function loadEpub(bytes: Uint8Array): Promise<LoadedDoc> {
  const zip = await JSZip.loadAsync(bytes);
  const read = (path: string) => {
    const f = zip.file(path) ?? zip.file(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"))[0];
    if (!f) throw new Error(t("err.epubMissing", { path }));
    return f;
  };

  const container = parseXml(await read("META-INF/container.xml").async("string"), "application/xml");
  const opfPath = byTag(container, "rootfile")[0]?.getAttribute("full-path");
  if (!opfPath) throw new Error(t("err.epubInvalid"));
  const opfDir = dirOf(opfPath);
  const opf = parseXml(await read(opfPath).async("string"), "application/xml");

  const title = opf.getElementsByTagNameNS(DC, "title")[0]?.textContent?.trim() || t("err.untitled");
  const author = Array.from(opf.getElementsByTagNameNS(DC, "creator"))
    .map((c) => c.textContent?.trim())
    .filter(Boolean)
    .join("、");

  const manifest = new Map<string, { href: string; type: string; props: string }>();
  for (const it of byTag(opf, "item")) {
    manifest.set(it.getAttribute("id") ?? "", {
      href: resolvePath(opfDir, it.getAttribute("href") ?? "").path,
      type: it.getAttribute("media-type") ?? "",
      props: it.getAttribute("properties") ?? "",
    });
  }
  const spineEl = byTag(opf, "spine")[0];
  const spine = byTag(opf, "itemref")
    .map((r) => manifest.get(r.getAttribute("idref") ?? ""))
    .filter((m): m is NonNullable<typeof m> => !!m && /html|xml/.test(m.type));
  const sectionOf = new Map(spine.map((m, i) => [m.href, i] as const));

  // Resources (images) become blob URLs on demand.
  const blobs = new Map<string, string>();
  const blobUrl = async (path: string) => {
    if (!blobs.has(path)) {
      const f = zip.file(path);
      if (!f) return null;
      const type = [...manifest.values()].find((m) => m.href === path)?.type || "application/octet-stream";
      blobs.set(path, URL.createObjectURL(new Blob([await f.async("arraybuffer")], { type })));
    }
    return blobs.get(path)!;
  };

  const sections: FlowSection[] = spine.map((item) => ({
    href: item.href,
    async lightRender() {
      const doc = parseXml(await read(item.href).async("string"));
      const body = doc.body ?? doc.getElementsByTagName("body")[0];
      return sanitize(body ? body.innerHTML : "");
    },
    async render() {
      const doc = parseXml(await read(item.href).async("string"));
      const body = doc.body ?? doc.getElementsByTagName("body")[0];
      const frag = sanitize(body ? body.innerHTML : "");
      const base = dirOf(item.href);
      const jobs: Promise<void>[] = [];
      frag.querySelectorAll("img[src]").forEach((img) => {
        const p = resolvePath(base, img.getAttribute("src")!).path;
        jobs.push(blobUrl(p).then((u) => (u ? img.setAttribute("src", u) : img.remove())));
        img.setAttribute("loading", "lazy");
      });
      frag.querySelectorAll("image").forEach((img) => {
        const href = img.getAttribute("href") ?? img.getAttributeNS("http://www.w3.org/1999/xlink", "href");
        if (!href) return;
        const p = resolvePath(base, href).path;
        jobs.push(
          blobUrl(p).then((u) => {
            if (u) {
              img.setAttribute("href", u);
              img.setAttributeNS("http://www.w3.org/1999/xlink", "href", u);
            }
          }),
        );
      });
      await Promise.all(jobs);
      return frag;
    },
  }));

  const linkTarget = (fromDir: string, href: string) => {
    const { path, fragment } = resolvePath(fromDir, href);
    const section = sectionOf.get(path);
    return section === undefined ? null : { section, fragment };
  };

  // Table of contents: EPUB 3 nav document, falling back to EPUB 2 NCX.
  let toc: TocItem[] = [];
  const navItem = [...manifest.values()].find((m) => m.props.split(/\s+/).includes("nav"));
  try {
    if (navItem) {
      const nav = parseXml(await read(navItem.href).async("string"));
      const navs = byTag(nav, "nav");
      const tocNav = navs.find((n) => (n.getAttribute("epub:type") ?? n.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? "").includes("toc")) ?? navs[0];
      const walk = (ol: Element | undefined): TocItem[] =>
        ol
          ? Array.from(ol.children)
              .filter((li) => li.localName === "li")
              .map((li) => {
                const a = Array.from(li.children).find((c) => c.localName === "a" || c.localName === "span");
                const t = a?.getAttribute("href") ? linkTarget(dirOf(navItem.href), a.getAttribute("href")!) : null;
                return {
                  label: a?.textContent?.trim().replace(/\s+/g, " ") ?? "",
                  section: t?.section ?? -1,
                  fragment: t?.fragment,
                  children: walk(Array.from(li.children).find((c) => c.localName === "ol")),
                };
              })
          : [];
      toc = walk(tocNav ? byTag(tocNav, "ol")[0] : undefined);
    }
    if (!toc.length) {
      const ncxItem = manifest.get(spineEl?.getAttribute("toc") ?? "") ?? [...manifest.values()].find((m) => m.type.includes("ncx"));
      if (ncxItem) {
        const ncx = parseXml(await read(ncxItem.href).async("string"), "application/xml");
        const walk = (parent: Element): TocItem[] =>
          Array.from(parent.children)
            .filter((c) => c.localName === "navPoint")
            .map((np) => {
              const src = byTag(np, "content")[0]?.getAttribute("src") ?? "";
              const t = linkTarget(dirOf(ncxItem.href), src);
              return {
                label: byTag(np, "text")[0]?.textContent?.trim() ?? "",
                section: t?.section ?? -1,
                fragment: t?.fragment,
                children: walk(np),
              };
            });
        const navMap = byTag(ncx, "navMap")[0];
        if (navMap) toc = walk(navMap);
      }
    }
  } catch {
    toc = [];
  }

  return flowDoc({
    format: "epub",
    title,
    author,
    toc,
    sections,
    resolveLink: (from, href) => linkTarget(dirOf(spine[from]?.href ?? ""), href),
    cleanup: () => blobs.forEach((u) => URL.revokeObjectURL(u)),
  });
}
