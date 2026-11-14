import { useEffect, useState } from "react";
import { FileSearch } from "lucide-react";
import type { BookRecord } from "../core/types";
import { t } from "../i18n";
import { bookIndex, type Found } from "./backend";
import "./search.css";

export type TextTarget = { section: number; text: string; snippet?: string };

/** On the shelf: what the books' own text says about the search words (books on the shelf stay filtered by title as before). */
export function TextHits({ query, books, onOpen }: { query: string; books: BookRecord[]; onOpen(bookId: string, target: TextTarget): void }) {
  const q = query.trim();
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    if ([...q].length < 2) return void setFound(null);
    let alive = true;
    const id = window.setTimeout(() => {
      bookIndex.search(q, 3, 30).then(
        (f) => alive && setFound(f),
        () => alive && setFound(null),
      );
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [q]);
  if (!found || !found.hits.length) return null;
  const byId = new Map(books.map((b) => [b.id, b]));
  const groups: { id: string; count: number; hits: Found["hits"] }[] = [];
  for (const h of found.hits) {
    const g = groups.find((x) => x.id === h.bookId);
    if (g) g.hits.push(h);
    else groups.push({ id: h.bookId, count: h.count, hits: [h] });
  }
  return (
    <section className="th">
      <h3>
        <FileSearch size={15} /> {t("th.title", { n: found.books })}
      </h3>
      {groups.map((g) => {
        const b = byId.get(g.id);
        if (!b) return null;
        return (
          <div key={g.id} className="th-book">
            <div className="th-name">
              {b.title} <i>{t("th.count", { n: g.count })}</i>
            </div>
            {g.hits.map((h, i) => (
              <button key={i} className="th-hit" onClick={() => onOpen(g.id, { section: h.section, text: q, snippet: h.snippet })}>
                <span>{h.snippet}</span>
                {h.section > 0 && <small>{t(b.format === "pdf" ? "th.page" : "th.section", { n: h.section + 1 })}</small>}
              </button>
            ))}
          </div>
        );
      })}
      {found.truncated && <p className="th-more">{t("th.truncated")}</p>}
    </section>
  );
}
