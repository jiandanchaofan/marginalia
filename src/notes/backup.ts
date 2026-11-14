import type { BookRecord } from "../core/types";
import { backupApi, type BackupStatus } from "../platform";
import { notesStore, dayKey } from "./store";
import { imageIdsOf, notesToMarkdown } from "./query";
import { relationsFor } from "./relations";
import { tasksStore } from "../tasks/store";
import { goalStore } from "../tasks/goalStore";
import { tasksToMarkdown } from "../tasks/markdown";
import { t } from "../i18n";
import { readingStore } from "../reading/store";
import { readingToMarkdown } from "../reading/markdown";
import { reviewStore } from "../review/store";
import { reviewToMarkdown } from "../review/markdown";

let running = false;

/** Export every note as one Markdown file (+ its pictures) into the Markdown backup folder. */
export async function runMdBackup(books: BookRecord[]): Promise<BackupStatus> {
  if (running) throw new Error(t("bk.running"));
  running = true;
  try {
    const hits = (await notesStore.query({ sort: "time", limit: -1 })).items;
    const map = new Map(books.map((b) => [b.id, b]));
    let md = notesToMarkdown(hits, map, t("bk.title"), await relationsFor(hits));
    const extra = tasksToMarkdown(await tasksStore.all(), (await goalStore.all()).goals, (await goalStore.all()).links);
    if (extra.trim()) md = `${md.trimEnd()}

---

# ${t("bk.tasks")}

${extra}`;
    const log = readingToMarkdown(await readingStore.all(), map);
    if (log.trim()) md = `${md.trimEnd()}

---

# ${t("bk.reading")}

${log}`;
    const rv = reviewToMarkdown(await reviewStore.all(), hits);
    if (rv.trim()) md = `${md.trimEnd()}

---

# ${t("bk.review")}

${rv}`;
    return await backupApi.mdWrite(md, imageIdsOf(hits));
  } finally {
    running = false;
  }
}

/** Once a day (the first check after launch, then hourly), if the Markdown backup is switched on. */
export function scheduleMdBackup(getBooks: () => BookRecord[]) {
  if (!backupApi.available) return () => {};
  const check = async () => {
    try {
      const s = await backupApi.status();
      if (s.config.mdEnabled && s.mdLast?.slice(0, 10) !== dayKey(Date.now())) await runMdBackup(getBooks());
    } catch (e) {
      console.warn("markdown backup failed", e);
    }
  };
  const first = window.setTimeout(check, 30_000);
  const every = window.setInterval(check, 3_600_000);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
