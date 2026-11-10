import type { TocItem } from "../core/types";
import type { ModePref } from "../core/layout";
import { EN_FONTS, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, type EnFontChoice, type FontChoice, type Settings, type Theme } from "../settings";

export function TocPanel({ toc, current, onGo }: { toc: TocItem[]; current: number; onGo(t: TocItem): void }) {
  const render = (items: TocItem[], depth: number) =>
    items.map((t, i) => (
      <div key={`${depth}-${i}`}>
        <button
          className={`toc-item ${t.section === current ? "on" : ""}`}
          style={{ paddingLeft: 14 + depth * 14 }}
          disabled={t.section < 0}
          onClick={() => onGo(t)}
        >
          {t.label || "（无标题）"}
        </button>
        {t.children.length > 0 && render(t.children, depth + 1)}
      </div>
    ));
  return (
    <div className="toc-list">
      {toc.length ? render(toc, 0) : <div className="panel-empty">此文档没有目录</div>}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange(v: T): void }) {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPanel({ s, onChange, isPdf, canZoom = false, libZoom = false, stage }: { s: Settings; onChange(p: Partial<Settings>): void; isPdf: boolean; canZoom?: boolean; libZoom?: boolean; stage?: { mode: string; width: number; dual: number; single: number } }) {
  return (
    <div className="panel settings-panel">
      <div className="panel-title">阅读设置</div>
      <div className="settings-body">
        <label>主题</label>
        <div className="theme-row">
          {(
            [
              ["paper", "纸张"],
              ["light", "素白"],
              ["dark", "夜读"],
            ] as [Theme, string][]
          ).map(([t, name]) => (
            <button key={t} className={`theme-swatch t-${t} ${s.theme === t ? "on" : ""}`} onClick={() => onChange({ theme: t })}>
              <span>文</span>
              {name}
            </button>
          ))}
        </div>
        {canZoom && (
          <>
            {libZoom && (
              <>
                <label>
                  书架与笔记缩放 <em>{Math.round(s.libZoom * 100)}%</em>
                  {s.libZoom !== 1 && (
                    <button className="zoom-reset" onClick={() => onChange({ libZoom: 1 })}>
                      还原
                    </button>
                  )}
                </label>
                <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={ZOOM_STEP} value={s.libZoom} onChange={(e) => onChange({ libZoom: Math.round(+e.target.value * 10) / 10 })} />
                <p className="settings-hint">放大书架、笔记、探索页面。在这些页面里也可以用 Ctrl + 加号 / 减号、Ctrl + 滚轮，Ctrl + 0 还原。</p>
              </>
            )}
            <label>
              阅读界面缩放 <em>{Math.round(s.zoom * 100)}%</em>
              {s.zoom !== 1 && (
                <button className="zoom-reset" onClick={() => onChange({ zoom: 1 })}>
                  还原
                </button>
              )}
            </label>
            <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={ZOOM_STEP} value={s.zoom} onChange={(e) => onChange({ zoom: Math.round(+e.target.value * 10) / 10 })} />
            <p className="settings-hint">放大整个阅读界面（正文、笔记、PDF 页面一起）。阅读时用 Ctrl + 加号 / 减号、Ctrl + 滚轮，Ctrl + 0 还原。</p>
          </>
        )}
        {!isPdf && (
          <>
            <label>字体</label>
            <Segmented<FontChoice>
              value={s.font}
              options={[
                ["serif", "宋体"],
                ["kai", "楷体"],
                ["sans", "黑体"],
              ]}
              onChange={(font) => onChange({ font })}
            />
            <label>英文字体</label>
            <div className="font-grid">
              {EN_FONTS.map((f) => (
                <button key={f.key} className={`font-card ${s.fontEn === f.key ? "on" : ""}`} onClick={() => onChange({ fontEn: f.key as EnFontChoice, fontEnUser: true })} title={f.note}>
                  <span className="font-sample" style={f.stack ? { fontFamily: f.stack } : undefined}>
                    Reading quietly, 1984.
                  </span>
                  <span className="font-name">
                    {f.label}
                    {f.builtin && <em className="font-builtin">内置</em>}
                  </span>
                </button>
              ))}
            </div>
            {(s.font !== "serif" || s.fontEn !== "sourceserif") && (
              <button className="recommended-font-btn" onClick={() => onChange({ font: "serif", fontEn: "sourceserif", fontEnUser: false })}>
                恢复推荐搭配（宋体 + Source Serif）
              </button>
            )}
            <p className="settings-hint">{EN_FONTS.find((f) => f.key === s.fontEn)?.note}。中文字符仍使用上面的中文字体；若你的设备没装某款字体，会自动换成相近的。</p>
            <label>
              字号 <em>{s.fontSize}px</em>
            </label>
            <input type="range" min={14} max={28} step={1} value={s.fontSize} onChange={(e) => onChange({ fontSize: +e.target.value })} />
            <label>
              行距 <em>{s.lineHeight.toFixed(2)}</em>
            </label>
            <input type="range" min={1.4} max={2.4} step={0.05} value={s.lineHeight} onChange={(e) => onChange({ lineHeight: +e.target.value })} />
            <label className="check">
              <input type="checkbox" checked={s.indent} onChange={(e) => onChange({ indent: e.target.checked })} /> 段首缩进两字
            </label>
          </>
        )}
        <label>笔记布局</label>
        <Segmented<ModePref>
          value={s.layout}
          options={[
            ["auto", "自动"],
            ["dual", "双侧"],
            ["single", "单侧"],
            ["compact", "收起"],
            ["immersive", "沉浸"],
          ]}
          onChange={(layout) => onChange({ layout })}
        />
        <p className="settings-hint">“自动”会按窗口宽度在双侧、单侧、收起之间切换；空间不足时强制模式也会自动降级。</p>
        {stage && (
          <p className="settings-hint stage-info">
            当前可用宽度 {stage.width}px，正在使用「{{ dual: "双侧", single: "单侧", compact: "收起", immersive: "沉浸" }[stage.mode] ?? stage.mode}」。双侧需要至少 {stage.dual}px，单侧至少 {stage.single}px；
            {stage.mode === "dual" ? "宽度充足。" : "不够时可以把窗口拉宽，或按 Ctrl + 减号缩小界面（高分屏的缩放比例大时尤其有用）。"}
          </p>
        )}
      </div>
    </div>
  );
}
