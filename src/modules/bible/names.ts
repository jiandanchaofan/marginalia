/**
 * Names a person may type for each book: the full Chinese name, the one-character / short Chinese abbreviations used in
 * the 和合本 (约 = 约翰福音), and English names and abbreviations. Lower case, no spaces: `norm()` is applied to input.
 */
export const BOOK_NAMES: Record<string, string[]> = {
  GEN: ["创世记", "创", "genesis", "gen", "ge", "gn"],
  EXO: ["出埃及记", "出", "exodus", "exod", "exo", "ex"],
  LEV: ["利未记", "利", "leviticus", "lev", "le", "lv"],
  NUM: ["民数记", "民", "numbers", "num", "nu", "nm"],
  DEU: ["申命记", "申", "deuteronomy", "deut", "deu", "dt"],
  JOS: ["约书亚记", "书", "joshua", "josh", "jos"],
  JDG: ["士师记", "士", "judges", "judg", "jdg", "jg"],
  RUT: ["路得记", "得", "ruth", "rut", "ru"],
  "1SA": ["撒母耳记上", "撒上", "1samuel", "1sam", "1sa", "isam", "1s"],
  "2SA": ["撒母耳记下", "撒下", "2samuel", "2sam", "2sa", "iisam", "2s"],
  "1KI": ["列王纪上", "王上", "1kings", "1kgs", "1ki", "ikgs", "1k"],
  "2KI": ["列王纪下", "王下", "2kings", "2kgs", "2ki", "iikgs", "2k"],
  "1CH": ["历代志上", "代上", "1chronicles", "1chron", "1chr", "1ch", "ichr"],
  "2CH": ["历代志下", "代下", "2chronicles", "2chron", "2chr", "2ch", "iichr"],
  EZR: ["以斯拉记", "拉", "ezra", "ezr"],
  NEH: ["尼希米记", "尼", "nehemiah", "neh", "ne"],
  EST: ["以斯帖记", "斯", "esther", "esth", "est", "es"],
  JOB: ["约伯记", "伯", "job", "jb"],
  PSA: ["诗篇", "诗", "psalms", "psalm", "ps", "psa", "pss"],
  PRO: ["箴言", "箴", "proverbs", "prov", "pro", "pr", "prv"],
  ECC: ["传道书", "传", "ecclesiastes", "eccles", "eccl", "ecc", "ec"],
  SNG: ["雅歌", "歌", "songofsolomon", "songofsongs", "song", "sos", "sng", "so"],
  ISA: ["以赛亚书", "赛", "isaiah", "isa", "is"],
  JER: ["耶利米书", "耶", "jeremiah", "jer", "je"],
  LAM: ["耶利米哀歌", "哀", "lamentations", "lam", "la"],
  EZK: ["以西结书", "结", "ezekiel", "ezek", "eze", "ezk"],
  DAN: ["但以理书", "但", "daniel", "dan", "da", "dn"],
  HOS: ["何西阿书", "何", "hosea", "hos", "ho"],
  JOL: ["约珥书", "珥", "joel", "joe", "jl"],
  AMO: ["阿摩司书", "摩", "amos", "amo", "am"],
  OBA: ["俄巴底亚书", "俄", "obadiah", "obad", "oba", "ob"],
  JON: ["约拿书", "拿", "jonah", "jon", "jnh"],
  MIC: ["弥迦书", "弥", "micah", "mic", "mi"],
  NAM: ["那鸿书", "鸿", "nahum", "nah", "na"],
  HAB: ["哈巴谷书", "哈", "habakkuk", "hab", "hb"],
  ZEP: ["西番雅书", "番", "zephaniah", "zeph", "zep", "zp"],
  HAG: ["哈该书", "该", "haggai", "hag", "hg"],
  ZEC: ["撒迦利亚书", "亚", "zechariah", "zech", "zec", "zc"],
  MAL: ["玛拉基书", "玛", "malachi", "mal", "ml"],
  MAT: ["马太福音", "太", "matthew", "matt", "mat", "mt"],
  MRK: ["马可福音", "可", "mark", "mrk", "mar", "mk"],
  LUK: ["路加福音", "路", "luke", "luk", "lk"],
  JHN: ["约翰福音", "约", "john", "jhn", "joh", "jn"],
  ACT: ["使徒行传", "徒", "acts", "act", "ac"],
  ROM: ["罗马书", "罗", "romans", "rom", "ro", "rm"],
  "1CO": ["哥林多前书", "林前", "1corinthians", "1cor", "1co", "icor"],
  "2CO": ["哥林多后书", "林后", "2corinthians", "2cor", "2co", "iicor"],
  GAL: ["加拉太书", "加", "galatians", "gal", "ga"],
  EPH: ["以弗所书", "弗", "ephesians", "eph", "ep"],
  PHP: ["腓立比书", "腓", "philippians", "phil", "php", "pp"],
  COL: ["歌罗西书", "西", "colossians", "col", "co"],
  "1TH": ["帖撒罗尼迦前书", "帖前", "1thessalonians", "1thess", "1thes", "1th", "ithess"],
  "2TH": ["帖撒罗尼迦后书", "帖后", "2thessalonians", "2thess", "2thes", "2th", "iithess"],
  "1TI": ["提摩太前书", "提前", "1timothy", "1tim", "1ti", "itim"],
  "2TI": ["提摩太后书", "提后", "2timothy", "2tim", "2ti", "iitim"],
  TIT: ["提多书", "多", "titus", "tit", "ti"],
  PHM: ["腓利门书", "门", "philemon", "philem", "phlm", "phm"],
  HEB: ["希伯来书", "来", "hebrews", "heb", "he"],
  JAS: ["雅各书", "雅", "james", "jas", "jm"],
  "1PE": ["彼得前书", "彼前", "1peter", "1pet", "1pe", "1pt", "ipet"],
  "2PE": ["彼得后书", "彼后", "2peter", "2pet", "2pe", "2pt", "iipet"],
  "1JN": ["约翰一书", "约一", "约壹", "1john", "1jn", "1jo", "ijohn"],
  "2JN": ["约翰二书", "约二", "约贰", "2john", "2jn", "2jo", "iijohn"],
  "3JN": ["约翰三书", "约三", "约叁", "3john", "3jn", "3jo", "iiijohn"],
  JUD: ["犹大书", "犹", "jude", "jud", "jd"],
  REV: ["启示录", "启", "revelation", "rev", "re", "rv"],
};

/** Lower case, no spaces or dots, fullwidth punctuation to plain. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s.．。]+/g, "")
    .replace(/[：·・]/g, ":")
    .replace(/[－–—~～]/g, "-")
    .replace(/[，,]/g, ",");

/** (name as typed, normalised) -> book id, longest names first so "约一" wins over "约". */
export const NAME_INDEX: { name: string; book: string }[] = Object.entries(BOOK_NAMES)
  .flatMap(([book, names]) => names.map((n) => ({ name: norm(n), book })))
  .sort((a, b) => b.name.length - a.name.length);
