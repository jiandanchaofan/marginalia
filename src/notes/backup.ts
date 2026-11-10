import type { BookRecord } from "../core/types";
import { backupApi, type BackupStatus } from "../platform";
import { notesStore, dayKey } from "./store";
import { imageIdsOf, notesToMarkdown } from "./query";

let running = false;

/** Export every note as one Markdown file (+ its pictures) into the Markdown backup folder. */
export async function runMdBackup(books: BookRecord[]): Promise<BackupStatus> {
  if (running) throw new Error("正在导出，请稍候");
  running = true;
  try {
    const hits = (await notesStore.query({ sort: "time", limit: -1 })).items;
    const map = new Map(books.map((b) => [b.id, b]));
    return await backupApi.mdWrite(notesToMarkdown(hits, map, "墨边笔记备份"), imageIdsOf(hits));
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
