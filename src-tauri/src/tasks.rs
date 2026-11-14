//! Task library (SQLite, same database as the notes).
//!
//! A task is either standalone (made on the 任务 page) or comes from a todo line (`- [ ] …`) of a note
//! (`source_note_id`). The frontend decides which tasks exist and what they contain (it parses the notes); this module
//! only stores them. Deleting a note deletes the tasks that came from it, deleting a task deletes its subtasks.

use crate::notes::Db;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

const SEP: char = '\u{1f}';
const NOW_SQL: &str = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// Free-text remarks (only stored here, never in the note).
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub done_at: Option<i64>,
    /// 0 = none, 1 = 低, 2 = 中, 3 = 高.
    #[serde(default)]
    pub priority: i64,
    /// Planned for a day / week / month / year, as written (`2026-11-20`, `2026-W47`, `2026-11`, `2026`); "" = not planned.
    #[serde(default)]
    pub plan: String,
    /// "day" | "week" | "month" | "year" | "".
    #[serde(default)]
    pub plan_kind: String,
    /// First and last day of the planned period (YYYY-MM-DD, inclusive).
    #[serde(default)]
    pub plan_start: String,
    #[serde(default)]
    pub plan_end: String,
    #[serde(default)]
    pub deadline: String,
    /// All tags: the task's own and the ones inherited from its note.
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub own_tags: Vec<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort: i64,
    #[serde(default)]
    pub source_note_id: Option<String>,
    /// The todo line as it was last seen in the note (for writing changes back).
    #[serde(default)]
    pub source_line: String,
    pub created_at: i64,
    pub updated_at: i64,
}

fn join(tags: &[String]) -> String {
    tags.iter().filter(|t| !t.is_empty() && !t.contains(SEP)).cloned().collect::<Vec<_>>().join(&SEP.to_string())
}
fn split(s: &str) -> Vec<String> {
    s.split(SEP).filter(|t| !t.is_empty()).map(String::from).collect()
}
fn norm_kind(k: &str) -> &'static str {
    match k {
        "day" => "day",
        "week" => "week",
        "month" => "month",
        "year" => "year",
        _ => "",
    }
}

pub(crate) fn put_one(conn: &Connection, t: &Task) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO tasks(id, title, note, done, done_at, priority, plan, plan_kind, plan_start, plan_end, deadline, tags, own_tags,
                           parent_id, sort, source_note_id, source_line, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, note = excluded.note, done = excluded.done, done_at = excluded.done_at,
           priority = excluded.priority, plan = excluded.plan, plan_kind = excluded.plan_kind, plan_start = excluded.plan_start,
           plan_end = excluded.plan_end, deadline = excluded.deadline, tags = excluded.tags, own_tags = excluded.own_tags,
           parent_id = excluded.parent_id, sort = excluded.sort, source_note_id = excluded.source_note_id,
           source_line = excluded.source_line, updated_at = excluded.updated_at",
        params![
            t.id,
            t.title,
            t.note,
            t.done,
            t.done_at,
            t.priority.clamp(0, 3),
            t.plan,
            norm_kind(&t.plan_kind),
            t.plan_start,
            t.plan_end,
            t.deadline,
            join(&t.tags),
            join(&t.own_tags),
            t.parent_id,
            t.sort,
            t.source_note_id,
            t.source_line,
            t.created_at,
            t.updated_at
        ],
    )?;
    Ok(())
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Task>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, note, done, done_at, priority, plan, plan_kind, plan_start, plan_end, deadline, tags, own_tags,
                parent_id, sort, source_note_id, source_line, created_at, updated_at
         FROM tasks ORDER BY created_at, id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Task {
            id: r.get(0)?,
            title: r.get(1)?,
            note: r.get(2)?,
            done: r.get(3)?,
            done_at: r.get(4)?,
            priority: r.get(5)?,
            plan: r.get(6)?,
            plan_kind: r.get(7)?,
            plan_start: r.get(8)?,
            plan_end: r.get(9)?,
            deadline: r.get(10)?,
            tags: split(&r.get::<_, String>(11)?),
            own_tags: split(&r.get::<_, String>(12)?),
            parent_id: r.get(13)?,
            sort: r.get(14)?,
            source_note_id: r.get(15)?,
            source_line: r.get(16)?,
            created_at: r.get(17)?,
            updated_at: r.get(18)?,
        })
    })?;
    rows.collect()
}

/// Write some tasks and delete others in one transaction (all or nothing). Parents may come after their subtasks.
pub fn apply(conn: &mut Connection, put: &[Task], delete: &[String]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON").map_err(|e| e.to_string())?;
    // foreign keys are checked when the transaction commits (so parents may come after their subtasks)
    let explain = |e: rusqlite::Error| {
        if e.to_string().contains("FOREIGN KEY") {
            "任务指向的笔记或上级任务不存在".to_string()
        } else {
            e.to_string()
        }
    };
    for t in put {
        put_one(&tx, t).map_err(explain)?;
    }
    for id in delete {
        tx.execute("DELETE FROM tasks WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(explain)
}

#[tauri::command]
pub fn tasks_all(db: tauri::State<Db>) -> Result<Vec<Task>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tasks_apply(db: tauri::State<Db>, put: Vec<Task>, delete: Vec<String>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    apply(&mut conn, &put, &delete)
}

// ---------------------------------------------------------------------------------------------------------------
// Goals (年度 / 月度目标). A goal is its own object; todos support goals through `task_goals` (many to many).
// ---------------------------------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// Free-text remarks: what counts as reaching it, where things stand.
    #[serde(default)]
    pub note: String,
    /// "year" | "month".
    #[serde(default)]
    pub kind: String,
    /// `2026` or `2026-11`.
    #[serde(default)]
    pub period: String,
    /// A month goal may support one year goal.
    #[serde(default)]
    pub parent_id: Option<String>,
    /// "doing" | "done" | "missed" | "dropped".
    #[serde(default)]
    pub status: String,
    /// "auto" = share of supporting todos that are done; "manual" = `percent`.
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub percent: i64,
    #[serde(default)]
    pub sort: i64,
    #[serde(default)]
    pub closed_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct GoalData {
    pub goals: Vec<Goal>,
    /// `[task id, goal id]`
    pub links: Vec<(String, String)>,
}

fn norm_goal_kind(k: &str) -> &'static str {
    if k == "year" {
        "year"
    } else {
        "month"
    }
}
fn norm_status(s: &str) -> &'static str {
    match s {
        "done" => "done",
        "missed" => "missed",
        "dropped" => "dropped",
        _ => "doing",
    }
}

pub fn goals_list(conn: &Connection) -> rusqlite::Result<GoalData> {
    let mut stmt = conn.prepare("SELECT id, title, note, kind, period, parent_id, status, mode, percent, sort, closed_at, created_at, updated_at FROM goals ORDER BY created_at, id")?;
    let goals = stmt
        .query_map([], |r| {
            Ok(Goal {
                id: r.get(0)?,
                title: r.get(1)?,
                note: r.get(2)?,
                kind: r.get(3)?,
                period: r.get(4)?,
                parent_id: r.get(5)?,
                status: r.get(6)?,
                mode: r.get(7)?,
                percent: r.get(8)?,
                sort: r.get(9)?,
                closed_at: r.get(10)?,
                created_at: r.get(11)?,
                updated_at: r.get(12)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut stmt = conn.prepare("SELECT task_id, goal_id FROM task_goals ORDER BY task_id, goal_id")?;
    let links = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(GoalData { goals, links })
}

/// Write / delete goals and add / remove task↔goal links in one transaction. Deleting a goal removes its links only.
pub fn goals_change(conn: &mut Connection, put: &[Goal], delete: &[String], link: &[(String, String)], unlink: &[(String, String)]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON").map_err(|e| e.to_string())?;
    let explain = |e: rusqlite::Error| {
        if e.to_string().contains("FOREIGN KEY") {
            "目标或待办不存在".to_string()
        } else {
            e.to_string()
        }
    };
    for g in put {
        put_goal(&tx, g).map_err(explain)?;
    }
    for id in delete {
        tx.execute("DELETE FROM goals WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    }
    for (t, g) in link {
        tx.execute("INSERT OR IGNORE INTO task_goals(task_id, goal_id) VALUES(?1, ?2)", params![t, g]).map_err(explain)?;
        touch_task(&tx, t).map_err(explain)?;
    }
    for (t, g) in unlink {
        tx.execute("DELETE FROM task_goals WHERE task_id = ?1 AND goal_id = ?2", params![t, g]).map_err(|e| e.to_string())?;
        touch_task(&tx, t).map_err(explain)?;
    }
    tx.commit().map_err(explain)
}

/// A to-do whose goals changed counts as changed (its goals travel with it when syncing).
fn touch_task(conn: &Connection, task_id: &str) -> rusqlite::Result<()> {
    conn.execute(&format!("UPDATE tasks SET updated_at = MAX(updated_at + 1, {NOW_SQL}) WHERE id = ?1"), [task_id])?;
    Ok(())
}

pub(crate) fn put_goal(tx: &Connection, g: &Goal) -> rusqlite::Result<()> {
    {
        tx.execute(
            "INSERT INTO goals(id, title, note, kind, period, parent_id, status, mode, percent, sort, closed_at, created_at, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, note = excluded.note, kind = excluded.kind, period = excluded.period,
               parent_id = excluded.parent_id, status = excluded.status, mode = excluded.mode, percent = excluded.percent,
               sort = excluded.sort, closed_at = excluded.closed_at, updated_at = excluded.updated_at",
            params![
                g.id,
                g.title,
                g.note,
                norm_goal_kind(&g.kind),
                g.period,
                g.parent_id,
                norm_status(&g.status),
                if g.mode == "manual" { "manual" } else { "auto" },
                g.percent.clamp(0, 100),
                g.sort,
                g.closed_at,
                g.created_at,
                g.updated_at
            ],
        )?;
    }
    Ok(())
}

#[tauri::command]
pub fn goals_all(db: tauri::State<Db>) -> Result<GoalData, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    goals_list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn goals_apply(db: tauri::State<Db>, put: Vec<Goal>, delete: Vec<String>, link: Vec<(String, String)>, unlink: Vec<(String, String)>) -> Result<(), String> {
    let mut conn = db.0.lock().map_err(|e| e.to_string())?;
    goals_change(&mut conn, &put, &delete, &link, &unlink)
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
    fn task(id: &str) -> Task {
        Task {
            id: id.into(),
            title: format!("任务 {id}"),
            note: String::new(),
            done: false,
            done_at: None,
            priority: 0,
            plan: String::new(),
            plan_kind: String::new(),
            plan_start: String::new(),
            plan_end: String::new(),
            deadline: String::new(),
            tags: vec![],
            own_tags: vec![],
            parent_id: None,
            sort: 0,
            source_note_id: None,
            source_line: String::new(),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn roundtrip_update_and_delete() {
        let mut conn = db();
        let mut t = task("a");
        t.plan = "2026-W47".into();
        t.plan_kind = "week".into();
        t.plan_start = "2026-11-16".into();
        t.plan_end = "2026-11-22".into();
        t.deadline = "2026-11-22".into();
        t.priority = 9; // out of range → clamped
        t.tags = vec!["专题/产品改版".into(), "工作".into()];
        t.own_tags = vec!["工作".into()];
        t.note = "备注 #不是标签".into();
        apply(&mut conn, &[t.clone()], &[]).unwrap();
        let got = list(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].priority, 3);
        assert_eq!((got[0].plan.as_str(), got[0].plan_kind.as_str(), got[0].deadline.as_str()), ("2026-W47", "week", "2026-11-22"));
        assert_eq!(got[0].tags, vec!["专题/产品改版", "工作"]);
        assert_eq!(got[0].own_tags, vec!["工作"]);
        assert_eq!(got[0].note, "备注 #不是标签");
        // an update keeps the row (and its creation time)
        t.title = "改了".into();
        t.done = true;
        t.done_at = Some(5);
        t.plan_kind = "decade".into(); // unknown kinds are stored as "not planned"
        t.created_at = 99;
        t.updated_at = 7;
        apply(&mut conn, &[t], &[]).unwrap();
        let got = list(&conn).unwrap();
        assert_eq!((got.len(), got[0].title.as_str(), got[0].done, got[0].done_at, got[0].plan_kind.as_str(), got[0].created_at), (1, "改了", true, Some(5), "", 1));
        apply(&mut conn, &[], &["a".to_string()]).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn subtasks_follow_their_parent_and_order_does_not_matter() {
        let mut conn = db();
        let mut child = task("child");
        child.parent_id = Some("parent".into());
        let mut grand = task("grand");
        grand.parent_id = Some("child".into());
        // children first, parent last
        apply(&mut conn, &[grand, child, task("parent"), task("other")], &[]).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 4);
        apply(&mut conn, &[], &["parent".to_string()]).unwrap();
        let left: Vec<String> = list(&conn).unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(left, vec!["other"]);
    }

    #[test]
    fn deleting_a_note_deletes_its_tasks_only() {
        let mut conn = db();
        note(&conn, "n1");
        note(&conn, "n2");
        let mut a = task("a");
        a.source_note_id = Some("n1".into());
        let mut b = task("b");
        b.source_note_id = Some("n2".into());
        apply(&mut conn, &[a, b, task("standalone")], &[]).unwrap();
        conn.execute("DELETE FROM notes WHERE id = 'n1'", []).unwrap();
        let left: Vec<String> = list(&conn).unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(left, vec!["b", "standalone"]);
    }

    #[test]
    fn a_failing_batch_changes_nothing() {
        let mut conn = db();
        apply(&mut conn, &[task("keep")], &[]).unwrap();
        let mut bad = task("bad");
        bad.source_note_id = Some("no-such-note".into());
        let err = apply(&mut conn, &[task("new"), bad], &["keep".to_string()]).unwrap_err();
        assert!(err.contains("不存在"), "{err}");
        let ids: Vec<String> = list(&conn).unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["keep"]); // neither the new task nor the deletion happened
        // a subtask whose parent never shows up is refused too
        let mut orphan = task("orphan");
        orphan.parent_id = Some("ghost".into());
        assert!(apply(&mut conn, &[orphan], &[]).is_err());
    }

    fn goal(id: &str, kind: &str, period: &str) -> Goal {
        Goal { id: id.into(), title: format!("目标 {id}"), note: String::new(), kind: kind.into(), period: period.into(), parent_id: None, status: "doing".into(), mode: "auto".into(), percent: 0, sort: 0, closed_at: None, created_at: 1, updated_at: 1 }
    }

    #[test]
    fn goals_link_to_many_tasks_and_back() {
        let mut conn = db();
        apply(&mut conn, &[task("a"), task("b")], &[]).unwrap();
        let mut m = goal("m", "month", "2026-11");
        m.parent_id = Some("y".into());
        m.percent = 250; // clamped
        m.mode = "weird".into();
        goals_change(&mut conn, &[m, goal("y", "year", "2026")], &[], &[("a".into(), "m".into()), ("a".into(), "y".into()), ("b".into(), "y".into()), ("a".into(), "m".into())], &[]).unwrap();
        let d = goals_list(&conn).unwrap();
        assert_eq!(d.goals.len(), 2);
        let m = d.goals.iter().find(|g| g.id == "m").unwrap();
        assert_eq!((m.percent, m.mode.as_str(), m.parent_id.as_deref()), (100, "auto", Some("y")));
        assert_eq!(d.links.len(), 3); // the duplicate link is ignored
        goals_change(&mut conn, &[], &[], &[], &[("a".into(), "y".into())]).unwrap();
        assert_eq!(goals_list(&conn).unwrap().links.len(), 2);
    }

    #[test]
    fn deleting_a_task_or_a_goal_only_removes_links() {
        let mut conn = db();
        apply(&mut conn, &[task("a"), task("b")], &[]).unwrap();
        let mut m = goal("m", "month", "2026-11");
        m.parent_id = Some("y".into());
        goals_change(&mut conn, &[m, goal("y", "year", "2026")], &[], &[("a".into(), "m".into()), ("b".into(), "m".into())], &[]).unwrap();
        apply(&mut conn, &[], &["a".to_string()]).unwrap();
        assert_eq!(goals_list(&conn).unwrap().links, vec![("b".to_string(), "m".to_string())]);
        // deleting the year goal keeps the month goal (now without a parent) and the task
        goals_change(&mut conn, &[], &["y".to_string()], &[], &[]).unwrap();
        let d = goals_list(&conn).unwrap();
        assert_eq!((d.goals.len(), d.goals[0].parent_id.clone()), (1, None));
        goals_change(&mut conn, &[], &["m".to_string()], &[], &[]).unwrap();
        assert!(goals_list(&conn).unwrap().links.is_empty());
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn a_link_to_nothing_is_refused_and_changes_nothing() {
        let mut conn = db();
        apply(&mut conn, &[task("a")], &[]).unwrap();
        let err = goals_change(&mut conn, &[goal("g", "year", "2026")], &[], &[("a".into(), "g".into()), ("ghost".into(), "g".into())], &[]).unwrap_err();
        assert!(err.contains("不存在"), "{err}");
        assert!(goals_list(&conn).unwrap().goals.is_empty());
    }
}
