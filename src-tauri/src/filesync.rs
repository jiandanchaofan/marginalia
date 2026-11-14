//! The files that are not in the database: pictures in notes, and the books themselves (docs/cloud-sync-plan.md).
//!
//! Every file is cut into parts of a few MB, each sealed on its own, so a big one can be resumed after a drop and nothing big
//! sits in memory. A small "meta" file written last says the file is complete. Names in the cloud are a keyed hash of the
//! file's own hash (see `crypto::remote_name`), and what is downloaded is checked against the hash in its name.
//!
//!   files/<kind>/<name>/<part>.bin   sealed part      files/<kind>/<name>/meta.bin   sealed: size, parts, extension
//!
//! Pictures that notes refer to go up and come down by themselves. A book only goes up if the user marked it (`cloud` in its
//! description), and comes down only when asked. Large transfers stop at the month's budget (the free 坚果云 plan allows
//! 1GB up and 3GB down a month); notes and the rest of the sync are never held back by it.

use crate::crypto::{self, DataKey};
use crate::notes::Db;
use crate::remote::Remote;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const CHUNK: usize = 4 * 1024 * 1024;
const HOUR: i64 = 3_600_000;

#[derive(Serialize, Deserialize)]
struct Meta {
    size: u64,
    parts: u64,
    #[serde(default)]
    ext: String,
}

#[derive(Debug, PartialEq, Clone)]
pub enum Outcome {
    /// Bytes that went over the wire.
    Done(i64),
    AlreadyThere,
    /// The file is not in the cloud (yet).
    NotThere,
    /// It would not fit in what is left of this month's budget.
    NoBudget,
}

#[derive(Debug, Default, PartialEq)]
pub struct FileReport {
    pub uploaded: usize,
    pub downloaded: usize,
    pub bytes_up: i64,
    pub bytes_down: i64,
    /// Waiting for next month's budget.
    pub deferred: usize,
    pub errors: Vec<String>,
}

#[derive(Clone, Copy)]
pub struct Limits {
    /// Bytes per month, up and down.
    pub up: i64,
    pub down: i64,
}
impl Default for Limits {
    fn default() -> Self {
        // the free plan, with a tenth left over
        Limits { up: 900 * 1024 * 1024, down: 2700 * 1024 * 1024 }
    }
}

pub struct Options {
    pub now: i64,
    pub limits: Limits,
    pub chunk: usize,
}
impl Options {
    pub fn normal(now: i64) -> Options {
        Options { now, limits: Limits::default(), chunk: CHUNK }
    }
}

// ---------------------------------------------------------------- the month's budget

fn month_of(conn: &Connection, now: i64) -> rusqlite::Result<String> {
    conn.query_row("SELECT strftime('%Y-%m', ?1 / 1000, 'unixepoch')", [now], |r| r.get(0))
}

/// Bytes sent and received so far this month (by this device).
pub fn used(conn: &Connection, now: i64) -> rusqlite::Result<(i64, i64)> {
    let m = month_of(conn, now)?;
    let get = |dir: &str| -> rusqlite::Result<i64> {
        Ok(conn.query_row("SELECT value FROM meta WHERE key = ?1", [format!("syncquota:{m}:{dir}")], |r| r.get::<_, String>(0)).optional()?.and_then(|v| v.parse().ok()).unwrap_or(0))
    };
    Ok((get("up")?, get("down")?))
}

fn spend(conn: &Connection, now: i64, dir: &str, bytes: i64) -> rusqlite::Result<()> {
    let m = month_of(conn, now)?;
    let key = format!("syncquota:{m}:{dir}");
    let have: i64 = conn.query_row("SELECT value FROM meta WHERE key = ?1", [&key], |r| r.get::<_, String>(0)).optional()?.and_then(|v| v.parse().ok()).unwrap_or(0);
    conn.execute("INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, (have + bytes).to_string()])?;
    // older months are of no use
    conn.execute("DELETE FROM meta WHERE key LIKE 'syncquota:%' AND key NOT LIKE ?1", [format!("syncquota:{m}:%")])?;
    Ok(())
}

pub struct Budget {
    pub up_left: i64,
    pub down_left: i64,
}
impl Budget {
    pub fn for_now(conn: &Connection, now: i64, l: Limits) -> rusqlite::Result<Budget> {
        let (u, d) = used(conn, now)?;
        Ok(Budget { up_left: (l.up - u).max(0), down_left: (l.down - d).max(0) })
    }
}

// ---------------------------------------------------------------- one file

fn base(kind: &str, name: &str) -> String {
    format!("files/{kind}/{name}")
}

/// Put a file in the cloud, part by part. Parts that are already there (from an upload that was cut short) are not sent again.
pub fn upload(remote: &dyn Remote, key: &DataKey, kind: &str, id: &str, ext: &str, path: &Path, budget: &mut Budget, chunk: usize) -> Result<Outcome, String> {
    let name = crypto::remote_name(key, kind, id);
    let dir = base(kind, &name);
    if remote.get(&format!("{dir}/meta.bin")).map_err(|e| e.to_string())?.is_some() {
        return Ok(Outcome::AlreadyThere);
    }
    let size = fs::metadata(path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?.len();
    // a rough price: the file itself (the sealing adds a few bytes per part)
    if size as i64 > budget.up_left {
        return Ok(Outcome::NoBudget);
    }
    let parts = size.div_ceil(chunk as u64).max(1);
    let have: HashSet<String> = remote.list(&dir).map_err(|e| e.to_string())?.into_iter().collect();
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut sent = 0i64;
    for i in 0..parts {
        let part = format!("{i:06}.bin");
        if have.contains(&part) {
            continue;
        }
        let start = i * chunk as u64;
        let len = ((size - start) as usize).min(chunk);
        let mut buf = vec![0u8; len];
        file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut buf)).map_err(|e| e.to_string())?;
        let sealed = crypto::seal(key, "file", &format!("{name}/{i}"), &buf, false).map_err(|e| e.to_string())?;
        remote.put(&format!("{dir}/{part}"), &sealed).map_err(|e| e.to_string())?;
        sent += sealed.len() as i64;
        budget.up_left -= sealed.len() as i64;
    }
    // the meta file is what says the file is whole
    let meta = serde_json::to_vec(&Meta { size, parts, ext: ext.to_string() }).unwrap();
    let sealed = crypto::seal(key, "filemeta", &name, &meta, false).map_err(|e| e.to_string())?;
    remote.put(&format!("{dir}/meta.bin"), &sealed).map_err(|e| e.to_string())?;
    sent += sealed.len() as i64;
    Ok(Outcome::Done(sent))
}

/// What a downloaded file's name promises: the start of its SHA-256 (pictures), or the whole of it (books).
fn matches_name(kind: &str, id: &str, hash_hex: &str) -> bool {
    let stem = id.split('.').next().unwrap_or(id);
    if kind == "image" {
        stem.len() >= 16 && hash_hex.starts_with(&stem[..16])
    } else {
        stem == hash_hex
    }
}

/// Bring a file down from the cloud to `dest`. Written to a temporary file first, checked against its hash, then moved into place.
pub fn download(remote: &dyn Remote, key: &DataKey, kind: &str, id: &str, dest: &Path, budget: &mut Budget) -> Result<Outcome, String> {
    let name = crypto::remote_name(key, kind, id);
    let dir = base(kind, &name);
    let Some(meta_bytes) = remote.get(&format!("{dir}/meta.bin")).map_err(|e| e.to_string())? else { return Ok(Outcome::NotThere) };
    let meta: Meta = serde_json::from_slice(&crypto::open(key, "filemeta", &name, &meta_bytes).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if meta.size as i64 > budget.down_left {
        return Ok(Outcome::NoBudget);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_extension(format!("{}.part", dest.extension().and_then(|e| e.to_str()).unwrap_or("")));
    let result = (|| -> Result<i64, String> {
        let mut out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut got = 0i64;
        let mut total = 0u64;
        for i in 0..meta.parts {
            let bytes = remote.get(&format!("{dir}/{i:06}.bin")).map_err(|e| e.to_string())?.ok_or_else(|| format!("云端缺少第 {} 段", i + 1))?;
            got += bytes.len() as i64;
            let plain = crypto::open(key, "file", &format!("{name}/{i}"), &bytes).map_err(|e| e.to_string())?;
            hasher.update(&plain);
            total += plain.len() as u64;
            out.write_all(&plain).map_err(|e| e.to_string())?;
        }
        out.flush().map_err(|e| e.to_string())?;
        if total != meta.size || !matches_name(kind, id, &hex::encode(hasher.finalize())) {
            return Err("下载的文件和它的校验值对不上，已丢弃".into());
        }
        Ok(got)
    })();
    match result {
        Ok(got) => {
            fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
            budget.down_left -= got;
            Ok(Outcome::Done(got))
        }
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

// ---------------------------------------------------------------- the round

fn image_path(dir: &Path, id: &str) -> PathBuf {
    dir.join("images").join(id)
}
fn book_path(dir: &Path, id: &str, ext: &str) -> PathBuf {
    dir.join("books").join(format!("{id}.{ext}"))
}
fn valid_image_id(id: &str) -> bool {
    match id.split_once('.') {
        Some((h, ext)) => h.len() == 16 && h.bytes().all(|b| b.is_ascii_hexdigit()) && ["png", "jpg", "gif", "webp", "bmp"].contains(&ext),
        None => false,
    }
}
fn valid_book_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit())
}

fn mark(conn: &Connection, kind: &str, id: &str, state: &str, at: i64) -> rusqlite::Result<()> {
    conn.execute("INSERT OR REPLACE INTO sync_files(kind, id, state, at) VALUES(?1, ?2, ?3, ?4)", params![kind, id, state, at])?;
    Ok(())
}
fn marked(conn: &Connection, kind: &str, id: &str) -> rusqlite::Result<Option<(String, i64)>> {
    conn.query_row("SELECT state, at FROM sync_files WHERE kind = ?1 AND id = ?2", params![kind, id], |r| Ok((r.get(0)?, r.get(1)?))).optional()
}

/// Pictures the notes refer to.
fn pictures_in_use(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut st = conn.prepare("SELECT images FROM notes WHERE images <> ''")?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    let mut seen = HashSet::new();
    let mut out = vec![];
    for r in rows {
        for id in r?.split(',').filter(|s| !s.is_empty()) {
            if valid_image_id(id) && seen.insert(id.to_string()) {
                out.push(id.to_string());
            }
        }
    }
    Ok(out)
}

/// The books the user marked for the cloud: (id, extension).
fn marked_books(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut st = conn.prepare("SELECT data FROM books")?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = vec![];
    for r in rows {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&r?) {
            if v.get("cloud").and_then(|c| c.as_bool()) == Some(true) {
                if let (Some(id), Some(ext)) = (v.get("id").and_then(|x| x.as_str()), v.get("ext").and_then(|x| x.as_str())) {
                    if valid_book_id(id) {
                        out.push((id.to_string(), ext.to_string()));
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Send what is waiting to go (smallest first), bring down the pictures that are missing here.
pub fn sync_files(db: &Mutex<Connection>, remote: &dyn Remote, key: &DataKey, dir: &Path, opts: &Options) -> FileReport {
    let mut rep = FileReport::default();
    let go = (|| -> Result<(), String> {
        let (mut budget, pics, books) = {
            let c = db.lock().map_err(|e| e.to_string())?;
            (Budget::for_now(&c, opts.now, opts.limits).map_err(|e| e.to_string())?, pictures_in_use(&c).map_err(|e| e.to_string())?, marked_books(&c).map_err(|e| e.to_string())?)
        };
        // 1. going up: pictures that exist here, books that were marked
        let mut up: Vec<(&str, String, String, PathBuf, u64)> = vec![];
        for id in &pics {
            let p = image_path(dir, id);
            if let Ok(m) = fs::metadata(&p) {
                up.push(("image", id.clone(), String::new(), p, m.len()));
            }
        }
        for (id, ext) in &books {
            let p = book_path(dir, id, ext);
            if let Ok(m) = fs::metadata(&p) {
                up.push(("book", id.clone(), ext.clone(), p, m.len()));
            }
        }
        up.sort_by_key(|u| u.4);
        for (kind, id, ext, path, _) in up {
            let done = { marked(&*db.lock().map_err(|e| e.to_string())?, kind, &id).map_err(|e| e.to_string())?.map_or(false, |(s, _)| s == "up") };
            if done {
                continue;
            }
            match upload(remote, key, kind, &id, &ext, &path, &mut budget, opts.chunk) {
                Ok(Outcome::Done(n)) => {
                    let c = db.lock().map_err(|e| e.to_string())?;
                    mark(&c, kind, &id, "up", opts.now).map_err(|e| e.to_string())?;
                    spend(&c, opts.now, "up", n).map_err(|e| e.to_string())?;
                    rep.uploaded += 1;
                    rep.bytes_up += n;
                }
                Ok(Outcome::AlreadyThere) => {
                    mark(&*db.lock().map_err(|e| e.to_string())?, kind, &id, "up", opts.now).map_err(|e| e.to_string())?;
                }
                Ok(Outcome::NoBudget) => rep.deferred += 1,
                Ok(Outcome::NotThere) => {}
                Err(e) => {
                    // a failed one does not stop the others; it is tried again next round
                    rep.errors.push(format!("上传 {id} 失败：{e}"));
                }
            }
        }
        // 2. coming down: pictures the notes use that this device does not have
        for id in &pics {
            let dest = image_path(dir, id);
            if dest.exists() {
                continue;
            }
            let retry_after = { marked(&*db.lock().map_err(|e| e.to_string())?, "image", id).map_err(|e| e.to_string())? };
            if let Some((s, at)) = &retry_after {
                if s == "miss" && opts.now - at < HOUR {
                    continue; // asked recently and it was not there yet
                }
            }
            match download(remote, key, "image", id, &dest, &mut budget) {
                Ok(Outcome::Done(n)) => {
                    let c = db.lock().map_err(|e| e.to_string())?;
                    mark(&c, "image", id, "up", opts.now).map_err(|e| e.to_string())?;
                    spend(&c, opts.now, "down", n).map_err(|e| e.to_string())?;
                    rep.downloaded += 1;
                    rep.bytes_down += n;
                }
                Ok(Outcome::NotThere) => mark(&*db.lock().map_err(|e| e.to_string())?, "image", id, "miss", opts.now).map_err(|e| e.to_string())?,
                Ok(Outcome::NoBudget) => rep.deferred += 1,
                Ok(Outcome::AlreadyThere) => {}
                Err(e) => rep.errors.push(format!("下载图片 {id} 失败：{e}")),
            }
        }
        Ok(())
    })();
    if let Err(e) = go {
        rep.errors.push(e);
    }
    rep
}

/// Bring one book down on request. Returns its size in bytes.
pub fn download_book(db: &Mutex<Connection>, remote: &dyn Remote, key: &DataKey, dir: &Path, id: &str, ext: &str, limits: Limits, now: i64) -> Result<Outcome, String> {
    if !valid_book_id(id) || !["epub", "pdf", "txt", "md", "markdown", "html", "htm"].contains(&ext) {
        return Err("不是有效的书".into());
    }
    let mut budget = {
        let c = db.lock().map_err(|e| e.to_string())?;
        Budget::for_now(&c, now, limits).map_err(|e| e.to_string())?
    };
    let r = download(remote, key, "book", id, &book_path(dir, id, ext), &mut budget)?;
    if let Outcome::Done(n) = r {
        let c = db.lock().map_err(|e| e.to_string())?;
        spend(&c, now, "down", n).map_err(|e| e.to_string())?;
    }
    Ok(r)
}

/// Which of these books have their file on this device.
pub fn books_present(dir: &Path, books: &[(String, String)]) -> Vec<String> {
    books.iter().filter(|(id, ext)| valid_book_id(id) && book_path(dir, id, ext).exists()).map(|(id, _)| id.clone()).collect()
}

#[tauri::command]
pub fn files_present(app: tauri::AppHandle, books: Vec<(String, String)>) -> Result<Vec<String>, String> {
    use tauri::Manager;
    let _ = app.state::<Db>();
    Ok(books_present(&crate::app_dir(&app)?, &books))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::KdfParams;
    use crate::remote::Memory;

    fn db() -> Mutex<Connection> {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::notes::SCHEMA).unwrap();
        Mutex::new(conn)
    }
    fn key() -> DataKey {
        crypto::create_keys("pw", KdfParams { mem_kib: 8, iters: 1, lanes: 1 }).unwrap().1
    }
    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("marginalia-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("images")).unwrap();
        fs::create_dir_all(d.join("books")).unwrap();
        d
    }
    /// A picture's id is the start of the SHA-256 of its bytes.
    fn image(d: &Path, bytes: &[u8]) -> String {
        let id = format!("{}.png", &hex::encode(Sha256::digest(bytes))[..16]);
        fs::write(d.join("images").join(&id), bytes).unwrap();
        id
    }
    fn book(d: &Path, bytes: &[u8], ext: &str) -> String {
        let id = hex::encode(Sha256::digest(bytes));
        fs::write(d.join("books").join(format!("{id}.{ext}")), bytes).unwrap();
        id
    }
    fn note_with(c: &Mutex<Connection>, id: &str, images: &[&str]) {
        c.lock().unwrap().execute("INSERT INTO notes(id, book_id, anchor, color, style, images, created_at, updated_at) VALUES(?1, '_memo', '{}', 'amber', 'none', ?2, 1, 1)", params![id, images.join(",")]).unwrap();
    }
    fn shelf(c: &Mutex<Connection>, id: &str, ext: &str, cloud: bool) {
        c.lock().unwrap().execute("INSERT INTO books(id, data, updated_at) VALUES(?1, ?2, 1)", params![id, serde_json::json!({"id": id, "ext": ext, "title": "书", "cloud": cloud}).to_string()]).unwrap();
    }
    fn opts(now: i64) -> Options {
        Options { now, limits: Limits { up: 10_000_000, down: 10_000_000 }, chunk: 1024 }
    }
    fn bytes(n: usize, seed: u8) -> Vec<u8> {
        (0..n).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
    }

    #[test]
    fn a_picture_goes_up_from_one_device_and_comes_down_on_another() {
        let (remote, k) = (Memory::new(), key());
        let (a, b) = (db(), db());
        let (da, dbb) = (dir("a1"), dir("b1"));
        let id = image(&da, &bytes(5000, 1));
        note_with(&a, "n1", &[&id]);
        note_with(&b, "n1", &[&id]);
        let r = sync_files(&a, &remote, &k, &da, &opts(1000));
        assert_eq!((r.uploaded, r.errors.len()), (1, 0), "{r:?}");
        let r = sync_files(&b, &remote, &k, &dbb, &opts(2000));
        assert_eq!((r.downloaded, r.errors.len()), (1, 0), "{r:?}");
        assert_eq!(fs::read(dbb.join("images").join(&id)).unwrap(), bytes(5000, 1));
        assert!(!fs::read_dir(dbb.join("images")).unwrap().flatten().any(|e| e.file_name().to_string_lossy().ends_with(".part")), "no temporary file left");
        // nothing is sent or fetched twice
        let (puts, gets, _) = remote.counts();
        let r = sync_files(&a, &remote, &k, &da, &opts(3000));
        let r2 = sync_files(&b, &remote, &k, &dbb, &opts(3000));
        assert_eq!((r.uploaded, r2.downloaded), (0, 0));
        assert_eq!(remote.counts(), (puts, gets, remote.counts().2), "not one request");
        let _ = (fs::remove_dir_all(&da), fs::remove_dir_all(&dbb));
    }

    #[test]
    fn a_big_file_is_cut_into_parts_and_an_upload_cut_short_carries_on_where_it_stopped() {
        let (remote, k) = (Memory::new(), key());
        let (a, d) = (db(), dir("a2"));
        let data = bytes(10_000, 7); // 10 parts of 1 KiB
        let id = book(&d, &data, "pdf");
        shelf(&a, &id, "pdf", true);
        remote.fail_puts_after(Some(remote.counts().0 + 4)); // the connection drops after four parts
        let r = sync_files(&a, &remote, &k, &d, &opts(1000));
        assert_eq!(r.uploaded, 0);
        assert_eq!(r.errors.len(), 1);
        let parts = remote.paths().iter().filter(|p| p.ends_with(".bin") && !p.ends_with("meta.bin")).count();
        assert_eq!(parts, 4);
        assert!(!remote.paths().iter().any(|p| p.ends_with("meta.bin")), "an unfinished file is not announced");
        remote.fail_puts_after(None);
        let before = remote.counts().0;
        let r = sync_files(&a, &remote, &k, &d, &opts(2000));
        assert_eq!((r.uploaded, r.errors.len()), (1, 0), "{r:?}");
        assert_eq!(remote.counts().0 - before, 6 + 1, "only the missing six parts and the meta file");
        // and another device gets exactly the bytes
        let (b, db2) = (db(), dir("b2"));
        let r = download_book(&b, &remote, &k, &db2, &id, "pdf", Limits { up: 1 << 30, down: 1 << 30 }, 3000).unwrap();
        assert!(matches!(r, Outcome::Done(_)));
        assert_eq!(fs::read(db2.join("books").join(format!("{id}.pdf"))).unwrap(), data);
        let _ = (fs::remove_dir_all(&d), fs::remove_dir_all(&db2));
    }

    #[test]
    fn a_book_goes_up_only_when_marked_and_never_comes_down_by_itself() {
        let (remote, k) = (Memory::new(), key());
        let (a, b) = (db(), db());
        let (da, dbb) = (dir("a3"), dir("b3"));
        let marked_id = book(&da, &bytes(3000, 1), "epub");
        let other = book(&da, &bytes(3000, 2), "epub");
        shelf(&a, &marked_id, "epub", true);
        shelf(&a, &other, "epub", false);
        let r = sync_files(&a, &remote, &k, &da, &opts(1000));
        assert_eq!(r.uploaded, 1, "only the marked one");
        shelf(&b, &marked_id, "epub", true);
        let r = sync_files(&b, &remote, &k, &dbb, &opts(2000));
        assert_eq!(r.downloaded, 0, "books are fetched on request");
        assert!(!dbb.join("books").join(format!("{marked_id}.epub")).exists());
        // asked for: it comes
        download_book(&b, &remote, &k, &dbb, &marked_id, "epub", Limits::default(), 3000).unwrap();
        assert!(dbb.join("books").join(format!("{marked_id}.epub")).exists());
        // one that was never put up is simply not there
        assert_eq!(download_book(&b, &remote, &k, &dbb, &other, "epub", Limits::default(), 3000).unwrap(), Outcome::NotThere);
        assert!(download_book(&b, &remote, &k, &dbb, "../x", "epub", Limits::default(), 3000).is_err());
        let _ = (fs::remove_dir_all(&da), fs::remove_dir_all(&dbb));
    }

    #[test]
    fn the_monthly_budget_holds_big_things_back_smallest_first_and_starts_over_next_month() {
        let (remote, k) = (Memory::new(), key());
        let (a, d) = (db(), dir("a4"));
        let small = image(&d, &bytes(2000, 1));
        let medium = image(&d, &bytes(5000, 2));
        let large = image(&d, &bytes(7000, 3));
        note_with(&a, "n1", &[&small, &medium, &large]);
        let jan = 1_767_225_600_000i64; // 2026-01-01
        let o = Options { now: jan, limits: Limits { up: 8000, down: 8000 }, chunk: 1024 };
        let r = sync_files(&a, &remote, &k, &d, &o);
        assert_eq!((r.uploaded, r.deferred), (2, 1), "{r:?}");
        let (up, _) = used(&a.lock().unwrap(), jan).unwrap();
        assert!(up >= 7000 && up < 8000, "{up}");
        // later the same month: nothing more fits
        let r = sync_files(&a, &remote, &k, &d, &Options { now: jan + DAY, ..o_clone(&o) });
        assert_eq!(r.uploaded, 0);
        // next month the counters are fresh and the rest goes up
        let feb = jan + 40 * DAY;
        let r = sync_files(&a, &remote, &k, &d, &Options { now: feb, ..o_clone(&o) });
        assert_eq!(r.uploaded, 1, "{r:?}");
        assert_eq!(used(&a.lock().unwrap(), feb).unwrap().0 > 0, true);
        let _ = fs::remove_dir_all(&d);
    }
    const DAY: i64 = 86_400_000;
    fn o_clone(o: &Options) -> Options {
        Options { now: o.now, limits: o.limits, chunk: o.chunk }
    }

    #[test]
    fn a_damaged_part_or_the_wrong_file_is_refused_and_nothing_is_left_behind() {
        let (remote, k) = (Memory::new(), key());
        let (a, d) = (db(), dir("a5"));
        let id = image(&d, &bytes(3000, 9));
        note_with(&a, "n1", &[&id]);
        sync_files(&a, &remote, &k, &d, &opts(1000));
        let part = remote.paths().into_iter().find(|p| p.ends_with("000001.bin")).unwrap();
        remote.corrupt(&part);
        let (b, db2) = (db(), dir("b5"));
        note_with(&b, "n1", &[&id]);
        let r = sync_files(&b, &remote, &k, &db2, &opts(2000));
        assert_eq!((r.downloaded, r.errors.len()), (0, 1), "{r:?}");
        assert!(!db2.join("images").join(&id).exists());
        assert!(fs::read_dir(db2.join("images")).unwrap().flatten().count() == 0, "no .part left");
        // a file that is whole and sealed properly but is not the one its name says
        let mut budget = Budget { up_left: 1 << 30, down_left: 1 << 30 };
        let liar = format!("{}.png", &hex::encode(Sha256::digest(b"something else"))[..16]);
        let src = d.join("liar.bin");
        fs::write(&src, bytes(500, 5)).unwrap();
        upload(&remote, &k, "image", &liar, "", &src, &mut budget, 1024).unwrap();
        let dest = db2.join("images").join(&liar);
        assert!(download(&remote, &k, "image", &liar, &dest, &mut budget).unwrap_err().contains("校验"));
        assert!(!dest.exists());
        let _ = (fs::remove_dir_all(&d), fs::remove_dir_all(&db2));
    }

    #[test]
    fn a_picture_that_is_not_in_the_cloud_yet_is_not_asked_for_every_round() {
        let (remote, k) = (Memory::new(), key());
        let (b, d) = (db(), dir("b6"));
        note_with(&b, "n1", &["0123456789abcdef.png"]);
        sync_files(&b, &remote, &k, &d, &opts(1000));
        let gets = remote.counts().1;
        sync_files(&b, &remote, &k, &d, &opts(1000 + 60_000));
        assert_eq!(remote.counts().1, gets, "asked again within the hour");
        sync_files(&b, &remote, &k, &d, &opts(1000 + 2 * HOUR));
        assert!(remote.counts().1 > gets, "but asked again later");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn a_file_that_is_already_in_the_cloud_is_not_sent_again_and_the_cloud_shows_nothing_readable() {
        let (remote, k) = (Memory::new(), key());
        let (a, b) = (db(), db());
        let (da, dbb) = (dir("a7"), dir("b7"));
        let data = bytes(2500, 4);
        let id = image(&da, &data);
        image(&dbb, &data); // the same picture is on the other device too
        note_with(&a, "n1", &[&id]);
        note_with(&b, "n1", &[&id]);
        sync_files(&a, &remote, &k, &da, &opts(1000));
        let puts = remote.counts().0;
        let r = sync_files(&b, &remote, &k, &dbb, &opts(2000));
        assert_eq!(r.uploaded, 0);
        assert_eq!(remote.counts().0, puts, "the cloud already had it");
        for p in remote.paths() {
            assert!(!p.contains(&id) && !p.contains(&id[..16]), "{p} shows the picture's hash");
            let bytes = remote.get(&p).unwrap().unwrap();
            assert_eq!(&bytes[..4], b"MGC1");
            assert!(!bytes.windows(8).any(|w| w == &data[..8]), "{p} holds the bytes in clear");
        }
        let _ = (fs::remove_dir_all(&da), fs::remove_dir_all(&dbb));
    }

    #[test]
    fn which_books_are_on_this_device() {
        let d = dir("present");
        let id = book(&d, b"x", "txt");
        let list = vec![(id.clone(), "txt".to_string()), ("abcdef".to_string(), "pdf".to_string()), ("../zz".to_string(), "pdf".to_string())];
        assert_eq!(books_present(&d, &list), vec![id]);
        let _ = fs::remove_dir_all(&d);
    }
}
