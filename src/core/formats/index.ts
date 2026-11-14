import type { BookFormat, LoadedDoc } from "../types";
import { t } from "../../i18n";

export const formatOf = (ext: string): BookFormat | null => {
  switch (ext.toLowerCase()) {
    case "epub":
      return "epub";
    case "pdf":
      return "pdf";
    case "txt":
      return "txt";
    case "md":
    case "markdown":
      return "md";
    case "html":
    case "htm":
      return "html";
    default:
      return null;
  }
};

export const ACCEPTED_EXTENSIONS = ["epub", "pdf", "txt", "md", "markdown", "html", "htm"];

/** Load any supported document. Parsers are code-split so startup stays fast. */
export async function loadDocument(bytes: Uint8Array, ext: string, fileName: string): Promise<LoadedDoc> {
  switch (formatOf(ext)) {
    case "epub":
      return (await import("./epub")).loadEpub(bytes);
    case "pdf":
      return (await import("./pdf")).loadPdf(bytes, fileName);
    case "txt":
      return (await import("./text")).loadTxt(bytes, fileName);
    case "md":
      return (await import("./text")).loadMarkdown(bytes, fileName);
    case "html":
      return (await import("./text")).loadHtml(bytes, fileName);
    default:
      throw new Error(t("err.unsupportedExt", { ext }));
  }
}
