import { useEffect, useRef, useState } from "react";
import { Bookmark, Check, Copy, Globe, Loader2, X } from "lucide-react";
import { clipArticle, looksLikeUrl, type ClipProgress, type ClipResult } from "../web/clip";

export const BOOKMARKLET = "javascript:location.href='marginalia://clip?url='+encodeURIComponent(location.href)";

const STAGES: { key: ClipProgress["stage"]; label: string }[] = [
  { key: "fetch", label: "抓取页面" },
  { key: "extract", label: "提取正文" },
  { key: "images", label: "保存图片" },
  { key: "save", label: "存入书架" },
];

interface Props {
  initialUrl?: string;
  /** Start immediately (bookmarklet / pasted link). */
  autoStart?: boolean;
  onDone(r: ClipResult, url: string): void;
  onClose(): void;
}

export function ClipDialog({ initialUrl = "", autoStart, onDone, onClose }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [progress, setProgress] = useState<ClipProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const running = progress !== null && !error;
  const linkRef = useRef<HTMLAnchorElement>(null);
  const started = useRef(false);

  // React refuses javascript: hrefs, so the bookmarklet link is set imperatively.
  useEffect(() => {
    linkRef.current?.setAttribute("href", BOOKMARKLET);
  }, []);

  // Prefill from the clipboard when it holds a link.
  useEffect(() => {
    if (initialUrl) return;
    navigator.clipboard
      ?.readText()
      .then((t) => looksLikeUrl(t) && setUrl((u) => u || t.trim()))
      .catch(() => {});
  }, [initialUrl]);

  const start = async (target = url) => {
    const u = target.trim();
    if (!looksLikeUrl(u)) {
      setError("请输入以 http:// 或 https:// 开头的网址");
      return;
    }
    setError(null);
    setProgress({ stage: "check" });
    try {
      const r = await clipArticle(u, setProgress);
      onDone(r, u);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (autoStart && initialUrl && !started.current) {
      started.current = true;
      start(initialUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, initialUrl]);

  const stageIndex = progress ? STAGES.findIndex((s) => s.key === progress.stage) : -1;

  return (
    <div className="modal-backdrop" onMouseDown={() => !running && onClose()}>
      <div className="modal clip-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose} title="关闭">
          <X size={18} />
        </button>
        <h2>
          <Globe size={20} /> 保存网页文章
        </h2>
        <p className="modal-sub">保存为离线快照（含图片），之后可以像书一样阅读、标注、写笔记。</p>

        <form
          className="clip-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!running) start();
          }}
        >
          <input
            autoFocus={!autoStart}
            value={url}
            disabled={running}
            placeholder="粘贴文章网址，例如 https://mp.weixin.qq.com/s/…"
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
          />
          <button className="primary-btn" type="submit" disabled={running || !url.trim()}>
            {running ? <Loader2 size={16} className="spin" /> : null}
            {running ? "保存中…" : "保存并阅读"}
          </button>
        </form>

        {progress && !error && (
          <ol className="clip-steps">
            {STAGES.map((s, i) => (
              <li key={s.key} className={i < stageIndex ? "done" : i === stageIndex ? "now" : ""}>
                <span className="dot">{i < stageIndex ? <Check size={11} /> : i + 1}</span>
                {s.label}
                {s.key === "images" && i === stageIndex && progress.total ? (
                  <em>
                    {progress.done}/{progress.total}
                  </em>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {error && <div className="clip-error">{error}</div>}

        <div className="clip-bookmarklet">
          <div className="bm-title">
            <Bookmark size={15} /> 在浏览器里一键保存
          </div>
          <p>
            把下面的按钮<b>拖到浏览器的书签栏</b>。以后在任意文章页点一下它，浏览器会询问是否打开「墨边」，确认后文章就会自动保存。
          </p>
          <div className="bm-row">
            <a ref={linkRef} className="bm-link" onClick={(e) => e.preventDefault()} draggable>
              存到墨边
            </a>
            <button
              className="batch-btn"
              onClick={() =>
                navigator.clipboard.writeText(BOOKMARKLET).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1800);
                })
              }
            >
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "已复制" : "复制书签代码"}
            </button>
          </div>
          <p className="bm-hint">拖不动时：在书签栏右键 →「添加网页」，名称填“存到墨边”，网址粘贴刚复制的代码。</p>
        </div>
      </div>
    </div>
  );
}
