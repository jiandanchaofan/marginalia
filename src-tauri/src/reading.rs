//! Reading time: how long each book was read on each day (summed per day and book; no per-visit detail).
//!
//! `p0` is the reading progress (0-1) the first time the book was read that day, `p1` the latest one, so the progress
//! made on a day is `p1 - p0`. Only seconds the reader was really reading are added (the frontend decides what counts).

use crate::notes::Db;
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    pub day: String,
    pub book_id: String,
    pub secs: i64,
    pub p0: f64,
    pub p1: f64,
}

pub(crate) fn add(conn: &Connection, day: &str, book_id: &str, secs: i64, progress: f64) -> rusqlite::Result<()> {
    let p = progress.clamp(0.0, 1.0);
    conn.execute(
        "INSERT INTO reading_days(day, book_id, secs, p0, p1, updated_at) VALUES(?1, ?2, ?3, ?4, ?4, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
         ON CONFLICT(day, book_id) DO UPDATE SET secs = secs + excluded.secs, p1 = excluded.p1, updated_at = excluded.updated_at",
        params![day, book_id, secs.max(0), p],
    )?;
    Ok(())
}

/// The time read on each day and book, on this device and on the others added together.
pub(crate) fn all(conn: &Connection) -> rusqlite::Result<Vec<Day>> {
    let mut st = conn.prepare(
        "SELECT day, book_id, SUM(secs), MIN(p0), MAX(p1) FROM (
           SELECT day, book_id, secs, p0, p1 FROM reading_days UNION ALL SELECT day, book_id, secs, p0, p1 FROM reading_remote
         ) GROUP BY day, book_id ORDER BY day, book_id",
    )?;
    let rows = st.query_map([], |r| Ok(Day { day: r.get(0)?, book_id: r.get(1)?, secs: r.get(2)?, p0: r.get(3)?, p1: r.get(4)? }))?;
    rows.collect()
}

#[tauri::command]
pub fn reading_add(db: tauri::State<Db>, day: String, book_id: String, secs: i64, progress: f64) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    add(&conn, &day, &book_id, secs, progress).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reading_all(db: tauri::State<Db>) -> Result<Vec<Day>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    all(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reading_clear(db: tauri::State<Db>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    conn.execute_batch("DELETE FROM reading_days; DELETE FROM reading_remote;").map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::notes::SCHEMA).unwrap();
        conn
    }

    #[test]
    fn seconds_add_up_per_day_and_book() {
        let conn = db();
        add(&conn, "2026-11-13", "a", 60, 0.10).unwrap();
        add(&conn, "2026-11-13", "a", 45, 0.14).unwrap();
        add(&conn, "2026-11-13", "b", 30, 0.50).unwrap();
        add(&conn, "2026-11-14", "a", 20, 0.15).unwrap();
        let rows = all(&conn).unwrap();
        assert_eq!(rows.len(), 3);
        let a = rows.iter().find(|r| r.day == "2026-11-13" && r.book_id == "a").unwrap();
        assert_eq!((a.secs, a.p0, a.p1), (105, 0.10, 0.14));
        assert_eq!(rows.iter().filter(|r| r.book_id == "a").map(|r| r.secs).sum::<i64>(), 125);
    }

    #[test]
    fn first_progress_of_the_day_is_kept_and_values_are_clamped() {
        let conn = db();
        add(&conn, "d", "a", 10, 0.30).unwrap();
        add(&conn, "d", "a", -5, 1.7).unwrap();
        let r = &all(&conn).unwrap()[0];
        assert_eq!((r.secs, r.p0, r.p1), (10, 0.30, 1.0));
    }

    #[test]
    fn clear_empties_the_table() {
        let conn = db();
        add(&conn, "d", "a", 10, 0.3).unwrap();
        conn.execute("DELETE FROM reading_days", []).unwrap();
        assert!(all(&conn).unwrap().is_empty());
    }
}
