import { t } from "../i18n";
import { settingsStore } from "../platform";
import { DEFAULT_SETTINGS, DEFAULT_WEEK_TAG, normalizeSettings } from "../settings";
import type { Key } from "../i18n/zh-Hans";

/** Words that can follow `!` in a todo line, in every language → priority level. */
const PRIORITY: Record<string, 1 | 2 | 3> = { 低: 1, 中: 2, 高: 3, low: 1, med: 2, medium: 2, mid: 2, high: 3, hi: 3 };
export const priorityFromWord = (w: string): 0 | 1 | 2 | 3 => PRIORITY[w.toLowerCase()] ?? 0;
/** What gets written for a priority level: in the current UI language. */
export const priorityWord = (p: number): string => (p >= 1 && p <= 3 ? t(`tok.pri${p}` as Key) : "");
/** Words that mark a deadline (all languages) as a regex source, and the one written now. */
export const DEADLINE_WORDS = "(?:截止|截至|due)";
export const PRIORITY_WORDS_RE = "(?:高|中|低|high|hi|medium|med|mid|low)";
export const deadlineToken = () => t("tok.due");
/** Tag of the weekly review note: what the user set (default Lifelog/WeeklyReview). */
export const weekTag = () => normalizeSettings(settingsStore.load(DEFAULT_SETTINGS)).weekTag ?? DEFAULT_WEEK_TAG;
/** Tag of the review note after finishing a to-do (current language). */
export const reviewTag = () => t("tok.reviewTag");
