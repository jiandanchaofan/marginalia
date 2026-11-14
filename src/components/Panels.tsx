import type { TocItem } from "../core/types";
import type { ModePref } from "../core/layout";
import { t } from "../i18n";
import type { Key } from "../i18n/zh-Hans";
import { EN_FONTS, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, type EnFontChoice, type FontChoice, type Settings, type Theme } from "../settings";

export function TocPanel({ toc, current, onGo }: { toc: TocItem[]; current: number; onGo(t: TocItem): void }) {
  const render = (items: TocItem[], depth: number) =>
    items.map((item, i) => (
      <div key={`${depth}-${i}`}>
        <button
          className={`toc-item ${item.section === current ? "on" : ""}`}
          style={{ paddingLeft: 14 + depth * 14 }}
          disabled={item.section < 0}
          onClick={() => onGo(item)}
        >
          {item.label || t("common.untitled")}
        </button>
        {item.children.length > 0 && render(item.children, depth + 1)}
      </div>
    ));
  return (
    <div className="toc-list">
      {toc.length ? render(toc, 0) : <div className="panel-empty">{t("common.noToc")}</div>}
    </div>
  );
}

/** Display name / note of an English-font choice (the three that have their own Chinese names are translated too). */
const enLabel = (f: (typeof EN_FONTS)[number]) => (f.key === "same" || f.key === "book" || f.key === "sans" ? t(`fonten.${f.key}.label` as Key) : f.label);
const enNote = (f: (typeof EN_FONTS)[number]) => t(`fonten.${f.key}.note` as Key);

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
      <div className="panel-title">{t("reading.title")}</div>
      <div className="settings-body">
        <label>{t("reading.theme")}</label>
        <div className="theme-row">
          {(
            [
              ["paper", t("reading.theme.paper")],
              ["light", t("reading.theme.light")],
              ["dark", t("reading.theme.dark")],
            ] as [Theme, string][]
          ).map(([th, name]) => (
            <button key={th} className={`theme-swatch t-${th} ${s.theme === th ? "on" : ""}`} onClick={() => onChange({ theme: th })}>
              <span>{t("reading.theme.sample")}</span>
              {name}
            </button>
          ))}
        </div>
        {canZoom && (
          <>
            {libZoom && (
              <>
                <label>
                  {t("reading.libZoom")} <em>{Math.round(s.libZoom * 100)}%</em>
                  {s.libZoom !== 1 && (
                    <button className="zoom-reset" onClick={() => onChange({ libZoom: 1 })}>
                      {t("common.reset")}
                    </button>
                  )}
                </label>
                <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={ZOOM_STEP} value={s.libZoom} onChange={(e) => onChange({ libZoom: Math.round(+e.target.value * 10) / 10 })} />
                <p className="settings-hint">{t("reading.libZoom.hint")}</p>
              </>
            )}
            <label>
              {t("reading.zoom")} <em>{Math.round(s.zoom * 100)}%</em>
              {s.zoom !== 1 && (
                <button className="zoom-reset" onClick={() => onChange({ zoom: 1 })}>
                  {t("common.reset")}
                </button>
              )}
            </label>
            <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={ZOOM_STEP} value={s.zoom} onChange={(e) => onChange({ zoom: Math.round(+e.target.value * 10) / 10 })} />
            <p className="settings-hint">{t("reading.zoom.hint")}</p>
          </>
        )}
        {!isPdf && (
          <>
            <label>{t("reading.font")}</label>
            <Segmented<FontChoice>
              value={s.font}
              options={[
                ["serif", t("reading.font.serif")],
                ["kai", t("reading.font.kai")],
                ["sans", t("reading.font.sans")],
              ]}
              onChange={(font) => onChange({ font })}
            />
            <label>{t("reading.fontEn")}</label>
            <div className="font-grid">
              {EN_FONTS.map((f) => (
                <button key={f.key} className={`font-card ${s.fontEn === f.key ? "on" : ""}`} onClick={() => onChange({ fontEn: f.key as EnFontChoice, fontEnUser: true })} title={enNote(f)}>
                  <span className="font-sample" style={f.stack ? { fontFamily: f.stack } : undefined}>
                    Reading quietly, 1984.
                  </span>
                  <span className="font-name">
                    {enLabel(f)}
                    {f.builtin && <em className="font-builtin">{t("reading.builtin")}</em>}
                  </span>
                </button>
              ))}
            </div>
            {(s.font !== "serif" || s.fontEn !== "sourceserif") && (
              <button className="recommended-font-btn" onClick={() => onChange({ font: "serif", fontEn: "sourceserif", fontEnUser: false })}>
                {t("reading.recommended")}
              </button>
            )}
            <p className="settings-hint">{t("reading.fontEn.hint", { note: enNote(EN_FONTS.find((f) => f.key === s.fontEn) ?? EN_FONTS[0]) })}</p>
            <label>
              {t("reading.size")} <em>{s.fontSize}px</em>
            </label>
            <input type="range" min={14} max={28} step={1} value={s.fontSize} onChange={(e) => onChange({ fontSize: +e.target.value })} />
            <label>
              {t("reading.lineHeight")} <em>{s.lineHeight.toFixed(2)}</em>
            </label>
            <input type="range" min={1.4} max={2.4} step={0.05} value={s.lineHeight} onChange={(e) => onChange({ lineHeight: +e.target.value })} />
            <label className="check">
              <input type="checkbox" checked={s.indent} onChange={(e) => onChange({ indent: e.target.checked })} /> {t("reading.indent")}
            </label>
          </>
        )}
        <label>{t("reading.layout")}</label>
        <Segmented<ModePref>
          value={s.layout}
          options={[
            ["auto", t("reading.layout.auto")],
            ["dual", t("reading.layout.dual")],
            ["single", t("reading.layout.single")],
            ["compact", t("reading.layout.compact")],
            ["immersive", t("reading.layout.immersive")],
          ]}
          onChange={(layout) => onChange({ layout })}
        />
        <p className="settings-hint">{t("reading.layout.hint")}</p>
        {stage && (
          <p className="settings-hint stage-info">
            {t("reading.stage", {
              width: stage.width,
              mode: t(`reading.layout.${stage.mode}` as Key),
              dual: stage.dual,
              single: stage.single,
              tail: stage.mode === "dual" ? t("reading.stage.ok") : t("reading.stage.tight"),
            })}
          </p>
        )}
      </div>
    </div>
  );
}
