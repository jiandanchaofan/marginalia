//! Groundwork for syncing between devices (see docs/cloud-sync-plan.md): who this device is, and what was deleted.
//!
//! Records carry `updated_at` and the newest one wins when two devices met; a record that is simply missing cannot be told
//! from one that never arrived, so deletions are kept as tombstones (written by SQLite triggers, see `notes::SCHEMA`).

use crate::notes::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tombstone {
    pub kind: String,
    pub id: String,
    pub deleted_at: i64,
}

/// This device's id, made up the first time it is asked for and kept for good.
pub fn device_id(conn: &Connection) -> rusqlite::Result<String> {
    if let Some(id) = conn.query_row("SELECT value FROM meta WHERE key = 'device_id'", [], |r| r.get::<_, String>(0)).optional()? {
        return Ok(id);
    }
    use sha2::{Digest, Sha256};
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let stack = &nanos as *const u128 as usize;
    let mut h = Sha256::new();
    h.update(nanos.to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    h.update(stack.to_le_bytes());
    let id = hex::encode(h.finalize())[..16].to_string();
    conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES('device_id', ?1)", [&id])?;
    conn.query_row("SELECT value FROM meta WHERE key = 'device_id'", [], |r| r.get(0))
}

/// What was deleted at or after `since` (ms), oldest first.
pub fn tombstones_since(conn: &Connection, since: i64) -> rusqlite::Result<Vec<Tombstone>> {
    let mut stmt = conn.prepare("SELECT kind, id, deleted_at FROM tombstones WHERE deleted_at >= ?1 ORDER BY deleted_at, kind, id")?;
    let rows = stmt.query_map([since], |r| Ok(Tombstone { kind: r.get(0)?, id: r.get(1)?, deleted_at: r.get(2)? }))?;
    rows.collect()
}

/// Forget tombstones older than `before` (once every device has seen them).
#[allow(dead_code)] // the sync (S2) calls this once it knows every device has read them
pub fn prune_tombstones(conn: &Connection, before: i64) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM tombstones WHERE deleted_at < ?1", params![before])
}

#[tauri::command]
pub fn sync_device(db: tauri::State<Db>) -> Result<String, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    device_id(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sync_tombstones(db: tauri::State<Db>, since: i64) -> Result<Vec<Tombstone>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    tombstones_since(&conn, since).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::notes::SCHEMA).unwrap();
        conn
    }
    fn note(conn: &Connection, id: &str) {
        conn.execute("INSERT INTO notes(id, book_id, anchor, color, style, created_at, updated_at) VALUES(?1, 'b', '{}', 'amber', 'none', 1, 1)", [id]).unwrap();
    }
    fn task(conn: &Connection, id: &str, note_id: Option<&str>, parent: Option<&str>) {
        conn.execute("INSERT INTO tasks(id, source_note_id, parent_id, created_at, updated_at) VALUES(?1, ?2, ?3, 1, 1)", params![id, note_id, parent]).unwrap();
    }
    fn gone(conn: &Connection) -> Vec<(String, String)> {
        tombstones_since(conn, 0).unwrap().into_iter().map(|t| (t.kind, t.id)).collect::<Vec<_>>()
    }

    #[test]
    fn the_device_id_is_made_once_and_kept() {
        let conn = db();
        let a = device_id(&conn).unwrap();
        assert_eq!(a.len(), 16);
        assert_eq!(device_id(&conn).unwrap(), a);
        let other = db();
        assert_ne!(device_id(&other).unwrap(), a);
    }

    #[test]
    fn deleting_leaves_a_tombstone_and_writing_again_takes_it_away() {
        let conn = db();
        note(&conn, "n1");
        assert!(gone(&conn).is_empty());
        conn.execute("DELETE FROM notes WHERE id = 'n1'", []).unwrap();
        assert_eq!(gone(&conn), vec![("note".to_string(), "n1".to_string())]);
        note(&conn, "n1"); // restored from the recycle bin
        assert!(gone(&conn).is_empty());
    }

    #[test]
    fn a_cascade_leaves_tombstones_for_everything_it_took() {
        let conn = db();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        note(&conn, "n1");
        task(&conn, "t1", Some("n1"), None);
        task(&conn, "t2", Some("n1"), Some("t1")); // a subtask
        conn.execute("DELETE FROM notes WHERE id = 'n1'", []).unwrap();
        let mut g = gone(&conn);
        g.sort();
        assert_eq!(g, vec![("note".into(), "n1".into()), ("task".into(), "t1".into()), ("task".into(), "t2".into())]);
    }

    #[test]
    fn goals_links_and_recycle_bin_entries_are_covered_too() {
        let conn = db();
        note(&conn, "a");
        note(&conn, "b");
        conn.execute("INSERT INTO note_links(id, a, b, created_at, updated_at) VALUES('l1', 'a', 'b', 1, 1)", []).unwrap();
        conn.execute("INSERT INTO goals(id, created_at, updated_at) VALUES('g1', 1, 1)", []).unwrap();
        conn.execute("INSERT INTO trash(id, kind, deleted_at, payload) VALUES('x1', 'note', 1, '{}')", []).unwrap();
        conn.execute_batch("DELETE FROM note_links; DELETE FROM goals; DELETE FROM trash;").unwrap();
        let mut g = gone(&conn);
        g.sort();
        assert_eq!(g, vec![("goal".into(), "g1".into()), ("link".into(), "l1".into()), ("trash".into(), "x1".into())]);
    }

    fn stamp(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn review_progress_pins_and_card_positions_know_when_they_were_written() {
        let mut conn = db();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        note(&conn, "n1");
        let now: i64 = stamp(&conn, "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)");
        // through the app's own write path for review progress
        let item = crate::review::Item { note_id: "n1".into(), level: 1, due: "2026-11-20".into(), last: String::new(), reps: 0, lapses: 0, suspended: false, added: "2026-11-01".into() };
        crate::review::put(&mut conn, &[item]).unwrap();
        conn.execute("INSERT INTO tag_meta(tag, pinned, updated_at) VALUES('x', 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))", []).unwrap();
        conn.execute("INSERT INTO graph_pos(note_id, x, y, updated_at) VALUES('n1', 1, 2, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))", []).unwrap();
        for sql in ["SELECT updated_at FROM review_items", "SELECT updated_at FROM tag_meta", "SELECT updated_at FROM graph_pos"] {
            assert!(stamp(&conn, sql) >= now - 5, "{sql}");
        }
    }

    #[test]
    fn an_old_database_gets_the_column_and_keeps_its_rows() {
        let old = Connection::open_in_memory().unwrap();
        old.execute_batch(
            "CREATE TABLE notes(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, section INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0, anchor TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', color TEXT NOT NULL, style TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', thought INTEGER NOT NULL DEFAULT 0, side TEXT NOT NULL DEFAULT 'right', side_locked INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'passage', images TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE tag_meta(tag TEXT PRIMARY KEY, pinned INTEGER NOT NULL DEFAULT 0);
             INSERT INTO tag_meta VALUES('x', 1);",
        )
        .unwrap();
        crate::notes::upgrade_for_test(&old);
        crate::notes::upgrade_for_test(&old); // idempotent
        let (p, at): (i64, i64) = old.query_row("SELECT pinned, updated_at FROM tag_meta", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((p, at), (1, 0));
    }

    #[test]
    fn tombstones_can_be_read_from_a_time_on_and_pruned() {
        let conn = db();
        conn.execute("INSERT INTO tombstones(kind, id, deleted_at) VALUES('note', 'old', 100), ('note', 'new', 5000)", []).unwrap();
        assert_eq!(tombstones_since(&conn, 1000).unwrap().len(), 1);
        assert_eq!(prune_tombstones(&conn, 1000).unwrap(), 1);
        assert_eq!(tombstones_since(&conn, 0).unwrap().len(), 1);
    }
}
