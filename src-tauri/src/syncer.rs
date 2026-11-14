//! One round of syncing: bring in what the other devices wrote, then put out what this device wrote (docs/cloud-sync-plan.md).
//!
//! In the cloud every device has its own folder of numbered change files and one small "head" file that says how far they
//! are complete. Nobody ever writes anybody else's files, so no two devices can overwrite each other, and a file is only
//! trusted once the head that points at it exists: a connection that drops in between leaves a file nobody reads, which the
//! next round simply writes again.
//!
//! Change files pile up, so now and then a device writes a **snapshot** (everything it knows, and how far in each device's
//! changes that is). A device that is new, or has been away so long that the files it needs are gone, starts from the
//! newest snapshot. A change file is deleted only once a snapshot covers it and every device that is still in use has read it.
//!
//!   keys.json                       the data key, wrapped by the password and the recovery key (plain; useless without them)
//!   manifest.json                   what this is
//!   devices/<device>.json           sealed: how many change files the device has finished, and how far it has read the others'
//!   changes/<device>/<seq>.bin      sealed (and compressed): one change
//!   snapshots/<time>-<device>.bin   sealed (and compressed): everything, up to a point

use crate::crypto::{self, CryptoError, DataKey, KdfParams, KeyFile};
use crate::records::{self, Change, Report};
use crate::remote::{Remote, RemoteError};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Debug, PartialEq)]
pub enum SyncError {
    Remote(RemoteError),
    Crypto(CryptoError),
    /// Nothing has been set up in this cloud folder yet.
    NoLibrary,
    /// The library already exists (use its password instead).
    LibraryExists,
    /// What was written could not be read back the same.
    NotWritten(String),
    Db(String),
}
impl From<RemoteError> for SyncError {
    fn from(e: RemoteError) -> Self {
        SyncError::Remote(e)
    }
}
impl From<CryptoError> for SyncError {
    fn from(e: CryptoError) -> Self {
        SyncError::Crypto(e)
    }
}
impl From<rusqlite::Error> for SyncError {
    fn from(e: rusqlite::Error) -> Self {
        SyncError::Db(e.to_string())
    }
}
impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Remote(e) => write!(f, "{e}"),
            SyncError::Crypto(e) => write!(f, "{e}"),
            SyncError::NoLibrary => write!(f, "这个云端文件夹里还没有墨边的数据，请先在另一台设备上开启同步"),
            SyncError::LibraryExists => write!(f, "这个云端文件夹里已经有一份数据了，请用它的同步密码加入"),
            SyncError::NotWritten(s) => write!(f, "上传后核对不一致：{s}"),
            SyncError::Db(s) => write!(f, "本地数据库出错：{s}"),
        }
    }
}
impl std::error::Error for SyncError {}

fn db_err<T>(e: std::sync::PoisonError<T>) -> SyncError {
    SyncError::Db(e.to_string())
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    v: u32,
    app: String,
    created_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct Head {
    device: String,
    name: String,
    /// How many change files the device has written completely.
    seq: u64,
    /// How many of each other device's change files it has merged.
    #[serde(default)]
    seen: BTreeMap<String, u64>,
    updated_at: i64,
    format: u32,
}

/// Everything a device knew at one moment, and how far into each device's changes that is.
#[derive(Serialize, Deserialize)]
struct Snapshot {
    covers: BTreeMap<String, u64>,
    change: Change,
}

// ---------------------------------------------------------------- the library in the cloud

/// Set up a new library in an empty cloud folder. Returns the data key and the recovery key (to show once).
pub fn create_library(remote: &dyn Remote, password: &str, kdf: KdfParams, now: i64) -> Result<(DataKey, String), SyncError> {
    if remote.get("keys.json")?.is_some() {
        return Err(SyncError::LibraryExists);
    }
    let (kf, key, recovery) = crypto::create_keys(password, kdf)?;
    remote.put("keys.json", serde_json::to_string_pretty(&kf).unwrap().as_bytes())?;
    remote.put("manifest.json", serde_json::to_string_pretty(&Manifest { v: 1, app: "marginalia".into(), created_at: now }).unwrap().as_bytes())?;
    Ok((key, recovery))
}

/// Join the library that is already in the cloud folder.
pub fn open_library(remote: &dyn Remote, password: &str) -> Result<DataKey, SyncError> {
    let kf = read_keys(remote)?;
    Ok(crypto::unlock(&kf, password)?)
}

pub fn open_library_with_recovery(remote: &dyn Remote, recovery: &str) -> Result<DataKey, SyncError> {
    let kf = read_keys(remote)?;
    Ok(crypto::unlock_with_recovery(&kf, recovery)?)
}

fn read_keys(remote: &dyn Remote) -> Result<KeyFile, SyncError> {
    let bytes = remote.get("keys.json")?.ok_or(SyncError::NoLibrary)?;
    serde_json::from_slice(&bytes).map_err(|_| SyncError::Crypto(CryptoError::Corrupt))
}

// ---------------------------------------------------------------- what this device remembers

fn state_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [format!("sync:{key}")], |r| r.get(0)).optional()
}
fn state_num(conn: &Connection, key: &str) -> rusqlite::Result<i64> {
    Ok(state_get(conn, key)?.and_then(|v| v.parse().ok()).unwrap_or(0))
}
fn state_put(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![format!("sync:{key}"), value])?;
    Ok(())
}
fn state_set(conn: &Connection, key: &str, value: i64) -> rusqlite::Result<()> {
    state_put(conn, key, &value.to_string())
}

/// How far this device has read into each other device's changes.
fn seen_map(conn: &Connection) -> rusqlite::Result<BTreeMap<String, u64>> {
    let mut st = conn.prepare("SELECT key, value FROM meta WHERE key LIKE 'sync:seen:%'")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = BTreeMap::new();
    for r in rows {
        let (k, v) = r?;
        if let (Some(dev), Ok(n)) = (k.strip_prefix("sync:seen:"), v.parse::<u64>()) {
            out.insert(dev.to_string(), n);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- a round

#[derive(Debug, Default, PartialEq)]
pub struct SyncReport {
    /// Change files read from other devices.
    pub pulled: usize,
    pub merged: Report,
    /// Change files written, and the records in them.
    pub pushed_files: usize,
    pub pushed_items: usize,
    /// Started from a snapshot (a new device, or one that was away so long that the changes it needed were gone).
    pub from_snapshot: bool,
    /// A snapshot was written this round.
    pub snapshot_written: bool,
    /// Change files deleted (every device has read them and a snapshot covers them).
    pub pruned: usize,
    /// Devices whose files could not be used (damaged, or from a newer version); the rest was still merged.
    pub problems: Vec<String>,
}

pub struct Options {
    /// Records per change file (a big first sync is cut into several).
    pub max_items: usize,
    /// The time now, in ms.
    pub now: i64,
    /// A snapshot is written when at least this many change files came after the newest one…
    pub snapshot_min_files: u64,
    /// …and the newest one is at least this old.
    pub snapshot_min_age_ms: i64,
    /// A device that has not been heard from for this long is not waited for when deleting old changes.
    pub stale_after_ms: i64,
}
const DAY: i64 = 86_400_000;
impl Options {
    pub fn normal(now: i64) -> Options {
        Options { max_items: 3000, now, snapshot_min_files: 30, snapshot_min_age_ms: 7 * DAY, stale_after_ms: 45 * DAY }
    }
}

fn change_path(device: &str, seq: u64) -> String {
    format!("changes/{device}/{seq:010}.bin")
}
fn change_name(device: &str, seq: u64) -> String {
    format!("{device}/{seq}")
}
fn snapshot_path(at: i64, device: &str) -> String {
    format!("snapshots/{at:015}-{device}.bin")
}
fn snapshot_name(at: i64, device: &str) -> String {
    format!("snapshot/{at}-{device}")
}

fn read_head(remote: &dyn Remote, key: &DataKey, device: &str) -> Result<Option<Head>, SyncError> {
    let Some(bytes) = remote.get(&format!("devices/{device}.json"))? else { return Ok(None) };
    Ok(crypto::open(key, "device", &format!("devices/{device}"), &bytes).ok().and_then(|p| serde_json::from_slice(&p).ok()))
}

fn write_head(remote: &dyn Remote, key: &DataKey, head: &Head) -> Result<(), SyncError> {
    let sealed = crypto::seal(key, "device", &format!("devices/{}", head.device), &serde_json::to_vec(head).unwrap(), false)?;
    remote.put(&format!("devices/{}.json", head.device), &sealed)?;
    Ok(())
}

/// The newest snapshot that can be read, if there is one.
fn newest_snapshot(remote: &dyn Remote, key: &DataKey) -> Result<Option<(i64, String, Snapshot)>, SyncError> {
    let mut files: Vec<String> = remote.list("snapshots")?.into_iter().filter(|f| f.ends_with(".bin")).collect();
    files.sort();
    for f in files.into_iter().rev() {
        let stem = f.trim_end_matches(".bin");
        let Some((at, dev)) = stem.split_once('-') else { continue };
        let Ok(at) = at.parse::<i64>() else { continue };
        let Some(bytes) = remote.get(&format!("snapshots/{f}"))? else { continue };
        if let Ok(plain) = crypto::open(key, "snapshot", &snapshot_name(at, dev), &bytes) {
            if let Ok(s) = serde_json::from_slice::<Snapshot>(&plain) {
                if s.change.v <= records::FORMAT {
                    return Ok(Some((at, dev.to_string(), s)));
                }
            }
        }
    }
    Ok(None)
}

/// Start from the newest snapshot: merge it, and note how far into each device's changes it reaches. Returns whether it moved anything on.
fn use_snapshot(db: &Mutex<Connection>, remote: &dyn Remote, key: &DataKey, device: &str, report: &mut SyncReport) -> Result<bool, SyncError> {
    let Some((_, _, snap)) = newest_snapshot(remote, key)? else { return Ok(false) };
    let mut c = db.lock().map_err(db_err)?;
    let seen = seen_map(&c)?;
    let moves = snap.covers.iter().any(|(d, n)| d != device && *n > seen.get(d).copied().unwrap_or(0));
    if !moves {
        return Ok(false);
    }
    let last_at = state_num(&c, "last_at")?;
    let r = records::apply(&mut c, &[snap.change.clone()], device, last_at)?;
    report.merged = add_reports(std::mem::take(&mut report.merged), r);
    for (d, n) in &snap.covers {
        if d != device && *n > seen.get(d).copied().unwrap_or(0) {
            state_set(&c, &format!("seen:{d}"), *n as i64)?;
        }
    }
    report.from_snapshot = true;
    Ok(true)
}

fn add_reports(a: Report, b: Report) -> Report {
    Report { applied: a.applied + b.applied, older: a.older + b.older, deleted: a.deleted + b.deleted, removed: a.removed + b.removed, conflicts: a.conflicts + b.conflicts, dropped: a.dropped + b.dropped }
}

/// Bring in what the others wrote, then put out what this one wrote; now and then also write a snapshot and clear away old changes.
pub fn sync_once(db: &Mutex<Connection>, remote: &dyn Remote, key: &DataKey, device: &str, name: &str, opts: &Options) -> Result<SyncReport, SyncError> {
    let started = opts.now;
    let mut report = SyncReport::default();
    let (last_sync_at, mut my_seq, pushed_at) = {
        let c = db.lock().map_err(db_err)?;
        (state_num(&c, "last_at")?, state_num(&c, "seq")? as u64, state_num(&c, "pushed_at")?)
    };

    // a device that has never synced starts from the newest snapshot
    if last_sync_at == 0 {
        use_snapshot(db, remote, key, device, &mut report)?;
    }

    // 1. what the others wrote
    let mut heads: BTreeMap<String, Head> = BTreeMap::new();
    for file in remote.list("devices")? {
        let Some(other) = file.strip_suffix(".json") else { continue };
        match read_head(remote, key, other)? {
            Some(h) => {
                heads.insert(other.to_string(), h);
            }
            None if other != device => report.problems.push(format!("设备 {other} 的状态文件不能读取")),
            None => {}
        }
    }
    let mut fetched: Vec<(String, u64, Change)> = vec![];
    let mut tried_snapshot = report.from_snapshot;
    for (other, head) in heads.iter().filter(|(d, _)| d.as_str() != device) {
        let mut seen = {
            let c = db.lock().map_err(db_err)?;
            state_num(&c, &format!("seen:{other}"))? as u64
        };
        let mut seq = seen + 1;
        while seq <= head.seq {
            let Some(bytes) = remote.get(&change_path(other, seq))? else {
                // the file is gone: if it was cleared away, a snapshot covers it
                if !tried_snapshot {
                    tried_snapshot = true;
                    if use_snapshot(db, remote, key, device, &mut report)? {
                        seen = {
                            let c = db.lock().map_err(db_err)?;
                            state_num(&c, &format!("seen:{other}"))? as u64
                        };
                        seq = seen + 1;
                        continue;
                    }
                }
                report.problems.push(format!("设备 {other} 的第 {seq} 号变更文件不存在"));
                break;
            };
            let plain = match crypto::open(key, "change", &change_name(other, seq), &bytes) {
                Ok(p) => p,
                Err(e) => {
                    report.problems.push(format!("设备 {other} 的第 {seq} 号变更文件不能用：{e}"));
                    break;
                }
            };
            match serde_json::from_slice::<Change>(&plain) {
                Ok(ch) if ch.v <= records::FORMAT => fetched.push((other.clone(), seq, ch)),
                Ok(ch) => {
                    report.problems.push(format!("设备 {other} 的变更来自更新的版本（格式 {}），请先升级应用", ch.v));
                    break;
                }
                Err(_) => {
                    report.problems.push(format!("设备 {other} 的第 {seq} 号变更文件格式不对"));
                    break;
                }
            }
            seq += 1;
        }
    }
    if !fetched.is_empty() {
        let changes: Vec<Change> = fetched.iter().map(|(_, _, c)| c.clone()).collect();
        let mut c = db.lock().map_err(db_err)?;
        let r = records::apply(&mut c, &changes, device, last_sync_at)?;
        report.merged = add_reports(std::mem::take(&mut report.merged), r);
        for (other, seq, _) in &fetched {
            let seen = state_num(&c, &format!("seen:{other}"))?;
            if *seq as i64 > seen {
                state_set(&c, &format!("seen:{other}"), *seq as i64)?;
            }
        }
        report.pulled = fetched.len();
    }

    // 2. what this device wrote
    let (items, tombstones) = {
        let c = db.lock().map_err(db_err)?;
        records::export_since(&c, pushed_at)?
    };
    let mut wrote = false;
    if !items.is_empty() || !tombstones.is_empty() {
        let per = opts.max_items.max(1);
        let mut groups: Vec<Vec<records::Item>> = items.chunks(per).map(|c| c.to_vec()).collect();
        if groups.is_empty() {
            groups.push(vec![]);
        }
        let mut tombs = Some(tombstones);
        for group in groups {
            my_seq += 1;
            report.pushed_items += group.len();
            let ch = Change { v: records::FORMAT, device: device.to_string(), seq: my_seq, created_at: opts.now, items: group, tombstones: tombs.take().unwrap_or_default() };
            let sealed = crypto::seal(key, "change", &change_name(device, my_seq), &serde_json::to_vec(&ch).unwrap(), true)?;
            let path = change_path(device, my_seq);
            remote.put(&path, &sealed)?;
            // write, then read back and compare: only a file that is really there is announced
            if remote.get(&path)?.as_deref() != Some(&sealed[..]) {
                return Err(SyncError::NotWritten(path));
            }
            report.pushed_files += 1;
        }
        wrote = true;
    }

    // 3. say how far this device is (the head is what makes new change files count, and tells the others what it has read)
    let seen_now = {
        let c = db.lock().map_err(db_err)?;
        seen_map(&c)?
    };
    let my_head = Head { device: device.to_string(), name: name.to_string(), seq: my_seq, seen: seen_now.clone(), updated_at: opts.now, format: records::FORMAT };
    let seen_sig = serde_json::to_string(&seen_now).unwrap();
    let head_stale = {
        let c = db.lock().map_err(db_err)?;
        state_get(&c, "head_seen")?.as_deref() != Some(seen_sig.as_str())
    };
    if wrote || head_stale || !heads.contains_key(device) {
        write_head(remote, key, &my_head)?;
        let c = db.lock().map_err(db_err)?;
        state_set(&c, "seq", my_seq as i64)?;
        state_put(&c, "head_seen", &seen_sig)?;
        if wrote {
            // a little before the start, so a write that was just being made when this round began is caught by the next one
            let mark = (started - 1000).max(pushed_at);
            state_set(&c, "pushed_at", mark)?;
            // what arrived before that mark can no longer be exported anyway: forget it
            c.execute("DELETE FROM sync_known WHERE stamp < ?1", [mark])?;
        }
    }
    heads.insert(device.to_string(), my_head);

    // 4. now and then: a snapshot, and clearing away what everybody has read
    maybe_snapshot(db, remote, key, device, &heads, opts, &mut report)?;
    prune(remote, key, &heads, opts, &mut report)?;

    let c = db.lock().map_err(db_err)?;
    state_set(&c, "last_at", started)?;
    Ok(report)
}

/// Write a snapshot when enough has piled up since the last one.
fn maybe_snapshot(db: &Mutex<Connection>, remote: &dyn Remote, key: &DataKey, device: &str, heads: &BTreeMap<String, Head>, opts: &Options, report: &mut SyncReport) -> Result<(), SyncError> {
    let newest = newest_snapshot(remote, key)?;
    let (covers, age) = match &newest {
        Some((at, _, s)) => (s.covers.clone(), opts.now - *at),
        None => (BTreeMap::new(), i64::MAX),
    };
    let since: u64 = heads.iter().map(|(d, h)| h.seq.saturating_sub(covers.get(d).copied().unwrap_or(0))).sum();
    if since < opts.snapshot_min_files || age < opts.snapshot_min_age_ms {
        return Ok(());
    }
    // what this device has: everything in its database, and how far into each device's changes that is
    let (items, tombstones, mut covers_now) = {
        let c = db.lock().map_err(db_err)?;
        let (i, t) = records::export_all(&c)?;
        (i, t, seen_map(&c)?)
    };
    covers_now.insert(device.to_string(), heads.get(device).map_or(0, |h| h.seq));
    let snap = Snapshot { covers: covers_now, change: Change { v: records::FORMAT, device: device.to_string(), seq: 0, created_at: opts.now, items, tombstones } };
    let sealed = crypto::seal(key, "snapshot", &snapshot_name(opts.now, device), &serde_json::to_vec(&snap).unwrap(), true)?;
    let path = snapshot_path(opts.now, device);
    remote.put(&path, &sealed)?;
    if remote.get(&path)?.as_deref() != Some(&sealed[..]) {
        return Err(SyncError::NotWritten(path));
    }
    // keep the two newest
    let mut files: Vec<String> = remote.list("snapshots")?.into_iter().filter(|f| f.ends_with(".bin")).collect();
    files.sort();
    while files.len() > 2 {
        remote.delete(&format!("snapshots/{}", files.remove(0)))?;
    }
    report.snapshot_written = true;
    Ok(())
}

/// Delete change files that a snapshot covers and every device still in use has already read.
fn prune(remote: &dyn Remote, key: &DataKey, heads: &BTreeMap<String, Head>, opts: &Options, report: &mut SyncReport) -> Result<(), SyncError> {
    let Some((_, _, snap)) = newest_snapshot(remote, key)? else { return Ok(()) };
    for (dev, covered) in &snap.covers {
        let readers = heads.iter().filter(|(d, h)| *d != dev && opts.now - h.updated_at < opts.stale_after_ms);
        // the files up to this number are read by everybody who counts, and covered by the snapshot
        let bound = readers.map(|(_, h)| h.seen.get(dev).copied().unwrap_or(0)).min().unwrap_or(*covered).min(*covered);
        if bound == 0 {
            continue;
        }
        for f in remote.list(&format!("changes/{dev}"))? {
            let Some(n) = f.strip_suffix(".bin").and_then(|s| s.parse::<u64>().ok()) else { continue };
            if n <= bound {
                remote.delete(&format!("changes/{dev}/{f}"))?;
                report.pruned += 1;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::Memory;

    const FAST: KdfParams = KdfParams { mem_kib: 8, iters: 1, lanes: 1 };

    struct Dev {
        db: Mutex<Connection>,
        id: String,
        clock: i64,
    }
    fn device() -> Dev {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::notes::SCHEMA).unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        let id = crate::sync::device_id(&conn).unwrap();
        Dev { db: Mutex::new(conn), id, clock: 10_000 }
    }
    impl Dev {
        fn write(&mut self, id: &str, text: &str) {
            self.clock += 10;
            let n: crate::notes::Note = serde_json::from_value(serde_json::json!({
                "id": id, "anchor": {"section": 0, "start": 0, "end": 0, "exact": ""}, "color": "amber", "style": "none",
                "note": text, "kind": "free", "createdAt": 1, "updatedAt": self.clock
            }))
            .unwrap();
            crate::notes::upsert(&self.db.lock().unwrap(), "_memo", &n).unwrap();
        }
        fn delete(&mut self, id: &str) {
            self.clock += 10;
            let c = self.db.lock().unwrap();
            crate::notes::delete_ids(&c, &[id.to_string()]).unwrap();
            c.execute("UPDATE tombstones SET deleted_at = ?2 WHERE kind = 'note' AND id = ?1", params![id, self.clock]).unwrap();
        }
        fn text(&self, id: &str) -> Option<String> {
            self.db.lock().unwrap().query_row("SELECT note FROM notes WHERE id = ?1", [id], |r| r.get(0)).optional().unwrap()
        }
        fn notes(&self) -> Vec<(String, String)> {
            let c = self.db.lock().unwrap();
            let mut st = c.prepare("SELECT id, note FROM notes ORDER BY id").unwrap();
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().filter_map(Result::ok).collect()
        }
        fn opts(&mut self) -> Options {
            self.clock += 10_000;
            // snapshots and clearing away are off unless a test asks for them
            Options { max_items: 1000, now: self.clock, snapshot_min_files: u64::MAX, snapshot_min_age_ms: 0, stale_after_ms: 45 * DAY }
        }
        fn sync(&mut self, remote: &Memory, key: &DataKey) -> Result<SyncReport, SyncError> {
            let o = self.opts();
            sync_once(&self.db, remote, key, &self.id, "测试设备", &o)
        }
        fn sync_with(&mut self, remote: &Memory, key: &DataKey, min_files: u64) -> Result<SyncReport, SyncError> {
            let mut o = self.opts();
            o.snapshot_min_files = min_files;
            sync_once(&self.db, remote, key, &self.id, "测试设备", &o)
        }
    }

    fn setup() -> (Memory, DataKey, Dev, Dev) {
        let remote = Memory::new();
        let (key, _) = create_library(&remote, "pw", FAST, 1).unwrap();
        (remote, key, device(), device())
    }
    fn change_files(remote: &Memory) -> usize {
        remote.paths().iter().filter(|p| p.starts_with("changes/")).count()
    }

    #[test]
    fn what_one_device_writes_arrives_on_the_other_and_back() {
        let (remote, key, mut a, mut b) = setup();
        a.write("n1", "A 写的");
        a.write("n2", "第二条");
        let r = a.sync(&remote, &key).unwrap();
        assert_eq!((r.pushed_files, r.pushed_items), (1, 2));
        let r = b.sync(&remote, &key).unwrap();
        assert_eq!((r.pulled, r.merged.applied), (1, 2));
        assert_eq!(b.text("n1").as_deref(), Some("A 写的"));
        b.write("n1", "B 改过了");
        b.sync(&remote, &key).unwrap();
        a.sync(&remote, &key).unwrap();
        assert_eq!(a.text("n1").as_deref(), Some("B 改过了"));
        assert_eq!(a.notes(), b.notes());
    }

    #[test]
    fn a_round_with_nothing_new_writes_nothing() {
        let (remote, key, mut a, mut b) = setup();
        a.write("n1", "x");
        a.sync(&remote, &key).unwrap();
        b.sync(&remote, &key).unwrap();
        a.sync(&remote, &key).unwrap(); // (A now knows B has read its changes)
        let before = remote.counts().0;
        let r1 = a.sync(&remote, &key).unwrap();
        let r2 = b.sync(&remote, &key).unwrap();
        assert_eq!((r1.pushed_files, r2.pushed_files, r1.pulled, r2.pulled), (0, 0, 0, 0));
        assert_eq!(remote.counts().0, before, "not a single file written");
    }

    #[test]
    fn deletions_and_late_edits_work_through_the_whole_path() {
        let (remote, key, mut a, mut b) = setup();
        a.write("n1", "x");
        a.write("n2", "y");
        a.sync(&remote, &key).unwrap();
        b.sync(&remote, &key).unwrap();
        a.delete("n1");
        b.write("n2", "y，B 又改了");
        a.sync(&remote, &key).unwrap();
        b.sync(&remote, &key).unwrap();
        a.sync(&remote, &key).unwrap();
        assert_eq!(a.text("n1"), None);
        assert_eq!(b.text("n1"), None, "deleted on A, gone on B");
        assert_eq!(a.text("n2").as_deref(), Some("y，B 又改了"));
        assert_eq!(a.notes(), b.notes());
    }

    #[test]
    fn a_connection_that_drops_before_the_head_is_written_leaves_nothing_for_others_to_read() {
        let (remote, key, mut a, mut b) = setup();
        a.write("n1", "x");
        remote.fail_puts_after(Some(remote.counts().0 + 1)); // the change file gets through, the head does not
        assert!(matches!(a.sync(&remote, &key), Err(SyncError::Remote(_))));
        remote.fail_puts_after(None); // (B has its own connection)
        let r = b.sync(&remote, &key).unwrap();
        assert_eq!((r.pulled, b.text("n1")), (0, None), "an unannounced file is not read");
        let r = a.sync(&remote, &key).unwrap();
        assert_eq!(r.pushed_files, 1);
        b.sync(&remote, &key).unwrap();
        assert_eq!(b.text("n1").as_deref(), Some("x"));
        let files: Vec<_> = remote.paths().into_iter().filter(|p| p.starts_with("changes/")).collect();
        assert_eq!(files.len(), 1, "the leftover was written over, not added to: {files:?}");
    }

    #[test]
    fn a_damaged_file_is_reported_and_changes_nothing() {
        let (remote, key, mut a, mut b) = setup();
        a.write("n1", "x");
        a.sync(&remote, &key).unwrap();
        let path = remote.paths().into_iter().find(|p| p.starts_with("changes/")).unwrap();
        remote.corrupt(&path);
        let r = b.sync(&remote, &key).unwrap();
        assert_eq!(r.pulled, 0);
        assert_eq!(r.problems.len(), 1, "{:?}", r.problems);
        assert_eq!(b.text("n1"), None);
        assert_eq!(b.db.lock().unwrap().query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn a_healthy_device_is_still_merged_when_another_one_is_damaged() {
        let remote = Memory::new();
        let (key, _) = create_library(&remote, "pw", FAST, 1).unwrap();
        let (mut a, mut b, mut c) = (device(), device(), device());
        a.write("na", "来自 A");
        b.write("nb", "来自 B");
        a.sync(&remote, &key).unwrap();
        b.sync(&remote, &key).unwrap();
        let a_file = remote.paths().into_iter().find(|p| p.starts_with(&format!("changes/{}/", a.id))).unwrap();
        remote.corrupt(&a_file);
        let r = c.sync(&remote, &key).unwrap();
        assert_eq!(r.problems.len(), 1);
        assert_eq!(c.text("nb").as_deref(), Some("来自 B"));
        assert_eq!(c.text("na"), None);
    }

    #[test]
    fn the_password_is_checked_and_an_empty_folder_is_not_a_library() {
        let remote = Memory::new();
        assert_eq!(open_library(&remote, "pw").err(), Some(SyncError::NoLibrary));
        let (key, recovery) = create_library(&remote, "right", FAST, 1).unwrap();
        assert_eq!(create_library(&remote, "other", FAST, 1).err(), Some(SyncError::LibraryExists));
        assert_eq!(open_library(&remote, "wrong").err(), Some(SyncError::Crypto(CryptoError::BadPassword)));
        assert_eq!(open_library(&remote, "right").unwrap().as_bytes(), key.as_bytes());
        assert_eq!(open_library_with_recovery(&remote, &recovery).unwrap().as_bytes(), key.as_bytes());
    }

    #[test]
    fn a_first_sync_of_a_lot_is_cut_into_several_files() {
        let (remote, key, mut a, mut b) = setup();
        for i in 0..10 {
            a.write(&format!("n{i}"), &format!("笔记 {i}"));
        }
        a.clock += 10_000;
        let o = Options { max_items: 3, ..a.opts() };
        let r = sync_once(&a.db, &remote, &key, &a.id, "A", &o).unwrap();
        assert_eq!((r.pushed_files, r.pushed_items), (4, 10));
        let r = b.sync(&remote, &key).unwrap();
        assert_eq!((r.pulled, r.merged.applied), (4, 10));
        assert_eq!(a.notes(), b.notes());
    }

    #[test]
    fn a_change_from_a_newer_format_is_not_touched() {
        let (remote, key, mut a, mut b) = setup();
        a.write("n1", "x");
        // forge a device that writes a format this version does not know
        let ch = Change { v: 99, device: "zz".into(), seq: 1, created_at: 1, items: vec![], tombstones: vec![] };
        remote.put(&change_path("zz", 1), &crypto::seal(&key, "change", "zz/1", &serde_json::to_vec(&ch).unwrap(), true).unwrap()).unwrap();
        write_head(&remote, &key, &Head { device: "zz".into(), name: "future".into(), seq: 1, seen: BTreeMap::new(), updated_at: 1, format: 99 }).unwrap();
        a.sync(&remote, &key).unwrap();
        let r = b.sync(&remote, &key).unwrap();
        assert_eq!(r.problems.len(), 1);
        assert!(r.problems[0].contains("升级"), "{:?}", r.problems);
        assert_eq!(b.text("n1").as_deref(), Some("x"), "the readable part is still merged");
    }

    #[test]
    fn nothing_in_the_cloud_can_be_read_without_the_key() {
        let (remote, key, mut a, _b) = setup();
        a.write("n1", "一条绝对不能让云端看见的私密笔记");
        a.sync_with(&remote, &key, 0).unwrap(); // (and a snapshot too)
        assert!(remote.paths().iter().any(|p| p.starts_with("snapshots/")));
        for p in remote.paths() {
            let bytes = remote.get(&p).unwrap().unwrap();
            let hay = String::from_utf8_lossy(&bytes);
            assert!(!hay.contains("私密笔记"), "{p} shows the text");
            if p != "keys.json" && p != "manifest.json" {
                assert_eq!(&bytes[..4], b"MGC1", "{p} is not sealed");
            }
        }
    }

    #[test]
    fn three_devices_that_all_write_and_sync_in_turn_end_up_the_same() {
        let remote = Memory::new();
        let (key, _) = create_library(&remote, "pw", FAST, 1).unwrap();
        let mut devs = [device(), device(), device()];
        let mut seed: u64 = 99;
        let mut next = move |n: u64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) % n
        };
        let mut t = 0i64;
        for _ in 0..40 {
            let i = next(3) as usize;
            // all devices share one clock so "later" means the same everywhere
            t += 20;
            devs[i].clock = devs[i].clock.max(t);
            let id = format!("n{}", next(5));
            match next(4) {
                0 => {
                    if devs[i].text(&id).is_some() {
                        devs[i].delete(&id)
                    }
                }
                1 => {
                    let j = next(3) as usize;
                    devs[j].clock = devs[j].clock.max(t);
                    devs[j].sync(&remote, &key).unwrap();
                }
                _ => devs[i].write(&id, &format!("{i}@{t}")),
            }
            t = t.max(devs[i].clock);
        }
        for _ in 0..3 {
            for d in devs.iter_mut() {
                d.sync(&remote, &key).unwrap();
            }
        }
        assert_eq!(devs[0].notes(), devs[1].notes());
        assert_eq!(devs[1].notes(), devs[2].notes());
    }

    // ---- snapshots and clearing away

    #[test]
    fn a_new_device_starts_from_the_snapshot_and_reads_only_what_came_after() {
        let (remote, key, mut a, mut b) = setup();
        for round in 0..6 {
            a.write(&format!("n{round}"), &format!("第 {round} 条"));
            a.sync(&remote, &key).unwrap();
        }
        b.sync(&remote, &key).unwrap(); // B has read everything A wrote
        let r = a.sync_with(&remote, &key, 3).unwrap();
        assert!(r.snapshot_written, "enough had piled up");
        a.write("late", "快照之后写的");
        a.sync(&remote, &key).unwrap();
        // a brand-new device
        let mut c = device();
        let r = c.sync(&remote, &key).unwrap();
        assert!(r.from_snapshot);
        assert_eq!(r.pulled, 1, "only the one change written after the snapshot");
        assert_eq!(c.notes(), a.notes());
        assert_eq!(c.text("late").as_deref(), Some("快照之后写的"));
    }

    #[test]
    fn no_snapshot_is_written_for_a_few_changes() {
        let (remote, key, mut a, mut b) = setup();
        a.write("n1", "x");
        a.sync_with(&remote, &key, 30).unwrap();
        b.sync_with(&remote, &key, 30).unwrap();
        assert!(!remote.paths().iter().any(|p| p.starts_with("snapshots/")));
    }

    #[test]
    fn old_changes_are_cleared_only_when_covered_and_read_by_every_device_in_use() {
        let (remote, key, mut a, mut b) = setup();
        b.sync(&remote, &key).unwrap(); // B joins (and has read nothing of A's yet)
        for round in 0..5 {
            a.write(&format!("n{round}"), "x");
            a.sync(&remote, &key).unwrap();
        }
        assert_eq!(change_files(&remote), 5);
        // a snapshot exists, but B has not read anything yet: nothing may go
        let r = a.sync_with(&remote, &key, 2).unwrap();
        assert!(r.snapshot_written);
        assert_eq!((r.pruned, change_files(&remote)), (0, 5));
        // B reads them and says so: whichever device syncs next clears what everybody has read (here B itself)
        let rb = b.sync(&remote, &key).unwrap();
        let ra = a.sync(&remote, &key).unwrap();
        assert_eq!(rb.pruned + ra.pruned, 5, "{rb:?} {ra:?}");
        assert_eq!(change_files(&remote), 0);
        // and both are still in step, and a newcomer gets everything through the snapshot
        a.write("after", "清理之后");
        a.sync(&remote, &key).unwrap();
        b.sync(&remote, &key).unwrap();
        assert_eq!(a.notes(), b.notes());
        let mut c = device();
        c.sync(&remote, &key).unwrap();
        assert_eq!(c.notes(), a.notes());
    }

    #[test]
    fn a_device_that_was_away_until_its_changes_were_cleared_starts_again_from_the_snapshot() {
        let (remote, key, mut a, mut away) = setup();
        a.write("old", "走之前就有");
        a.sync(&remote, &key).unwrap();
        away.sync(&remote, &key).unwrap();
        away.write("mine", "离线时自己写的，还没同步");
        // a long time passes: A writes a lot, a snapshot is made, and since the other device is not heard from, its absence is not waited for
        for round in 0..4 {
            a.write(&format!("n{round}"), "x");
            a.clock += 60 * DAY;
            a.sync(&remote, &key).unwrap();
        }
        a.clock += 60 * DAY;
        let mut o = a.opts();
        o.snapshot_min_files = 2;
        let r = sync_once(&a.db, &remote, &key, &a.id, "A", &o).unwrap();
        assert!(r.snapshot_written);
        assert!(r.pruned > 0, "the away device is not waited for: {r:?}");
        assert_eq!(change_files(&remote), 0);
        // the long-away device comes back
        away.clock = a.clock;
        let r = away.sync(&remote, &key).unwrap();
        assert!(r.from_snapshot, "{r:?}");
        assert!(r.problems.is_empty(), "{:?}", r.problems);
        for n in ["old", "n0", "n3"] {
            assert!(away.text(n).is_some(), "{n}");
        }
        assert_eq!(away.text("mine").as_deref(), Some("离线时自己写的，还没同步"), "what it wrote while away is not lost");
        a.sync(&remote, &key).unwrap();
        away.sync(&remote, &key).unwrap();
        a.sync(&remote, &key).unwrap();
        assert_eq!(a.notes(), away.notes());
    }
}
