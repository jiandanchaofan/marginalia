import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

/** A LaTeX formula, drawn by KaTeX. A formula it cannot read is shown as its source, in red, instead of breaking the note. */
export function Tex({ tex, display = false }: { tex: string; display?: boolean }) {
  const html = useMemo(() => {
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: true, output: "html", trust: false, strict: "ignore" });
    } catch {
      return null;
    }
  }, [tex, display]);
  const Tag = display ? "div" : "span";
  if (html === null) {
    return (
      <Tag className={`math-error ${display ? "display" : ""}`} title="LaTeX">
        {display ? `$$${tex}$$` : `$${tex}$`}
      </Tag>
    );
  }
  return <Tag className={`math ${display ? "display" : ""}`} onMouseDown={(e) => e.stopPropagation()} dangerouslySetInnerHTML={{ __html: html }} />;
}
