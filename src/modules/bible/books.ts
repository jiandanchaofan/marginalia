// The 66 books of the Protestant canon (ids are USFM / Paratext codes, the book part of references like JHN.3.16).
// Generated from the translation sources; see scripts/scripture-*.mjs.
export interface BookInfo {
  id: string;
  ord: number;
  /** Old Testament (39 books); otherwise New Testament (27). */
  ot: boolean;
  zh: string;
  en: string;
  chapters: number;
}

export const BIBLE_BOOKS: BookInfo[] = [
  { id: "GEN", ord: 1, ot: true, zh: "创世记", en: "Genesis", chapters: 50 },
  { id: "EXO", ord: 2, ot: true, zh: "出埃及记", en: "Exodus", chapters: 40 },
  { id: "LEV", ord: 3, ot: true, zh: "利未记", en: "Leviticus", chapters: 27 },
  { id: "NUM", ord: 4, ot: true, zh: "民数记", en: "Numbers", chapters: 36 },
  { id: "DEU", ord: 5, ot: true, zh: "申命记", en: "Deuteronomy", chapters: 34 },
  { id: "JOS", ord: 6, ot: true, zh: "约书亚记", en: "Joshua", chapters: 24 },
  { id: "JDG", ord: 7, ot: true, zh: "士师记", en: "Judges", chapters: 21 },
  { id: "RUT", ord: 8, ot: true, zh: "路得记", en: "Ruth", chapters: 4 },
  { id: "1SA", ord: 9, ot: true, zh: "撒母耳记上", en: "1 Samuel", chapters: 31 },
  { id: "2SA", ord: 10, ot: true, zh: "撒母耳记下", en: "2 Samuel", chapters: 24 },
  { id: "1KI", ord: 11, ot: true, zh: "列王纪上", en: "1 Kings", chapters: 22 },
  { id: "2KI", ord: 12, ot: true, zh: "列王纪下", en: "2 Kings", chapters: 25 },
  { id: "1CH", ord: 13, ot: true, zh: "历代志上", en: "1 Chronicles", chapters: 29 },
  { id: "2CH", ord: 14, ot: true, zh: "历代志下", en: "2 Chronicles", chapters: 36 },
  { id: "EZR", ord: 15, ot: true, zh: "以斯拉记", en: "Ezra", chapters: 10 },
  { id: "NEH", ord: 16, ot: true, zh: "尼希米记", en: "Nehemiah", chapters: 13 },
  { id: "EST", ord: 17, ot: true, zh: "以斯帖记", en: "Esther", chapters: 10 },
  { id: "JOB", ord: 18, ot: true, zh: "约伯记", en: "Job", chapters: 42 },
  { id: "PSA", ord: 19, ot: true, zh: "诗篇", en: "Psalms", chapters: 150 },
  { id: "PRO", ord: 20, ot: true, zh: "箴言", en: "Proverbs", chapters: 31 },
  { id: "ECC", ord: 21, ot: true, zh: "传道书", en: "Ecclesiastes", chapters: 12 },
  { id: "SNG", ord: 22, ot: true, zh: "雅歌", en: "Song of Solomon", chapters: 8 },
  { id: "ISA", ord: 23, ot: true, zh: "以赛亚书", en: "Isaiah", chapters: 66 },
  { id: "JER", ord: 24, ot: true, zh: "耶利米书", en: "Jeremiah", chapters: 52 },
  { id: "LAM", ord: 25, ot: true, zh: "耶利米哀歌", en: "Lamentations", chapters: 5 },
  { id: "EZK", ord: 26, ot: true, zh: "以西结书", en: "Ezekiel", chapters: 48 },
  { id: "DAN", ord: 27, ot: true, zh: "但以理书", en: "Daniel", chapters: 12 },
  { id: "HOS", ord: 28, ot: true, zh: "何西阿书", en: "Hosea", chapters: 14 },
  { id: "JOL", ord: 29, ot: true, zh: "约珥书", en: "Joel", chapters: 3 },
  { id: "AMO", ord: 30, ot: true, zh: "阿摩司书", en: "Amos", chapters: 9 },
  { id: "OBA", ord: 31, ot: true, zh: "俄巴底亚书", en: "Obadiah", chapters: 1 },
  { id: "JON", ord: 32, ot: true, zh: "约拿书", en: "Jonah", chapters: 4 },
  { id: "MIC", ord: 33, ot: true, zh: "弥迦书", en: "Micah", chapters: 7 },
  { id: "NAM", ord: 34, ot: true, zh: "那鸿书", en: "Nahum", chapters: 3 },
  { id: "HAB", ord: 35, ot: true, zh: "哈巴谷书", en: "Habakkuk", chapters: 3 },
  { id: "ZEP", ord: 36, ot: true, zh: "西番雅书", en: "Zephaniah", chapters: 3 },
  { id: "HAG", ord: 37, ot: true, zh: "哈该书", en: "Haggai", chapters: 2 },
  { id: "ZEC", ord: 38, ot: true, zh: "撒迦利亚书", en: "Zechariah", chapters: 14 },
  { id: "MAL", ord: 39, ot: true, zh: "玛拉基书", en: "Malachi", chapters: 4 },
  { id: "MAT", ord: 40, ot: false, zh: "马太福音", en: "Matthew", chapters: 28 },
  { id: "MRK", ord: 41, ot: false, zh: "马可福音", en: "Mark", chapters: 16 },
  { id: "LUK", ord: 42, ot: false, zh: "路加福音", en: "Luke", chapters: 24 },
  { id: "JHN", ord: 43, ot: false, zh: "约翰福音", en: "John", chapters: 21 },
  { id: "ACT", ord: 44, ot: false, zh: "使徒行传", en: "Acts", chapters: 28 },
  { id: "ROM", ord: 45, ot: false, zh: "罗马书", en: "Romans", chapters: 16 },
  { id: "1CO", ord: 46, ot: false, zh: "哥林多前书", en: "1 Corinthians", chapters: 16 },
  { id: "2CO", ord: 47, ot: false, zh: "哥林多后书", en: "2 Corinthians", chapters: 13 },
  { id: "GAL", ord: 48, ot: false, zh: "加拉太书", en: "Galatians", chapters: 6 },
  { id: "EPH", ord: 49, ot: false, zh: "以弗所书", en: "Ephesians", chapters: 6 },
  { id: "PHP", ord: 50, ot: false, zh: "腓立比书", en: "Philippians", chapters: 4 },
  { id: "COL", ord: 51, ot: false, zh: "歌罗西书", en: "Colossians", chapters: 4 },
  { id: "1TH", ord: 52, ot: false, zh: "帖撒罗尼迦前书", en: "1 Thessalonians", chapters: 5 },
  { id: "2TH", ord: 53, ot: false, zh: "帖撒罗尼迦后书", en: "2 Thessalonians", chapters: 3 },
  { id: "1TI", ord: 54, ot: false, zh: "提摩太前书", en: "1 Timothy", chapters: 6 },
  { id: "2TI", ord: 55, ot: false, zh: "提摩太后书", en: "2 Timothy", chapters: 4 },
  { id: "TIT", ord: 56, ot: false, zh: "提多书", en: "Titus", chapters: 3 },
  { id: "PHM", ord: 57, ot: false, zh: "腓利门书", en: "Philemon", chapters: 1 },
  { id: "HEB", ord: 58, ot: false, zh: "希伯来书", en: "Hebrews", chapters: 13 },
  { id: "JAS", ord: 59, ot: false, zh: "雅各书", en: "James", chapters: 5 },
  { id: "1PE", ord: 60, ot: false, zh: "彼得前书", en: "1 Peter", chapters: 5 },
  { id: "2PE", ord: 61, ot: false, zh: "彼得后书", en: "2 Peter", chapters: 3 },
  { id: "1JN", ord: 62, ot: false, zh: "约翰一书", en: "1 John", chapters: 5 },
  { id: "2JN", ord: 63, ot: false, zh: "约翰二书", en: "2 John", chapters: 1 },
  { id: "3JN", ord: 64, ot: false, zh: "约翰三书", en: "3 John", chapters: 1 },
  { id: "JUD", ord: 65, ot: false, zh: "犹大书", en: "Jude", chapters: 1 },
  { id: "REV", ord: 66, ot: false, zh: "启示录", en: "Revelation", chapters: 22 },
];

export const bookInfo = (id: string) => BIBLE_BOOKS.find((b) => b.id === id);
