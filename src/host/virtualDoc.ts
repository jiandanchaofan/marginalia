import type { LoadedDoc } from "../core/types";
import { flowDoc } from "../core/formats/flow";
import { docProvider } from "./registry";

/** True when a module that is switched on owns this document id (so it is opened by the module, not from a file). */
export const isVirtualDoc = (id: string) => !!docProvider(id);

/** Open a document a module provides, as a reflowable document like an EPUB (chapters = sections). */
export async function loadVirtualDoc(docId: string): Promise<LoadedDoc> {
  const provider = docProvider(docId);
  if (!provider) throw new Error(docId);
  const v = await provider.open(docId);
  return flowDoc({
    format: "html",
    title: v.title,
    author: v.author ?? "",
    toc: v.toc.map(function item(x): LoadedDoc["toc"][number] {
      return { label: x.label, section: x.section, fragment: x.fragment, children: (x.children ?? []).map(item) };
    }),
    sections: Array.from({ length: v.sectionCount }, (_, i) => ({
      async render() {
        const c = await v.section(i);
        const t = document.createElement("template");
        t.innerHTML = c.html;
        return t.content;
      },
    })),
  });
}
