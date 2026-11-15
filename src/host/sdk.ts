/**
 * What a module may use of the app, and what it hands back. Everything that crosses this line is plain data
 * (JSON): no stores, no components of the reader, no DOM nodes of the host. That keeps the door open for running
 * modules apart from the app one day; today they are built in and switched on in settings.
 *
 * A module is `{ id, name, activate(host), deactivate() }` (see registry.ts). `activate` receives a `Host` and
 * registers what the module provides; `deactivate` takes it all back.
 */
import type { ComponentType } from "react";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------- documents that are not files

/** One entry of a contents tree. `id` is the module's own address of the entry (e.g. "JHN" or "JHN.3"). */
export interface TocNode {
  id: string;
  title: string;
  children?: TocNode[];
  /** True for entries that open a page of text (a chapter); false for groups (a book, a testament). */
  leaf?: boolean;
}

/** One page of text of a virtual document, as HTML the reader renders like any other chapter. */
export interface SectionContent {
  html: string;
  title?: string;
  /** Canonical position of the whole page, e.g. "JHN.3" (notes made on it carry refs inside it). */
  ref?: string;
}

/** An entry of the contents list of one open document (a chapter, a part). */
export interface DocTocItem {
  label: string;
  /** Index of the section (page of text) it leads to, and optionally an element id inside it. */
  section: number;
  fragment?: string;
  children?: DocTocItem[];
}

/** One document as the reader shows it: a title, a contents list and sections made on demand. */
export interface VirtualDoc {
  title: string;
  author?: string;
  toc: DocTocItem[];
  sectionCount: number;
  /** The reading column this document wants (px); the reader keeps its own default when absent. */
  preferredWidth?: number;
  section(index: number): Promise<SectionContent>;
}

/**
 * Documents that have no file. Their ids start with `prefix` ("bible:cuv-hans:JHN"); notes made in them record that id
 * as the book they belong to. They never appear on the shelf: the module offers its own way in.
 */
export interface DocProvider {
  prefix: string;
  /** What the module offers to open, as a tree (testaments, books, ...). Leaves carry the id of a document. */
  toc(): Promise<TocNode[]>;
  open(docId: string): Promise<VirtualDoc>;
  /**
   * The canonical position of a selection that covers elements carrying `data-ref` (in document order);
   * e.g. ["JHN.3.16", "JHN.3.17"] -> "JHN.3.16-17". Without it a single ref is used as it is.
   */
  joinRefs?(refs: string[]): string;
  /** The start of the canonical positions that appear in a document ("JHN" for John): notes written elsewhere at such positions are looked up for it. */
  refPrefix?(docId: string): string;
  /** A short name for a document, for "from WEB" on a note written in it. */
  label?(docId: string): string;
}

// ---------------------------------------------------------------- references in any text

export interface RefMatch {
  /** Character offsets of the reference inside the text that was searched. */
  start: number;
  end: number;
  /** Canonical position, e.g. "JHN.3.16" or "ROM.8.28". */
  ref: string;
  /** How to show it, e.g. "约 3:16". */
  label: string;
}

/** A place a reference leads to: which document to open and where in it. */
export interface RefTarget {
  docId: string;
  /** Title of the document (shown in the reader's top bar while it opens). */
  title: string;
  /** How the place reads, e.g. "约翰福音 3:16". */
  label: string;
  /** A second line, e.g. the translation. */
  sub?: string;
  section: number;
  fragment?: string;
  ref: string;
}

/** Finds references to the module's texts inside other text (a book, a note) and previews them. */
export interface RefRecognizer {
  id: string;
  find(text: string): RefMatch[];
  /** Places that match what was typed in the command palette ("约 3:16", "rom 8"). */
  lookup?(query: string): RefTarget[];
  preview?(ref: string): Promise<{ title: string; html: string } | null>;
}

// ---------------------------------------------------------------- places in the interface

export type SlotName = "reader.topbar" | "reader.selection" | "reader.drawer" | "reader.overlay" | "notes.sidebar";

/** What a slot component is told about the place it sits in. */
export interface SlotContext {
  /** The open document (a book id or a virtual document id), if any. */
  docId?: string;
  /** Canonical position at the reading cursor, if the document has one. */
  ref?: string;
  /** The selected text, for the selection slot. */
  selection?: string;
}

/** What a module's page is given. */
export interface PageContext {
  /** Open one of the module's documents in the reader. */
  openDoc(docId: string, title?: string): void;
  /** Documents of this module opened lately (newest first), with how far the reader got. */
  recent(prefix: string): { docId: string; title: string; progress: number; at: number }[];
  /** Make to-dos (one for each planned day) and goals for a plan; returns their ids, to keep for taking the plan back. */
  applyPlan(title: string, tasks: PlannedTask[]): Promise<{ taskIds: string[]; goalIds: string[] }>;
  removePlan(ids: { taskIds: string[]; goalIds: string[] }): Promise<void>;
  /** How many of a plan's to-dos are done, and the first one that is not. */
  planProgress(taskIds: string[]): Promise<{ done: number; total: number; next?: { title: string; day: string } }>;
  /** Called when to-dos change; returns the way to stop listening. */
  onTasksChanged(cb: () => void): () => void;
}

/** A whole page of its own, reached from a tab beside Notes / Shelf / Tasks / Explore. */
export interface PageItem {
  id: string;
  title: string;
  component: ComponentType<{ ctx: PageContext }>;
}

export interface SlotItem {
  /** Unique within the module. */
  id: string;
  slot: SlotName;
  /** Tab title (drawer) or tooltip (buttons). */
  title: string;
  component: ComponentType<{ ctx: SlotContext }>;
}

// ---------------------------------------------------------------- plans

export interface PlannedTask {
  title: string;
  /** Day it is planned for, "YYYY-MM-DD". */
  day: string;
  tags?: string[];
}

/** Turns a rule into a list of to-dos (a reading plan, a revision timetable). `params` is what the user chose. */
export interface PlanProvider {
  id: string;
  title: string;
  generate(params: Json, from: string): PlannedTask[];
}

// ---------------------------------------------------------------- what the module is given

export interface Host {
  registerDoc(p: DocProvider): void;
  registerRecognizer(r: RefRecognizer): void;
  registerSlot(item: SlotItem): void;
  registerPage(page: PageItem): void;
  registerPlan(p: PlanProvider): void;
  /** Called (at most about 4 times a second) when the reading position moves to another canonical position. */
  onActiveRef(cb: (ref: string, docId: string) => void): () => void;
}

export interface Module {
  /** Reverse-domain id, e.g. "org.marginalia.bible". Notes written by the module carry it in `sourceModule`. */
  id: string;
  /** Name shown to the user. */
  name: string;
  activate(host: Host): void;
  deactivate(): void;
}
