//! Full-text index of the books on the shelf (their text, not the reader's notes).
//!
//! Lives in its own file (`book_text.db`): it can always be rebuilt from the books, it is big, and writing it must never
//! hold up the notes and to-dos. The frontend extracts each book's text (per section, cut into paragraph-sized chunks) and
//! hands it over; this module stores it in an FTS5 trigram table and answers searches with a short snippet and the section.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

pub struct BookIdx(pub Mutex<Connection>);

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS indexed(
  book_id TEXT PRIMARY KEY,
  chars INTEGER NOT NULL DEFAULT 0,
  sections INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(text, book_id UNINDEXED, section UNINDEXED, tokenize = 'trigram');
";

pub fn open(dir: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(dir.join("book_text.db"))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub section: i64,
    pub text: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub book_id: String,
    pub chars: i64,
    pub sections: i64,
    pub indexed_at: i64,
    pub version: i64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub book_id: String,
    pub section: i64,
    pub snippet: String,
    /// How many places in this book matched (within what was scanned).
    pub count: usize,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    /// Per book: its best hits (at most `per_book`), books in the order they were found.
    pub hits: Vec<Hit>,
    /// Books that matched at all.
    pub books: usize,
    /// The scan stopped at its limit: there may be more.
    pub truncated: bool,
}

pub fn replace(conn: &mut Connection, book_id: &str, chunks: &[Chunk], sections: i64, now: i64, version: i64) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM chunks WHERE book_id = ?1", [book_id])?;
    let mut chars = 0i64;
    {
        let mut stmt = tx.prepare("INSERT INTO chunks(text, book_id, section) VALUES(?1, ?2, ?3)")?;
        for c in chunks.iter().filter(|c| !c.text.trim().is_empty()) {
            chars += c.text.chars().count() as i64;
            stmt.execute(params![c.text, book_id, c.section])?;
        }
    }
    tx.execute(
        "INSERT INTO indexed(book_id, chars, sections, indexed_at, version) VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(book_id) DO UPDATE SET chars = excluded.chars, sections = excluded.sections, indexed_at = excluded.indexed_at, version = excluded.version",
        params![book_id, chars, sections, now, version],
    )?;
    tx.commit()
}

pub fn remove(conn: &mut Connection, book_id: &str) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM chunks WHERE book_id = ?1", [book_id])?;
    tx.execute("DELETE FROM indexed WHERE book_id = ?1", [book_id])?;
    tx.commit()
}

pub fn status(conn: &Connection) -> rusqlite::Result<Vec<Status>> {
    let mut stmt = conn.prepare("SELECT book_id, chars, sections, indexed_at, version FROM indexed")?;
    let rows = stmt.query_map([], |r| Ok(Status { book_id: r.get(0)?, chars: r.get(1)?, sections: r.get(2)?, indexed_at: r.get(3)?, version: r.get(4)? }))?;
    rows.collect()
}

/// The window around the first match (case-insensitive), cut at character boundaries.
fn snippet(text: &str, term: &str) -> String {
    let low = |c: char| c.to_lowercase().next().unwrap_or(c);
    let hay: Vec<char> = text.chars().map(low).collect();
    let needle: Vec<char> = term.chars().map(low).collect();
    let pos = if needle.is_empty() { None } else { hay.windows(needle.len()).position(|w| w == needle.as_slice()) };
    let chars: Vec<char> = text.chars().collect();
    let at = pos.unwrap_or(0);
    let from = at.saturating_sub(28);
    let to = (at + needle.len() + 70).min(chars.len());
    let mut s: String = chars[from..to].iter().collect();
    if from > 0 {
        s.insert(0, '…');
    }
    if to < chars.len() {
        s.push('…');
    }
    s
}

pub fn search(conn: &Connection, query: &str, per_book: usize, max_books: usize, only: Option<&[String]>) -> rusqlite::Result<Found> {
    const SCAN: usize = 3000;
    let term = query.trim();
    if term.chars().count() < 2 {
        return Ok(Found { hits: vec![], books: 0, truncated: false });
    }
    let (sql, arg): (&str, String) = if term.chars().count() >= 3 {
        // a trigram phrase match: the whole text must contain the words in this order
        ("SELECT book_id, section, text FROM chunks WHERE chunks MATCH ?1 LIMIT 3000", format!("\"{}\"", term.replace('"', "\"\"")))
    } else {
        // trigram needs 3 characters; a one- or two-character term is a plain scan
        ("SELECT book_id, section, text FROM chunks WHERE instr(lower(text), lower(?1)) > 0 LIMIT 3000", term.to_string())
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([arg], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))?;
    let mut order: Vec<String> = vec![];
    let mut per: std::collections::HashMap<String, (Vec<Hit>, usize)> = std::collections::HashMap::new();
    let mut seen = 0usize;
    for row in rows {
        let (book, section, text) = row?;
        seen += 1;
        if let Some(only) = only {
            if !only.contains(&book) {
                continue;
            }
        }
        let e = per.entry(book.clone()).or_insert_with(|| {
            order.push(book.clone());
            (vec![], 0)
        });
        e.1 += 1;
        if e.0.len() < per_book {
            e.0.push(Hit { book_id: book, section, snippet: snippet(&text, term), count: 0 });
        }
    }
    let books = order.len();
    let mut hits = vec![];
    for b in order.into_iter().take(max_books) {
        let (list, n) = per.remove(&b).unwrap();
        hits.extend(list.into_iter().map(|h| Hit { count: n, ..h }));
    }
    Ok(Found { hits, books, truncated: seen >= SCAN })
}

pub fn size(conn: &Connection) -> rusqlite::Result<i64> {
    let pages: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
    let page: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
    Ok(pages * page)
}

type R<T> = Result<T, String>;
fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

#[tauri::command]
pub fn bidx_status(db: tauri::State<BookIdx>) -> R<Vec<Status>> {
    let conn = db.0.lock().map_err(e)?;
    status(&conn).map_err(e)
}

#[tauri::command]
pub fn bidx_replace(db: tauri::State<BookIdx>, book_id: String, chunks: Vec<Chunk>, sections: i64, version: i64) -> R<()> {
    let mut conn = db.0.lock().map_err(e)?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    replace(&mut conn, &book_id, &chunks, sections, now, version).map_err(e)
}

#[tauri::command]
pub fn bidx_remove(db: tauri::State<BookIdx>, book_id: String) -> R<()> {
    let mut conn = db.0.lock().map_err(e)?;
    remove(&mut conn, &book_id).map_err(e)
}

#[tauri::command]
pub fn bidx_clear(db: tauri::State<BookIdx>) -> R<()> {
    let conn = db.0.lock().map_err(e)?;
    conn.execute_batch("DELETE FROM chunks; DELETE FROM indexed;").map_err(e)?;
    let _ = conn.execute_batch("VACUUM");
    Ok(())
}

#[tauri::command]
pub fn bidx_search(db: tauri::State<BookIdx>, query: String, per_book: usize, max_books: usize, only: Option<Vec<String>>) -> R<Found> {
    let conn = db.0.lock().map_err(e)?;
    search(&conn, &query, per_book.clamp(1, 200), max_books.clamp(1, 200), only.as_deref()).map_err(e)
}

#[tauri::command]
pub fn bidx_size(db: tauri::State<BookIdx>) -> R<i64> {
    let conn = db.0.lock().map_err(e)?;
    size(&conn).map_err(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }
    fn c(section: i64, text: &str) -> Chunk {
        Chunk { section, text: text.into() }
    }

    #[test]
    fn finds_chinese_and_english_with_section_and_snippet() {
        let mut conn = db();
        replace(&mut conn, "a", &[c(0, "第一章 慢读比多读更有用，把每一次阅读都写成自己的话。"), c(3, "Slow reading beats fast reading, every time.")], 4, 1, 1).unwrap();
        replace(&mut conn, "b", &[c(1, "另一本书里也提到慢读这件事。")], 2, 1, 1).unwrap();
        let f = search(&conn, "慢读比多读", 3, 10, None).unwrap();
        assert_eq!(f.hits.len(), 1);
        assert_eq!((f.hits[0].book_id.as_str(), f.hits[0].section), ("a", 0));
        assert!(f.hits[0].snippet.contains("慢读比多读"));
        let f = search(&conn, "SLOW reading", 3, 10, None).unwrap();
        assert_eq!((f.hits[0].book_id.as_str(), f.hits[0].section), ("a", 3));
    }

    #[test]
    fn a_two_character_term_is_scanned_and_grouped_by_book() {
        let mut conn = db();
        replace(&mut conn, "a", &[c(0, "慢读一"), c(1, "慢读二"), c(2, "慢读三")], 3, 1, 1).unwrap();
        replace(&mut conn, "b", &[c(0, "也有慢读")], 1, 1, 1).unwrap();
        let f = search(&conn, "慢读", 2, 10, None).unwrap();
        assert_eq!(f.books, 2);
        assert_eq!(f.hits.iter().filter(|h| h.book_id == "a").count(), 2); // at most per_book
        assert_eq!(f.hits.iter().find(|h| h.book_id == "a").unwrap().count, 3);
        assert!(search(&conn, "慢", 2, 10, None).unwrap().hits.is_empty()); // one character: too short
    }

    #[test]
    fn replace_and_remove_a_book() {
        let mut conn = db();
        replace(&mut conn, "a", &[c(0, "旧的内容在这里")], 1, 1, 1).unwrap();
        replace(&mut conn, "a", &[c(0, "新的内容在这里")], 1, 2, 1).unwrap();
        assert!(search(&conn, "旧的内容", 3, 10, None).unwrap().hits.is_empty());
        assert_eq!(search(&conn, "新的内容", 3, 10, None).unwrap().hits.len(), 1);
        assert_eq!(status(&conn).unwrap().len(), 1);
        remove(&mut conn, "a").unwrap();
        assert!(search(&conn, "新的内容", 3, 10, None).unwrap().hits.is_empty());
        assert!(status(&conn).unwrap().is_empty());
    }

    #[test]
    fn can_search_only_some_books() {
        let mut conn = db();
        replace(&mut conn, "a", &[c(0, "共同的句子出现在这里")], 1, 1, 1).unwrap();
        replace(&mut conn, "b", &[c(0, "共同的句子也在这里")], 1, 1, 1).unwrap();
        let f = search(&conn, "共同的句子", 3, 10, Some(&["b".to_string()])).unwrap();
        assert_eq!(f.hits.len(), 1);
        assert_eq!(f.hits[0].book_id, "b");
    }
}
