/**
 * Covers for the shelf. An EPUB carries its cover picture; take it out, shrink it to shelf size and keep it
 * with the note pictures (see notes/images.ts). Books without a cover keep the generated coloured one.
 */
import JSZip from "jszip";
import { putImage } from "../notes/images";

const MAX_W = 360;
const MAX_H = 520;
const IMAGE_TYPES = /^image\/(jpeg|png|gif|webp)/;

const norm = (p: string) => {
  const out: string[] = [];
  for (const part of p.replace(/\\/g, "/").split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return out.join("/");
};
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (base: string, rel: string) => norm((base ? base + "/" : "") + decodeURIComponent(rel.split("#")[0]));

/** The cover picture inside an EPUB, or null. */
export async function epubCover(bytes: Uint8Array): Promise<Blob | null> {
  const zip = await JSZip.loadAsync(bytes);
  const text = async (path: string) => (await zip.file(path)?.async("string")) ?? null;
  const container = await text("META-INF/container.xml");
  const opfPath = container && new DOMParser().parseFromString(container, "application/xml").querySelector("rootfile")?.getAttribute("full-path");
  if (!opfPath) return null;
  const opfXml = await text(opfPath);
  if (!opfXml) return null;
  const opf = new DOMParser().parseFromString(opfXml, "application/xml");
  const dir = dirOf(opfPath);
  const items = [...opf.getElementsByTagName("item")].map((i) => ({ id: i.getAttribute("id") ?? "", href: i.getAttribute("href") ?? "", type: i.getAttribute("media-type") ?? "", props: i.getAttribute("properties") ?? "" }));
  const images = items.filter((i) => IMAGE_TYPES.test(i.type));
  const metaId = [...opf.getElementsByTagName("meta")].find((m) => m.getAttribute("name") === "cover")?.getAttribute("content");
  const pick =
    images.find((i) => i.props.split(/\s+/).includes("cover-image")) ??
    images.find((i) => i.id === metaId) ??
    images.find((i) => /cover/i.test(i.id) || /cover/i.test(i.href));
  if (!pick) return null;
  const file = zip.file(join(dir, pick.href));
  return file ? new Blob([await file.async("arraybuffer")], { type: pick.type }) : null;
}

/** Shrink to shelf size (a JPEG of at most MAX_W x MAX_H) and store it. Returns the picture id. */
export async function storeCover(blob: Blob): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(blob);
    if (bmp.width < 60 || bmp.height < 60) {
      bmp.close();
      return null; // a stray icon, not a cover
    }
    const scale = Math.min(1, MAX_W / bmp.width, MAX_H / bmp.height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff"; // transparent PNG covers get a white ground
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const jpg = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    return jpg ? await putImage(jpg) : null;
  } catch {
    return null;
  }
}
