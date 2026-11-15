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

/** A document that has no file: the module makes its contents tree and its pages on demand. */
export interface DocProvider {
  /** Id of the virtual document as notes record it in `book_id`, e.g. "bible:cuv". Never shown on the shelf. */
  id: string;
  title: string;
  toc(): Promise<TocNode[]>;
  section(id: string): Promise<SectionContent>;
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

/** Finds references to the module's texts inside other text (a book, a note) and previews them. */
export interface RefRecognizer {
  id: string;
  find(text: string): RefMatch[];
  preview?(ref: string): Promise<{ title: string; html: string } | null>;
}

// ---------------------------------------------------------------- places in the interface

export type SlotName = "reader.topbar" | "reader.selection" | "reader.drawer" | "notes.sidebar";

/** What a slot component is told about the place it sits in. */
export interface SlotContext {
  /** The open document (a book id or a virtual document id), if any. */
  docId?: string;
  /** Canonical position at the reading cursor, if the document has one. */
  ref?: string;
  /** The selected text, for the selection slot. */
  selection?: string;
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
