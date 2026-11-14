import { useEffect, useRef, useState } from "react";
import { Bookmark, Check, Copy, Globe, Loader2, X } from "lucide-react";
import { clipArticle, looksLikeUrl, type ClipProgress, type ClipResult } from "../web/clip";
import { t } from "../i18n";
import { localizeErr } from "../i18n/errors";

export const BOOKMARKLET = "javascript:location.href='marginalia://clip?url='+encodeURIComponent(location.href)";

const STAGES: { key: ClipProgress["stage"]; label: string }[] = [
  { key: "fetch", get label() { return t("clip.stage.fetch"); } },
  { key: "extract", get label() { return t("clip.stage.extract"); } },
  { key: "images", get label() { return t("clip.stage.images"); } },
  { key: "save", get label() { return t("clip.stage.save"); } },
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
      setError(t("clip.badUrl"));
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
        <button className="icon-btn modal-close" onClick={onClose} title={t("common.close")}>
          <X size={18} />
        </button>
        <h2>
          <Globe size={20} /> {t("clip.title")}
        </h2>
        <p className="modal-sub">{t("clip.sub")}</p>

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
            placeholder={t("clip.placeholder")}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
          />
          <button className="primary-btn" type="submit" disabled={running || !url.trim()}>
            {running ? <Loader2 size={16} className="spin" /> : null}
            {running ? t("clip.saving") : t("clip.saveRead")}
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
        {error && <div className="clip-error">{localizeErr(error)}</div>}

        <div className="clip-bookmarklet">
          <div className="bm-title">
            <Bookmark size={15} /> {t("clip.bookmark")}
          </div>
          <p>
            {t("clip.drag1")}<b>{t("clip.drag2")}</b>{t("clip.drag3")}
          </p>
          <div className="bm-row">
            <a ref={linkRef} className="bm-link" onClick={(e) => e.preventDefault()} draggable>
              {t("clip.bmName")}
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
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t("clip.copied") : t("clip.copy")}
            </button>
          </div>
          <p className="bm-hint">{t("clip.bmHint")}</p>
        </div>
      </div>
    </div>
  );
}
