//! What travels between devices, and how two devices' versions of the same thing are merged (see docs/cloud-sync-plan.md).
//!
//! A [`Change`] is everything one device wrote (or deleted) since some time. Merging is by time, record by record:
//! the version written last wins, a deletion counts as a write, a tie goes to the larger device id. Merging is idempotent
//! (the same change twice does nothing the second time) and does not depend on the order changes arrive in, so devices that
//! exchange changes in any order end up with the same data. A note edited on two devices since they last met keeps the losing
//! version as a "conflict copy" in the recycle bin, so nothing is silently lost.
//!
//! Not in here yet: reading time (to be added up, not overwritten), goal-progress snapshots and the relation graph's card positions.

use crate::notes::{self, Link, Note};
use crate::sync::Tombstone;
use crate::tasks::{self, Goal, Task};
use crate::{review, trash};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FORMAT: u32 = 1;
const NOW: &str = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Item {
    Note { book_id: String, note: Note },
    /// A to-do with the ids of the goals it supports.
    Task { task: Task, goals: Vec<String> },
    Goal { goal: Goal },
    Link { link: Link },
    /// The description of a book on the shelf (not its file).
    Book { id: String, data: Value, updated_at: i64 },
    Trash { row: trash::Row },
    Review { item: review::Item, updated_at: i64 },
    Pin { tag: String, pinned: bool, updated_at: i64 },
    /// Time read on one day in one book, on the device that wrote this change (the totals are the sum over devices).
    Reading { day: String, book_id: String, secs: i64, p0: f64, p1: f64, updated_at: i64 },
    /// How far a goal was on a day.
    Snap { day: String, goal_id: String, percent: i64, updated_at: i64 },
    /// Where a note's card sits in the relation graph.
    Pos { note_id: String, x: f64, y: f64, w: f64, h: f64, updated_at: i64 },
}

impl Item {
    pub fn kind(&self) -> &'static str {
        match self {
            Item::Note { .. } => "note",
            Item::Task { .. } => "task",
            Item::Goal { .. } => "goal",
            Item::Link { .. } => "link",
            Item::Book { .. } => "book",
            Item::Trash { .. } => "trash",
            Item::Review { .. } => "review",
            Item::Pin { .. } => "pin",
            Item::Reading { .. } => "reading",
            Item::Snap { .. } => "snap",
            Item::Pos { .. } => "pos",
        }
    }
    pub fn id(&self) -> String {
        match self {
            Item::Note { note, .. } => note.id.clone(),
            Item::Task { task, .. } => task.id.clone(),
            Item::Goal { goal } => goal.id.clone(),
            Item::Link { link } => link.id.clone(),
            Item::Book { id, .. } => id.clone(),
            Item::Trash { row } => row.id.clone(),
            Item::Review { item, .. } => item.note_id.clone(),
            Item::Pin { tag, .. } => tag.clone(),
            Item::Reading { day, book_id, .. } => format!("{day}|{book_id}"),
            Item::Snap { day, goal_id, .. } => format!("{day}|{goal_id}"),
            Item::Pos { note_id, .. } => note_id.clone(),
        }
    }
    /// When it was last written.
    pub fn stamp(&self) -> i64 {
        match self {
            Item::Note { note, .. } => note.updated_at,
            Item::Task { task, .. } => task.updated_at,
            Item::Goal { goal } => goal.updated_at,
            Item::Link { link } => link.updated_at,
            Item::Book { updated_at, .. } | Item::Review { updated_at, .. } | Item::Pin { updated_at, .. } | Item::Reading { updated_at, .. } | Item::Snap { updated_at, .. } | Item::Pos { updated_at, .. } => *updated_at,
            Item::Trash { row } => row.deleted_at,
        }
    }
    /// The order things are written in, so what they refer to is there first.
    fn rank(&self) -> u8 {
        match self {
            Item::Book { .. } => 0,
            Item::Note { .. } => 1,
            Item::Goal { .. } => 2,
            Item::Task { .. } => 3,
            Item::Link { .. } => 4,
            Item::Review { .. } => 5,
            Item::Pin { .. } => 6,
            Item::Trash { .. } => 7,
            Item::Snap { .. } | Item::Pos { .. } => 5,
            Item::Reading { .. } => 8,
        }
    }
}

/// One file of changes in the cloud: what `device` wrote after its `seq - 1`th change.
#[derive(Serialize, Deserialize, Clone)]
pub struct Change {
    pub v: u32,
    pub device: String,
    pub seq: u64,
    pub created_at: i64,
    pub items: Vec<Item>,
    pub tombstones: Vec<Tombstone>,
}

// ---------------------------------------------------------------- what this device wrote

/// Everything written or deleted after `since` (ms).
pub fn export_since(conn: &Connection, since: i64) -> rusqlite::Result<(Vec<Item>, Vec<Tombstone>)> {
    export(conn, since, true)
}

/// Everything there is (for a snapshot): including what came from other devices.
pub fn export_all(conn: &Connection) -> rusqlite::Result<(Vec<Item>, Vec<Tombstone>)> {
    export(conn, -1, false)
}

fn export(conn: &Connection, since: i64, skip_known: bool) -> rusqlite::Result<(Vec<Item>, Vec<Tombstone>)> {
    let mut items = vec![];
    for h in notes::notes_changed_since(conn, since)? {
        items.push(Item::Note { book_id: h.book_id, note: h.note });
    }
    let goal_data = tasks::goals_list(conn)?;
    for t in tasks::list(conn)?.into_iter().filter(|t| t.updated_at > since) {
        let goals = goal_data.links.iter().filter(|(tid, _)| *tid == t.id).map(|(_, g)| g.clone()).collect();
        items.push(Item::Task { task: t, goals });
    }
    for g in goal_data.goals.into_iter().filter(|g| g.updated_at > since) {
        items.push(Item::Goal { goal: g });
    }
    for l in notes::links_list(conn)?.into_iter().filter(|l| l.updated_at > since) {
        items.push(Item::Link { link: l });
    }
    {
        let mut st = conn.prepare("SELECT id, data, updated_at FROM books WHERE updated_at > ?1")?;
        let rows = st.query_map([since], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))?;
        for r in rows {
            let (id, data, updated_at) = r?;
            if let Ok(data) = serde_json::from_str(&data) {
                items.push(Item::Book { id, data, updated_at });
            }
        }
    }
    for row in trash::all(conn)?.into_iter().filter(|r| r.deleted_at > since) {
        items.push(Item::Trash { row });
    }
    {
        let mut st = conn.prepare("SELECT note_id, level, due, last, reps, lapses, suspended, added, updated_at FROM review_items WHERE updated_at > ?1")?;
        let rows = st.query_map([since], |r| {
            Ok(Item::Review {
                item: review::Item { note_id: r.get(0)?, level: r.get(1)?, due: r.get(2)?, last: r.get(3)?, reps: r.get(4)?, lapses: r.get(5)?, suspended: r.get::<_, i64>(6)? != 0, added: r.get(7)? },
                updated_at: r.get(8)?,
            })
        })?;
        for r in rows {
            items.push(r?);
        }
    }
    {
        let mut st = conn.prepare("SELECT tag, pinned, updated_at FROM tag_meta WHERE updated_at > ?1")?;
        let rows = st.query_map([since], |r| Ok(Item::Pin { tag: r.get(0)?, pinned: r.get::<_, i64>(1)? != 0, updated_at: r.get(2)? }))?;
        for r in rows {
            items.push(r?);
        }
    }
    {
        let mut st = conn.prepare("SELECT day, book_id, secs, p0, p1, updated_at FROM reading_days WHERE updated_at > ?1")?;
        let rows = st.query_map([since], |r| Ok(Item::Reading { day: r.get(0)?, book_id: r.get(1)?, secs: r.get(2)?, p0: r.get(3)?, p1: r.get(4)?, updated_at: r.get(5)? }))?;
        for r in rows {
            items.push(r?);
        }
    }
    {
        let mut st = conn.prepare("SELECT day, goal_id, percent, updated_at FROM goal_snaps WHERE updated_at > ?1")?;
        let rows = st.query_map([since], |r| Ok(Item::Snap { day: r.get(0)?, goal_id: r.get(1)?, percent: r.get(2)?, updated_at: r.get(3)? }))?;
        for r in rows {
            items.push(r?);
        }
    }
    {
        let mut st = conn.prepare("SELECT note_id, x, y, w, h, updated_at FROM graph_pos WHERE updated_at > ?1")?;
        let rows = st.query_map([since], |r| Ok(Item::Pos { note_id: r.get(0)?, x: r.get(1)?, y: r.get(2)?, w: r.get(3)?, h: r.get(4)?, updated_at: r.get(5)? }))?;
        for r in rows {
            items.push(r?);
        }
    }
    // what arrived from other devices is not sent back to them (unless it has been written again here since)
    let mut tombs = crate::sync::tombstones_since(conn, since + 1)?;
    if skip_known {
        items.retain(|i| !is_known(conn, i.kind(), &i.id(), i.stamp()));
        tombs.retain(|t| !is_known(conn, &format!("del:{}", t.kind), &t.id, t.deleted_at));
    }
    Ok((items, tombs))
}

fn is_known(conn: &Connection, kind: &str, id: &str, stamp: i64) -> bool {
    conn.query_row("SELECT stamp FROM sync_known WHERE kind = ?1 AND id = ?2", params![kind, id], |r| r.get::<_, i64>(0)).optional().ok().flatten() == Some(stamp)
}

fn remember(tx: &Connection, kind: &str, id: &str, stamp: i64) -> rusqlite::Result<()> {
    tx.execute("INSERT OR REPLACE INTO sync_known(kind, id, stamp) VALUES(?1, ?2, ?3)", params![kind, id, stamp])?;
    Ok(())
}

pub fn make_change(conn: &Connection, device: &str, seq: u64, since: i64) -> rusqlite::Result<Change> {
    let (items, tombstones) = export_since(conn, since)?;
    let created_at: i64 = conn.query_row(&format!("SELECT {NOW}"), [], |r| r.get(0))?;
    Ok(Change { v: FORMAT, device: device.to_string(), seq, created_at, items, tombstones })
}

// ---------------------------------------------------------------- merging what other devices wrote

#[derive(Default, Debug, PartialEq)]
pub struct Report {
    /// Written (new, or newer than ours).
    pub applied: usize,
    /// Ours is newer: left as it is.
    pub older: usize,
    /// It was deleted after this was written.
    pub deleted: usize,
    /// Deleted here because another device deleted it.
    pub removed: usize,
    /// Edited on both devices: the losing version was kept as a conflict copy.
    pub conflicts: usize,
    /// Refers to something that does not exist here (any more): left out.
    pub dropped: usize,
}

enum Verdict {
    Apply,
    Older,
    Deleted,
}

fn tombstone_at(tx: &Connection, kind: &str, id: &str) -> rusqlite::Result<Option<i64>> {
    tx.query_row("SELECT deleted_at FROM tombstones WHERE kind = ?1 AND id = ?2", params![kind, id], |r| r.get(0)).optional()
}

/// When our copy was last written (None: we have none).
fn local_stamp(tx: &Connection, kind: &str, id: &str) -> rusqlite::Result<Option<i64>> {
    let sql = match kind {
        "note" => "SELECT updated_at FROM notes WHERE id = ?1",
        "task" => "SELECT updated_at FROM tasks WHERE id = ?1",
        "goal" => "SELECT updated_at FROM goals WHERE id = ?1",
        "link" => "SELECT updated_at FROM note_links WHERE id = ?1",
        "book" => "SELECT updated_at FROM books WHERE id = ?1",
        "trash" => "SELECT deleted_at FROM trash WHERE id = ?1",
        "review" => "SELECT updated_at FROM review_items WHERE note_id = ?1",
        "pin" => "SELECT updated_at FROM tag_meta WHERE tag = ?1",
        "snap" => "SELECT updated_at FROM goal_snaps WHERE day || '|' || goal_id = ?1",
        "pos" => "SELECT updated_at FROM graph_pos WHERE note_id = ?1",
        _ => return Ok(None),
    };
    tx.query_row(sql, [id], |r| r.get(0)).optional()
}

fn exists(tx: &Connection, table: &str, key: &str, id: &str) -> rusqlite::Result<bool> {
    Ok(tx.query_row(&format!("SELECT 1 FROM {table} WHERE {key} = ?1"), [id], |_| Ok(())).optional()?.is_some())
}

fn verdict(tx: &Connection, kind: &str, id: &str, remote: i64, remote_dev: &str, local_dev: &str) -> rusqlite::Result<Verdict> {
    if let Some(d) = tombstone_at(tx, kind, id)? {
        if d >= remote {
            return Ok(Verdict::Deleted);
        }
    }
    if let Some(l) = local_stamp(tx, kind, id)? {
        // the newer wins; on a tie the larger device id does (so both devices pick the same one)
        if l > remote || (l == remote && remote_dev <= local_dev) {
            return Ok(Verdict::Older);
        }
    }
    Ok(Verdict::Apply)
}

fn delete_local(tx: &Connection, kind: &str, id: &str) -> rusqlite::Result<()> {
    match kind {
        "note" => notes::delete_ids(tx, &[id.to_string()])?,
        "task" => drop(tx.execute("DELETE FROM tasks WHERE id = ?1", [id])?),
        "goal" => drop(tx.execute("DELETE FROM goals WHERE id = ?1", [id])?),
        "link" => drop(tx.execute("DELETE FROM note_links WHERE id = ?1", [id])?),
        "book" => drop(tx.execute("DELETE FROM books WHERE id = ?1", [id])?),
        "trash" => drop(tx.execute("DELETE FROM trash WHERE id = ?1", [id])?),
        _ => {}
    }
    Ok(())
}

fn preview(n: &Note) -> String {
    let text = if n.note.trim().is_empty() { n.anchor.get("exact").and_then(Value::as_str).unwrap_or("") } else { n.note.as_str() };
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(60).collect()
}

/// Keep our version of a note in the recycle bin before another device's version replaces it (as a note of its own, with its
/// own id, so restoring it can never overwrite the one that won).
fn keep_conflict_copy(tx: &Connection, book_id: &str, mine: &Note) -> rusqlite::Result<()> {
    let mut copy = serde_json::to_value(mine).unwrap_or(Value::Null);
    let new_id = format!("{}~c{}", mine.id, mine.updated_at);
    copy["id"] = Value::String(new_id.clone());
    let payload = serde_json::json!({ "bookId": book_id, "note": copy, "links": [], "review": null, "tasks": [], "goalLinks": [] });
    tx.execute(
        &format!("INSERT OR REPLACE INTO trash(id, kind, deleted_at, title, payload) VALUES(?1, 'note', {NOW}, ?2, ?3)"),
        params![format!("conflict-{new_id}"), format!("（冲突副本）{}", preview(mine)), payload.to_string()],
    )?;
    Ok(())
}

/// Merge what other devices wrote into this database, all in one transaction (nothing is applied if anything fails).
/// `last_sync_at` is when this device last synced: a note edited here since then and also changed elsewhere is a conflict.
pub fn apply(conn: &mut Connection, changes: &[Change], local_device: &str, last_sync_at: i64) -> rusqlite::Result<Report> {
    let tx = conn.transaction()?;
    let mut rep = Report::default();

    // 1. deletions first: a deletion newer than our copy removes it, an older one leaves our newer copy alone
    let mut tombs: Vec<(&Tombstone, &str)> = changes.iter().flat_map(|c| c.tombstones.iter().map(move |t| (t, c.device.as_str()))).collect();
    tombs.sort_by(|a, b| (a.0.deleted_at, &a.0.kind, &a.0.id, a.1).cmp(&(b.0.deleted_at, &b.0.kind, &b.0.id, b.1)));
    for (t, _) in tombs {
        match local_stamp(&tx, &t.kind, &t.id)? {
            Some(l) if l > t.deleted_at => rep.older += 1, // we wrote it after it was deleted
            Some(_) => {
                delete_local(&tx, &t.kind, &t.id)?;
                // the trigger noted the deletion as "now": it happened when the other device says
                tx.execute("INSERT OR REPLACE INTO tombstones(kind, id, deleted_at) VALUES(?1, ?2, ?3)", params![t.kind, t.id, t.deleted_at])?;
                remember(&tx, &format!("del:{}", t.kind), &t.id, t.deleted_at)?;
                rep.removed += 1;
            }
            None => {
                tx.execute(
                    "INSERT INTO tombstones(kind, id, deleted_at) VALUES(?1, ?2, ?3) ON CONFLICT(kind, id) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)",
                    params![t.kind, t.id, t.deleted_at],
                )?;
                remember(&tx, &format!("del:{}", t.kind), &t.id, t.deleted_at)?;
            }
        }
    }

    // 2. writes, in the order that keeps references valid, the oldest first
    let mut items: Vec<(&Item, &str)> = changes.iter().flat_map(|c| c.items.iter().map(move |i| (i, c.device.as_str()))).collect();
    items.sort_by(|a, b| (a.0.rank(), a.0.stamp(), a.1).cmp(&(b.0.rank(), b.0.stamp(), b.1)));
    let mut task_parents: Vec<(String, String)> = vec![];
    let mut goal_parents: Vec<(String, String)> = vec![];
    for (item, dev) in items {
        if let Item::Reading { day, book_id, secs, p0, p1, updated_at } = item {
            // each device's reading time is its own row: the newest version of that row wins, and the totals add the rows up
            let have: Option<i64> = tx.query_row("SELECT updated_at FROM reading_remote WHERE day = ?1 AND book_id = ?2 AND device = ?3", params![day, book_id, dev], |r| r.get(0)).optional()?;
            if dev != local_device && have.map_or(true, |h| h < *updated_at) {
                tx.execute(
                    "INSERT INTO reading_remote(day, book_id, device, secs, p0, p1, updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)
                     ON CONFLICT(day, book_id, device) DO UPDATE SET secs = excluded.secs, p0 = excluded.p0, p1 = excluded.p1, updated_at = excluded.updated_at",
                    params![day, book_id, dev, secs, p0, p1, updated_at],
                )?;
                rep.applied += 1;
            } else {
                rep.older += 1;
            }
            continue;
        }
        match verdict(&tx, item.kind(), &item.id(), item.stamp(), dev, local_device)? {
            Verdict::Deleted => {
                rep.deleted += 1;
                continue;
            }
            Verdict::Older => {
                rep.older += 1;
                continue;
            }
            Verdict::Apply => {}
        }
        let ok = match item {
            Item::Note { book_id, note } => {
                if let Some(mine) = notes::note_by_id(&tx, &note.id)? {
                    let changed_here = mine.note.updated_at > last_sync_at;
                    if changed_here && (mine.note.note != note.note || mine.note.images != note.images) {
                        keep_conflict_copy(&tx, &mine.book_id, &mine.note)?;
                        rep.conflicts += 1;
                    }
                }
                notes::upsert(&tx, book_id, note)?;
                true
            }
            Item::Goal { goal } => {
                let mut g = goal.clone();
                if let Some(p) = g.parent_id.take() {
                    goal_parents.push((g.id.clone(), p));
                }
                tasks::put_goal(&tx, &g)?;
                true
            }
            Item::Task { task, goals } => {
                if task.source_note_id.as_deref().map_or(false, |n| !exists(&tx, "notes", "id", n).unwrap_or(false)) {
                    false // its note is gone
                } else {
                    let mut t = task.clone();
                    if let Some(p) = t.parent_id.take() {
                        task_parents.push((t.id.clone(), p));
                    }
                    tasks::put_one(&tx, &t)?;
                    tx.execute("DELETE FROM task_goals WHERE task_id = ?1", [&t.id])?;
                    for g in goals {
                        if exists(&tx, "goals", "id", g)? {
                            tx.execute("INSERT OR IGNORE INTO task_goals(task_id, goal_id) VALUES(?1, ?2)", params![t.id, g])?;
                        }
                    }
                    true
                }
            }
            Item::Link { link } => exists(&tx, "notes", "id", &link.a)? && exists(&tx, "notes", "id", &link.b)? && notes::link_put_one(&tx, link).is_ok(),
            Item::Book { id, data, updated_at } => {
                tx.execute(
                    "INSERT INTO books(id, data, updated_at) VALUES(?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
                    params![id, serde_json::to_string(data).unwrap_or_default(), updated_at],
                )?;
                true
            }
            Item::Trash { row } => {
                tx.execute(
                    "INSERT OR REPLACE INTO trash(id, kind, deleted_at, title, payload) VALUES(?1, ?2, ?3, ?4, ?5)",
                    params![row.id, row.kind, row.deleted_at, row.title, row.payload],
                )?;
                true
            }
            Item::Review { item: it, updated_at } => {
                if !exists(&tx, "notes", "id", &it.note_id)? {
                    false
                } else {
                    tx.execute(
                        "INSERT INTO review_items(note_id, level, due, last, reps, lapses, suspended, added, updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
                         ON CONFLICT(note_id) DO UPDATE SET level = excluded.level, due = excluded.due, last = excluded.last, reps = excluded.reps,
                           lapses = excluded.lapses, suspended = excluded.suspended, updated_at = excluded.updated_at",
                        params![it.note_id, it.level, it.due, it.last, it.reps, it.lapses, it.suspended as i64, it.added, updated_at],
                    )?;
                    true
                }
            }
            Item::Snap { day, goal_id, percent, updated_at } => {
                if !exists(&tx, "goals", "id", goal_id)? {
                    false
                } else {
                    tx.execute(
                        "INSERT INTO goal_snaps(day, goal_id, percent, updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(day, goal_id) DO UPDATE SET percent = excluded.percent, updated_at = excluded.updated_at",
                        params![day, goal_id, percent, updated_at],
                    )?;
                    true
                }
            }
            Item::Pos { note_id, x, y, w, h, updated_at } => {
                if !exists(&tx, "notes", "id", note_id)? {
                    false
                } else {
                    tx.execute(
                        "INSERT INTO graph_pos(note_id, x, y, w, h, updated_at) VALUES(?1,?2,?3,?4,?5,?6)
                         ON CONFLICT(note_id) DO UPDATE SET x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, updated_at = excluded.updated_at",
                        params![note_id, x, y, w, h, updated_at],
                    )?;
                    true
                }
            }
            Item::Reading { .. } => true, // handled above
            Item::Pin { tag, pinned, updated_at } => {
                tx.execute("INSERT OR REPLACE INTO tag_meta(tag, pinned, updated_at) VALUES(?1, ?2, ?3)", params![tag, *pinned as i64, updated_at])?;
                true
            }
        };
        if ok {
            remember(&tx, item.kind(), &item.id(), item.stamp())?;
            rep.applied += 1;
        } else {
            rep.dropped += 1;
        }
    }

    // 3. parents last: they may have arrived after their children
    for (id, parent) in task_parents {
        if exists(&tx, "tasks", "id", &parent)? {
            tx.execute("UPDATE tasks SET parent_id = ?2 WHERE id = ?1", params![id, parent])?;
        }
    }
    for (id, parent) in goal_parents {
        if exists(&tx, "goals", "id", &parent)? {
            tx.execute("UPDATE goals SET parent_id = ?2 WHERE id = ?1", params![id, parent])?;
        }
    }
    tx.commit()?;
    Ok(rep)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(notes::SCHEMA).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn
    }
    fn note(id: &str, text: &str, at: i64) -> Note {
        serde_json::from_value(serde_json::json!({
            "id": id, "anchor": {"section": 0, "start": 0, "end": 0, "exact": ""}, "color": "amber", "style": "none",
            "note": text, "kind": "free", "createdAt": 1, "updatedAt": at
        }))
        .unwrap()
    }
    fn put_note(c: &Connection, id: &str, text: &str, at: i64) {
        notes::upsert(c, "_memo", &note(id, text, at)).unwrap();
    }
    /// A deletion that happened at a known time (the trigger would say "now").
    fn del_note(c: &Connection, id: &str, at: i64) {
        notes::delete_ids(c, &[id.to_string()]).unwrap();
        c.execute("UPDATE tombstones SET deleted_at = ?2 WHERE kind = 'note' AND id = ?1", params![id, at]).unwrap();
    }
    fn text(c: &Connection, id: &str) -> Option<(String, i64)> {
        c.query_row("SELECT note, updated_at FROM notes WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().unwrap()
    }
    /// What `from` has written, merged into `to`.
    fn send(from: &Connection, from_dev: &str, to: &mut Connection, to_dev: &str, last_sync: i64) -> Report {
        let ch = make_change(from, from_dev, 1, 0).unwrap();
        // through JSON, as it will travel
        let ch: Change = serde_json::from_str(&serde_json::to_string(&ch).unwrap()).unwrap();
        apply(to, &[ch], to_dev, last_sync).unwrap()
    }

    #[test]
    fn a_note_written_on_one_device_arrives_on_the_other_with_its_own_time() {
        let a = db();
        let mut b = db();
        put_note(&a, "n1", "写在 A 上的笔记 #读书", 1000);
        let r = send(&a, "A", &mut b, "B", 0);
        assert_eq!(r.applied, 1);
        assert_eq!(text(&b, "n1"), Some(("写在 A 上的笔记 #读书".into(), 1000)));
        // the search index and the tags came along
        let found: i64 = b.query_row("SELECT count(*) FROM notes_fts WHERE notes_fts MATCH '\"A 上的笔记\"'", [], |r| r.get(0)).unwrap();
        assert_eq!(found, 1);
        let tags: i64 = b.query_row("SELECT count(*) FROM note_tags WHERE tag = '读书'", [], |r| r.get(0)).unwrap();
        assert_eq!(tags, 1);
    }

    #[test]
    fn the_newer_version_wins_in_either_direction() {
        let mut a = db();
        let mut b = db();
        put_note(&a, "n1", "旧", 1000);
        put_note(&b, "n1", "新", 2000);
        let r1 = send(&b, "B", &mut a, "A", 5000);
        assert_eq!(r1.applied, 1);
        assert_eq!(text(&a, "n1").unwrap().0, "新");
        let r2 = send(&a, "A", &mut b, "B", 5000); // now A holds the same: nothing to do
        assert_eq!(text(&b, "n1").unwrap().0, "新");
        assert_eq!(r2.applied, 0);
    }

    #[test]
    fn merging_twice_changes_nothing_the_second_time() {
        let a = db();
        let mut b = db();
        put_note(&a, "n1", "x", 1000);
        a.execute("INSERT INTO goals(id, created_at, updated_at) VALUES('g', 1, 1000)", []).unwrap();
        assert_eq!(send(&a, "A", &mut b, "B", 0).applied, 2);
        let again = send(&a, "A", &mut b, "B", 0);
        assert_eq!(again.applied, 0);
        assert_eq!(again.older, 2);
    }

    #[test]
    fn a_deletion_travels_and_keeps_the_time_it_happened() {
        let a = db();
        let mut b = db();
        put_note(&a, "n1", "x", 1000);
        send(&a, "A", &mut b, "B", 0);
        del_note(&a, "n1", 3000);
        let r = send(&a, "A", &mut b, "B", 0);
        assert_eq!(r.removed, 1);
        assert!(text(&b, "n1").is_none());
        let at: i64 = b.query_row("SELECT deleted_at FROM tombstones WHERE kind = 'note' AND id = 'n1'", [], |r| r.get(0)).unwrap();
        assert_eq!(at, 3000, "not the moment B happened to hear about it");
        // an old copy of the note turning up later is not brought back
        let mut c = db();
        put_note(&c, "n1", "x", 1000);
        let r = send(&a, "A", &mut c, "C", 0); // (what B learned from A is not sent on by B: C hears it from A)
        assert!(text(&c, "n1").is_none(), "{r:?}");
    }

    #[test]
    fn an_edit_after_a_deletion_brings_the_note_back_everywhere() {
        let mut a = db();
        let mut b = db();
        put_note(&a, "n1", "x", 1000);
        send(&a, "A", &mut b, "B", 0);
        del_note(&a, "n1", 2000); // A deletes it
        put_note(&b, "n1", "x，后来又改了", 3000); // B, not knowing, edits it later
        send(&a, "A", &mut b, "B", 0);
        assert_eq!(text(&b, "n1").unwrap().0, "x，后来又改了", "B's later edit survives the deletion");
        send(&b, "B", &mut a, "A", 0);
        assert_eq!(text(&a, "n1").unwrap().0, "x，后来又改了", "and A gets it back");
        let gone: i64 = a.query_row("SELECT count(*) FROM tombstones WHERE id = 'n1'", [], |r| r.get(0)).unwrap();
        assert_eq!(gone, 0);
    }

    #[test]
    fn a_note_edited_on_both_devices_keeps_the_loser_as_a_conflict_copy() {
        let mut a = db();
        let b = db();
        put_note(&a, "n1", "原文", 1000); // both had this when they last met (at 1500)
        put_note(&b, "n1", "B 的改动", 3000);
        a.execute("UPDATE notes SET note = 'A 的改动', updated_at = 2000 WHERE id = 'n1'", []).unwrap();
        let r = send(&b, "B", &mut a, "A", 1500);
        assert_eq!((r.applied, r.conflicts), (1, 1));
        assert_eq!(text(&a, "n1").unwrap().0, "B 的改动");
        let (title, payload): (String, String) = a.query_row("SELECT title, payload FROM trash WHERE id LIKE 'conflict-%'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert!(title.starts_with("（冲突副本）A 的改动"), "{title}");
        let p: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(p["note"]["note"], "A 的改动");
        assert_ne!(p["note"]["id"], "n1", "restoring the copy must not overwrite the winner");
        assert_eq!(p["bookId"], "_memo");
    }

    #[test]
    fn a_plain_update_is_not_a_conflict() {
        let mut a = db();
        let b = db();
        put_note(&a, "n1", "原文", 1000); // A has not touched it since they met at 1500
        put_note(&b, "n1", "B 的改动", 3000);
        let r = send(&b, "B", &mut a, "A", 1500);
        assert_eq!((r.applied, r.conflicts), (1, 0));
    }

    #[test]
    fn todos_bring_their_goals_and_subtasks_and_wait_for_what_they_refer_to() {
        let a = db();
        let mut b = db();
        a.execute("INSERT INTO goals(id, title, kind, created_at, updated_at) VALUES('g1', '读书', 'month', 1, 1000)", []).unwrap();
        a.execute("INSERT INTO tasks(id, title, created_at, updated_at) VALUES('t1', '父', 1, 1000)", []).unwrap();
        a.execute("INSERT INTO tasks(id, title, parent_id, created_at, updated_at) VALUES('t2', '子', 't1', 1, 1000)", []).unwrap();
        a.execute("INSERT INTO task_goals(task_id, goal_id) VALUES('t2', 'g1')", []).unwrap();
        let r = send(&a, "A", &mut b, "B", 0);
        assert_eq!((r.applied, r.dropped), (3, 0));
        let parent: Option<String> = b.query_row("SELECT parent_id FROM tasks WHERE id = 't2'", [], |r| r.get(0)).unwrap();
        assert_eq!(parent.as_deref(), Some("t1"));
        let linked: i64 = b.query_row("SELECT count(*) FROM task_goals WHERE task_id = 't2' AND goal_id = 'g1'", [], |r| r.get(0)).unwrap();
        assert_eq!(linked, 1);
    }

    #[test]
    fn changing_a_todos_goals_counts_as_changing_the_todo() {
        let mut a = db();
        a.execute("INSERT INTO goals(id, created_at, updated_at) VALUES('g1', 1, 1)", []).unwrap();
        a.execute("INSERT INTO tasks(id, created_at, updated_at) VALUES('t1', 1, 1000)", []).unwrap();
        tasks::goals_change(&mut a, &[], &[], &[("t1".into(), "g1".into())], &[]).unwrap();
        let at: i64 = a.query_row("SELECT updated_at FROM tasks WHERE id = 't1'", [], |r| r.get(0)).unwrap();
        assert!(at > 1000);
        let mut b = db();
        send(&a, "A", &mut b, "B", 0);
        let linked: i64 = b.query_row("SELECT count(*) FROM task_goals", [], |r| r.get(0)).unwrap();
        assert_eq!(linked, 1);
    }

    #[test]
    fn a_todo_whose_note_was_deleted_is_left_out_and_links_need_both_notes() {
        let a = db();
        let mut b = db();
        put_note(&a, "n1", "x", 1000);
        a.execute("INSERT INTO tasks(id, title, source_note_id, created_at, updated_at) VALUES('t1', 'a', 'n1', 1, 1000)", []).unwrap();
        a.execute("INSERT INTO note_links(id, a, b, created_at, updated_at) VALUES('l1', 'n1', 'zz', 1, 1000)", []).unwrap_err(); // (a link to a missing note cannot even exist on A)
        // B had the note and deleted it long ago
        put_note(&b, "n1", "x", 1000);
        del_note(&b, "n1", 5000);
        let r = send(&a, "A", &mut b, "B", 0);
        assert!(text(&b, "n1").is_none());
        assert_eq!(r.deleted, 1);
        assert_eq!(r.dropped, 1, "{r:?}"); // the todo had nowhere to live
        let n: i64 = b.query_row("SELECT count(*) FROM tasks", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn books_review_progress_and_pins_follow_the_newest_write() {
        let a = db();
        let mut b = db();
        a.execute("INSERT INTO books(id, data, updated_at) VALUES('bk', '{\"id\":\"bk\",\"title\":\"书\",\"progress\":0.5}', 4000)", []).unwrap();
        b.execute("INSERT INTO books(id, data, updated_at) VALUES('bk', '{\"id\":\"bk\",\"title\":\"书\",\"progress\":0.9}', 6000)", []).unwrap();
        put_note(&a, "n1", "x", 1);
        a.execute("INSERT INTO review_items(note_id, level, due, updated_at) VALUES('n1', 3, '2026-12-01', 4000)", []).unwrap();
        a.execute("INSERT INTO tag_meta(tag, pinned, updated_at) VALUES('读书', 1, 4000)", []).unwrap();
        send(&a, "A", &mut b, "B", 0);
        let prog: String = b.query_row("SELECT data FROM books WHERE id = 'bk'", [], |r| r.get(0)).unwrap();
        assert!(prog.contains("0.9"), "B's newer progress is kept: {prog}");
        let lvl: i64 = b.query_row("SELECT level FROM review_items WHERE note_id = 'n1'", [], |r| r.get(0)).unwrap();
        assert_eq!(lvl, 3);
        let pinned: i64 = b.query_row("SELECT pinned FROM tag_meta WHERE tag = '读书'", [], |r| r.get(0)).unwrap();
        assert_eq!(pinned, 1);
    }

    #[test]
    fn a_tie_goes_to_the_larger_device_id_on_both_sides() {
        let mut a = db();
        let mut b = db();
        put_note(&a, "n1", "来自 A", 1000);
        put_note(&b, "n1", "来自 B", 1000);
        send(&a, "A", &mut b, "B", 0);
        send(&b, "B", &mut a, "A", 0);
        assert_eq!(text(&a, "n1"), text(&b, "n1"));
        assert_eq!(text(&a, "n1").unwrap().0, "来自 B"); // "B" > "A"
    }

    #[test]
    fn a_failed_merge_applies_nothing() {
        let a = db();
        let mut b = db();
        put_note(&a, "n1", "x", 1000);
        let mut ch = make_change(&a, "A", 1, 0).unwrap();
        // a note whose JSON is fine but whose kind of book id breaks nothing: force a failure with an impossible link
        ch.items.push(Item::Link { link: Link { id: "l".into(), a: "n1".into(), b: "n1".into(), label: String::new(), color: String::new(), style: String::new(), side_a: String::new(), side_b: String::new(), created_at: 1, updated_at: 2000 } });
        let r = apply(&mut b, &[ch], "B", 0).unwrap();
        assert_eq!(r.dropped, 1); // a link to itself is refused and left out, the note still arrives
        assert!(text(&b, "n1").is_some());
    }

    fn hours(c: &Connection) -> Vec<(String, String, i64)> {
        crate::reading::all(c).unwrap().into_iter().map(|d| (d.day, d.book_id, d.secs)).collect()
    }

    #[test]
    fn reading_time_from_two_devices_adds_up_and_does_not_double_count() {
        let mut a = db();
        let mut b = db();
        crate::reading::add(&a, "2026-11-14", "book1", 600, 0.2).unwrap();
        crate::reading::add(&b, "2026-11-14", "book1", 300, 0.25).unwrap();
        crate::reading::add(&b, "2026-11-14", "book2", 120, 0.0).unwrap();
        send(&a, "A", &mut b, "B", 0);
        send(&b, "B", &mut a, "A", 0);
        assert_eq!(hours(&a), hours(&b));
        assert_eq!(hours(&a), [("2026-11-14".into(), "book1".into(), 900), ("2026-11-14".into(), "book2".into(), 120)]);
        // the same changes again: still 900
        send(&a, "A", &mut b, "B", 0);
        send(&b, "B", &mut a, "A", 0);
        assert_eq!(hours(&b)[0].2, 900);
        // A reads on: its row grows, B's total follows (not 900 + 700)
        crate::reading::add(&a, "2026-11-14", "book1", 100, 0.3).unwrap();
        send(&a, "A", &mut b, "B", 0);
        assert_eq!(hours(&b)[0].2, 1000);
        // progress over the day: first position from the earliest, last from the latest
        let d = crate::reading::all(&b).unwrap().into_iter().find(|d| d.book_id == "book1").unwrap();
        assert!(d.p0 <= 0.2 + 1e-9 && d.p1 >= 0.3 - 1e-9, "{d:?}");
    }

    #[test]
    fn goal_snapshots_and_card_positions_follow_the_newest_write() {
        let mut a = db();
        let mut b = db();
        put_note(&a, "n1", "x", 1000);
        a.execute("INSERT INTO goals(id, created_at, updated_at) VALUES('g1', 1, 1000)", []).unwrap();
        a.execute("INSERT INTO goal_snaps(day, goal_id, percent, updated_at) VALUES('2026-11-08', 'g1', 30, 4000)", []).unwrap();
        a.execute("INSERT INTO graph_pos(note_id, x, y, w, h, updated_at) VALUES('n1', 10, 20, 0, 0, 4000)", []).unwrap();
        send(&a, "A", &mut b, "B", 0);
        let pct: i64 = b.query_row("SELECT percent FROM goal_snaps WHERE day = '2026-11-08'", [], |r| r.get(0)).unwrap();
        assert_eq!(pct, 30);
        let x: f64 = b.query_row("SELECT x FROM graph_pos WHERE note_id = 'n1'", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 10.0);
        // B moves the card later: A's old position does not win back
        b.execute("UPDATE graph_pos SET x = 99, updated_at = 6000 WHERE note_id = 'n1'", []).unwrap();
        send(&a, "A", &mut b, "B", 0);
        let x: f64 = b.query_row("SELECT x FROM graph_pos WHERE note_id = 'n1'", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 99.0);
        send(&b, "B", &mut a, "A", 0);
        let x: f64 = a.query_row("SELECT x FROM graph_pos WHERE note_id = 'n1'", [], |r| r.get(0)).unwrap();
        assert_eq!(x, 99.0);
    }

    /// Two devices write and delete at random, then swap everything once: they must end up the same.
    #[test]
    fn devices_that_write_and_delete_at_random_end_up_the_same() {
        let mut seed: u64 = 12345;
        let mut next = move |n: u64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) % n
        };
        for round in 0..300 {
            let mut a = db();
            let mut b = db();
            let mut clock = 1000i64;
            for _ in 0..(5 + next(25)) {
                clock += 1 + next(5) as i64; // every action has its own time, as real writes do
                let (c, _name) = if next(2) == 0 { (&a, "A") } else { (&b, "B") };
                let id = format!("n{}", next(6));
                if next(4) == 0 {
                    if text(c, &id).is_some() {
                        del_note(c, &id, clock);
                    }
                } else {
                    put_note(c, &id, &format!("v{clock}"), clock);
                }
            }
            let (ca, cb) = (make_change(&a, "A", 1, 0).unwrap(), make_change(&b, "B", 1, 0).unwrap());
            apply(&mut a, &[cb.clone()], "A", 0).unwrap();
            apply(&mut b, &[ca.clone()], "B", 0).unwrap();
            for i in 0..6 {
                let id = format!("n{i}");
                assert_eq!(text(&a, &id), text(&b, &id), "round {round}, note {id}");
            }
            // and a second exchange changes nothing
            let (ca2, cb2) = (make_change(&a, "A", 2, 0).unwrap(), make_change(&b, "B", 2, 0).unwrap());
            apply(&mut a, &[cb2], "A", 0).unwrap();
            apply(&mut b, &[ca2], "B", 0).unwrap();
            for i in 0..6 {
                let id = format!("n{i}");
                assert_eq!(text(&a, &id), text(&b, &id), "round {round} (second exchange), note {id}");
            }
        }
    }
}
