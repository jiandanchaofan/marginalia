import { t } from "../i18n";
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
  /**
   * Region annotation (PDF pages without selectable text, or figures): a box on the page, as fractions
   * (0–1) of the page width / height so it follows zoom and resizing. `exact` is empty; `thumb` is the
   * picture of the boxed area (an id from `notes/images.ts`) that stands in for the quoted text.
   */
  region?: { x: number; y: number; w: number; h: number };
  thumb?: string;
  /**
   * Region on a picture inside a reflowing document (EPUB / web article / Markdown): which <img> of the section
   * (`index`, counted in document order) and its natural size (`key`, to notice if the book changed). The region
   * fractions then refer to that picture instead of a PDF page.
   */
  image?: { index: number; key: string };
  /** Colours of the dashed frame drawn around the region, chosen to contrast with the picture behind it (`c` = line, `h` = halo). */
  frame?: { c: string; h: string };
}

export const isRegionAnchor = (a: Pick<TextAnchor, "region">) => !!a.region;

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
  /** Where the note belongs in a shared text system (OSIS-style, e.g. "JHN.3.16"); empty / absent for ordinary notes. */
  canonicalRef?: string;
  /** Id of the module that wrote the note (e.g. "org.marginalia.bible"). Notes stay readable as plain cards without it. */
  sourceModule?: string;
  createdAt: number;
  updatedAt: number;
}

/** A relation between two notes (undirected), described in words. A note can have any number of them. */
export interface NoteLink {
  id: string;
  a: string; // note ids, a < b
  b: string;
  label: string;
  /** Colour of the line in the relation graph (palette key; empty = default). */
  color?: string;
  /** Line style in the relation graph (empty = solid). */
  style?: "" | "solid" | "dashed" | "dotted";
  /** Where the line leaves card `a` / card `b`: top, right, bottom or left ("" = automatic). */
  sideA?: "" | "t" | "r" | "b" | "l";
  sideB?: "" | "t" | "r" | "b" | "l";
  createdAt: number;
  updatedAt: number;
}

/** A task: either standalone, or a todo line of a note (`sourceNoteId`). */
export interface Task {
  id: string;
  title: string;
  /** Remarks (kept only in the task library). */
  note: string;
  done: boolean;
  doneAt: number | null;
  /** 0 = none, 1 = 低, 2 = 中, 3 = 高. */
  priority: number;
  /** Planned for a day / week / month / year, as written (`2026-11-20`, `2026-W47`, `2026-11`, `2026`); "" = not planned. */
  plan: string;
  planKind: "" | "day" | "week" | "month" | "year";
  /** First and last day of the planned period (YYYY-MM-DD). */
  planStart: string;
  planEnd: string;
  deadline: string;
  /** Own tags and the ones inherited from the note. */
  tags: string[];
  ownTags: string[];
  parentId: string | null;
  sort: number;
  sourceNoteId: string | null;
  /** The todo line as last seen in the note. */
  sourceLine: string;
  createdAt: number;
  updatedAt: number;
}

export interface GraphPos {
  noteId: string;
  x: number;
  y: number;
  /** Size of the card in the relation graph (0 / missing = default). */
  w?: number;
  h?: number;
}

export type ReadStatus ="want" | "reading" | "done";

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
  /** The user chose to keep this file in the cloud (cloud sync uploads it). */
  cloud?: boolean;
  /** Shelf cover: the id of a stored picture taken from the file. `coverTried` means there was none to take. */
  coverId?: string;
  coverTried?: boolean;
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
  /** The readable text, section by section and paragraph by paragraph (for the book-text index). Not every format has it. */
  extractText?(): Promise<string[][]>;
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
/** Reading-status names in the current language (getters, so every existing `STATUS_LABEL[s]` follows the language). */
export const STATUS_LABEL: Record<ReadStatus, string> = {
  get want() {
    return t("status.want");
  },
  get reading() {
    return t("status.reading");
  },
  get done() {
    return t("status.done");
  },
};

/**
 * A goal (目标) for a year or a month. Todos support goals (many to many, stored as links); a goal's progress is either
 * typed in by hand ("manual") or, for a month goal, the share of its supporting todos that are done ("auto").
 */
export interface Goal {
  id: string;
  title: string;
  /** What counts as reaching it, where things stand. */
  note: string;
  kind: "year" | "month";
  /** `2026` or `2026-11`. */
  period: string;
  /** A month goal may support one year goal. */
  parentId: string | null;
  status: "doing" | "done" | "missed" | "dropped";
  mode: "auto" | "manual";
  /** 0–100, used in manual mode. */
  percent: number;
  sort: number;
  closedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
