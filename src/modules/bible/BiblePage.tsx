import { useState } from "react";
import type { PageContext } from "../../host/sdk";
import { BIBLE_BOOKS } from "./books";
import { BUNDLED } from "./packs";
import { docIdOf } from "./ids";

const VERSION_KEY = "reader:bible:version";
const getVersion = () => {
  try {
    const v = localStorage.getItem(VERSION_KEY);
    return BUNDLED.some((b) => b.id === v) ? (v as string) : BUNDLED[0].id;
  } catch {
    return BUNDLED[0].id;
  }
};

/** The Bible page: pick a translation, continue where you were, or open any of the 66 books. */
export function BiblePage({ ctx }: { ctx: PageContext }) {
  const [version, setVersionState] = useState(getVersion);
  const setVersion = (v: string) => {
    setVersionState(v);
    try {
      localStorage.setItem(VERSION_KEY, v);
    } catch {
      /* not remembered */
    }
  };
  const zh = BUNDLED.find((b) => b.id === version)?.lang.startsWith("zh") ?? true;
  const recent = ctx.recent("bible:").slice(0, 3);
  const group = (title: string, ot: boolean) => (
    <section className="bible-group">
      <h3>{title}</h3>
      <div className="bible-books">
        {BIBLE_BOOKS.filter((b) => b.ot === ot).map((b) => (
          <button key={b.id} className="bible-book" onClick={() => ctx.openDoc(docIdOf(version, b.id), zh ? b.zh : b.en)} title={`${b.zh} · ${b.en}`}>
            {zh ? b.zh : b.en}
          </button>
        ))}
      </div>
    </section>
  );
  return (
    <div className="bible-page">
      <div className="bible-top">
        <h2>圣经</h2>
        <div className="segmented small" role="group" aria-label="译本">
          {BUNDLED.map((b) => (
            <button key={b.id} className={b.id === version ? "on" : ""} onClick={() => setVersion(b.id)}>
              {b.name}
            </button>
          ))}
        </div>
      </div>
      {recent.length > 0 && (
        <div className="continue">
          <span className="continue-label">继续阅读</span>
          {recent.map((r) => (
            <button key={r.docId} className="continue-row" onClick={() => ctx.openDoc(r.docId, r.title)}>
              <span className="continue-title">{r.title}</span>
              <span className="continue-bar">
                <i style={{ width: `${Math.round(r.progress * 100)}%` }} />
              </span>
              <span className="continue-meta">{Math.round(r.progress * 100)}%</span>
            </button>
          ))}
        </div>
      )}
      {group(zh ? "旧约" : "Old Testament", true)}
      {group(zh ? "新约" : "New Testament", false)}
    </div>
  );
}
