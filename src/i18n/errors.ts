import { getLang, t } from "./index";
import type { Key } from "./zh-Hans";

/**
 * Error texts produced by the Rust side are Chinese sentences. They are shown to the user in the current language
 * by matching them here (the longest sentences first; `{a}` is whatever follows or fills the sentence).
 */
const PATTERNS: [RegExp, Key][] = [
  [/这份数据来自更新版本的「墨边」，当前版本无法安全读取。请先升级应用，数据没有被改动。/g, "rs.newerData"],
  [/公众号合集暂时无法访问（可能需要稍后重试）/g, "rs.albumDown"],
  [/公众号合集返回了无法识别的内容/g, "rs.albumUnreadable"],
  [/这个网址不是网页（可能是文件下载链接）/g, "rs.notWebPage"],
  [/无法连接到该网站，请检查网络或代理设置/g, "rs.noConnectSite"],
  [/无法连接（请检查网络或代理）/g, "rs.noConnect"],
  [/连接超时，请稍后重试/g, "rs.timeoutRetry"],
  [/连接超时/g, "rs.timeout"],
  [/不能把标签移到它自己的子标签下/g, "rs.tagSelf"],
  [/任务指向的笔记或上级任务不存在/g, "rs.taskParent"],
  [/不是有效的 RSS \/ Atom 订阅源/g, "rs.notFeed"],
  [/图片为空或超过 20MB/g, "rs.imageSize"],
  [/不能把笔记连接到它自己/g, "rs.selfLink"],
  [/要连接的笔记不存在/g, "rs.linkMissing"],
  [/目标或待办不存在/g, "rs.goalMissing"],
  [/只支持 http \/ https 网址/g, "rs.httpOnly"],
  [/不支持的图片格式/g, "rs.imageFormat"],
  [/无效的图片 id/g, "rs.imageId"],
  [/无效的导出路径/g, "rs.exportPath"],
  [/标签名不能为空/g, "rs.tagEmpty"],
  [/网址格式不正确/g, "rs.badUrl"],
  [/跳转次数过多/g, "rs.redirects"],
  [/订阅源过大/g, "rs.feedTooBig"],
  [/内容过大/g, "rs.tooBig"],
  [/不是图片/g, "rs.notImage"],
  [/无法使用文件夹 (\S+?)：/g, "rs.folderUnusable"],
  [/文件夹 (\S+?) 不可写：/g, "rs.folderReadonly"],
  [/暂不支持的格式: \.(\w+)/g, "rs.formatUnsupported"],
  [/网页返回错误 (\d+)/g, "rs.pageStatus"],
  [/图片返回错误 (\d+)/g, "rs.imageStatus"],
  [/服务器返回 (\d+)/g, "rs.server"],
  [/网络错误：/g, "rs.network"],
  [/读取文件失败: /g, "rs.readFail"],
  [/书籍文件丢失: /g, "rs.bookMissing"],
  [/无法打开笔记数据库: /g, "rs.dbOpen"],
  [/无法初始化订阅表: /g, "rs.feedsInit"],
];

/** `text` with the known Rust sentences replaced by the current language (unchanged in simplified Chinese). */
export function localizeErr(text: string): string {
  if (getLang() === "zh-Hans" || !/[一-鿿]/.test(text)) return text;
  let out = text;
  for (const [re, key] of PATTERNS) {
    // sentences that continue after a colon ("网络错误：<details>") keep their trailing details as they are
    out = out.replace(re, (_m, a?: string) => t(key, { a: a ?? "" }));
  }
  return out;
}
