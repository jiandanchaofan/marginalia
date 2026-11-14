//! Note review (spaced repetition): when each note is due to be read again, and what was answered each day.
//!
//! The frontend owns the rules (levels, intervals, the daily limit); this module only stores the schedule.
//! `review_items` rows go away with their note; `review_log` keeps the answers for the statistics.

use crate::notes::Db;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub note_id: String,
    pub level: i64,
    /// Day (YYYY-MM-DD) the note is due.
    pub due: String,
    /// Day it was last read again ("" = never).
    #[serde(default)]
    pub last: String,
    #[serde(default)]
    pub reps: i64,
    #[serde(default)]
    pub lapses: i64,
    #[serde(default)]
    pub suspended: bool,
    /// Day the note entered the schedule.
    #[serde(default)]
    pub added: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogRow {
    pub day: String,
    pub note_id: String,
    /// 0 forgot, 1 fuzzy, 2 known.
    pub rating: i64,
}

#[derive(Serialize)]
pub struct All {
    pub items: Vec<Item>,
    pub log: Vec<LogRow>,
}

fn all(conn: &Connection) -> rusqlite::Result<All> {
    let mut st = conn.prepare("SELECT note_id, level, due, last, reps, lapses, suspended, added FROM review_items")?;
    let items = st
        .query_map([], |r| {
            Ok(Item { note_id: r.get(0)?, level: r.get(1)?, due: r.get(2)?, last: r.get(3)?, reps: r.get(4)?, lapses: r.get(5)?, suspended: r.get::<_, i64>(6)? != 0, added: r.get(7)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut st = conn.prepare("SELECT day, note_id, rating FROM review_log ORDER BY day")?;
    let log = st.query_map([], |r| Ok(LogRow { day: r.get(0)?, note_id: r.get(1)?, rating: r.get(2)? }))?.collect::<Result<Vec<_>, _>>()?;
    Ok(All { items, log })
}

/// Insert or update schedules. Notes that do not exist (any more) are skipped.
pub(crate) fn put(conn: &mut Connection, items: &[Item]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for it in items {
        let known: i64 = tx.query_row("SELECT count(*) FROM notes WHERE id = ?1", [&it.note_id], |r| r.get(0))?;
        if known == 0 {
            continue;
        }
        tx.execute(
            "INSERT INTO review_items(note_id, level, due, last, reps, lapses, suspended, added, updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
             ON CONFLICT(note_id) DO UPDATE SET level = excluded.level, due = excluded.due, last = excluded.last, reps = excluded.reps,
               lapses = excluded.lapses, suspended = excluded.suspended, updated_at = excluded.updated_at",
            params![it.note_id, it.level.clamp(0, 20), it.due, it.last, it.reps.max(0), it.lapses.max(0), it.suspended as i64, it.added],
        )?;
    }
    tx.commit()
}

fn log_put(conn: &Connection, day: &str, note_id: &str, rating: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO review_log(day, note_id, rating) VALUES(?1, ?2, ?3) ON CONFLICT(day, note_id) DO UPDATE SET rating = excluded.rating",
        params![day, note_id, rating.clamp(0, 2)],
    )?;
    Ok(())
}

#[tauri::command]
pub fn review_all(db: tauri::State<Db>) -> Result<All, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn review_put(db: tauri::State<Db>, items: Vec<Item>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    put(&mut conn, &items).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn review_log_put(db: tauri::State<Db>, day: String, note_id: String, rating: i64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    log_put(&conn, &day, &note_id, rating).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn review_reset(db: tauri::State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute_batch("DELETE FROM review_items; DELETE FROM review_log;").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(crate::notes::SCHEMA).unwrap();
        conn
    }
    fn note(conn: &Connection, id: &str) {
        conn.execute("INSERT INTO notes(id, book_id, anchor, color, style, created_at, updated_at) VALUES(?1, 'b', '{}', 'amber', 'none', 1, 1)", [id]).unwrap();
    }
    fn item(id: &str, level: i64, due: &str) -> Item {
        Item { note_id: id.into(), level, due: due.into(), last: String::new(), reps: 0, lapses: 0, suspended: false, added: "2026-11-01".into() }
    }

    #[test]
    fn schedules_are_stored_updated_and_cascade_with_their_note() {
        let mut conn = db();
        note(&conn, "n1");
        note(&conn, "n2");
        put(&mut conn, &[item("n1", 0, "2026-11-02"), item("n2", 0, "2026-11-03")]).unwrap();
        let mut moved = item("n1", 2, "2026-11-20");
        moved.reps = 3;
        moved.last = "2026-11-13".into();
        moved.added = "ignored".into();
        put(&mut conn, &[moved]).unwrap();
        let a = all(&conn).unwrap();
        let n1 = a.items.iter().find(|i| i.note_id == "n1").unwrap();
        assert_eq!((n1.level, n1.due.as_str(), n1.reps, n1.last.as_str(), n1.added.as_str()), (2, "2026-11-20", 3, "2026-11-13", "2026-11-01"), "the day it was added stays");
        conn.execute("DELETE FROM notes WHERE id = 'n2'", []).unwrap();
        assert_eq!(all(&conn).unwrap().items.len(), 1);
    }

    #[test]
    fn unknown_notes_are_skipped() {
        let mut conn = db();
        put(&mut conn, &[item("ghost", 0, "2026-11-02")]).unwrap();
        assert!(all(&conn).unwrap().items.is_empty());
    }

    #[test]
    fn the_answer_of_a_day_is_replaced_and_reset_empties_everything() {
        let mut conn = db();
        note(&conn, "n1");
        put(&mut conn, &[item("n1", 0, "d")]).unwrap();
        log_put(&conn, "2026-11-13", "n1", 1).unwrap();
        log_put(&conn, "2026-11-13", "n1", 2).unwrap();
        let a = all(&conn).unwrap();
        assert_eq!(a.log.len(), 1);
        assert_eq!(a.log[0].rating, 2);
        conn.execute_batch("DELETE FROM review_items; DELETE FROM review_log;").unwrap();
        let a = all(&conn).unwrap();
        assert!(a.items.is_empty() && a.log.is_empty());
    }
}
