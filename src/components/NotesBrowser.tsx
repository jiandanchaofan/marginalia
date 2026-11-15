import { useEffect, useMemo, useRef, useState } from "react";
import { docLabel } from "../host/label";
import { ArrowUpRight, Check, CheckSquare, Copy, Download, FilePlus2, Hash, ImagePlus, Link2, Palette, Pencil, Search, Square, Star, StickyNote, Tag, Trash2, X } from "lucide-react";
import { isDocNote, isFreeNote, type Annotation, type BookRecord, type NoteLink } from "../core/types";
import { NoteLinks } from "./NoteLinks";
import { LinkDialog } from "./LinkDialog";
import { RelatedComposer } from "./RelatedComposer";
import { useLinks } from "../notes/useLinks";
import { linksOf } from "../notes/links";
import { relationsFor } from "../notes/relations";
import { ReflectBox } from "./ReflectBox";
import { reflectTitleOnTick } from "../tasks/reflect";
import { toggleTodoLine } from "../notes/edit";
import { PALETTE, styleName, swatch } from "../core/palette";
import { filterHits, notesStore, tagStats, useGlobalTags, useNotesVersion, type NoteHit } from "../notes/store";
import { addTag, buildTree, hasThought, parseTags, removeTag } from "../notes/tags";
import { deleteNotes } from "../trash/delete";
import { EMPTY_FILTER, dayLabel, isFiltered, imageIdsOf, notesToMarkdown, safeFileName, toQuery, type NotesFilter } from "../notes/query";
import type { Theme } from "../settings";
import { exportTextFile } from "../platform";
import { Marked, NoteText } from "./NoteText";
import { TagTextarea, type TagTextareaHandle } from "./TagTextarea";
import { FormatBar } from "./FormatBar";
import { RegionQuote } from "./NoteImages";
import { NoteImages } from "./NoteImages";
import { collate, fmtDateTime, t } from "../i18n";

export { EMPTY_FILTER, type NotesFilter };

const PAGE = 60;
const fmtDate = (t: number) => {
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return fmtDateTime(d, { year: sameYear ? undefined : "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};

interface Props {
  theme: Theme;
  filter: NotesFilter;
  onFilter(f: NotesFilter): void;
  books: Map<string, BookRecord>;
  /** Live notes of one book (in-book panel). Omitted → query the global store. */
  source?: NoteHit[];
  chapterOf?(section: number): string;
  /** In-book panel: show a compact tag picker above the list. */
  tagPicker?: boolean;
  compact?: boolean;
  /** Enable multi-select + batch actions (global store only). */
  batch?: boolean;
  /** Title used for "export current results"; omit to hide the button. */
  exportHeading?: string;
  /** Show a ☆ to save the current filter. */
  onSaveFilter?(): void;
  onOpen(hit: NoteHit): void;
  /** Override persistence (in-book list edits go through the reader's own state). */
  onEdit?(hit: NoteHit, patch: Partial<Annotation>): void;
  onDelete?(hit: NoteHit): void;
  headerExtra?: React.ReactNode;
  notify?(msg: string): void;
}

export function NotesBrowser(props: Props) {
  const { theme, filter, onFilter, books, source, chapterOf, tagPicker, compact, batch, exportHeading, onSaveFilter, onOpen, onEdit, onDelete, headerExtra, notify } = props;
  const version = useNotesVersion();
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<{ items: NoteHit[]; total: number }>({ items: [], total: 0 });
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Map<string, NoteHit>>(new Map());
  const links = useLinks();
  const [linkFor, setLinkFor] = useState<NoteHit | null>(null); // "connect to existing notes" dialog
  const [relatedFrom, setRelatedFrom] = useState<NoteHit[] | null>(null); // "new related note" dialog
  const query = useMemo(() => toQuery(filter, books), [filter, books]);
  const set = (p: Partial<NotesFilter>) => onFilter({ ...filter, ...p });

  useEffect(() => setLimit(PAGE), [filter]);
  useEffect(() => {
    if (source) {
      const all = filterHits(source, query);
      setResult({ items: all.slice(0, limit), total: all.length });
      return;
    }
    let alive = true;
    notesStore.query({ ...query, limit, offset: 0 }).then((r) => alive && setResult(r));
    return () => {
      alive = false;
    };
  }, [query, limit, version, source]);

  // Selection survives search/filter changes: refresh entries that are visible, keep the rest as they are.
  useEffect(() => {
    setSelected((old) => {
      if (!old.size) return old;
      const fresh = new Map(result.items.map((h) => [h.note.id, h]));
      return new Map([...old].map(([id, h]) => [id, fresh.get(id) ?? h]));
    });
  }, [result]);
  const replaceSelected = (hits: NoteHit[]) =>
    setSelected((old) => {
      const next = new Map(old);
      hits.forEach((h) => next.has(h.note.id) && next.set(h.note.id, h));
      return next;
    });

  const toggleTag = (tag: string) => set({ tags: filter.tags.includes(tag) ? filter.tags.filter((t) => t !== tag) : [...filter.tags, tag] });

  const save = async (hit: NoteHit, patch: Partial<Annotation>) => {
    if (onEdit) return onEdit(hit, patch);
    await notesStore.update(hit.bookId, { ...hit.note, ...patch, updatedAt: Date.now() });
  };
  const remove = async (hit: NoteHit) => {
    if (onDelete) return onDelete(hit);
    await deleteNotes([hit]);
  };

  const exportResults = async () => {
    const hits = selecting && selected.size ? [...selected.values()] : source ? filterHits(source, query) : (await notesStore.query({ ...query, limit: -1 })).items;
    if (!hits.length) return;
    const heading = exportHeading ?? t("nb.exportDefault");
    try {
      const ok = await exportTextFile(`${safeFileName(heading)}.md`, notesToMarkdown(hits, books, heading, await relationsFor(hits)), imageIdsOf(hits));
      if (ok) notify?.(t("nb.exported", { n: hits.length }));
    } catch (e) {
      notify?.(t("nb.exportFail", { err: String(e) }));
    }
  };

  const toggleSelect = (hit: NoteHit) =>
    setSelected((old) => {
      const next = new Map(old);
      if (next.has(hit.note.id)) next.delete(hit.note.id);
      else next.set(hit.note.id, hit);
      return next;
    });
  const exitSelect = () => {
    setSelecting(false);
    setSelected(new Map());
  };

  const groupByType = filter.sort === "type" && !source;
  const typeOf = (a: Annotation) => (a.kind === "free" ? t("kind.free") : a.kind === "doc" ? t("kind.doc") : hasThought(a.note) ? t("kind.passageNote") : t("kind.excerpt"));
  let lastKind = "";
  let lastChapter = "";

  return (
    <div className={`notes-browser ${compact ? "compact" : ""} ${selecting ? "selecting" : ""}`}>
      <div className="nb-toolbar">
        <label className="nb-search" title={t("nb.syntaxTip")}>
          <Search size={15} />
          <input
            value={filter.q}
            placeholder={compact ? t("nb.searchShort") : t("nb.searchFull")}
            onChange={(e) => set({ q: e.target.value })}
            onKeyDown={(e) => e.key === "Escape" && filter.q && (e.stopPropagation(), set({ q: "" }))}
          />
          {filter.q && (
            <button onClick={() => set({ q: "" })} title={t("shelf.clearSearch")}>
              <X size={14} />
            </button>
          )}
        </label>
        {onSaveFilter && isFiltered(filter) && (
          <button className="icon-btn" title={t("nb.saveFilter")} onClick={onSaveFilter}>
            <Star size={17} />
          </button>
        )}
        {exportHeading && (
          <button className="icon-btn" title={selecting && selected.size ? t("nb.exportSel") : t("nb.exportMd")} onClick={exportResults} disabled={!result.total}>
            <Download size={17} />
          </button>
        )}
        {batch && !source && (
          <button className={`icon-btn ${selecting ? "on" : ""}`} title={t("nb.select")} onClick={() => (selecting ? exitSelect() : setSelecting(true))}>
            <CheckSquare size={17} />
          </button>
        )}
        {headerExtra}
      </div>

      {tagPicker && source && <InlineTagPicker hits={source} selected={filter.tags} onToggle={toggleTag} />}

      <div className="nb-filters">
        {filter.tags.map((t) => (
          <button key={t} className="filter-chip tag" onClick={() => toggleTag(t)}>
            #{t} <X size={12} />
          </button>
        ))}
        {filter.tags.length > 1 && (
          <button className="filter-chip ghost" onClick={() => set({ tagMode: filter.tagMode === "and" ? "or" : "and" })} title={t("nb.tagMode")}>
            {filter.tagMode === "and" ? t("nb.tagAnd") : t("nb.tagOr")}
          </button>
        )}
        {filter.day && (
          <button className="filter-chip tag" onClick={() => set({ day: undefined })} title={t("nb.clearDay")}>
            {dayLabel(filter.day)} <X size={12} />
          </button>
        )}
        {!source && (
          <button className={`filter-chip ${filter.kind === "free" ? "on" : ""}`} onClick={() => set({ kind: filter.kind === "free" ? undefined : "free", hasText: undefined })} title={t("nb.freeTip")}>
            {t("kind.free")}
          </button>
        )}
        <button
          className={`filter-chip ${filter.kind === "passage" && filter.hasText === true ? "on" : ""}`}
          onClick={() => (filter.kind === "passage" && filter.hasText === true ? set({ kind: undefined, hasText: undefined }) : set({ kind: "passage", hasText: true }))}
          title={t("nb.passageTip")}
        >
          {t("kind.passageNote")}
        </button>
        <button className={`filter-chip ${filter.kind === "doc" ? "on" : ""}`} onClick={() => set({ kind: filter.kind === "doc" ? undefined : "doc", hasText: undefined })} title={t("nb.docTip")}>
          {t("kind.doc")}
        </button>
        <button
          className={`filter-chip ${filter.kind === "passage" && filter.hasText === false ? "on" : ""}`}
          onClick={() => (filter.kind === "passage" && filter.hasText === false ? set({ kind: undefined, hasText: undefined }) : set({ kind: "passage", hasText: false }))}
          title={t("nb.excerptTip")}
        >
          {t("kind.excerpt")}
        </button>
        <span className="nb-colors">
          {PALETTE.map((p) => (
            <button
              key={p.key}
              title={p.name}
              className={`swatch-dot ${filter.colors.includes(p.key) ? "on" : ""}`}
              style={{ ["--dot" as string]: theme === "dark" ? p.dark : p.ink, ["--dot-soft" as string]: theme === "dark" ? p.dark : p.light }}
              onClick={() => set({ colors: filter.colors.includes(p.key) ? filter.colors.filter((c) => c !== p.key) : [...filter.colors, p.key] })}
            />
          ))}
        </span>
        <span className="nb-spacer" />
        <div className="segmented small">
          <button className={filter.sort === "time" ? "on" : ""} onClick={() => set({ sort: "time" })}>
            {t("nb.sortTime")}
          </button>
          <button className={filter.sort === (source ? "position" : "type") ? "on" : ""} onClick={() => set({ sort: source ? "position" : "type" })}>
            {source ? t("nb.sortOrder") : t("nb.sortType")}
          </button>
        </div>
      </div>

      <div className="nb-count">
        {t("nb.total", { n: result.total })}
        {(filter.q || filter.tags.length || filter.colors.length || filter.hasText !== undefined || filter.kind || filter.day) && (
          <button className="link" onClick={() => onFilter({ ...EMPTY_FILTER, bookIds: filter.bookIds, sort: filter.sort })}>
            {t("nb.clearFilter")}
          </button>
        )}
      </div>

      {selecting && (
        <BatchBar
          theme={theme}
          selected={[...selected.values()]}
          pageCount={result.items.length}
          onSelectPage={() => setSelected(new Map(result.items.map((h) => [h.note.id, h])))}
          onClear={() => setSelected(new Map())}
          onExport={exportResults}
          onExit={exitSelect}
          onReplace={replaceSelected}
          onRelated={() => setRelatedFrom([...selected.values()])}
          notify={notify}
        />
      )}

      <div className="nb-list">
        {!result.items.length && <div className="nb-empty">{result.total === 0 && !filter.q && !filter.tags.length && !filter.day ? (source ? t("nb.emptyBook") : t("nb.emptyAll")) : t("nb.noMatch")}</div>}
        {result.items.map((hit) => {
          const book = books.get(hit.bookId);
          let header: React.ReactNode = null;
          if (groupByType && typeOf(hit.note) !== lastKind) {
            lastKind = typeOf(hit.note);
            header = <div className="nb-group">{lastKind}</div>;
          } else if (source && filter.sort === "position" && chapterOf) {
            const ch = isDocNote(hit.note) ? t("nb.docChapter") : chapterOf(hit.note.anchor.section);
            if (ch !== lastChapter) {
              lastChapter = ch;
              header = <div className="nb-group">{ch}</div>;
            }
          }
          return (
            <div key={hit.note.id}>
              {header}
              <NoteItem
                hit={hit}
                theme={theme}
                bookTitle={source || isFreeNote(hit.note) ? undefined : book?.title ?? (hit.note.sourceModule ? docLabel(undefined, hit.note) : undefined)}
                noun={book && (book.format === "md" || book.format === "html") ? t("noun.article") : t("noun.book")}
                terms={query.terms}
                activeTags={filter.tags}
                selectable={selecting}
                selected={selected.has(hit.note.id)}
                onSelect={() => toggleSelect(hit)}
                onTag={toggleTag}
                onOpen={() => onOpen(hit)}
                onSave={(p) => save(hit, p)}
                onDelete={() => remove(hit)}
                links={linksOf(links, hit.note.id)}
                books={books}
                onOpenNote={(h) => {
                  // In the reader's own list only notes of this document can be jumped to.
                  if (source && !source.some((s) => s.note.id === h.note.id)) return notify?.(t("nb.elsewhere"));
                  onOpen(h);
                }}
                onLink={() => setLinkFor(hit)}
                onRelated={() => setRelatedFrom([hit])}
                notify={notify}
              />
            </div>
          );
        })}
        {result.total > result.items.length && (
          <button className="nb-more" onClick={() => setLimit((l) => l + PAGE)}>
            {t("nb.more", { n: result.total - result.items.length })}
          </button>
        )}
      </div>
      {linkFor && <LinkDialog from={linkFor} books={books} onClose={() => setLinkFor(null)} notify={(m) => notify?.(m)} />}
      {relatedFrom && (
        <RelatedComposer
          sources={relatedFrom}
          books={books}
          onClose={() => setRelatedFrom(null)}
          onDone={() => exitSelect()}
          notify={(m) => notify?.(m)}
        />
      )}
    </div>
  );
}

/** Batch actions on the selected notes (global store). */
function BatchBar({
  theme,
  selected,
  pageCount,
  onSelectPage,
  onClear,
  onExport,
  onExit,
  onReplace,
  onRelated,
  notify,
}: {
  theme: Theme;
  onReplace(hits: NoteHit[]): void;
  onRelated(): void;
  selected: NoteHit[];
  pageCount: number;
  onSelectPage(): void;
  onClear(): void;
  onExport(): void;
  onExit(): void;
  notify?(msg: string): void;
}) {
  const [mode, setMode] = useState<"add" | "remove" | "color" | null>(null);
  const [tagInput, setTagInput] = useState("");
  const globalTags = useGlobalTags();
  const present = useMemo(() => [...new Set(selected.flatMap((h) => parseTags(h.note.note)))].sort(collate), [selected]);
  const n = selected.length;
  const now = Date.now();

  const apply = async (fn: (a: Annotation) => Annotation, msg: string) => {
    const changed = selected.map((h) => ({ ...h, note: fn(h.note) })).filter((h, i) => h.note !== selected[i].note);
    if (!changed.length) return setMode(null);
    const stamped = changed.map((h) => ({ ...h, note: { ...h.note, updatedAt: now } }));
    await notesStore.updateMany(stamped);
    onReplace(stamped);
    notify?.(msg.replace("{n}", String(changed.length)));
    setMode(null);
  };
  const addToAll = () => {
    const tag = tagInput.trim().replace(/^#/, "");
    if (!tag) return;
    setTagInput("");
    apply((a) => {
      const note = addTag(a.note, tag);
      return note === a.note ? a : { ...a, note };
    }, t("nb.batch.tagged", { tag }));
  };
  const removeFromAll = (tag: string) =>
    apply((a) => {
      const note = removeTag(a.note, tag);
      return note === a.note ? a : { ...a, note };
    }, t("nb.batch.untagged", { tag }));
  const recolor = (color: string) => apply((a) => (a.color === color ? a : { ...a, color }), t("nb.batch.recolored"));
  const removeAll = async () => {
    if (await deleteNotes(selected)) onClear();
  };

  return (
    <div className="batch-bar">
      <div className="batch-row">
        <span className="batch-count">{t("nb.batch.picked", { n })}</span>
        <button className="link" onClick={n >= pageCount ? onClear : onSelectPage}>
          {n >= pageCount && n > 0 ? t("nb.batch.unpage") : t("nb.batch.page")}
        </button>
        <span className="nb-spacer" />
        <button className={`batch-btn ${mode === "add" ? "on" : ""}`} disabled={!n} onClick={() => setMode(mode === "add" ? null : "add")}>
          <Tag size={14} /> {t("nb.batch.addTag")}
        </button>
        <button className={`batch-btn ${mode === "remove" ? "on" : ""}`} disabled={!present.length} onClick={() => setMode(mode === "remove" ? null : "remove")}>
          <Hash size={14} /> {t("nb.batch.removeTag")}
        </button>
        <button className={`batch-btn ${mode === "color" ? "on" : ""}`} disabled={!n} onClick={() => setMode(mode === "color" ? null : "color")}>
          <Palette size={14} /> {t("nb.batch.color")}
        </button>
        <button className="batch-btn" disabled={!n} onClick={onRelated} title={t("nb.batch.relatedTip")}>
          <FilePlus2 size={14} /> {t("nb.batch.related")}
        </button>
        <button className="batch-btn" disabled={!n} onClick={onExport}>
          <Download size={14} /> {t("nb.batch.export")}
        </button>
        <button className="batch-btn danger" disabled={!n} onClick={removeAll}>
          <Trash2 size={14} /> {t("nb.batch.delete")}
        </button>
        <button className="batch-btn" onClick={onExit} title={t("nb.batch.exit")}>
          <X size={14} />
        </button>
      </div>
      {mode === "add" && (
        <div className="batch-row sub">
          <Hash size={14} />
          <input
            className="batch-input"
            autoFocus
            list="batch-tags"
            placeholder={t("nb.batch.tagPlaceholder")}
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addToAll()}
          />
          <datalist id="batch-tags">
            {globalTags.map((t) => (
              <option key={t.tag} value={t.tag} />
            ))}
          </datalist>
          <button className="batch-btn primary" onClick={addToAll} disabled={!tagInput.trim()}>
            <Check size={14} /> {t("nb.batch.addTo", { n })}
          </button>
        </div>
      )}
      {mode === "remove" && (
        <div className="batch-row sub wrap">
          <span className="batch-hint">{t("nb.batch.pickRemove")}</span>
          {present.map((t) => (
            <button key={t} className="tag-chip" onClick={() => removeFromAll(t)}>
              #{t} <X size={11} />
            </button>
          ))}
        </div>
      )}
      {mode === "color" && (
        <div className="batch-row sub">
          <span className="batch-hint">{t("nb.batch.changeTo")}</span>
          {PALETTE.map((p) => (
            <button
              key={p.key}
              title={p.name}
              className="swatch-dot big"
              style={{ ["--dot" as string]: theme === "dark" ? p.dark : p.ink, ["--dot-soft" as string]: theme === "dark" ? p.dark : p.light }}
              onClick={() => recolor(p.key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NoteItem({
  hit,
  theme,
  bookTitle,
  noun,
  terms,
  activeTags,
  selectable,
  selected,
  onSelect,
  onTag,
  onOpen,
  onSave,
  onDelete,
  links,
  books,
  onOpenNote,
  onLink,
  onRelated,
  notify,
}: {
  links: NoteLink[];
  books: Map<string, BookRecord>;
  onOpenNote(hit: NoteHit): void;
  onLink(): void;
  onRelated(): void;
  notify?(msg: string): void;
  hit: NoteHit;
  theme: Theme;
  bookTitle?: string;
  noun: string;
  terms?: string[];
  activeTags: string[];
  selectable?: boolean;
  selected?: boolean;
  onSelect?(): void;
  onTag(tag: string): void;
  onOpen(): void;
  onSave(p: Partial<Annotation>): void;
  onDelete(): void;
}) {
  const a = hit.note;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.note);
  const [draftImages, setDraftImages] = useState<string[]>(a.images ?? []);
  const editor = useRef<TagTextareaHandle>(null);
  const sw = swatch(a.color);
  const free = isFreeNote(a);
  const fresh = free && Date.now() - a.createdAt < 4000;
  const [copied, setCopied] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const [reflect, setReflect] = useState<string | null>(null); // a todo was just ticked: ask what it taught
  const copyQuote = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(a.anchor.exact).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  const startEdit = () => {
    setDraft(a.note);
    setDraftImages(a.images ?? []);
    setEditing(true);
  };
  const commit = () => {
    if (draft !== a.note || draftImages.join() !== (a.images ?? []).join()) onSave({ note: draft, tags: parseTags(draft), images: draftImages });
    setEditing(false);
  };
  const quote = free ? null : a.anchor.region ? (
    <RegionQuote id={a.anchor.thumb} page={a.anchor.image ? undefined : a.anchor.section} onOpen={selectable ? undefined : onOpen} />
  ) : isDocNote(a) ? (
        <button className="nb-doc-badge" onClick={selectable ? undefined : onOpen} title={selectable ? undefined : t("nb.openDoc")}>
          <StickyNote size={14} /> {t("nb.docBadge", { noun })}
        </button>
      ) : (
        <div className="nb-quote-wrap">
          {/* Plain text: drag / double-click / triple-click to select part of it. Ctrl + click jumps to the source. */}
          <div
            className="nb-quote"
            title={selectable ? undefined : t("nb.quoteTip")}
            onClick={(e) => {
              if (!selectable && (e.ctrlKey || e.metaKey)) {
                e.stopPropagation();
                onOpen();
              }
            }}
          >
            <Marked text={a.anchor.exact} terms={terms} />
          </div>
        </div>
      );
  return (
    <div
      className={`nb-item ${free ? "free" : ""} ${fresh ? "fresh" : ""} ${editing ? "editing" : ""} ${selectable ? "selectable" : ""} ${selected ? "selected" : ""}`}
      style={{ ["--accent" as string]: theme === "dark" ? sw.dark : sw.ink }}
      onClick={selectable ? onSelect : undefined}
      // Double-click anywhere on the card (not on its buttons, tags or pictures) starts editing.
      onDoubleClick={(e) => {
        if (selectable || editing || (e.target as Element).closest("button, a, img, textarea, input, .ni-strip, .nb-quote")) return;
        window.getSelection()?.removeAllRanges();
        startEdit();
      }}
    >
      {selectable && <span className="nb-check">{selected ? <CheckSquare size={17} /> : <Square size={17} />}</span>}
      {quote}
      {editing ? (
        <div className="nb-edit" onClick={(e) => e.stopPropagation()}>
          <TagTextarea ref={editor} className="note-editor" value={draft} onChange={setDraft} images={draftImages} onImages={setDraftImages} autoFocus placeholder={t("nb.editPlaceholder")} onSubmit={commit} onEscape={() => setEditing(false)} />
          <div className="nb-edit-actions">
            <button className="ni-add" title={t("nb.addImage")} onClick={() => editor.current?.pickImage()}>
              <ImagePlus size={14} />
            </button>
            <FormatBar onFormat={(k) => editor.current?.format(k)} />
            <span>{t("nb.saveHint")}</span>
            <button onClick={() => setEditing(false)}>{t("common.cancel")}</button>
            <button className="primary" onClick={commit}>
              <Check size={14} /> {t("common.save")}
            </button>
          </div>
        </div>
      ) : (
        a.note.trim() && <NoteText className="nb-note" text={a.note} terms={terms} activeTags={activeTags} onTag={selectable ? undefined : onTag} onToggle={selectable ? undefined : (line) => (setReflect(reflectTitleOnTick(a.note, line) || null), onSave({ note: toggleTodoLine(a.note, line) }))} />
      )}
      {!editing && reflect && <ReflectBox title={reflect} noteId={a.id} notify={notify} onClose={() => setReflect(null)} />}
      {!editing && <NoteImages ids={a.images} />}
      {!selectable && !editing && showLinks && <NoteLinks noteId={a.id} links={links} books={books} onOpenNote={onOpenNote} onAdd={onLink} onRelated={onRelated} notify={notify} />}
      <div className="nb-meta">
        {bookTitle && <span className="nb-book">{bookTitle}</span>}
        <span>{fmtDate(a.createdAt)}</span>
        <span>{free ? t("kind.free") : isDocNote(a) ? t("kind.doc") : styleName(a.style)}</span>
        {!selectable && links.length > 0 && (
          <button className={`nb-link-chip ${showLinks ? "on" : ""}`} title={t("nb.viewLinks")} onClick={() => setShowLinks((s) => !s)}>
            <Link2 size={12} /> {links.length}
          </button>
        )}
        {!selectable && (
          <span className="nb-actions">
            {(links.length === 0 || !showLinks) && (
              <button title={t("nb.linkTip")} onClick={() => (links.length ? setShowLinks(true) : setShowLinks((s) => !s))}>
                <Link2 size={14} />
              </button>
            )}
            {!free && !isDocNote(a) && !a.anchor.region && (
              <button title={t("nb.copyQuote")} onClick={copyQuote}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            )}
            {!free && (
              <button title={t("nb.goText")} onClick={onOpen}>
                <ArrowUpRight size={14} />
              </button>
            )}
            {!editing && (
              <button
                title={t("nb.edit")}
                onClick={startEdit}
              >
                <Pencil size={13} />
              </button>
            )}
            <button title={t("card.delete")} className="danger" onClick={onDelete}>
              <Trash2 size={13} />
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** In-book tag picker: tags present in this book, as an indented chip list. */
function InlineTagPicker({ hits, selected, onToggle }: { hits: NoteHit[]; selected: string[]; onToggle(t: string): void }) {
  const tree = useMemo(() => buildTree(tagStats(hits)), [hits]);
  if (!tree.length) return null;
  const flat: { tag: string; name: string; count: number; depth: number }[] = [];
  const walk = (nodes: typeof tree, depth: number) =>
    nodes.forEach((n) => {
      flat.push({ tag: n.tag, name: n.name, count: n.count, depth });
      walk(n.children, depth + 1);
    });
  walk(tree, 0);
  return (
    <div className="nb-tagpicker">
      {flat.map((t) => (
        <button key={t.tag} className={`tag-chip ${selected.includes(t.tag) ? "on" : ""}`} onClick={() => onToggle(t.tag)} title={`#${t.tag}`}>
          {t.depth > 0 && <span className="tag-depth">{"›".repeat(t.depth)}</span>}
          <Hash size={11} />
          {t.name}
          <em>{t.count}</em>
        </button>
      ))}
    </div>
  );
}
