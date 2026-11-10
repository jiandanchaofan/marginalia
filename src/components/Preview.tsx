import { useEffect, useRef, useState } from "react";
import { ArrowLeft, BookOpen, ChevronLeft, ChevronRight, EyeOff, Globe, Loader2, X } from "lucide-react";
import type { FeedItem } from "../feeds/api";
import { extractReadable, getPage, type Readable } from "../web/clip";
import { openWebWindow } from "../platform";

interface Props {
  item: FeedItem;
  sourceTitle?: string;
  saved: boolean;
  saving: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev(): void;
  onNext(): void;
  onSave(): void;
  onOpenSaved(): void;
  onDismiss(): void;
  onClose(): void;
}

type State = { status: "loading" } | { status: "ok"; meta: Readable["meta"]; html: string } | { status: "error"; error: string };

const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};

/**
 * In-app reader-mode preview of an inbox item: read before deciding to save. Links inside the article
 * open in the same pane (with Back); "原始网页" opens the site itself in an in-app window.
 */
export function Preview(p: Props) {
  const [stack, setStack] = useState<string[]>([p.item.url]);
  const [state, setState] = useState<State>({ status: "loading" });
  const scroller = useRef<HTMLDivElement>(null);
  const url = stack[stack.length - 1];
  const atRoot = stack.length === 1;

  useEffect(() => setStack([p.item.url]), [p.item.url]);

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    scroller.current?.scrollTo(0, 0);
    (async () => {
      try {
        const page = await getPage(url);
        const r = extractReadable(page, url === p.item.url ? { title: p.item.title, siteName: p.sourceTitle } : {});
        r.holder.querySelectorAll("img").forEach((img) => {
          img.setAttribute("referrerpolicy", "no-referrer");
          img.setAttribute("loading", "lazy");
        });
        if (alive) setState({ status: "ok", meta: r.meta, html: r.holder.innerHTML });
      } catch (e) {
        if (alive) setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [url, p.item.url, p.item.title, p.sourceTitle]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as Element).closest?.("input, textarea")) return;
      if (e.key === "Escape") p.onClose();
      else if (e.key === "ArrowLeft" && atRoot && p.hasPrev) p.onPrev();
      else if (e.key === "ArrowRight" && atRoot && p.hasNext) p.onNext();
      else if (e.key.toLowerCase() === "s" && atRoot && !p.saved && !p.saving) p.onSave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p, atRoot]);

  // Links inside the article stay in the app: follow them in this pane.
  const onContentClick = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      scroller.current?.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView({ behavior: "smooth" });
    } else if (/^https?:/i.test(href)) setStack((s) => [...s, href]);
  };

  const published = state.status === "ok" && state.meta.publishedAt ? new Date(state.meta.publishedAt).toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }) : "";

  return (
    <div className="preview-backdrop" onMouseDown={p.onClose}>
      <div className="preview" onMouseDown={(e) => e.stopPropagation()}>
        <header className="pv-bar">
          {atRoot ? (
            <div className="pv-nav">
              <button className="icon-btn" title="上一篇（←）" disabled={!p.hasPrev} onClick={p.onPrev}>
                <ChevronLeft size={18} />
              </button>
              <button className="icon-btn" title="下一篇（→）" disabled={!p.hasNext} onClick={p.onNext}>
                <ChevronRight size={18} />
              </button>
            </div>
          ) : (
            <button className="fi-btn" onClick={() => setStack((s) => s.slice(0, -1))}>
              <ArrowLeft size={14} /> 返回
            </button>
          )}
          <div className="pv-where" title={url}>
            {atRoot && p.sourceTitle ? `${p.sourceTitle} · ` : ""}
            {host(url)}
          </div>
          <span className="nb-spacer" />
          {atRoot &&
            (p.saved ? (
              <button className="fi-btn primary ghost" onClick={p.onOpenSaved}>
                <BookOpen size={14} /> 已保存 · 打开精读
              </button>
            ) : (
              <button className="fi-btn primary" disabled={p.saving} onClick={p.onSave} title="保存精读（S）">
                {p.saving ? <Loader2 size={14} className="spin" /> : <BookOpen size={14} />}
                {p.saving ? "保存中…" : "保存精读"}
              </button>
            ))}
          {atRoot && !p.saved && p.item.status !== "dismissed" && (
            <button className="fi-btn" onClick={p.onDismiss} title="忽略这篇，看下一篇">
              <EyeOff size={14} /> 忽略
            </button>
          )}
          <button className="fi-btn" onClick={() => openWebWindow(url, state.status === "ok" ? state.meta.title : p.item.title)} title="在应用内的网页窗口中查看原始页面">
            <Globe size={14} /> 原始网页
          </button>
          <button className="icon-btn" title="关闭（Esc）" onClick={p.onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="pv-scroll" ref={scroller}>
          {state.status === "loading" && (
            <div className="pv-loading">
              <Loader2 size={20} className="spin" /> 正在加载正文…
            </div>
          )}
          {state.status === "error" && (
            <div className="pv-error">
              <p>{state.error}</p>
              <button className="primary-btn" onClick={() => openWebWindow(url, p.item.title)}>
                <Globe size={16} /> 在应用内查看原始网页
              </button>
            </div>
          )}
          {state.status === "ok" && (
            <article className="pv-article">
              <div className="article-site">{state.meta.siteName}</div>
              <h1 className="article-title">{state.meta.title}</h1>
              <div className="article-byline">{[state.meta.author, published].filter(Boolean).join(" · ")}</div>
              <div
                className="content pv-content"
                style={{ ["--font-body" as string]: "var(--read-font)", ["--font-size" as string]: "17px", ["--line-height" as string]: 1.9, ["--indent" as string]: "0" }}
                onClick={onContentClick}
                dangerouslySetInnerHTML={{ __html: state.html }}
              />
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
