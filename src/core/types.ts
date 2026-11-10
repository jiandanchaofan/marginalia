/** Data model. Annotations follow the W3C Web Annotation idea: several selectors that back each other up. */

export type HighlightStyle =
  | "highlight"
  | "marker"
  | "underline"
  | "double"
  | "wavy"
  | "dashed"
  | "dotted"
  | "emphasis"
  | "box"
  | "sidebar"
  | "strike"
  /** No mark in the text: a pure note anchored to the passage. */
  | "none";

export interface TextAnchor {
  /** Index of the section (EPUB spine item / PDF page / whole text doc = 0). */
  section: number;
  /** TextPositionSelector: character offsets inside the section's text. */
  start: number;
  end: number;
  /** TextQuoteSelector: exact text plus context, used to re-find the text when offsets drift. */
  exact: string;
  prefix: string;
  suffix: string;
}

export interface Annotation {
  id: string;
  anchor: TextAnchor;
  color: string; // palette key
  style: HighlightStyle;
  note: string;
  tags: string[];
  /** Margin chosen by the user. Only honoured when `sideLocked`; otherwise sides are auto-balanced. */
  side: "left" | "right";
  sideLocked?: boolean;
  /** "passage" (default) = anchored to selected text; "doc" = a note about the whole book / article; "free" = a standalone 随手记. */
  kind?: "passage" | "doc" | "free";
  /** Attached pictures (ids from `notes/images.ts`), shown under the note text. */
  images?: string[];
  createdAt: number;
  updatedAt: number;
}

export type ReadStatus = "want" | "reading" | "done";

export type BookFormat = "epub" | "pdf" | "txt" | "md" | "html";

export interface BookRecord {
  id: string; // sha-256 of the file
  ext: string; // stored extension
  format: BookFormat;
  title: string;
  author: string;
  fileName: string;
  size: number;
  addedAt: number;
  lastOpenedAt: number;
  progress: number; // 0..1
  annotationCount: number;
  /** Reading position that survives font/width changes: section + fraction through it. */
  location?: { section: number; ratio: number };
  /** Personal rating (1–5) and reading status; status falls back to a value derived from progress. */
  rating?: number;
  status?: ReadStatus;
  /** Reading interests ("基督教", "AI"…), the same vocabulary as the subscription sources. */
  interests?: string[];
  /** Web clippings: where the snapshot came from. */
  sourceUrl?: string;
  siteName?: string;
  publishedAt?: number;
  excerpt?: string;
  /** Set once the user renamed the item: holds the original title so it can be restored. */
  origTitle?: string;
  /** Free-text remark (附注) shown on the shelf. */
  remark?: string;
}

export interface TocItem {
  label: string;
  section: number;
  fragment?: string;
  children: TocItem[];
}

/** A loaded, renderable document. Everything renders into one continuously scrolling column. */
export interface LoadedDoc {
  format: BookFormat;
  title: string;
  author: string;
  toc: TocItem[];
  /** Ideal reading column width (px) — PDFs want wider columns than reflowable text. */
  preferredWidth: number;
  /** Render into `host`. `onSectionReady` fires whenever a section's text becomes available or re-laid out. */
  mount(host: HTMLElement, opts: MountOptions): Promise<void>;
  /** Re-layout after the column width changed (PDF re-scales; reflowable text needs nothing). */
  relayout?(width: number): Promise<void>;
  /** Section root elements whose text content is what anchors point into. */
  sectionRoot(index: number): HTMLElement | null;
  sectionCount(): number;
  /** Navigate to a section/fragment; returns the target element if found. */
  locate(section: number, fragment?: string): HTMLElement | null;
  destroy(): void;
}

export interface MountOptions {
  width: number;
  onSectionReady: (index: number) => void;
  onNavigate: (section: number, fragment?: string) => void;
}

/** Anchor used by whole-document notes: no position in the text. */
export const DOC_ANCHOR: TextAnchor = { section: -1, start: 0, end: 0, exact: "", prefix: "", suffix: "" };
export const isDocNote = (a: { kind?: string }) => a.kind === "doc";
/** Standalone notes ("随手记") are stored under this pseudo book id. */
export const FREE_BOOK = "_memo";
export const isFreeNote = (a: { kind?: string }) => a.kind === "free";

/** Status shown on the shelf: the user's choice, else derived from reading progress. */
export function readStatus(b: Pick<BookRecord, "status" | "progress">): ReadStatus | undefined {
  if (b.status) return b.status;
  if (b.progress >= 0.98) return "done";
  if (b.progress > 0.005) return "reading";
  return undefined;
}
export const STATUS_LABEL: Record<ReadStatus, string> = { want: "想读", reading: "在读", done: "读完" };
