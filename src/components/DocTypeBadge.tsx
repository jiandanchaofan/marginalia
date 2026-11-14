import type { BookRecord } from "../core/types";
import { t } from "../i18n";

export type DocType = "pdf" | "epub" | "md" | "txt" | "web";

/** Web clippings count as 网页 whatever their stored format. */
export const docType = (b: Pick<BookRecord, "format" | "sourceUrl">): DocType => (b.sourceUrl ? "web" : b.format === "html" ? "web" : b.format);

/**
 * One colour per document type (cover gradient) plus its logo glyph.
 * Hues are spread around the wheel and all carry white text well: plum, amber, blue, graphite, teal.
 */
export const DOC_TYPES: Record<DocType, { label: string; from: string; to: string }> = {
  pdf: { label: "PDF", from: "#7d5d8a", to: "#47314f" },
  epub: { label: "EPUB", from: "#c08a2c", to: "#7a4f14" },
  md: { label: "Markdown", from: "#3f78bd", to: "#234777" },
  txt: { label: "TXT", from: "#707684", to: "#424856" },
  web: {
    get label() {
      return t("doctype.web");
    },
    from: "#2a8f93",
    to: "#185766",
  },
};

const PAGE = "M6.5 2.5h7.8l4.2 4.2v13.8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z";
const FOLD = "M14.3 2.5v4.2h4.2";

/** Line glyphs (24×24) for the non-PDF types. */
const GLYPH: Record<Exclude<DocType, "pdf">, React.ReactNode> = {
  epub: <path d="M12 6.6C10.3 5.2 7.7 4.7 3.8 5v12.6c3.9-.3 6.5.2 8.2 1.6m0-12.6c1.7-1.4 4.3-1.9 8.2-1.6v12.6c-3.9-.3-6.5.2-8.2 1.6m0-12.6v12.6" />,
  md: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2.2" />
      <path d="M6 15V9l2.5 3L11 9v6" />
      <path d="M16.2 9v6m0 0-2-2m2 2 2-2" />
    </>
  ),
  txt: (
    <>
      <path d={PAGE} />
      <path d={FOLD} />
      <path d="M8.6 12.2h7M8.6 15.2h7M8.6 18.2h4.4" />
    </>
  ),
  web: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z" />
    </>
  ),
};

/**
 * The classic PDF document icon: Font Awesome Free 6.5.2 "file-pdf" (solid), Icons: CC BY 4.0, (c) Fonticons, Inc.
 * https://fontawesome.com/license/free — also kept as src/assets/icons/file-pdf.svg with a NOTICE.
 */
const PDF_ICON_PATH =
  "M0 64C0 28.7 28.7 0 64 0L224 0l0 128c0 17.7 14.3 32 32 32l128 0 0 144-208 0c-35.3 0-64 28.7-64 64l0 144-48 0c-35.3 0-64-28.7-64-64L0 64zm384 64l-128 0L256 0 384 128zM176 352l32 0c30.9 0 56 25.1 56 56s-25.1 56-56 56l-16 0 0 32c0 8.8-7.2 16-16 16s-16-7.2-16-16l0-48 0-80c0-8.8 7.2-16 16-16zm32 80c13.3 0 24-10.7 24-24s-10.7-24-24-24l-16 0 0 48 16 0zm96-80l32 0c26.5 0 48 21.5 48 48l0 64c0 26.5-21.5 48-48 48l-32 0c-8.8 0-16-7.2-16-16l0-128c0-8.8 7.2-16 16-16zm32 128c8.8 0 16-7.2 16-16l0-64c0-8.8-7.2-16-16-16l-16 0 0 96 16 0zm80-112c0-8.8 7.2-16 16-16l48 0c8.8 0 16 7.2 16 16s-7.2 16-16 16l-32 0 0 32 32 0c8.8 0 16 7.2 16 16s-7.2 16-16 16l-32 0 0 48c0 8.8-7.2 16-16 16s-16-7.2-16-16l0-64 0-64z";

/** Logo badge for the top-right corner of a cover. */
export function DocTypeBadge({ type, inline, size = 19 }: { type: DocType; inline?: boolean; size?: number }) {
  return (
    <span className={`type-badge t-${type} ${inline ? "inline" : ""}`} title={DOC_TYPES[type].label}>
      {type === "pdf" ? (
        <svg viewBox="0 0 512 512" width={size} height={size} fill="currentColor" aria-hidden>
          <path d={PDF_ICON_PATH} />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          {GLYPH[type]}
        </svg>
      )}
    </span>
  );
}
