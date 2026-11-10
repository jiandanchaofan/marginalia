import { useState } from "react";
import { Check, FileUp, Loader2, Rss, X } from "lucide-react";
import { discover, type Discovered } from "../feeds/discover";
import { feedsApi, feedsChanged, interestCounts, type Source } from "../feeds/api";
import { InterestPicker } from "./InterestPicker";
import { refreshSource } from "../feeds/refresh";

type Row = { input: string; state: "pending" | "ok" | "error" | "exists"; found?: Discovered; error?: string; pick: boolean; interests: string[] };

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const fmt = (t: number) => (t ? new Date(t).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" }) : "");

/** Parse OPML (exported by Feedly / Inoreader / NetNewsWire …) into feed URLs. */
function opmlUrls(text: string) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  return Array.from(doc.querySelectorAll("outline[xmlUrl]"))
    .map((o) => o.getAttribute("xmlUrl")!)
    .filter(Boolean);
}

export function AddSourceDialog({ existing, onClose, notify }: { existing: Source[]; onClose(): void; notify(msg: string): void }) {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [phase, setPhase] = useState<"input" | "detecting" | "review" | "adding">("input");
  const knownInterests = interestCounts(existing).map((i) => i.name);

  const detect = async (lines: string[]) => {
    const inputs = [...new Set(lines.map((l) => l.trim()).filter(Boolean))];
    if (!inputs.length) return;
    setPhase("detecting");
    const list: Row[] = inputs.map((input) => ({ input, state: "pending", pick: false, interests: [] }));
    setRows([...list]);
    const known = new Set(existing.map((s) => s.feedUrl));
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, list.length) }, async () => {
        while (i < list.length) {
          const row = list[i++];
          try {
            const found = await discover(row.input);
            Object.assign(row, known.has(found.feedUrl) ? { state: "exists", found } : { state: "ok", found, pick: true });
          } catch (e) {
            Object.assign(row, { state: "error", error: e instanceof Error ? e.message : String(e) });
          }
          setRows([...list]);
        }
      }),
    );
    setPhase("review");
  };

  const add = async () => {
    const picked = rows.filter((r) => r.pick && r.found);
    if (!picked.length) return;
    setPhase("adding");
    let items = 0;
    for (const r of picked) {
      const f = r.found!;
      const src: Source = { id: uid(), title: f.title, siteUrl: f.siteUrl, feedUrl: f.feedUrl, kind: f.kind, errorCount: 0, createdAt: Date.now(), unread: 0, total: 0, interests: r.interests };
      await feedsApi.saveSource(src);
      items += (await refreshSource(src, true)).added;
      feedsChanged();
    }
    notify(`已添加 ${picked.length} 个订阅，获取到 ${items} 篇文章`);
    onClose();
  };

  const busy = phase === "detecting" || phase === "adding";
  return (
    <div className="modal-backdrop" onMouseDown={() => !busy && onClose()}>
      <div className="modal add-source" onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose} title="关闭">
          <X size={18} />
        </button>
        <h2>
          <Rss size={19} /> 添加订阅
        </h2>
        <p className="modal-sub">每行一个网址：博客或网站首页、RSS 地址、公众号「合集」链接都可以，墨边会自动找到订阅源。</p>

        {phase === "input" ? (
          <>
            <textarea
              className="source-input"
              autoFocus
              rows={6}
              value={text}
              placeholder={"https://cn.9marks.org/articles\nhttps://nacr.info/WordPress/\nhttps://mp.weixin.qq.com/mp/appmsgalbum?__biz=…&album_id=…"}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="modal-actions">
              <label className="batch-btn file-btn">
                <FileUp size={14} /> 导入 OPML
                <input
                  type="file"
                  accept=".opml,.xml,text/xml"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const urls = opmlUrls(await f.text());
                    if (!urls.length) return notify("这个文件里没有找到订阅源");
                    setText((t) => [t.trim(), ...urls].filter(Boolean).join("\n"));
                  }}
                />
              </label>
              <span className="nb-spacer" />
              <button className="primary-btn" disabled={!text.trim()} onClick={() => detect(text.split(/\n+/))}>
                检测订阅源
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="source-rows">
              {rows.map((r, k) => (
                <label key={k} className={`source-row ${r.state}`}>
                  <input
                    type="checkbox"
                    disabled={r.state !== "ok" || busy}
                    checked={r.pick}
                    onChange={(e) => setRows((rs) => rs.map((x, j) => (j === k ? { ...x, pick: e.target.checked } : x)))}
                  />
                  <div className="sr-body">
                    <div className="sr-title">
                      {r.state === "pending" && <Loader2 size={13} className="spin" />}
                      {r.found ? r.found.title : r.input}
                      {r.state === "ok" && <em>{r.found!.kind === "wechat-album" ? "公众号合集" : "RSS"} · {r.found!.count} 篇</em>}
                      {r.state === "exists" && <em>已订阅</em>}
                    </div>
                    {r.state === "error" && <div className="sr-error">{r.error}</div>}
                    {r.found && (
                      <ul className="sr-latest">
                        {r.found.latest.map((l, i) => (
                          <li key={i}>
                            <span>{l.title}</span>
                            <time>{fmt(l.publishedAt)}</time>
                          </li>
                        ))}
                      </ul>
                    )}
                    {r.state === "ok" && (
                      <div className="sr-interests">
                        <span>阅读兴趣</span>
                        <InterestPicker
                          value={r.interests}
                          all={[...new Set([...knownInterests, ...rows.flatMap((x) => x.interests)])]}
                          onChange={(v) => setRows((rs) => rs.map((x, j) => (j === k ? { ...x, interests: v } : x)))}
                        />
                      </div>
                    )}
                    <div className="sr-url">{r.found?.feedUrl ?? r.input}</div>
                  </div>
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button className="batch-btn" disabled={busy} onClick={() => setPhase("input")}>
                返回修改
              </button>
              <span className="nb-spacer" />
              <button className="primary-btn" disabled={busy || !rows.some((r) => r.pick)} onClick={add}>
                {phase === "adding" ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
                {phase === "adding" ? "正在获取文章…" : `添加 ${rows.filter((r) => r.pick).length} 个订阅`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
