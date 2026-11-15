//! Notes database (SQLite + FTS5 trigram).
//!
//! A note = one annotation: anchor + colour/style + free text. Tags are written inline in the
//! text Flomo-style (`#读书/方法`), parsed into `note_tags`, and are global across all books.

use rusqlite::{params, params_from_iter, types::Value as Sql, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

pub(crate) const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS notes(
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,
  section INTEGER NOT NULL DEFAULT 0,
  pos INTEGER NOT NULL DEFAULT 0,
  anchor TEXT NOT NULL,
  quote TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  style TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  thought INTEGER NOT NULL DEFAULT 0,
  side TEXT NOT NULL DEFAULT 'right',
  side_locked INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'passage',
  images TEXT NOT NULL DEFAULT '',
  canonical_ref TEXT NOT NULL DEFAULT '',
  source_module TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_book ON notes(book_id, section, pos);
CREATE INDEX IF NOT EXISTS notes_created ON notes(created_at);
CREATE TABLE IF NOT EXISTS note_tags(
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY(note_id, tag)
);
CREATE INDEX IF NOT EXISTS note_tags_tag ON note_tags(tag);
CREATE TABLE IF NOT EXISTS tag_meta(tag TEXT PRIMARY KEY, pinned INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS note_links(
  id TEXT PRIMARY KEY,
  a TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  b TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  side_a TEXT NOT NULL DEFAULT '',
  side_b TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS note_links_a ON note_links(a);
CREATE INDEX IF NOT EXISTS note_links_b ON note_links(b);
CREATE TABLE IF NOT EXISTS graph_pos(
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  x REAL NOT NULL,
  y REAL NOT NULL,
  w REAL NOT NULL DEFAULT 0,
  h REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  plan TEXT NOT NULL DEFAULT '',
  plan_kind TEXT NOT NULL DEFAULT '',
  plan_start TEXT NOT NULL DEFAULT '',
  plan_end TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  own_tags TEXT NOT NULL DEFAULT '',
  parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0,
  source_note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
  source_line TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_note ON tasks(source_note_id);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
CREATE TABLE IF NOT EXISTS goals(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'month',
  period TEXT NOT NULL DEFAULT '',
  parent_id TEXT REFERENCES goals(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'doing',
  mode TEXT NOT NULL DEFAULT 'auto',
  percent INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS task_goals(
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, goal_id)
);
CREATE INDEX IF NOT EXISTS task_goals_goal ON task_goals(goal_id);
CREATE TABLE IF NOT EXISTS review_items(
  note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  level INTEGER NOT NULL DEFAULT 0,
  due TEXT NOT NULL,
  last TEXT NOT NULL DEFAULT '',
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  added TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS review_items_due ON review_items(due);
CREATE TABLE IF NOT EXISTS trash(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trash_deleted ON trash(deleted_at);
CREATE TABLE IF NOT EXISTS review_log(
  day TEXT NOT NULL,
  note_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  PRIMARY KEY(day, note_id)
);
CREATE TABLE IF NOT EXISTS goal_snaps(
  day TEXT NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  percent INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, goal_id)
);
CREATE TABLE IF NOT EXISTS reading_days(
  day TEXT NOT NULL,
  book_id TEXT NOT NULL,
  secs INTEGER NOT NULL DEFAULT 0,
  p0 REAL NOT NULL DEFAULT 0,
  p1 REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, book_id)
);
-- Reading time other devices recorded (each device only ever writes its own rows, so the totals are the sum of all rows).
CREATE TABLE IF NOT EXISTS reading_remote(
  day TEXT NOT NULL,
  book_id TEXT NOT NULL,
  device TEXT NOT NULL,
  secs INTEGER NOT NULL DEFAULT 0,
  p0 REAL NOT NULL DEFAULT 0,
  p1 REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, book_id, device)
);
-- The shelf's books, one row each (the description of a book; the files stay under books/).
CREATE TABLE IF NOT EXISTS books(
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
-- What came from other devices (kind, id, the time it was written there), so it is not sent straight back to them.
CREATE TABLE IF NOT EXISTS sync_known(
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  stamp INTEGER NOT NULL,
  PRIMARY KEY(kind, id)
);
-- Which files (pictures, books) this device has put in the cloud, or asked for and not found (and when).
CREATE TABLE IF NOT EXISTS sync_files(
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  state TEXT NOT NULL,
  at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(kind, id)
);
-- What was deleted and when (for syncing between devices: another device must hear that a record is gone, not just that it is missing).
-- Triggers write it, so every way of deleting is covered, cascades included; writing a record again takes its tombstone away.
CREATE TABLE IF NOT EXISTS tombstones(
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY(kind, id)
);
CREATE TRIGGER IF NOT EXISTS notes_tomb AFTER DELETE ON notes BEGIN
  INSERT OR REPLACE INTO tombstones(kind, id, deleted_at) VALUES('note', OLD.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS notes_untomb AFTER INSERT ON notes BEGIN
  DELETE FROM tombstones WHERE kind = 'note' AND id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS tasks_tomb AFTER DELETE ON tasks BEGIN
  INSERT OR REPLACE INTO tombstones(kind, id, deleted_at) VALUES('task', OLD.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS tasks_untomb AFTER INSERT ON tasks BEGIN
  DELETE FROM tombstones WHERE kind = 'task' AND id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS goals_tomb AFTER DELETE ON goals BEGIN
  INSERT OR REPLACE INTO tombstones(kind, id, deleted_at) VALUES('goal', OLD.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS goals_untomb AFTER INSERT ON goals BEGIN
  DELETE FROM tombstones WHERE kind = 'goal' AND id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS note_links_tomb AFTER DELETE ON note_links BEGIN
  INSERT OR REPLACE INTO tombstones(kind, id, deleted_at) VALUES('link', OLD.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS note_links_untomb AFTER INSERT ON note_links BEGIN
  DELETE FROM tombstones WHERE kind = 'link' AND id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS trash_tomb AFTER DELETE ON trash BEGIN
  INSERT OR REPLACE INTO tombstones(kind, id, deleted_at) VALUES('trash', OLD.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS trash_untomb AFTER INSERT ON trash BEGIN
  DELETE FROM tombstones WHERE kind = 'trash' AND id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS books_tomb AFTER DELETE ON books BEGIN
  INSERT OR REPLACE INTO tombstones(kind, id, deleted_at) VALUES('book', OLD.id, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
END;
CREATE TRIGGER IF NOT EXISTS books_untomb AFTER INSERT ON books BEGIN
  DELETE FROM tombstones WHERE kind = 'book' AND id = NEW.id;
END;
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(quote, note, tokenize = 'trigram');
";

// ---------------------------------------------------------------- tags

const STOP: &str = "，。、；：！？,.;:!?()（）[]【】{}<>《》\"'“”‘’…·`~|*";

fn is_stop(c: char) -> bool {
    c.is_whitespace() || c == '#' || STOP.contains(c)
}

/// `#tag` tokens: (byte start of '#', byte end, normalized tag). Must match src/notes/tags.ts.
pub fn tag_spans(text: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut i = 0;
    while i < chars.len() {
        let (b, c) = chars[i];
        let boundary = i == 0 || is_stop(chars[i - 1].1);
        if c == '#' && boundary {
            let mut j = i + 1;
            while j < chars.len() && !is_stop(chars[j].1) {
                j += 1;
            }
            let end = if j < chars.len() { chars[j].0 } else { text.len() };
            let norm = normalize(&text[b + 1..end]);
            if !norm.is_empty() {
                out.push((b, end, norm));
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    out
}

pub fn normalize(tag: &str) -> String {
    tag.split('/').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("/")
}

pub fn parse_tags(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    tag_spans(text).into_iter().map(|s| s.2).filter(|t| seen.insert(t.clone())).collect()
}

/// Text with all tag tokens removed — non-empty means the note carries an actual thought.
fn has_thought(text: &str) -> bool {
    let mut rest = String::new();
    let mut last = 0;
    for (s, e, _) in tag_spans(text) {
        rest.push_str(&text[last..s]);
        last = e;
    }
    rest.push_str(&text[last..]);
    !rest.trim().is_empty()
}

fn under(tag: &str, root: &str) -> bool {
    tag == root || (tag.len() > root.len() && tag.starts_with(root) && tag.as_bytes()[root.len()] == b'/')
}

/// Rewrite tag tokens under `from` to live under `to` (or remove them when `to` is None).
fn rewrite_tags(text: &str, from: &str, to: Option<&str>) -> String {
    let mut out = String::new();
    let mut last = 0;
    for (s, e, tag) in tag_spans(text) {
        if !under(&tag, from) {
            continue;
        }
        out.push_str(&text[last..s]);
        if let Some(to) = to {
            out.push('#');
            out.push_str(to);
            out.push_str(&tag[from.len()..]);
        }
        last = e;
    }
    out.push_str(&text[last..]);
    if to.is_none() {
        // Tidy the whitespace left behind by removed tokens.
        out = out.split(' ').filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ");
        out = out.trim().to_string();
    }
    out
}

// ---------------------------------------------------------------- model

/// Sentinel `book_id` of free-standing notes ("随手记"), which belong to no book or article.
pub const FREE_BOOK: &str = "_memo";

/// "passage" = anchored to selected text; "doc" = about the whole book / article (no anchor);
/// "free" = a standalone note unrelated to any document.
fn default_kind() -> String {
    "passage".into()
}

fn default_side() -> String {
    "right".into()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub anchor: Value,
    pub color: String,
    pub style: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_side")]
    pub side: String,
    #[serde(default)]
    pub side_locked: bool,
    #[serde(default = "default_kind")]
    pub kind: String,
    /// Ids of attached pictures (files under `images/`), in display order.
    #[serde(default)]
    pub images: Vec<String>,
    /// Canonical position in a shared text system (OSIS-style, e.g. `JHN.3.16` or `JHN.3.16-18`); empty for ordinary notes.
    #[serde(default)]
    pub canonical_ref: String,
    /// Id of the module that wrote the note (e.g. `org.marginalia.bible`); empty for ordinary notes.
    #[serde(default)]
    pub source_module: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub book_id: String,
    pub note: Note,
}

#[derive(Serialize)]
pub struct QueryResult {
    pub items: Vec<Hit>,
    pub total: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub tag: String,
    /// Distinct notes carrying this tag or any descendant.
    pub count: usize,
    /// Notes carrying exactly this tag.
    pub own: usize,
    pub pinned: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    pub book_ids: Option<Vec<String>>,
    pub tags: Vec<String>,
    pub tag_mode: Option<String>,
    pub colors: Vec<String>,
    pub styles: Vec<String>,
    pub has_text: Option<bool>,
    /// "doc" | "passage" | "free"
    pub kind: Option<String>,
    pub terms: Vec<String>,
    pub sort: Option<String>,
    /** Seed for `sort = "shuffle"` (daily review): same seed → same order. */
    pub seed: Option<i64>,
    /** Only notes created before this timestamp (ms). */
    pub before: Option<i64>,
    /** Only notes created at or after this timestamp (ms). */
    pub after: Option<i64>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

// ---------------------------------------------------------------- db

/// Version of the database layout this build writes (stored in SQLite's `user_version`).
/// To change the layout in a later release: bump this, add an `if ver < N { ... }` step to `upgrade`
/// (additive changes only: new tables / columns with defaults), and never edit or drop old data in place.
/// Databases from before versioning report 0 and are brought up to date by the idempotent steps.
const SCHEMA_VERSION: i64 = 3;

pub fn open(dir: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(dir.join("reader.db"))?;
    let ver: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if ver > SCHEMA_VERSION {
        // Opening a newer database with an older app could corrupt it: refuse and leave it untouched.
        return Err(rusqlite::Error::ToSqlConversionFailure(
            "这份数据来自更新版本的「墨边」，当前版本无法安全读取。请先升级应用，数据没有被改动。".into(),
        ));
    }
    let has_data = conn
        .query_row("SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'notes'", [], |r| r.get::<_, i64>(0))?
        > 0;
    if ver < SCHEMA_VERSION && has_data {
        // Safety net: keep a full copy of the database as it was before the upgrade touches it.
        let backups = dir.join("backups");
        let _ = fs::create_dir_all(&backups);
        let copy = backups.join(format!("pre-upgrade-v{ver}-to-v{SCHEMA_VERSION}.db"));
        if !copy.exists() {
            conn.execute("VACUUM INTO ?1", [copy.to_string_lossy().as_ref()])?;
        }
    }
    conn.execute_batch(SCHEMA)?;
    upgrade(&conn)?;
    if ver < SCHEMA_VERSION {
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    }
    migrate_json(&conn, dir);
    let mut conn = conn;
    crate::library::migrate(&mut conn, dir);
    Ok(conn)
}

/// In-place upgrades for databases created by older versions.
fn upgrade(conn: &Connection) -> rusqlite::Result<()> {
    let has_kind = conn
        .prepare("PRAGMA table_info(notes)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|c| c == "kind");
    if !has_kind {
        conn.execute("ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'passage'", [])?;
    }
    let has_images = conn
        .prepare("PRAGMA table_info(notes)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|c| c == "images");
    if !has_images {
        conn.execute("ALTER TABLE notes ADD COLUMN images TEXT NOT NULL DEFAULT ''", [])?;
    }
    // Where in a canonical text the note belongs (e.g. JHN.3.16) and which module wrote it; empty for ordinary notes.
    let note_cols: Vec<String> = conn
        .prepare("PRAGMA table_info(notes)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .collect();
    for col in ["canonical_ref", "source_module"] {
        if !note_cols.iter().any(|c| c == col) {
            conn.execute(&format!("ALTER TABLE notes ADD COLUMN {col} TEXT NOT NULL DEFAULT ''"), [])?;
        }
    }
    conn.execute("CREATE INDEX IF NOT EXISTS notes_ref ON notes(canonical_ref) WHERE canonical_ref <> ''", [])?;
    let link_cols: Vec<String> = conn
        .prepare("PRAGMA table_info(note_links)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .collect();
    for col in ["color", "style", "side_a", "side_b"] {
        if !link_cols.is_empty() && !link_cols.iter().any(|c| c == col) {
            conn.execute(&format!("ALTER TABLE note_links ADD COLUMN {col} TEXT NOT NULL DEFAULT ''"), [])?;
        }
    }
    let pos_cols: Vec<String> = conn
        .prepare("PRAGMA table_info(graph_pos)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .collect();
    for col in ["w", "h"] {
        if !pos_cols.is_empty() && !pos_cols.iter().any(|c| c == col) {
            conn.execute(&format!("ALTER TABLE graph_pos ADD COLUMN {col} REAL NOT NULL DEFAULT 0"), [])?;
        }
    }
    // when each of these was last written, for syncing (older rows keep 0: older than anything written since)
    for table in ["review_items", "tag_meta", "graph_pos", "reading_days", "goal_snaps"] {
        let cols: Vec<String> = conn
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |r| r.get::<_, String>(1))?
            .filter_map(Result::ok)
            .collect();
        if !cols.is_empty() && !cols.iter().any(|c| c == "updated_at") {
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0"), [])?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub fn upgrade_for_test(conn: &Connection) {
    upgrade(conn).unwrap();
}

/// One-time import of the v0.1 per-book JSON files.
fn migrate_json(conn: &Connection, dir: &Path) {
    let done: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'json_migrated'", [], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    if done.is_some() {
        return;
    }
    if let Ok(entries) = fs::read_dir(dir.join("annotations")) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let book_id = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
            let Ok(text) = fs::read_to_string(&path) else { continue };
            let Ok(list) = serde_json::from_str::<Vec<Note>>(&text) else { continue };
            for n in &list {
                let _ = upsert(conn, &book_id, n);
            }
        }
    }
    let _ = conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('json_migrated', '1')", []);
}

fn norm_kind(k: &str) -> &'static str {
    match k {
        "doc" => "doc",
        "free" => "free",
        _ => "passage",
    }
}

pub(crate) fn upsert(conn: &Connection, book_id: &str, n: &Note) -> rusqlite::Result<()> {
    let section = n.anchor.get("section").and_then(Value::as_i64).unwrap_or(0);
    let pos = n.anchor.get("start").and_then(Value::as_i64).unwrap_or(0);
    let quote = n.anchor.get("exact").and_then(Value::as_str).unwrap_or("");
    let tags = parse_tags(&n.note);
    conn.execute(
        "INSERT INTO notes(id, book_id, section, pos, anchor, quote, color, style, note, thought, side, side_locked, created_at, updated_at, kind, images, canonical_ref, source_module)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
         ON CONFLICT(id) DO UPDATE SET book_id = excluded.book_id, section = excluded.section, pos = excluded.pos,
           anchor = excluded.anchor, quote = excluded.quote, color = excluded.color, style = excluded.style,
           note = excluded.note, thought = excluded.thought, side = excluded.side, side_locked = excluded.side_locked,
           created_at = excluded.created_at, updated_at = excluded.updated_at, kind = excluded.kind, images = excluded.images,
           canonical_ref = excluded.canonical_ref, source_module = excluded.source_module",
        params![
            n.id,
            book_id,
            section,
            pos,
            n.anchor.to_string(),
            quote,
            n.color,
            n.style,
            n.note,
            has_thought(&n.note),
            n.side,
            n.side_locked,
            n.created_at,
            n.updated_at,
            norm_kind(&n.kind),
            n.images.join(","),
            n.canonical_ref,
            n.source_module
        ],
    )?;
    let rowid: i64 = conn.query_row("SELECT rowid FROM notes WHERE id = ?1", [&n.id], |r| r.get(0))?;
    conn.execute("DELETE FROM note_tags WHERE note_id = ?1", [&n.id])?;
    for t in &tags {
        conn.execute("INSERT OR IGNORE INTO note_tags(note_id, tag) VALUES(?1, ?2)", params![n.id, t])?;
    }
    conn.execute("DELETE FROM notes_fts WHERE rowid = ?1", [rowid])?;
    conn.execute("INSERT INTO notes_fts(rowid, quote, note) VALUES(?1, ?2, ?3)", params![rowid, quote, n.note])?;
    Ok(())
}

pub(crate) fn delete_ids(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    for id in ids {
        conn.execute("DELETE FROM notes_fts WHERE rowid = (SELECT rowid FROM notes WHERE id = ?1)", [id])?;
        conn.execute("DELETE FROM notes WHERE id = ?1", [id])?;
    }
    Ok(())
}

const NOTE_COLS: &str = "n.id, n.anchor, n.color, n.style, n.note, n.side, n.side_locked, n.created_at, n.updated_at, n.book_id,
  (SELECT group_concat(tag, char(31)) FROM note_tags t WHERE t.note_id = n.id), n.kind, n.images, n.canonical_ref, n.source_module";

fn row_hit(r: &rusqlite::Row) -> rusqlite::Result<Hit> {
    let anchor: String = r.get(1)?;
    let tags: Option<String> = r.get(10)?;
    Ok(Hit {
        book_id: r.get(9)?,
        note: Note {
            id: r.get(0)?,
            anchor: serde_json::from_str(&anchor).unwrap_or(Value::Null),
            color: r.get(2)?,
            style: r.get(3)?,
            note: r.get(4)?,
            side: r.get(5)?,
            side_locked: r.get(6)?,
            created_at: r.get(7)?,
            updated_at: r.get(8)?,
            kind: r.get(11)?,
            images: r.get::<_, String>(12)?.split(',').filter(|x| !x.is_empty()).map(String::from).collect(),
            canonical_ref: r.get(13)?,
            source_module: r.get(14)?,
            tags: tags.map(|s| s.split('\u{1f}').map(String::from).collect()).unwrap_or_default(),
        },
    })
}

/// Notes written at or after `since` (ms), for syncing.
pub(crate) fn notes_changed_since(conn: &Connection, since: i64) -> rusqlite::Result<Vec<Hit>> {
    notes_where(conn, "n.updated_at > ?", vec![Sql::Integer(since)], "n.updated_at, n.id", -1, 0)
}

pub(crate) fn note_by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<Hit>> {
    Ok(notes_where(conn, "n.id = ?", vec![Sql::Text(id.to_string())], "n.id", 1, 0)?.into_iter().next())
}

fn notes_where(conn: &Connection, sql_where: &str, args: Vec<Sql>, order: &str, limit: i64, offset: i64) -> rusqlite::Result<Vec<Hit>> {
    let sql = format!("SELECT {NOTE_COLS} FROM notes n WHERE {sql_where} ORDER BY {order} LIMIT {limit} OFFSET {offset}");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), row_hit)?;
    rows.collect()
}

// ---------------------------------------------------------------- commands

type R<T> = Result<T, String>;
fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}

/// Notes at a canonical position: exactly `r`, a range that starts there, or anything inside it
/// (`JHN.3` finds `JHN.3.16`; `JHN.3.16` finds `JHN.3.16-18`). Uses the `notes_ref` index.
pub(crate) fn notes_at_ref(conn: &Connection, r: &str) -> rusqlite::Result<Vec<Hit>> {
    let r = r.trim();
    if r.is_empty() {
        return Ok(vec![]);
    }
    notes_where(
        conn,
        "n.canonical_ref <> '' AND (n.canonical_ref = ?1 OR n.canonical_ref LIKE ?2 OR n.canonical_ref LIKE ?3)",
        vec![Sql::Text(r.to_string()), Sql::Text(format!("{r}.%")), Sql::Text(format!("{r}-%"))],
        "n.canonical_ref, n.created_at",
        -1,
        0,
    )
}

#[tauri::command]
pub fn notes_by_ref(db: tauri::State<Db>, canonical_ref: String) -> R<Vec<Hit>> {
    let conn = db.0.lock().map_err(e)?;
    notes_at_ref(&conn, &canonical_ref).map_err(e)
}

#[tauri::command]
pub fn notes_for_book(db: tauri::State<Db>, book_id: String) -> R<Vec<Note>> {
    let conn = db.0.lock().map_err(e)?;
    Ok(notes_where(&conn, "n.book_id = ?", vec![Sql::Text(book_id)], "n.section, n.pos", -1, 0)
        .map_err(e)?
        .into_iter()
        .map(|h| h.note)
        .collect())
}

/// Replace a book's notes with `notes` (only changed rows are rewritten).
#[tauri::command]
pub fn notes_put_book(db: tauri::State<Db>, book_id: String, notes: Vec<Note>) -> R<()> {
    let mut conn = db.0.lock().map_err(e)?;
    let tx = conn.transaction().map_err(e)?;
    let existing: HashMap<String, i64> = {
        let mut stmt = tx.prepare("SELECT id, updated_at FROM notes WHERE book_id = ?1").map_err(e)?;
        let rows = stmt.query_map([&book_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)?
    };
    let keep: HashSet<&str> = notes.iter().map(|n| n.id.as_str()).collect();
    let gone: Vec<String> = existing.keys().filter(|id| !keep.contains(id.as_str())).cloned().collect();
    delete_ids(&tx, &gone).map_err(e)?;
    for n in &notes {
        if existing.get(&n.id) != Some(&n.updated_at) {
            upsert(&tx, &book_id, n).map_err(e)?;
        }
    }
    tx.commit().map_err(e)
}

#[tauri::command]
pub fn note_update(db: tauri::State<Db>, book_id: String, note: Note) -> R<()> {
    let conn = db.0.lock().map_err(e)?;
    upsert(&conn, &book_id, &note).map_err(e)
}

#[tauri::command]
pub fn note_delete(db: tauri::State<Db>, id: String) -> R<()> {
    let conn = db.0.lock().map_err(e)?;
    delete_ids(&conn, &[id]).map_err(e)
}

// ---------------------------------------------------------------- note links

/// A relation between two notes (undirected; `a` < `b`), with a free-text description of how they relate.
/// Any note can have any number of links, and two notes can be linked more than once.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: String,
    pub a: String,
    pub b: String,
    #[serde(default)]
    pub label: String,
    /// Palette key of the line colour in the relation graph ("" = default).
    #[serde(default)]
    pub color: String,
    /// "solid" | "dashed" | "dotted" ("" = solid).
    #[serde(default)]
    pub style: String,
    /// Where the line leaves card `a` / card `b`: "t" | "r" | "b" | "l" (top, right, bottom, left), "" = automatic.
    #[serde(default)]
    pub side_a: String,
    #[serde(default)]
    pub side_b: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GraphPos {
    pub note_id: String,
    pub x: f64,
    pub y: f64,
    /// Size of the card in the graph (0 = the default size).
    #[serde(default)]
    pub w: f64,
    #[serde(default)]
    pub h: f64,
}

fn norm_side(s: &str) -> &'static str {
    match s {
        "t" => "t",
        "r" => "r",
        "b" => "b",
        "l" => "l",
        _ => "",
    }
}

fn norm_link_style(s: &str) -> &'static str {
    match s {
        "dashed" => "dashed",
        "dotted" => "dotted",
        _ => "",
    }
}

pub(crate) fn link_put_one(conn: &Connection, l: &Link) -> Result<(), String> {
    if l.a == l.b {
        return Err("不能把笔记连接到它自己".into());
    }
    // the pair is stored in a stable order; the sides follow their cards
    let (a, b, side_a, side_b) = if l.a < l.b { (&l.a, &l.b, &l.side_a, &l.side_b) } else { (&l.b, &l.a, &l.side_b, &l.side_a) };
    let label = l.label.trim();
    conn.execute(
        "INSERT INTO note_links(id, a, b, label, color, style, side_a, side_b, created_at, updated_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET a = excluded.a, b = excluded.b, label = excluded.label, color = excluded.color,
           style = excluded.style, side_a = excluded.side_a, side_b = excluded.side_b, updated_at = excluded.updated_at",
        params![l.id, a, b, label, l.color.trim(), norm_link_style(&l.style), norm_side(side_a), norm_side(side_b), l.created_at, l.updated_at],
    )
    .map_err(|err| if err.to_string().contains("FOREIGN KEY") { "要连接的笔记不存在".to_string() } else { err.to_string() })?;
    Ok(())
}

pub(crate) fn links_list(conn: &Connection) -> rusqlite::Result<Vec<Link>> {
    let mut stmt = conn.prepare("SELECT id, a, b, label, color, style, side_a, side_b, created_at, updated_at FROM note_links ORDER BY created_at, id")?;
    let rows = stmt.query_map([], |r| {
        Ok(Link { id: r.get(0)?, a: r.get(1)?, b: r.get(2)?, label: r.get(3)?, color: r.get(4)?, style: r.get(5)?, side_a: r.get(6)?, side_b: r.get(7)?, created_at: r.get(8)?, updated_at: r.get(9)? })
    })?;
    rows.collect()
}

#[tauri::command]
pub fn links_all(db: tauri::State<Db>) -> R<Vec<Link>> {
    let conn = db.0.lock().map_err(e)?;
    links_list(&conn).map_err(e)
}

/// Create or update links (all or none).
#[tauri::command]
pub fn links_put(db: tauri::State<Db>, links: Vec<Link>) -> R<()> {
    let mut conn = db.0.lock().map_err(e)?;
    let tx = conn.transaction().map_err(e)?;
    for l in &links {
        link_put_one(&tx, l)?;
    }
    tx.commit().map_err(e)
}

#[tauri::command]
pub fn link_delete(db: tauri::State<Db>, id: String) -> R<()> {
    let conn = db.0.lock().map_err(e)?;
    conn.execute("DELETE FROM note_links WHERE id = ?1", [id]).map_err(e)?;
    Ok(())
}

/// Notes by id (any book), in the order asked for; unknown ids are skipped.
#[tauri::command]
pub fn notes_by_ids(db: tauri::State<Db>, ids: Vec<String>) -> R<Vec<Hit>> {
    let conn = db.0.lock().map_err(e)?;
    let mut out = Vec::with_capacity(ids.len());
    for chunk in ids.chunks(400) {
        let marks = vec!["?"; chunk.len()].join(",");
        let hits = notes_where(&conn, &format!("n.id IN ({marks})"), chunk.iter().cloned().map(Sql::Text).collect(), "n.created_at", -1, 0).map_err(e)?;
        out.extend(hits);
    }
    let rank: HashMap<&str, usize> = ids.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    out.sort_by_key(|h| rank.get(h.note.id.as_str()).copied().unwrap_or(usize::MAX));
    Ok(out)
}

#[tauri::command]
pub fn graph_pos_all(db: tauri::State<Db>) -> R<Vec<GraphPos>> {
    let conn = db.0.lock().map_err(e)?;
    let mut stmt = conn.prepare("SELECT note_id, x, y, w, h FROM graph_pos").map_err(e)?;
    let rows = stmt.query_map([], |r| Ok(GraphPos { note_id: r.get(0)?, x: r.get(1)?, y: r.get(2)?, w: r.get(3)?, h: r.get(4)? })).map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

#[tauri::command]
pub fn graph_pos_put(db: tauri::State<Db>, positions: Vec<GraphPos>) -> R<()> {
    let mut conn = db.0.lock().map_err(e)?;
    let tx = conn.transaction().map_err(e)?;
    for p in &positions {
        // positions of notes that no longer exist are simply dropped
        tx.execute(
            "INSERT INTO graph_pos(note_id, x, y, w, h, updated_at) SELECT ?1, ?2, ?3, ?4, ?5, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE EXISTS (SELECT 1 FROM notes WHERE id = ?1)
             ON CONFLICT(note_id) DO UPDATE SET x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, updated_at = excluded.updated_at",
            params![p.note_id, p.x, p.y, p.w.max(0.0), p.h.max(0.0)],
        )
        .map_err(e)?;
    }
    tx.commit().map_err(e)
}

pub fn delete_book_notes(db: &Db, book_id: &str) -> R<()> {
    let conn = db.0.lock().map_err(e)?;
    conn.execute("DELETE FROM notes_fts WHERE rowid IN (SELECT rowid FROM notes WHERE book_id = ?1)", [book_id])
        .map_err(e)?;
    conn.execute("DELETE FROM notes WHERE book_id = ?1", [book_id]).map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn notes_query(db: tauri::State<Db>, filter: Filter) -> R<QueryResult> {
    let conn = db.0.lock().map_err(e)?;
    let mut clauses: Vec<String> = vec!["1 = 1".into()];
    let mut args: Vec<Sql> = Vec::new();
    let marks = |n: usize| vec!["?"; n].join(", ");

    if let Some(ids) = &filter.book_ids {
        if ids.is_empty() {
            return Ok(QueryResult { items: vec![], total: 0 });
        }
        clauses.push(format!("n.book_id IN ({})", marks(ids.len())));
        args.extend(ids.iter().cloned().map(Sql::Text));
    }
    if !filter.tags.is_empty() {
        let parts: Vec<String> = filter
            .tags
            .iter()
            .map(|t| {
                args.push(Sql::Text(t.clone()));
                args.push(Sql::Integer(t.chars().count() as i64 + 1));
                args.push(Sql::Text(format!("{t}/")));
                "EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND (t.tag = ? OR substr(t.tag, 1, ?) = ?))".to_string()
            })
            .collect();
        let joiner = if filter.tag_mode.as_deref() == Some("or") { " OR " } else { " AND " };
        clauses.push(format!("({})", parts.join(joiner)));
    }
    if !filter.colors.is_empty() {
        clauses.push(format!("n.color IN ({})", marks(filter.colors.len())));
        args.extend(filter.colors.iter().cloned().map(Sql::Text));
    }
    if !filter.styles.is_empty() {
        clauses.push(format!("n.style IN ({})", marks(filter.styles.len())));
        args.extend(filter.styles.iter().cloned().map(Sql::Text));
    }
    if let Some(k) = &filter.kind {
        clauses.push("n.kind = ?".into());
        args.push(Sql::Text(norm_kind(k).into()));
    }
    if let Some(t) = filter.has_text {
        clauses.push(format!("n.thought = {}", if t { 1 } else { 0 }));
    }
    for term in filter.terms.iter().map(|t| t.trim()).filter(|t| !t.is_empty()) {
        if term.chars().count() >= 3 {
            clauses.push("n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)".into());
            args.push(Sql::Text(format!("\"{}\"", term.replace('"', "\"\""))));
        } else {
            // Trigram FTS needs ≥3 chars; short (typically 1–2 CJK chars) terms use a scan.
            clauses.push("(instr(lower(n.quote), lower(?)) > 0 OR instr(lower(n.note), lower(?)) > 0)".into());
            args.push(Sql::Text(term.to_string()));
            args.push(Sql::Text(term.to_string()));
        }
    }
    if let Some(a) = filter.after {
        clauses.push("n.created_at >= ?".into());
        args.push(Sql::Integer(a));
    }
    if let Some(b) = filter.before {
        clauses.push("n.created_at < ?".into());
        args.push(Sql::Integer(b));
    }
    let sql_where = clauses.join(" AND ");
    let total: i64 = conn
        .query_row(&format!("SELECT count(*) FROM notes n WHERE {sql_where}"), params_from_iter(args.clone()), |r| r.get(0))
        .map_err(e)?;
    let order = order_clause(filter.sort.as_deref(), filter.seed);
    let items = notes_where(&conn, &sql_where, args, &order, filter.limit.unwrap_or(100), filter.offset.unwrap_or(0)).map_err(e)?;
    Ok(QueryResult { items, total })
}

fn order_clause(sort: Option<&str>, seed: Option<i64>) -> String {
    match sort {
        Some("position") => "n.book_id, n.section, n.pos".to_string(),
        // Note type first (随手记, 批注笔记, 阅读全局笔记, 原文摘录), newest first inside each.
        Some("type") => "CASE WHEN n.kind = 'free' THEN 0 WHEN n.kind = 'doc' THEN 2 WHEN n.thought = 1 THEN 1 ELSE 3 END, n.created_at DESC".to_string(),
        Some("shuffle") => {
            // Deterministic permutation: x ↦ (x·m + c) mod p is a bijection on [0, p). The seed picks a large
            // multiplier so even small rowids wrap around p and different seeds give unrelated orders.
            const P: u64 = 4_294_967_291; // largest prime < 2^32; rowid·m stays within i64 for rowid < 2^31
            let s = seed.unwrap_or(0).rem_euclid(1_000_000) as u64 + 1;
            let m = (2_654_435_761u64 * s) % P;
            let m = if m == 0 { 1 } else { m };
            let c = (s * 40_503) % P;
            format!("(n.rowid * {m} + {c}) % {P}, n.id")
        }
        _ => "n.created_at DESC".to_string(),
    }
}

#[tauri::command]
pub fn tags_list(db: tauri::State<Db>, book_id: Option<String>, aliases: Option<Vec<(String, String)>>) -> R<Vec<TagInfo>> {
    let conn = db.0.lock().map_err(e)?;
    let (sql, args): (&str, Vec<Sql>) = match &book_id {
        Some(b) => (
            "SELECT t.tag, t.note_id FROM note_tags t JOIN notes n ON n.id = t.note_id WHERE n.book_id = ?",
            vec![Sql::Text(b.clone())],
        ),
        None => ("SELECT tag, note_id FROM note_tags", vec![]),
    };
    let mut stmt = conn.prepare(sql).map_err(e)?;
    let rows: Vec<(String, String)> = stmt
        .query_map(params_from_iter(args), |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?
        .collect::<Result<_, _>>()
        .map_err(e)?;
    let (all, own) = count_tags(rows, &aliases.unwrap_or_default().into_iter().collect());
    let pinned: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT tag FROM tag_meta WHERE pinned = 1").map_err(e)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)?
    };
    Ok(all
        .into_iter()
        .map(|(tag, notes)| TagInfo {
            own: own.get(&tag).copied().unwrap_or(0),
            pinned: pinned.contains(&tag),
            count: notes.len(),
            tag,
        })
        .collect())
}

/// Notes per tag (every tag counts the notes under it and under its children) and notes carrying exactly that tag.
/// `aliases` maps tags written differently (another language, an older setting) to the one they are shown as.
fn count_tags(rows: Vec<(String, String)>, aliases: &HashMap<String, String>) -> (BTreeMap<String, HashSet<String>>, HashMap<String, usize>) {
    let mut all: BTreeMap<String, HashSet<String>> = BTreeMap::new();
    let mut own: HashMap<String, usize> = HashMap::new();
    for (tag, note) in rows {
        let tag = aliases.get(&tag).cloned().unwrap_or(tag);
        *own.entry(tag.clone()).or_default() += 1;
        let mut prefix = String::new();
        for seg in tag.split('/') {
            if !prefix.is_empty() {
                prefix.push('/');
            }
            prefix.push_str(seg);
            all.entry(prefix.clone()).or_default().insert(note.clone());
        }
    }
    (all, own)
}

/// Rename (or merge, when `to` already exists) a tag and all its descendants, across every book.
#[tauri::command]
pub fn tag_rename(db: tauri::State<Db>, from: String, to: String) -> R<usize> {
    let to = normalize(&to);
    if to.is_empty() {
        return Err("标签名不能为空".into());
    }
    if under(&to, &from) && to != from {
        return Err("不能把标签移到它自己的子标签下".into());
    }
    retag(&db, &from, Some(&to))
}

/// Remove a tag (and its descendants) from every note; the notes themselves stay.
#[tauri::command]
pub fn tag_delete(db: tauri::State<Db>, tag: String) -> R<usize> {
    retag(&db, &tag, None)
}

fn retag(db: &Db, from: &str, to: Option<&str>) -> R<usize> {
    let mut conn = db.0.lock().map_err(e)?;
    let tx = conn.transaction().map_err(e)?;
    let hits = notes_where(
        &tx,
        "EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND (t.tag = ? OR substr(t.tag, 1, ?) = ?))",
        vec![Sql::Text(from.into()), Sql::Integer(from.chars().count() as i64 + 1), Sql::Text(format!("{from}/"))],
        "n.created_at",
        -1,
        0,
    )
    .map_err(e)?;
    for mut h in hits.iter().map(|h| Hit { book_id: h.book_id.clone(), note: h.note.clone() }) {
        h.note.note = rewrite_tags(&h.note.note, from, to);
        upsert(&tx, &h.book_id, &h.note).map_err(e)?;
    }
    // Carry pin state over to the new name.
    if let Some(to) = to {
        tx.execute(
            "INSERT OR REPLACE INTO tag_meta(tag, pinned, updated_at) SELECT ?2, pinned, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM tag_meta WHERE tag = ?1",
            params![from, to],
        )
        .map_err(e)?;
    }
    tx.execute("DELETE FROM tag_meta WHERE tag = ?1", [from]).map_err(e)?;
    tx.commit().map_err(e)?;
    Ok(hits.len())
}

#[tauri::command]
pub fn tag_pin(db: tauri::State<Db>, tag: String, pinned: bool) -> R<()> {
    let conn = db.0.lock().map_err(e)?;
    conn.execute(
        "INSERT INTO tag_meta(tag, pinned, updated_at) VALUES(?1, ?2, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) ON CONFLICT(tag) DO UPDATE SET pinned = excluded.pinned, updated_at = excluded.updated_at",
        params![tag, pinned],
    )
    .map_err(e)?;
    Ok(())
}

/// Books that have at least one whole-document note, with how many.
#[tauri::command]
pub fn note_doc_counts(db: tauri::State<Db>) -> R<HashMap<String, i64>> {
    let conn = db.0.lock().map_err(e)?;
    let mut stmt = conn.prepare("SELECT book_id, count(*) FROM notes WHERE kind = 'doc' GROUP BY book_id").map_err(e)?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteStats {
    /// Local calendar day (`YYYY-MM-DD`) → notes created that day (every kind of note).
    pub days: HashMap<String, i64>,
    pub total: i64,
    pub tags: i64,
}

/// Counts behind the heat map. `tz_offset_min` = minutes east of UTC, so days follow the user's clock.
#[tauri::command]
pub fn notes_stats(db: tauri::State<Db>, tz_offset_min: i64) -> R<NoteStats> {
    let conn = db.0.lock().map_err(e)?;
    let mut stmt = conn
        .prepare("SELECT strftime('%Y-%m-%d', created_at / 1000 + ?1, 'unixepoch'), count(*) FROM notes GROUP BY 1")
        .map_err(e)?;
    let days: HashMap<String, i64> = stmt
        .query_map([tz_offset_min * 60], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)?
        .collect::<Result<_, _>>()
        .map_err(e)?;
    let total: i64 = conn.query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).map_err(e)?;
    let tags: i64 = conn.query_row("SELECT count(DISTINCT tag) FROM note_tags", [], |r| r.get(0)).map_err(e)?;
    Ok(NoteStats { days, total, tags })
}

#[tauri::command]
pub fn note_counts(db: tauri::State<Db>) -> R<HashMap<String, i64>> {
    let conn = db.0.lock().map_err(e)?;
    let mut stmt = conn.prepare("SELECT book_id, count(*) FROM notes GROUP BY book_id").map_err(e)?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flomo_style_tags() {
        assert_eq!(parse_tags("想法 #读书/方法 和 #金句，以及#不是标签"), vec!["读书/方法", "金句"]);
        assert_eq!(parse_tags("#a//b/ #a/b"), vec!["a/b"]);
        assert!(parse_tags("C# and url.com/#x").is_empty());
        assert!(!has_thought("#金句 #读书"));
        assert!(has_thought("#金句 很好"));
        // formatting markers (**bold**, *italic*, <u>..</u>, ~~..~~) never become part of a tag name
        assert_eq!(parse_tags("**#重点** *#斜体* <u>#下划</u> ~~#删除~~ #a/b*x*"), vec!["重点", "斜体", "下划", "删除", "a/b"]);
    }

    #[test]
    fn rewrites_tags() {
        assert_eq!(rewrite_tags("看 #读书/方法 和 #读书 #读书法", "读书", Some("阅读")), "看 #阅读/方法 和 #阅读 #读书法");
        assert_eq!(rewrite_tags("#金句 好句子", "金句", None), "好句子");
    }

    /// Rough timings on a big library. `cargo test --release scale -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn scale_notes() {
        use std::time::Instant;
        let path = std::env::temp_dir().join("marginalia-scale.db");
        let _ = std::fs::remove_file(&path);
        let mut conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;").unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let n_notes: usize = std::env::var("SCALE_N").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000);
        let text = "读书不是为了记住，而是为了改变看事情的方式。慢读比多读更有用，把每一次阅读都写成一条自己的话。";
        let t0 = Instant::now();
        let tx = conn.transaction().unwrap();
        for i in 0..n_notes {
            let body = format!("{text} 第{i}条 #读书/方法{} #主题{}", i % 40, i % 300);
            let n = Note {
                id: format!("n{i:06}"),
                anchor: serde_json::json!({"section": i % 30, "start": i, "exact": text}),
                color: "amber".into(),
                style: "highlight".into(),
                note: body,
                tags: vec![],
                side: "right".into(),
                side_locked: false,
                kind: "passage".into(),
                images: vec![],
                canonical_ref: String::new(),
                source_module: String::new(),
                created_at: 1_700_000_000_000 + i as i64 * 60_000,
                updated_at: 1_700_000_000_000 + i as i64 * 60_000,
            };
            upsert(&tx, &format!("book{}", i % 300), &n).unwrap();
        }
        tx.commit().unwrap();
        println!("insert {n_notes} notes: {:?}", t0.elapsed());
        let t = Instant::now();
        let page = notes_where(&conn, "1 = 1", vec![], "n.created_at DESC", 100, 0).unwrap();
        println!("first page of 100 (newest): {:?} ({} rows)", t.elapsed(), page.len());
        let t = Instant::now();
        let total: i64 = conn.query_row("SELECT count(*) FROM notes n WHERE 1 = 1", [], |r| r.get(0)).unwrap();
        println!("count all: {:?} ({total})", t.elapsed());
        let t = Instant::now();
        let hits = notes_where(&conn, "EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND (t.tag = ? OR substr(t.tag, 1, ?) = ?))", vec![Sql::Text("读书".into()), Sql::Integer(3), Sql::Text("读书/".into())], "n.created_at DESC", 100, 0).unwrap();
        println!("filter by a tag (first 100): {:?} ({} rows)", t.elapsed(), hits.len());
        let t = Instant::now();
        let r = notes_where(&conn, "n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)", vec![Sql::Text("\"改变看事情\"".into())], "n.created_at DESC", 100, 0).unwrap();
        println!("full-text search, 3+ chars (first 100): {:?} ({} rows)", t.elapsed(), r.len());
        let t = Instant::now();
        let r = notes_where(&conn, "(instr(lower(n.quote), lower(?)) > 0 OR instr(lower(n.note), lower(?)) > 0)", vec![Sql::Text("读书".into()), Sql::Text("读书".into())], "n.created_at DESC", 100, 0).unwrap();
        println!("short search (2 chars, scan) (first 100): {:?} ({} rows)", t.elapsed(), r.len());
        let t = Instant::now();
        let mut stmt = conn.prepare("SELECT tag, note_id FROM note_tags").unwrap();
        let rows: Vec<(String, String)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap();
        let (all, _own) = count_tags(rows.clone(), &HashMap::new());
        println!("tag tree ({} pairs -> {} tags): {:?}", rows.len(), all.len(), t.elapsed());
        let t = Instant::now();
        let everything = notes_where(&conn, "1 = 1", vec![], "n.created_at DESC", -1, 0).unwrap();
        let json = serde_json::to_string(&everything).unwrap();
        println!("ALL notes (limit -1) + JSON: {:?}, {:.1} MB", t.elapsed(), json.len() as f64 / 1e6);
        let t = Instant::now();
        let heat: i64 = conn.query_row("SELECT count(DISTINCT date(created_at / 1000, 'unixepoch')) FROM notes", [], |r| r.get(0)).unwrap();
        println!("distinct days: {:?} ({heat})", t.elapsed());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn shuffle_is_stable_per_seed() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for i in 0..20 {
            let n = Note {
                id: format!("n{i:02}"),
                anchor: serde_json::json!({"section": 0, "start": i, "exact": "x"}),
                color: "amber".into(),
                style: "highlight".into(),
                note: String::new(),
                tags: vec![],
                side: "right".into(),
                side_locked: false,
                kind: "passage".into(),
                images: vec![],
                canonical_ref: String::new(),
                source_module: String::new(),
                created_at: i,
                updated_at: i,
            };
            upsert(&conn, "b", &n).unwrap();
        }
        let ids = |seed| -> Vec<String> {
            notes_where(&conn, "1 = 1", vec![], &order_clause(Some("shuffle"), Some(seed)), 5, 0)
                .unwrap()
                .into_iter()
                .map(|h| h.note.id)
                .collect()
        };
        assert_eq!(ids(20401), ids(20401));
        assert_ne!(ids(20401), ids(20402));
        assert_eq!(ids(20401).len(), 5);
    }

    fn plain_note(id: &str) -> Note {
        Note {
            id: id.into(),
            anchor: serde_json::json!({"section": 0, "start": 0, "exact": id}),
            color: "amber".into(),
            style: "highlight".into(),
            note: String::new(),
            tags: vec![],
            side: "right".into(),
            side_locked: false,
            kind: "passage".into(),
            images: vec![],
            canonical_ref: String::new(),
            source_module: String::new(),
            created_at: 1,
            updated_at: 1,
        }
    }

    fn link(id: &str, a: &str, b: &str, label: &str) -> Link {
        Link { id: id.into(), a: a.into(), b: b.into(), label: label.into(), color: String::new(), style: String::new(), side_a: String::new(), side_b: String::new(), created_at: 1, updated_at: 1 }
    }

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        upgrade(&conn).unwrap();
        conn
    }

    #[test]
    fn a_canonical_position_and_module_are_kept_and_found_by_position() {
        let conn = mem();
        let put = |id: &str, r: &str, m: &str| {
            let mut n = plain_note(id);
            n.canonical_ref = r.into();
            n.source_module = m.into();
            upsert(&conn, "bible:cuv", &n).unwrap();
        };
        put("a", "JHN.3.16", "org.marginalia.bible");
        put("b", "JHN.3.16-18", "org.marginalia.bible");
        put("c", "JHN.3.17", "org.marginalia.bible");
        put("d", "JHN.4.1", "org.marginalia.bible");
        put("e", "JHN.31.1", "org.marginalia.bible"); // not chapter 3
        put("plain", "", "");
        let ids = |r: &str| -> Vec<String> { let mut v: Vec<String> = notes_at_ref(&conn, r).unwrap().into_iter().map(|h| h.note.id).collect(); v.sort(); v };
        assert_eq!(ids("JHN.3.16"), vec!["a", "b"], "the verse itself and a range that starts there");
        assert_eq!(ids("JHN.3"), vec!["a", "b", "c"], "everything inside the chapter, not JHN.31");
        assert!(ids("JHN.9").is_empty() && ids("").is_empty());
        // written and read back unchanged; an ordinary note has neither
        let got = notes_where(&conn, "n.id = ?", vec![Sql::Text("a".into())], "n.id", -1, 0).unwrap().remove(0).note;
        assert_eq!((got.canonical_ref.as_str(), got.source_module.as_str()), ("JHN.3.16", "org.marginalia.bible"));
        let plain = notes_where(&conn, "n.id = ?", vec![Sql::Text("plain".into())], "n.id", -1, 0).unwrap().remove(0).note;
        assert_eq!((plain.canonical_ref.as_str(), plain.source_module.as_str()), ("", ""));
        // editing a note keeps what the module wrote unless it is changed
        let mut again = got.clone();
        again.note = "edited".into();
        upsert(&conn, "bible:cuv", &again).unwrap();
        assert_eq!(ids("JHN.3.16"), vec!["a", "b"]);
        // an older app's note (no such keys in its JSON) still reads
        let old: Note = serde_json::from_value(serde_json::json!({"id": "x", "anchor": {}, "color": "amber", "style": "none", "createdAt": 1, "updatedAt": 1})).unwrap();
        assert_eq!((old.canonical_ref.as_str(), old.source_module.as_str()), ("", ""));
    }

    #[test]
    fn links_many_to_many_and_cascade() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        for id in ["n1", "n2", "n3", "n4"] {
            upsert(&conn, "b", &plain_note(id)).unwrap();
        }
        // one note linked to many, many notes linked to one, and the same pair linked twice
        link_put_one(&conn, &link("l1", "n1", "n2", "举例")).unwrap();
        link_put_one(&conn, &link("l2", "n3", "n1", " 反驳 ")).unwrap();
        link_put_one(&conn, &link("l3", "n1", "n4", "")).unwrap();
        link_put_one(&conn, &link("l4", "n2", "n1", "延伸")).unwrap();
        let all = links_list(&conn).unwrap();
        assert_eq!(all.len(), 4);
        // stored in a stable order (a < b) and trimmed
        let l2 = all.iter().find(|l| l.id == "l2").unwrap();
        assert_eq!((l2.a.as_str(), l2.b.as_str(), l2.label.as_str()), ("n1", "n3", "反驳"));
        // editing the text of a link keeps the link
        let mut edited = link("l1", "n1", "n2", "例证");
        edited.updated_at = 5;
        link_put_one(&conn, &edited).unwrap();
        assert_eq!(links_list(&conn).unwrap().len(), 4);
        assert_eq!(links_list(&conn).unwrap().iter().find(|l| l.id == "l1").unwrap().label, "例证");
        // no self links, no links to notes that do not exist
        assert!(link_put_one(&conn, &link("x", "n1", "n1", "")).is_err());
        assert!(link_put_one(&conn, &link("y", "n1", "ghost", "")).is_err());
        // deleting a note removes exactly its links
        delete_ids(&conn, &["n1".to_string()]).unwrap();
        assert!(links_list(&conn).unwrap().is_empty());
    }

    #[test]
    fn link_colour_and_style_roundtrip_and_old_tables_are_upgraded() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        upsert(&conn, "b", &plain_note("n1")).unwrap();
        upsert(&conn, "b", &plain_note("n2")).unwrap();
        let mut l = link("l1", "n1", "n2", "x");
        l.color = "rose".into();
        l.style = "dashed".into();
        link_put_one(&conn, &l).unwrap();
        l.id = "l2".into();
        l.style = "wavy".into(); // unknown styles fall back to solid
        link_put_one(&conn, &l).unwrap();
        let all = links_list(&conn).unwrap();
        assert_eq!((all[0].color.as_str(), all[0].style.as_str()), ("rose", "dashed"));
        assert_eq!(all[1].style, "");
        // a table written by the first build of the feature (no colour / style columns) gets them added, data kept
        let old = Connection::open_in_memory().unwrap();
        old.execute_batch(
            "CREATE TABLE notes(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, section INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0,
               anchor TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', color TEXT NOT NULL, style TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
               thought INTEGER NOT NULL DEFAULT 0, side TEXT NOT NULL DEFAULT 'right', side_locked INTEGER NOT NULL DEFAULT 0,
               kind TEXT NOT NULL DEFAULT 'passage', images TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE note_links(id TEXT PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO note_links VALUES('old', 'n1', 'n2', '举例', 1, 1);",
        )
        .unwrap();
        upgrade(&old).unwrap();
        upgrade(&old).unwrap(); // idempotent
        let kept = links_list(&old).unwrap();
        assert_eq!((kept[0].label.as_str(), kept[0].color.as_str(), kept[0].style.as_str()), ("举例", "", ""));
    }

    #[test]
    fn link_sides_are_stored_follow_their_cards_and_junk_is_ignored() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        upsert(&conn, "b", &plain_note("n1")).unwrap();
        upsert(&conn, "b", &plain_note("n2")).unwrap();
        // given "backwards" (n2 first): the pair is stored as n1 < n2 and the sides are swapped along with it
        let mut l = link("l1", "n2", "n1", "x");
        l.side_a = "t".into(); // top of n2
        l.side_b = "l".into(); // left of n1
        link_put_one(&conn, &l).unwrap();
        let got = &links_list(&conn).unwrap()[0];
        assert_eq!((got.a.as_str(), got.b.as_str(), got.side_a.as_str(), got.side_b.as_str()), ("n1", "n2", "l", "t"));
        let mut bad = link("l2", "n1", "n2", "y");
        bad.side_a = "diagonal".into();
        link_put_one(&conn, &bad).unwrap();
        assert_eq!(links_list(&conn).unwrap()[1].side_a, "");
    }

    #[test]
    fn graph_card_size_is_stored_and_old_position_tables_are_upgraded() {
        let old = Connection::open_in_memory().unwrap();
        old.execute_batch(
            "CREATE TABLE notes(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, section INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0,
               anchor TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', color TEXT NOT NULL, style TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
               thought INTEGER NOT NULL DEFAULT 0, side TEXT NOT NULL DEFAULT 'right', side_locked INTEGER NOT NULL DEFAULT 0,
               kind TEXT NOT NULL DEFAULT 'passage', images TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE graph_pos(note_id TEXT PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL);
             INSERT INTO graph_pos VALUES('n1', 10.5, -3.0);",
        )
        .unwrap();
        upgrade(&old).unwrap();
        upgrade(&old).unwrap(); // idempotent
        let (x, w, h): (f64, f64, f64) = old.query_row("SELECT x, w, h FROM graph_pos WHERE note_id = 'n1'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((x, w, h), (10.5, 0.0, 0.0)); // position kept, size = default
        old.execute("UPDATE graph_pos SET w = 120, h = 40 WHERE note_id = 'n1'", []).unwrap();
        let (w, h): (f64, f64) = old.query_row("SELECT w, h FROM graph_pos", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((w, h), (120.0, 40.0));
    }

    #[test]
    fn links_survive_rewriting_a_book() {
        // saving a book's notes again (what the reader does after every edit) must not touch their links
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        upsert(&conn, "b", &plain_note("n1")).unwrap();
        upsert(&conn, "b", &plain_note("n2")).unwrap();
        link_put_one(&conn, &link("l1", "n1", "n2", "x")).unwrap();
        let mut changed = plain_note("n1");
        changed.note = "改过".into();
        changed.updated_at = 9;
        upsert(&conn, "b", &changed).unwrap();
        assert_eq!(links_list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn doc_notes_kind_filter_and_upgrade() {
        // A database from before `kind` existed is upgraded in place, existing notes stay passage notes.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, section INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0,
               anchor TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', color TEXT NOT NULL, style TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
               thought INTEGER NOT NULL DEFAULT 0, side TEXT NOT NULL DEFAULT 'right', side_locked INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO notes(id, book_id, anchor, color, style, created_at, updated_at) VALUES('old', 'b1', '{}', 'amber', 'highlight', 1, 1);",
        )
        .unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        upgrade(&conn).unwrap();
        upgrade(&conn).unwrap(); // idempotent
        let kind: String = conn.query_row("SELECT kind FROM notes WHERE id = 'old'", [], |r| r.get(0)).unwrap();
        assert_eq!(kind, "passage");

        let doc = Note {
            id: "d1".into(),
            anchor: serde_json::json!({"section": -1, "start": 0, "end": 0, "exact": "", "prefix": "", "suffix": ""}),
            color: "amber".into(),
            style: "none".into(),
            note: "整本书的判断 #读后感".into(),
            tags: vec![],
            side: "right".into(),
            side_locked: false,
            kind: "doc".into(),
            images: vec![],
            canonical_ref: String::new(),
            source_module: String::new(),
            created_at: 5,
            updated_at: 5,
        };
        upsert(&conn, "b1", &doc).unwrap();
        let q = |kind: Option<&str>| -> Vec<String> {
            let clause = kind.map(|_| "n.kind = ?").unwrap_or("1 = 1");
            let args: Vec<Sql> = kind.map(|k| vec![Sql::Text(k.into())]).unwrap_or_default();
            notes_where(&conn, clause, args, "n.section, n.pos", -1, 0).unwrap().into_iter().map(|h| h.note.id).collect()
        };
        assert_eq!(q(None), vec!["d1", "old"]); // doc notes sort before anchored ones (section -1)
        assert_eq!(q(Some("doc")), vec!["d1"]);
        assert_eq!(q(Some("passage")), vec!["old"]);
        let tags: i64 = conn.query_row("SELECT count(*) FROM note_tags WHERE note_id = 'd1' AND tag = '读后感'", [], |r| r.get(0)).unwrap();
        assert_eq!(tags, 1);
    }

    #[test]
    fn query_and_retag_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let mk = |id: &str, note: &str, exact: &str| Note {
            id: id.into(),
            anchor: serde_json::json!({"section": 0, "start": 1, "end": 5, "exact": exact, "prefix": "", "suffix": ""}),
            color: "amber".into(),
            style: "highlight".into(),
            note: note.into(),
            tags: vec![],
            side: "right".into(),
            side_locked: false,
            kind: "passage".into(),
            images: vec![],
            canonical_ref: String::new(),
            source_module: String::new(),
            created_at: 1,
            updated_at: 1,
        };
        upsert(&conn, "b1", &mk("n1", "费曼技巧 #读书/方法", "以教代学")).unwrap();
        upsert(&conn, "b2", &mk("n2", "#读书", "页边的艺术")).unwrap();
        let db = Db(Mutex::new(conn));
        let conn = db.0.lock().unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM notes n WHERE n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH '\"页边的\"')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
        drop(conn);
        assert_eq!(retag(&db, "读书", Some("阅读")).unwrap(), 2);
        let conn = db.0.lock().unwrap();
        let tags: Vec<String> = conn
            .prepare("SELECT tag FROM note_tags ORDER BY tag")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(tags, vec!["阅读", "阅读/方法"]);
    }

    #[test]
    fn free_notes_keep_kind_and_group_by_local_day() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        // 2024-01-01 23:30 UTC and 2024-01-02 00:10 UTC are the same day at UTC+8 (07:30 / 08:10 on the 2nd).
        for (id, t) in [("a", 1_704_151_800_000_i64), ("b", 1_704_154_200_000)] {
            let n = Note {
                id: id.into(),
                anchor: serde_json::json!({"section": -1, "start": 0, "exact": ""}),
                color: "amber".into(),
                style: "none".into(),
                note: "随手想到 #灵感/产品".into(),
                tags: vec![],
                side: "right".into(),
                side_locked: false,
                kind: "free".into(),
                images: vec![],
                canonical_ref: String::new(),
                source_module: String::new(),
                created_at: t,
                updated_at: t,
            };
            upsert(&conn, FREE_BOOK, &n).unwrap();
        }
        let kind: String = conn.query_row("SELECT kind FROM notes WHERE id = 'a'", [], |r| r.get(0)).unwrap();
        assert_eq!(kind, "free");
        let days = |tz: i64| -> Vec<(String, i64)> {
            let mut stmt = conn
                .prepare("SELECT strftime('%Y-%m-%d', created_at / 1000 + ?1, 'unixepoch') d, count(*) FROM notes GROUP BY d ORDER BY d")
                .unwrap();
            stmt.query_map([tz * 60], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
        };
        assert_eq!(days(0), vec![("2024-01-01".into(), 1), ("2024-01-02".into(), 1)]);
        assert_eq!(days(480), vec![("2024-01-02".into(), 2)]);
    }

    #[test]
    fn aliased_tags_are_counted_as_one() {
        let rows = vec![
            ("Status/待办复盘".to_string(), "n1".to_string()),
            ("Status/Todo-review".to_string(), "n2".to_string()),
            ("Status/Todo-review".to_string(), "n1".to_string()),
            ("读书".to_string(), "n3".to_string()),
        ];
        let mut map = HashMap::new();
        map.insert("Status/Todo-review".to_string(), "Status/待办复盘".to_string());
        let (all, own) = count_tags(rows.clone(), &map);
        assert_eq!(all["Status/待办复盘"].len(), 2, "two notes, n1 counted once");
        assert_eq!(all["Status"].len(), 2);
        assert!(!all.contains_key("Status/Todo-review"));
        assert_eq!(own["Status/待办复盘"], 3);
        // without aliases the two spellings stay apart
        let (plain, _) = count_tags(rows, &HashMap::new());
        assert_eq!(plain["Status/Todo-review"].len(), 2);
        assert_eq!(plain["Status/待办复盘"].len(), 1);
    }

    #[test]
    fn upgrades_old_database_keeping_data_and_refuses_newer_ones() {
        let dir = std::env::temp_dir().join(format!("reader-migrate-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // A database as written by the very first release: no `kind`, no `images`, no user_version.
        {
            let conn = Connection::open(dir.join("reader.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE notes(id TEXT PRIMARY KEY, book_id TEXT NOT NULL, section INTEGER NOT NULL DEFAULT 0, pos INTEGER NOT NULL DEFAULT 0,
                   anchor TEXT NOT NULL, quote TEXT NOT NULL DEFAULT '', color TEXT NOT NULL, style TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
                   thought INTEGER NOT NULL DEFAULT 0, side TEXT NOT NULL DEFAULT 'right', side_locked INTEGER NOT NULL DEFAULT 0,
                   created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                 INSERT INTO notes(id, book_id, anchor, quote, color, style, note, created_at, updated_at)
                   VALUES('old', 'b', '{}', 'q', 'amber', 'highlight', '旧笔记 #标签', 1, 1);",
            )
            .unwrap();
        }
        let conn = open(&dir).unwrap();
        let (kind, images, note): (String, String, String) =
            conn.query_row("SELECT kind, images, note FROM notes WHERE id = 'old'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((kind.as_str(), images.as_str(), note.as_str()), ("passage", "", "旧笔记 #标签"));
        let (cref, module): (String, String) = conn.query_row("SELECT canonical_ref, source_module FROM notes WHERE id = 'old'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((cref.as_str(), module.as_str()), ("", ""), "an old note has no canonical position and no module");
        assert!(conn.query_row("SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'notes_ref'", [], |r| r.get::<_, i64>(0)).unwrap() == 1);
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
        // the pre-upgrade copy exists and still has the original layout + data
        let backup = Connection::open(dir.join("backups").join(format!("pre-upgrade-v0-to-v{SCHEMA_VERSION}.db"))).unwrap();
        assert_eq!(backup.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        drop(conn);
        // reopening is a no-op; a database from a newer app is refused untouched
        assert!(open(&dir).is_ok());
        Connection::open(dir.join("reader.db")).unwrap().pragma_update(None, "user_version", SCHEMA_VERSION + 1).unwrap();
        assert!(open(&dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
