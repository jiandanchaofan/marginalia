//! Recycle bin: notes and to-dos that were deleted stay here for 30 days, then go for good.
//!
//! The frontend writes the snapshot (the item, what hung on it: links, review schedule, derived to-dos …) as JSON and
//! restores it by writing the pieces back; this module only keeps the rows and sweeps the old ones.

use crate::notes::Db;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    /// "note" | "task"
    pub kind: String,
    pub deleted_at: i64,
    /// What the list shows.
    #[serde(default)]
    pub title: String,
    /// The snapshot, as JSON text.
    pub payload: String,
}

pub fn all(conn: &Connection) -> rusqlite::Result<Vec<Row>> {
    let mut stmt = conn.prepare("SELECT id, kind, deleted_at, title, payload FROM trash ORDER BY deleted_at DESC, id")?;
    let rows = stmt.query_map([], |r| Ok(Row { id: r.get(0)?, kind: r.get(1)?, deleted_at: r.get(2)?, title: r.get(3)?, payload: r.get(4)? }))?;
    rows.collect()
}

pub fn put(conn: &mut Connection, rows: &[Row]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for r in rows {
        tx.execute(
            "INSERT INTO trash(id, kind, deleted_at, title, payload) VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, deleted_at = excluded.deleted_at, title = excluded.title, payload = excluded.payload",
            params![r.id, r.kind, r.deleted_at, r.title, r.payload],
        )?;
    }
    tx.commit()
}

pub fn remove(conn: &mut Connection, ids: &[String]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for id in ids {
        tx.execute("DELETE FROM trash WHERE id = ?1", [id])?;
    }
    tx.commit()
}

/// Delete what was thrown away before `before` (ms). Returns how many went.
pub fn purge(conn: &Connection, before: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM trash WHERE deleted_at < ?1", [before])
}

#[tauri::command]
pub fn trash_all(db: tauri::State<Db>) -> Result<Vec<Row>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn trash_put(db: tauri::State<Db>, rows: Vec<Row>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    put(&mut conn, &rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn trash_delete(db: tauri::State<Db>, ids: Vec<String>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    remove(&mut conn, &ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn trash_purge(db: tauri::State<Db>, before: i64) -> Result<usize, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    purge(&conn, before).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::notes::SCHEMA).unwrap();
        conn
    }
    fn row(id: &str, at: i64) -> Row {
        Row { id: id.into(), kind: "note".into(), deleted_at: at, title: id.into(), payload: "{}".into() }
    }

    #[test]
    fn keeps_newest_first_and_replaces_by_id() {
        let mut c = db();
        put(&mut c, &[row("a", 10), row("b", 30), row("c", 20)]).unwrap();
        put(&mut c, &[Row { title: "B2".into(), ..row("b", 30) }]).unwrap();
        let ids: Vec<_> = all(&c).unwrap().into_iter().map(|r| (r.id, r.title)).collect();
        assert_eq!(ids, vec![("b".into(), "B2".into()), ("c".into(), "c".into()), ("a".into(), "a".into())]);
    }

    #[test]
    fn purge_removes_only_the_old() {
        let mut c = db();
        put(&mut c, &[row("old", 100), row("new", 5_000)]).unwrap();
        assert_eq!(purge(&c, 1_000).unwrap(), 1);
        assert_eq!(all(&c).unwrap().len(), 1);
        remove(&mut c, &["new".to_string()]).unwrap();
        assert!(all(&c).unwrap().is_empty());
    }
}
