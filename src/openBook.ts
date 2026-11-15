import type { LoadedDoc } from "./core/types";
import { formatOf, loadDocument } from "./core/formats";
import { bookSource, readBook } from "./platform";
import { isVirtualDoc, loadVirtualDoc } from "./host/virtualDoc";

/** PDFs at least this big are read page by page instead of being moved into the page whole. */
const RANGE_MIN = 16 << 20;

/** Open a stored book. Big PDFs open at once and only the pieces for the pages being shown are read. */
export async function openBook(book: { id: string; ext: string; fileName: string }): Promise<LoadedDoc> {
  if (isVirtualDoc(book.id)) return loadVirtualDoc(book.id);
  if (formatOf(book.ext) === "pdf") {
    const src = await bookSource(book.id, book.ext);
    if (src.size >= RANGE_MIN) return (await import("./core/formats/pdf")).loadPdfRanged(src, book.fileName);
  }
  return loadDocument(await readBook(book.id, book.ext), book.ext, book.fileName);
}
