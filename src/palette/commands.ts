import type { Tab } from "../components/SettingsDialog";
import type { Key } from "../i18n/zh-Hans";
import { t } from "../i18n";
import { postIntent, type Intent } from "./intent";

export type View = "shelf" | "feeds" | "notes" | "tasks";

/** What a command can do to the app. App supplies these. */
export interface Actions {
  view(v: View): void;
  settings(tab?: Tab): void;
  importDocs(): void;
  clip(): void;
  toggleTheme(): void;
  lang(l: "zh-Hans" | "zh-Hant" | "en"): void;
  card(k: "notes" | "todo"): void;
  capture(kind: "note" | "task"): void;
  desktop: boolean;
}

export interface Command {
  id: string;
  title: string;
  /** Extra words that also find it. */
  words: string;
  /** Short grey line under the title. */
  sub?: string;
  icon: "cmd" | "page";
  /** Whether it belongs to the first screen. */
  common?: boolean;
  run(a: Actions): void;
}

const go = (view: View, i?: Intent) => (a: Actions) => {
  if (i) postIntent(i);
  a.view(view);
};

/** Every command, in the order they are listed. Titles are read at call time so they follow the interface language. */
export function allCommands(desktop: boolean): Command[] {
  const goTo = (name: string) => t("pal.goTo", { name });
  const setTo = (name: string, tab: Tab, sub?: string): Command => ({ id: `settings-${tab}`, title: t("pal.setTo", { name }), words: `settings 设置 設定 ${name}`, sub, icon: "page", run: (a) => a.settings(tab) });
  const page = (id: string, name: string, view: View, i?: Intent, extra = "", common = false): Command => ({ id, title: goTo(name), words: `${name} ${extra}`, icon: "page", common, run: go(view, i) });
  const list = (id: string, key: Key, listKey: "inbox" | "today" | "week7" | "week" | "overdue" | "all" | "done" | "nogoal"): Command =>
    page(id, t(key), "tasks", { to: "tasks", view: "list", list: listKey });

  const cmds: Command[] = [
    { id: "new-note", title: t("pal.newNote"), words: "new note memo 新建 新增 随手记 隨手記", icon: "cmd", common: true, run: (a) => a.capture("note") },
    { id: "new-task", title: t("pal.newTask"), words: "new task todo 新建 新增 待办 待辦", icon: "cmd", common: true, run: (a) => a.capture("task") },
    { id: "import", title: t("shelf.import"), words: "import 导入 匯入 文档 文件", icon: "cmd", run: (a) => a.importDocs() },
    { id: "clip", title: t("pal.clip"), words: "clip web article 网页 網頁 文章 剪藏", icon: "cmd", run: (a) => a.clip() },

    page("page-notes", t("shelf.tab.notes"), "notes", { to: "hub", mode: "all" }, "notes"),
    page("page-shelf", t("shelf.tab.shelf"), "shelf", undefined, "shelf library"),
    page("page-tasks", t("shelf.tab.tasks"), "tasks", { to: "tasks", view: "list", list: "today" }, "tasks todo"),
    page("page-feeds", t("shelf.tab.explore"), "feeds", undefined, "explore feeds rss 订阅 訂閱"),

    page("hub-all", t("hub.all"), "notes", { to: "hub", mode: "all" }, "all notes"),
    page("hub-graph", t("hub.graph"), "notes", { to: "hub", mode: "graph" }, "graph"),
    page("hub-free", t("hub.free"), "notes", { to: "hub", mode: "free" }, "memo"),
    page("hub-books", t("hub.books"), "notes", { to: "hub", mode: "books" }, "books"),
    page("hub-articles", t("hub.articles"), "notes", { to: "hub", mode: "articles" }, "articles"),
    page("hub-review", t("hub.review"), "notes", { to: "hub", mode: "review" }, "review 回顾 回顧", true),
    page("hub-trash", t("tr.openNotes"), "notes", { to: "hub", mode: "trash" }, "trash recycle bin 回收站 删除"),
    page("hub-topics", t("tpo.title"), "notes", { to: "hub", mode: "topics" }, "topics tags 主题 主題"),

    page("tasks-month", t("tasks.thisMonth"), "tasks", { to: "tasks", view: "month" }, "month goals"),
    page("tasks-matrix", t("mx.nav"), "tasks", { to: "tasks", view: "matrix" }, "matrix quadrant eisenhower 四象限 重要 紧急"),
    page("tasks-year", t("tasks.yearGoals"), "tasks", { to: "tasks", view: "year" }, "year goals"),
    page("tasks-archive", t("tasks.archive"), "tasks", { to: "tasks", view: "archive" }, "archive"),
    list("list-inbox", "list.inbox", "inbox"),
    list("list-today", "list.today", "today"),
    list("list-week7", "list.week7", "week7"),
    list("list-week", "list.week", "week"),
    list("list-overdue", "list.overdue", "overdue"),
    list("list-all", "list.all", "all"),
    list("list-done", "list.done", "done"),
    list("list-nogoal", "tasks.noGoal", "nogoal"),
    page("tasks-trash", t("tr.openTasks"), "tasks", { to: "tasks", view: "trash" }, "trash recycle bin 回收站 删除"),
    page("tasks-weekly", t("wr.nav"), "tasks", { to: "tasks", view: "weekly" }, "weekly review"),

    { id: "settings", title: t("pal.openSettings"), words: "settings 设置 設定", icon: "page", common: true, run: (a) => a.settings() },
    setTo(t("settings.tab.look"), "look"),
    setTo(t("settings.tab.general"), "general"),
    setTo(t("settings.tab.keys"), "keys"),
    setTo(t("settings.tab.plugins"), "plugins"),
    setTo(t("settings.tab.backup"), "backup"),
    setTo(t("settings.tab.about"), "about"),

    { id: "theme", title: t("pal.theme"), words: "theme dark light 主题 主題 深色 浅色 淺色", icon: "cmd", run: (a) => a.toggleTheme() },
    { id: "lang-hans", title: t("pal.langHans"), words: "language 语言 語言 简体 簡體", icon: "cmd", run: (a) => a.lang("zh-Hans") },
    { id: "lang-hant", title: t("pal.langHant"), words: "language 语言 語言 繁体 繁體", icon: "cmd", run: (a) => a.lang("zh-Hant") },
    { id: "lang-en", title: t("pal.langEn"), words: "language 语言 語言 english 英文", icon: "cmd", run: (a) => a.lang("en") },
  ];
  if (desktop) {
    cmds.push(
      { id: "card-notes", title: t("pal.cardNotes"), words: "card widget 卡片 桌面", icon: "cmd", run: (a) => a.card("notes") },
      { id: "card-todo", title: t("pal.cardTodo"), words: "card widget 卡片 桌面", icon: "cmd", run: (a) => a.card("todo") },
    );
  }
  return cmds;
}
