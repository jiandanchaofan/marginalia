//! The shelf's list of books (title, author, progress, rating, status, interests …), one row per book.
//!
//! It used to be one `library.json` that was rewritten whole on every change; as rows each book has its own "last written"
//! time, which is what merging between devices needs, and a crash in the middle of a write can no longer damage the whole list.
//! The books' files (`books/<hash>.<ext>`) are not in the database, only this small description of each.

use crate::notes::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

const NOW: &str = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

/// Every book, in the order they were first written.
pub fn all(conn: &Connection) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare("SELECT data FROM books ORDER BY rowid")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(rows.filter_map(Result::ok).filter_map(|s| serde_json::from_str(&s).ok()).collect())
}

fn id_of(v: &Value) -> Option<&str> {
    v.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Make the table hold exactly `books`: only rows that are new or different are written (and get a new time), rows that are
/// not in the list are removed (the tombstone trigger notes it). `migrating` stamps each row with its own last activity
/// instead of "now", so an import never looks newer than what another device did later.
pub fn replace(conn: &mut Connection, books: &[Value], migrating: bool) -> rusqlite::Result<(usize, usize)> {
    let tx = conn.transaction()?;
    let have: HashMap<String, String> = {
        let mut stmt = tx.prepare("SELECT id, data FROM books")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut keep = std::collections::HashSet::new();
    let mut changed = 0;
    for b in books {
        let Some(id) = id_of(b) else { continue };
        keep.insert(id.to_string());
        let data = serde_json::to_string(b).unwrap_or_default();
        if have.get(id) == Some(&data) {
            continue;
        }
        changed += 1;
        if migrating {
            let at = ["lastOpenedAt", "addedAt"].iter().filter_map(|k| b.get(*k).and_then(Value::as_i64)).max().unwrap_or(0);
            tx.execute(
                "INSERT INTO books(id, data, updated_at) VALUES(?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
                params![id, data, at],
            )?;
        } else {
            tx.execute(
                &format!("INSERT INTO books(id, data, updated_at) VALUES(?1, ?2, {NOW}) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"),
                params![id, data],
            )?;
        }
    }
    let mut removed = 0;
    for id in have.keys().filter(|id| !keep.contains(*id)) {
        removed += tx.execute("DELETE FROM books WHERE id = ?1", [id])?;
    }
    tx.commit()?;
    Ok((changed, removed))
}

/// One-time move of `library.json` into the table. The file is kept, renamed, as a copy; if anything goes wrong it stays where
/// it is and the move is tried again next time.
pub fn migrate(conn: &mut Connection, dir: &Path) {
    let done: Option<String> = conn.query_row("SELECT value FROM meta WHERE key = 'library_migrated'", [], |r| r.get(0)).optional().ok().flatten();
    if done.is_some() {
        return;
    }
    let path = dir.join("library.json");
    let Ok(text) = fs::read_to_string(&path) else {
        // no old file (a fresh install): nothing to move
        let _ = conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('library_migrated', 'none')", []);
        return;
    };
    let Ok(Value::Array(list)) = serde_json::from_str::<Value>(&text) else { return };
    let existing: i64 = conn.query_row("SELECT count(*) FROM books", [], |r| r.get(0)).unwrap_or(0);
    if existing == 0 && replace(conn, &list, true).is_err() {
        return;
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if fs::rename(&path, dir.join(format!("library.json.migrated-{stamp}.bak"))).is_ok() || fs::copy(&path, dir.join(format!("library.json.migrated-{stamp}.bak"))).is_ok() {
        let _ = conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('library_migrated', ?1)", [stamp.to_string()]);
    }
}

type R<T> = Result<T, String>;

#[tauri::command]
pub fn books_all(db: tauri::State<Db>) -> R<Vec<Value>> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn books_replace(db: tauri::State<Db>, books: Vec<Value>) -> R<()> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    replace(&mut conn, &books, false).map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::notes::SCHEMA).unwrap();
        conn
    }
    fn book(id: &str, title: &str) -> Value {
        json!({"id": id, "title": title, "ext": "epub", "progress": 0.1, "addedAt": 1000, "lastOpenedAt": 2000})
    }
    fn stamps(conn: &Connection) -> HashMap<String, i64> {
        let mut stmt = conn.prepare("SELECT id, updated_at FROM books").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().filter_map(Result::ok).collect()
    }
    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("marginalia-lib-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn books_come_back_as_written_in_the_same_order() {
        let mut conn = db();
        replace(&mut conn, &[book("a", "甲"), book("b", "乙"), book("c", "丙")], false).unwrap();
        let ids: Vec<_> = all(&conn).unwrap().iter().map(|b| b["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["a", "b", "c"]);
        assert_eq!(all(&conn).unwrap()[0]["title"], "甲");
    }

    #[test]
    fn only_what_changed_is_rewritten_and_stamped() {
        let mut conn = db();
        replace(&mut conn, &[book("a", "甲"), book("b", "乙")], false).unwrap();
        conn.execute("UPDATE books SET updated_at = 5", []).unwrap(); // pretend both were written long ago
        let (changed, removed) = replace(&mut conn, &[book("a", "甲"), book("b", "乙（改）")], false).unwrap();
        assert_eq!((changed, removed), (1, 0));
        let s = stamps(&conn);
        assert_eq!(s["a"], 5); // untouched
        assert!(s["b"] > 5); // rewritten
    }

    #[test]
    fn a_removed_book_leaves_a_tombstone() {
        let mut conn = db();
        replace(&mut conn, &[book("a", "甲"), book("b", "乙")], false).unwrap();
        let (_, removed) = replace(&mut conn, &[book("a", "甲")], false).unwrap();
        assert_eq!(removed, 1);
        let gone = crate::sync::tombstones_since(&conn, 0).unwrap();
        assert_eq!(gone.iter().map(|t| (t.kind.as_str(), t.id.as_str())).collect::<Vec<_>>(), [("book", "b")]);
        replace(&mut conn, &[book("a", "甲"), book("b", "乙")], false).unwrap(); // added back: the tombstone goes
        assert!(crate::sync::tombstones_since(&conn, 0).unwrap().is_empty());
    }

    #[test]
    fn an_entry_without_an_id_is_ignored() {
        let mut conn = db();
        replace(&mut conn, &[json!({"title": "no id"}), book("a", "甲")], false).unwrap();
        assert_eq!(all(&conn).unwrap().len(), 1);
    }

    #[test]
    fn the_old_json_file_moves_in_and_is_kept_as_a_copy() {
        let dir = temp("move");
        let list = json!([book("a", "甲"), book("b", "乙")]);
        fs::write(dir.join("library.json"), serde_json::to_string_pretty(&list).unwrap()).unwrap();
        let mut conn = db();
        migrate(&mut conn, &dir);
        assert_eq!(all(&conn).unwrap().len(), 2);
        assert!(!dir.join("library.json").exists());
        let kept: Vec<_> = fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert!(kept.iter().any(|n| n.starts_with("library.json.migrated-")), "{kept:?}");
        // stamped with each book's own last activity, not with now
        assert_eq!(stamps(&conn)["a"], 2000);
        // a second start does nothing, even if a library.json shows up again
        fs::write(dir.join("library.json"), "[]").unwrap();
        migrate(&mut conn, &dir);
        assert_eq!(all(&conn).unwrap().len(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_file_is_left_alone_and_tried_again_next_time() {
        let dir = temp("broken");
        fs::write(dir.join("library.json"), "{ not json").unwrap();
        let mut conn = db();
        migrate(&mut conn, &dir);
        assert!(dir.join("library.json").exists());
        assert!(all(&conn).unwrap().is_empty());
        let done: Option<String> = conn.query_row("SELECT value FROM meta WHERE key = 'library_migrated'", [], |r| r.get(0)).optional().unwrap();
        assert!(done.is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_fresh_install_has_nothing_to_move() {
        let dir = temp("fresh");
        let mut conn = db();
        migrate(&mut conn, &dir);
        let done: Option<String> = conn.query_row("SELECT value FROM meta WHERE key = 'library_migrated'", [], |r| r.get(0)).optional().unwrap();
        assert_eq!(done.as_deref(), Some("none"));
        let _ = fs::remove_dir_all(&dir);
    }
}
