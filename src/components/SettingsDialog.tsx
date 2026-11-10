import { useEffect, useState } from "react";
import { DatabaseBackup, FileText, FolderOpen, Info, Palette, X } from "lucide-react";
import type { BookRecord } from "../core/types";
import type { Settings } from "../settings";
import { appVersion, backupApi, isTauri, type BackupStatus } from "../platform";
import { runMdBackup } from "../notes/backup";
import { SettingsPanel } from "./Panels";

type Tab = "look" | "backup" | "about";

interface Props {
  settings: Settings;
  books: BookRecord[];
  onChange(p: Partial<Settings>): void;
  onClose(): void;
  notify(msg: string): void;
}

const stampText = (s: string | null) => (s ? s.replace("_", " ").replace(/(\d\d)(\d\d)(\d\d)$/, "$1:$2:$3") : "还没有");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SettingsDialog({ settings, books, onChange, onClose, notify }: Props) {
  const [tab, setTab] = useState<Tab>("look");
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-btn modal-close" onClick={onClose} title="关闭">
          <X size={18} />
        </button>
        <h2>设置</h2>
        <div className="segmented settings-tabs">
          <button className={tab === "look" ? "on" : ""} onClick={() => setTab("look")}>
            <Palette size={14} /> 外观与阅读
          </button>
          <button className={tab === "backup" ? "on" : ""} onClick={() => setTab("backup")}>
            <DatabaseBackup size={14} /> 数据与备份
          </button>
          <button className={tab === "about" ? "on" : ""} onClick={() => setTab("about")}>
            <Info size={14} /> 关于
          </button>
        </div>
        <div className="settings-pane">
          {tab === "look" && <SettingsPanel s={settings} onChange={onChange} isPdf={false} canZoom={isTauri} libZoom />}
          {tab === "backup" && <BackupPane books={books} notify={notify} />}
          {tab === "about" && <AboutPane />}
        </div>
      </div>
    </div>
  );
}

function BackupPane({ books, notify }: { books: BookRecord[]; notify(msg: string): void }) {
  const [st, setSt] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState<"db" | "md" | null>(null);

  useEffect(() => {
    if (backupApi.available) backupApi.status().then(setSt, (e) => notify(`读取备份状态失败：${errText(e)}`));
  }, [notify]);

  if (!backupApi.available) return <p className="settings-hint">备份只在桌面版中可用（网页预览模式的数据保存在浏览器里）。</p>;
  if (!st) return <p className="settings-hint">正在读取…</p>;

  const save = async (patch: Partial<BackupStatus["config"]>) => {
    try {
      setSt(await backupApi.setConfig({ ...st.config, ...patch }));
    } catch (e) {
      notify(errText(e));
    }
  };
  const choose = async (key: "dbDir" | "mdDir", title: string) => {
    const dir = await backupApi.pickDir(title);
    if (dir) await save({ [key]: dir });
  };
  const run = async (kind: "db" | "md") => {
    setBusy(kind);
    try {
      setSt(kind === "db" ? await backupApi.dbNow() : await runMdBackup(books));
      notify(kind === "db" ? "数据库备份完成" : "已导出为 Markdown");
    } catch (e) {
      notify(`备份失败：${errText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const folder = (key: "dbDir" | "mdDir", dir: string, def: string, title: string) => (
    <div className="backup-folder">
      <div className="backup-path" title={dir}>
        {dir}
      </div>
      <div className="backup-folder-btns">
        <button className="panel-btn" onClick={() => choose(key, title)}>
          更改…
        </button>
        {st.config[key] && (
          <button className="panel-btn" onClick={() => save({ [key]: null })} title={def}>
            恢复默认
          </button>
        )}
        <button className="panel-btn" onClick={() => backupApi.openDir(dir).catch((e) => notify(errText(e)))}>
          <FolderOpen size={13} /> 打开
        </button>
      </div>
    </div>
  );

  return (
    <div className="backup-pane">
      <section>
        <h3>
          <DatabaseBackup size={15} /> 数据库备份
        </h3>
        <p className="settings-hint">每天自动备份一份完整的笔记数据库（含订阅），保留最近 3 份；笔记里的图片同步复制到同一文件夹的 images 里。可用于完整恢复。</p>
        {folder("dbDir", st.dbDir, st.defaultDbDir, "选择数据库备份文件夹")}
        <div className="backup-line">
          <span>
            最近一次：{st.dbLast ?? "还没有"}　·　已保留 {st.dbCount} 份
          </span>
          <button className="panel-btn" disabled={busy !== null} onClick={() => run("db")}>
            {busy === "db" ? "备份中…" : "立即备份"}
          </button>
        </div>
      </section>

      <section>
        <h3>
          <FileText size={15} /> Markdown 备份
        </h3>
        <p className="settings-hint">
          每天自动把全部笔记导出成一个 Markdown 文件（notes.md，图片用 Obsidian 的 ![[ ]] 嵌入，放在同级 images 文件夹），每次一个独立文件夹，保留最近 3 份。可直接用 Obsidian 等软件打开。
        </p>
        <label className="check">
          <input type="checkbox" checked={st.config.mdEnabled} onChange={(e) => save({ mdEnabled: e.target.checked })} /> 启用 Markdown 自动备份
        </label>
        {folder("mdDir", st.mdDir, st.defaultMdDir, "选择 Markdown 备份文件夹")}
        <div className="backup-line">
          <span>
            最近一次：{stampText(st.mdLast)}　·　已保留 {st.mdCount} 份
          </span>
          <button className="panel-btn" disabled={busy !== null} onClick={() => run("md")}>
            {busy === "md" ? "导出中…" : "立即导出"}
          </button>
        </div>
      </section>
      <p className="settings-hint">自动备份在墨边运行期间进行；两种备份的文件夹互相独立，可以分别放到网盘同步目录或移动硬盘上。</p>
    </div>
  );
}

const FEATURES: [string, string][] = [
  ["阅读", "支持 EPUB、PDF、TXT、Markdown、HTML 文档；主题、中英文字体、字号、行距、缩进都可以调整，进度自动记住。"],
  ["划线与批注", "选中文字即可高亮或划线，多种颜色和样式；想法写在原文旁边，可以双侧、单侧或收起显示。"],
  ["标签", "在笔记里写 #标签 即可归类，支持 #父/子 的层级标签，可重命名、合并和置顶。"],
  ["笔记页", "汇总所有书和文章里的笔记，按标签、颜色、类型、时间筛选和搜索；支持每日回顾、写作热力图，并可导出为 Markdown（含图片）。"],
  ["随手记", "记录与书籍、文章无关的想法，随时一句话记下来，同样参与标签、搜索和热力图。"],
  ["笔记配图", "在任何笔记里粘贴截图、拖入图片或选择本地图片；列表里显示缩略图，点开看大图，滚轮缩放。"],
  ["书架", "导入的书和文章集中管理，可为每本标注「阅读兴趣」，按兴趣分类筛选。"],
  ["探索", "订阅博客、网站（RSS / Atom）和公众号合集，新文章汇成收件箱；喜欢的点「保存精读」存入书架，偶遇的好文章用「添加网文」，或直接 Ctrl + V 粘贴网址。"],
  ["备份", "每天自动备份数据库，也可导出为 Markdown，两种备份各有独立的文件夹，可在「数据与备份」里设置。"],
];

function AboutPane() {
  const [v, setV] = useState("");
  useEffect(() => {
    appVersion().then(setV, () => setV(""));
  }, []);
  return (
    <div className="about-pane">
      <div className="about-brand">
        <span className="brand-mark">墨</span>
        <div>
          <div className="brand-name">墨边 · Marginalia</div>
          <div className="brand-sub">墨落两边，读懂字里行间</div>
        </div>
      </div>
      <p className="about-name">「墨边」意为墨迹落在书页的边缘；Marginalia 是拉丁语，指读者写在书页空白处的批注，这也正是这个应用想帮你留下的东西。</p>
      <p>版本 {v}</p>
      <h3>功能介绍</h3>
      <ul className="about-list">
        {FEATURES.map(([title, text]) => (
          <li key={title}>
            <b>{title}</b>
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
