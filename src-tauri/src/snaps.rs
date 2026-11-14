//! Goal progress snapshots: how far each goal was on a given day (one row per day and goal, the latest one of the day wins).
//! The weekly review compares today's progress with the last snapshot before the week began.

use crate::notes::Db;
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snap {
    pub day: String,
    pub goal_id: String,
    pub percent: i64,
}

fn save(conn: &mut Connection, day: &str, items: &[(String, i64)]) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for (goal, percent) in items {
        // a goal that no longer exists is skipped (the foreign key would refuse it)
        let known: i64 = tx.query_row("SELECT count(*) FROM goals WHERE id = ?1", [goal], |r| r.get(0))?;
        if known == 0 {
            continue;
        }
        tx.execute(
            "INSERT INTO goal_snaps(day, goal_id, percent, updated_at) VALUES(?1, ?2, ?3, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT(day, goal_id) DO UPDATE SET percent = excluded.percent, updated_at = excluded.updated_at",
            params![day, goal, (*percent).clamp(0, 100)],
        )?;
    }
    tx.commit()
}

fn all(conn: &Connection) -> rusqlite::Result<Vec<Snap>> {
    let mut st = conn.prepare("SELECT day, goal_id, percent FROM goal_snaps ORDER BY day, goal_id")?;
    let rows = st.query_map([], |r| Ok(Snap { day: r.get(0)?, goal_id: r.get(1)?, percent: r.get(2)? }))?;
    rows.collect()
}

#[tauri::command]
pub fn goal_snaps_save(db: tauri::State<Db>, day: String, items: Vec<(String, i64)>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    save(&mut conn, &day, &items).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn goal_snaps_all(db: tauri::State<Db>) -> Result<Vec<Snap>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    all(&conn).map_err(|e| e.to_string())
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
    fn goal(conn: &Connection, id: &str) {
        conn.execute("INSERT INTO goals(id, title, kind, period, created_at, updated_at) VALUES(?1, 'g', 'month', '2026-11', 1, 1)", [id]).unwrap();
    }

    #[test]
    fn the_latest_snapshot_of_a_day_wins() {
        let mut conn = db();
        goal(&conn, "g1");
        save(&mut conn, "2026-11-08", &[("g1".into(), 20)]).unwrap();
        save(&mut conn, "2026-11-08", &[("g1".into(), 30)]).unwrap();
        save(&mut conn, "2026-11-15", &[("g1".into(), 55)]).unwrap();
        let rows = all(&conn).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].day.as_str(), rows[0].percent), ("2026-11-08", 30));
    }

    #[test]
    fn unknown_goals_are_skipped_and_deleting_a_goal_removes_its_snapshots() {
        let mut conn = db();
        goal(&conn, "g1");
        save(&mut conn, "d", &[("g1".into(), 10), ("ghost".into(), 99)]).unwrap();
        assert_eq!(all(&conn).unwrap().len(), 1);
        conn.execute("DELETE FROM goals WHERE id = 'g1'", []).unwrap();
        assert!(all(&conn).unwrap().is_empty());
    }
}
