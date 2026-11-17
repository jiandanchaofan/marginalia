//! Cloud sync as the app uses it: set up the connection, remember it, and run a round now and then.
//!
//! The server address, the account and a few flags are kept in the database (`meta`); the two secrets (the application password
//! of the cloud account and the data key, so the sync password need not be typed again) go to the system's credential store,
//! never into the database or a settings file. The first round on a device is preceded by a full copy of the database.

use crate::crypto::{DataKey, KdfParams};
use crate::notes::Db;
use crate::remote::{Remote, WebDav};
use crate::syncer::{self, Options, SyncError, SyncReport};
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
pub const DEFAULT_URL: &str = "https://dav.jianguoyun.com/dav/";
pub const DEFAULT_ROOT: &str = "我的坚果云/墨边";

// ---------------------------------------------------------------- secrets

pub trait Secrets: Send + Sync {
    fn get(&self, name: &str) -> Option<String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str);
}

/// The system credential store (Windows Credential Manager, macOS Keychain).
pub struct SystemSecrets;
#[cfg(any(windows, target_os = "macos"))]
impl Secrets for SystemSecrets {
    fn get(&self, name: &str) -> Option<String> {
        keyring::Entry::new("com.shengmin.reader.sync", name).ok()?.get_password().ok()
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        keyring::Entry::new("com.shengmin.reader.sync", name).and_then(|e| e.set_password(value)).map_err(|e| format!("不能保存到系统凭据库：{e}"))
    }
    fn delete(&self, name: &str) {
        if let Ok(e) = keyring::Entry::new("com.shengmin.reader.sync", name) {
            let _ = e.delete_credential();
        }
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
impl Secrets for SystemSecrets {
    fn get(&self, _: &str) -> Option<String> {
        None
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err("这个平台还不能安全地保存同步密码".into())
    }
    fn delete(&self, _: &str) {}
}

/// In memory, for tests.
#[derive(Default)]
pub struct MemSecrets(Mutex<HashMap<String, String>>);
impl Secrets for MemSecrets {
    fn get(&self, name: &str) -> Option<String> {
        self.0.lock().unwrap().get(name).cloned()
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(name.into(), value.into());
        Ok(())
    }
    fn delete(&self, name: &str) {
        self.0.lock().unwrap().remove(name);
    }
}

// ---------------------------------------------------------------- what is remembered

fn conf_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [format!("syncconf:{key}")], |r| r.get(0)).optional().ok().flatten()
}
fn conf_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![format!("syncconf:{key}"), value])?;
    Ok(())
}
fn conf_del(conn: &Connection, key: &str) {
    let _ = conn.execute("DELETE FROM meta WHERE key = ?1", [format!("syncconf:{key}")]);
}

/// What the settings page shows.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Set up and switched on.
    pub connected: bool,
    pub url: String,
    pub root: String,
    pub user: String,
    pub device_name: String,
    pub device_id: String,
    /// When the last round went through (ms), 0 = never.
    pub last_ok_at: i64,
    pub last_error: String,
    pub running: bool,
    pub last: Option<ReportView>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReportView {
    pub pulled: usize,
    pub applied: usize,
    pub removed: usize,
    pub conflicts: usize,
    pub pushed_files: usize,
    pub pushed_items: usize,
    pub from_snapshot: bool,
    pub problems: Vec<String>,
}
impl From<&SyncReport> for ReportView {
    fn from(r: &SyncReport) -> Self {
        ReportView { pulled: r.pulled, applied: r.merged.applied, removed: r.merged.removed, conflicts: r.merged.conflicts, pushed_files: r.pushed_files, pushed_items: r.pushed_items, from_snapshot: r.from_snapshot, problems: r.problems.clone() }
    }
}

pub fn status(conn: &Connection, running: bool, last: Option<ReportView>) -> Status {
    Status {
        connected: conf_get(conn, "enabled").as_deref() == Some("1"),
        url: conf_get(conn, "url").unwrap_or_else(|| DEFAULT_URL.into()),
        root: conf_get(conn, "root").unwrap_or_else(|| DEFAULT_ROOT.into()),
        user: conf_get(conn, "user").unwrap_or_default(),
        device_name: conf_get(conn, "name").unwrap_or_default(),
        device_id: crate::sync::device_id(conn).unwrap_or_default(),
        last_ok_at: conf_get(conn, "last_ok_at").and_then(|v| v.parse().ok()).unwrap_or(0),
        last_error: conf_get(conn, "last_error").unwrap_or_default(),
        running,
        last,
    }
}

// ---------------------------------------------------------------- connecting

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Connect {
    pub url: String,
    pub root: String,
    pub user: String,
    /// The application password of the cloud account.
    pub password: String,
    pub sync_password: String,
    /// "create" a new library in this folder, or "join" the one that is there.
    pub mode: String,
    /// Join with the recovery key instead of the sync password.
    #[serde(default)]
    pub recovery: Option<String>,
    pub device_name: String,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Build the connection to the cloud folder from what was typed / what is remembered.
pub type MakeRemote<'a> = &'a dyn Fn(&str, &str, &str, &str) -> Result<Box<dyn Remote>, String>;

pub fn web_dav() -> impl Fn(&str, &str, &str, &str) -> Result<Box<dyn Remote>, String> {
    |url, root, user, pw| WebDav::new(url, root, user, pw).map(|w| Box::new(w) as Box<dyn Remote>).map_err(|e| e.to_string())
}

/// Set the connection up. Returns the recovery key when a new library was made (to be shown once).
pub fn connect(db: &Mutex<Connection>, secrets: &dyn Secrets, make: MakeRemote, c: &Connect, kdf: KdfParams) -> Result<Option<String>, String> {
    let remote = make(&c.url, &c.root, &c.user, &c.password)?;
    // reachable, and the account and password are right
    remote.list("").map_err(|e| e.to_string())?;
    let (key, recovery) = match c.mode.as_str() {
        "create" => {
            let (k, r) = syncer::create_library(remote.as_ref(), &c.sync_password, kdf, now_ms()).map_err(|e| e.to_string())?;
            (k, Some(r))
        }
        _ => {
            let k = match c.recovery.as_deref().filter(|r| !r.trim().is_empty()) {
                Some(r) => syncer::open_library_with_recovery(remote.as_ref(), r),
                None => syncer::open_library(remote.as_ref(), &c.sync_password),
            }
            .map_err(|e| e.to_string())?;
            (k, None)
        }
    };
    secrets.set("webdav_password", &c.password)?;
    secrets.set("data_key", &B64.encode(key.as_bytes()))?;
    let conn = db.lock().map_err(|e| e.to_string())?;
    let name = if c.device_name.trim().is_empty() { "这台设备".to_string() } else { c.device_name.trim().to_string() };
    for (k, v) in [("url", c.url.as_str()), ("root", c.root.as_str()), ("user", c.user.as_str()), ("name", name.as_str()), ("enabled", "1")] {
        conf_set(&conn, k, v).map_err(|e| e.to_string())?;
    }
    conf_del(&conn, "last_error");
    Ok(recovery)
}

/// Stop syncing on this device: forget the account and the keys. Nothing in the app or in the cloud is deleted.
pub fn disconnect(db: &Mutex<Connection>, secrets: &dyn Secrets) -> Result<(), String> {
    secrets.delete("webdav_password");
    secrets.delete("data_key");
    let conn = db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM meta WHERE key LIKE 'syncconf:%' OR key LIKE 'sync:%'", []).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM sync_known", []).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- a round

/// A full copy of the database before the very first round, so that anything unexpected can be undone.
fn backup_before_first_sync(conn: &Connection, dir: &Path) -> Result<(), String> {
    if conf_get(conn, "backed_up").is_some() {
        return Ok(());
    }
    let backups = dir.join("backups");
    std::fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let copy = backups.join(format!("before-first-sync-{}.db", now_ms()));
    conn.execute("VACUUM INTO ?1", [copy.to_string_lossy().as_ref()]).map_err(|e| format!("同步前备份失败：{e}"))?;
    conf_set(conn, "backed_up", &copy.to_string_lossy()).map_err(|e| e.to_string())
}

/// One round with what is remembered. The result (or the error) is also remembered, for the status.
pub fn run(db: &Mutex<Connection>, secrets: &dyn Secrets, make: MakeRemote, dir: &Path, now: i64) -> Result<SyncReport, String> {
    let (url, root, user, name, device, enabled) = {
        let c = db.lock().map_err(|e| e.to_string())?;
        (conf_get(&c, "url").unwrap_or_default(), conf_get(&c, "root").unwrap_or_default(), conf_get(&c, "user").unwrap_or_default(), conf_get(&c, "name").unwrap_or_default(), crate::sync::device_id(&c).map_err(|e| e.to_string())?, conf_get(&c, "enabled").as_deref() == Some("1"))
    };
    if !enabled {
        return Err("同步还没有开启".into());
    }
    let result = (|| -> Result<SyncReport, String> {
        let pw = secrets.get("webdav_password").ok_or("找不到保存的应用密码，请重新连接")?;
        let key_b64 = secrets.get("data_key").ok_or("找不到保存的同步密钥，请重新连接")?;
        let key = DataKey::from_bytes(&B64.decode(key_b64).map_err(|_| "保存的同步密钥已损坏，请重新连接".to_string())?).ok_or("保存的同步密钥已损坏，请重新连接")?;
        let remote = make(&url, &root, &user, &pw)?;
        {
            let c = db.lock().map_err(|e| e.to_string())?;
            backup_before_first_sync(&c, dir)?;
        }
        let mut report = syncer::sync_once(db, remote.as_ref(), &key, &device, &name, &Options::normal(now)).map_err(|e: SyncError| e.to_string())?;
        // pictures and marked books; a failure here is reported but never undoes the round
        let files = crate::filesync::sync_files(db, remote.as_ref(), &key, dir, &crate::filesync::Options::normal(now));
        report.problems.extend(files.errors);
        Ok(report)
    })();
    let c = db.lock().map_err(|e| e.to_string())?;
    match &result {
        Ok(r) => {
            let _ = conf_set(&c, "last_ok_at", &now.to_string());
            if r.problems.is_empty() {
                conf_del(&c, "last_error");
            } else {
                let _ = conf_set(&c, "last_error", &r.problems.join("；"));
            }
        }
        Err(e) => {
            let _ = conf_set(&c, "last_error", e);
        }
    }
    result
}

// ---------------------------------------------------------------- the app

/// What the sync commands share.
pub struct App {
    pub running: AtomicBool,
    pub last: Mutex<Option<ReportView>>,
    pub secrets: Box<dyn Secrets>,
}
impl App {
    pub fn new() -> App {
        App { running: AtomicBool::new(false), last: Mutex::new(None), secrets: Box::new(SystemSecrets) }
    }
}

fn snapshot(app: &AppHandle) -> Status {
    let st = app.state::<App>();
    let db = app.state::<Db>();
    let last = st.last.lock().ok().and_then(|l| l.clone());
    match db.0.lock() {
        Ok(c) => status(&c, st.running.load(Ordering::SeqCst), last),
        Err(_) => Status::default(),
    }
}

fn announce(app: &AppHandle) {
    let _ = app.emit("sync-status", snapshot(app));
}

/// A round, off the interface thread. Does nothing if one is already running.
pub fn run_in_background(app: AppHandle) -> bool {
    let st = app.state::<App>();
    if st.running.swap(true, Ordering::SeqCst) {
        return false;
    }
    announce(&app);
    std::thread::spawn(move || {
        let dir = crate::app_dir(&app).unwrap_or_default();
        let make = web_dav();
        let res = {
            let db = app.state::<Db>();
            let st = app.state::<App>();
            run(&db.0, st.secrets.as_ref(), &make, &dir, now_ms())
        };
        let st = app.state::<App>();
        if let Ok(r) = &res {
            if let Ok(mut l) = st.last.lock() {
                *l = Some(ReportView::from(r));
            }
        }
        st.running.store(false, Ordering::SeqCst);
        announce(&app);
        let _ = app.emit("sync-done", res.is_ok());
    });
    true
}

/// Every few minutes while the app runs, if sync is on.
pub fn start_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(25));
        loop {
            let due = {
                let db = app.state::<Db>();
                match db.0.lock() {
                    Ok(c) => conf_get(&c, "enabled").as_deref() == Some("1"),
                    Err(_) => false,
                }
            };
            if due {
                run_in_background(app.clone());
            }
            std::thread::sleep(std::time::Duration::from_secs(5 * 60));
        }
    });
}

/// Fetch one book's file from the cloud (when the user asks). Returns "done", "none" (it was never uploaded) or "budget".
pub fn fetch_book(db: &Mutex<Connection>, secrets: &dyn Secrets, make: MakeRemote, dir: &Path, id: &str, ext: &str, now: i64) -> Result<String, String> {
    let (url, root, user) = {
        let c = db.lock().map_err(|e| e.to_string())?;
        (conf_get(&c, "url").unwrap_or_default(), conf_get(&c, "root").unwrap_or_default(), conf_get(&c, "user").unwrap_or_default())
    };
    let pw = secrets.get("webdav_password").ok_or("找不到保存的应用密码，请重新连接")?;
    let key_b64 = secrets.get("data_key").ok_or("找不到保存的同步密钥，请重新连接")?;
    let key = DataKey::from_bytes(&B64.decode(key_b64).map_err(|_| "保存的同步密钥已损坏，请重新连接".to_string())?).ok_or("保存的同步密钥已损坏，请重新连接")?;
    let remote = make(&url, &root, &user, &pw)?;
    use crate::filesync::{download_book, Limits, Outcome};
    Ok(match download_book(db, remote.as_ref(), &key, dir, id, ext, Limits::default(), now)? {
        Outcome::Done(_) | Outcome::AlreadyThere => "done",
        Outcome::NotThere => "none",
        Outcome::NoBudget => "budget",
    }
    .to_string())
}

#[tauri::command]
pub async fn sync_download_book(app: AppHandle, id: String, ext: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = crate::app_dir(&app)?;
        let db = app.state::<Db>();
        let st = app.state::<App>();
        fetch_book(&db.0, st.secrets.as_ref(), &web_dav(), &dir, &id, &ext, now_ms())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// This month's traffic (bytes up, bytes down) and what the month allows.
#[tauri::command]
pub fn sync_quota(app: AppHandle) -> Result<(i64, i64, i64, i64), String> {
    let db = app.state::<Db>();
    let c = db.0.lock().map_err(|e| e.to_string())?;
    let (u, d) = crate::filesync::used(&c, now_ms()).map_err(|e| e.to_string())?;
    let l = crate::filesync::Limits::default();
    Ok((u, d, l.up, l.down))
}

#[tauri::command]
pub fn sync_status(app: AppHandle) -> Status {
    snapshot(&app)
}

#[tauri::command]
pub async fn sync_connect(app: AppHandle, params: Connect) -> Result<Option<String>, String> {
    let res = tauri::async_runtime::spawn_blocking(move || {
        let db = app.state::<Db>();
        let st = app.state::<App>();
        let make = web_dav();
        let r = connect(&db.0, st.secrets.as_ref(), &make, &params, KdfParams::default());
        announce(&app);
        r
    })
    .await
    .map_err(|e| e.to_string())?;
    res
}

#[tauri::command]
pub fn sync_now(app: AppHandle) -> bool {
    run_in_background(app)
}

#[tauri::command]
pub fn sync_disconnect(app: AppHandle) -> Result<(), String> {
    let db = app.state::<Db>();
    let st = app.state::<App>();
    disconnect(&db.0, st.secrets.as_ref())?;
    if let Ok(mut l) = st.last.lock() {
        *l = None;
    }
    announce(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::Memory;

    const FAST: KdfParams = KdfParams { mem_kib: 8, iters: 1, lanes: 1 };

    fn db() -> Mutex<Connection> {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::notes::SCHEMA).unwrap();
        Mutex::new(conn)
    }
    fn params(mode: &str, sync_password: &str) -> Connect {
        Connect { url: DEFAULT_URL.into(), root: DEFAULT_ROOT.into(), user: "me@example.com".into(), password: "app-password".into(), sync_password: sync_password.into(), mode: mode.into(), recovery: None, device_name: "我的电脑".into() }
    }
    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("marginalia-syncapp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn put_note(db: &Mutex<Connection>, id: &str, text: &str, at: i64) {
        let n: crate::notes::Note = serde_json::from_value(serde_json::json!({
            "id": id, "anchor": {"section": 0, "start": 0, "end": 0, "exact": ""}, "color": "amber", "style": "none", "note": text, "kind": "free", "createdAt": 1, "updatedAt": at
        }))
        .unwrap();
        crate::notes::upsert(&db.lock().unwrap(), "_memo", &n).unwrap();
    }

    #[test]
    fn connecting_creates_a_library_remembers_the_account_and_keeps_secrets_out_of_the_database() {
        let (d, secrets, mem) = (db(), MemSecrets::default(), Memory::new());
        let m = mem.clone();
        let make = move |_: &str, _: &str, _: &str, _: &str| -> Result<Box<dyn Remote>, String> { Ok(Box::new(m.clone())) };
        let recovery = connect(&d, &secrets, &make, &params("create", "a long sync password"), FAST).unwrap().unwrap();
        assert_eq!(recovery.len(), 64);
        let st = status(&d.lock().unwrap(), false, None);
        assert!(st.connected);
        assert_eq!((st.user.as_str(), st.device_name.as_str(), st.root.as_str()), ("me@example.com", "我的电脑", DEFAULT_ROOT));
        assert!(secrets.get("webdav_password").is_some() && secrets.get("data_key").is_some());
        // nothing secret in the database
        let all: String = {
            let c = d.lock().unwrap();
            let mut st = c.prepare("SELECT key || '=' || value FROM meta").unwrap();
            st.query_map([], |r| r.get::<_, String>(0)).unwrap().filter_map(Result::ok).collect::<Vec<_>>().join("\n")
        };
        assert!(!all.contains("app-password") && !all.contains("a long sync password"), "{all}");
        assert!(mem.paths().contains(&"keys.json".to_string()));
    }

    #[test]
    fn joining_needs_the_right_password_and_a_library_that_exists() {
        let mem = Memory::new();
        let m = mem.clone();
        let make = move |_: &str, _: &str, _: &str, _: &str| -> Result<Box<dyn Remote>, String> { Ok(Box::new(m.clone())) };
        let (d1, d2, d3) = (db(), db(), db());
        let secrets = MemSecrets::default();
        assert!(connect(&d1, &secrets, &make, &params("join", "x"), FAST).unwrap_err().contains("还没有墨边的数据"));
        let recovery = connect(&d1, &secrets, &make, &params("create", "right"), FAST).unwrap().unwrap();
        let s2 = MemSecrets::default();
        assert!(connect(&d2, &s2, &make, &params("join", "wrong"), FAST).unwrap_err().contains("同步密码不对"));
        assert!(!status(&d2.lock().unwrap(), false, None).connected, "a failed attempt leaves nothing behind");
        assert!(s2.get("data_key").is_none());
        assert!(connect(&d2, &s2, &make, &params("join", "right"), FAST).unwrap().is_none());
        // with the recovery key instead of the password
        let s3 = MemSecrets::default();
        let mut p = params("join", "");
        p.recovery = Some(recovery);
        assert!(connect(&d3, &s3, &make, &p, FAST).is_ok());
        assert_eq!(s2.get("data_key"), secrets.get("data_key"));
    }

    #[test]
    fn a_wrong_account_stops_before_anything_is_stored() {
        let (d, secrets) = (db(), MemSecrets::default());
        let make = |_: &str, _: &str, _: &str, _: &str| -> Result<Box<dyn Remote>, String> { Err("地址不对".into()) };
        assert_eq!(connect(&d, &secrets, &make, &params("create", "x"), FAST).unwrap_err(), "地址不对");
        assert!(secrets.get("webdav_password").is_none());
        assert!(!status(&d.lock().unwrap(), false, None).connected);
    }

    #[test]
    fn two_devices_set_up_through_the_app_layer_sync_each_other() {
        let mem = Memory::new();
        let (m1, m2) = (mem.clone(), mem.clone());
        let make1 = move |_: &str, _: &str, _: &str, _: &str| -> Result<Box<dyn Remote>, String> { Ok(Box::new(m1.clone())) };
        let make2 = move |_: &str, _: &str, _: &str, _: &str| -> Result<Box<dyn Remote>, String> { Ok(Box::new(m2.clone())) };
        let (a, b) = (db(), db());
        let (sa, sb) = (MemSecrets::default(), MemSecrets::default());
        connect(&a, &sa, &make1, &params("create", "pw"), FAST).unwrap();
        connect(&b, &sb, &make2, &params("join", "pw"), FAST).unwrap();
        put_note(&a, "n1", "来自 A", 5_000);
        let (da, dbb) = (temp("a"), temp("b"));
        let r = run(&a, &sa, &make1, &da, 100_000).unwrap();
        assert_eq!(r.pushed_items, 1);
        let r = run(&b, &sb, &make2, &dbb, 200_000).unwrap();
        assert_eq!(r.merged.applied, 1);
        let text: String = b.lock().unwrap().query_row("SELECT note FROM notes WHERE id = 'n1'", [], |r| r.get(0)).unwrap();
        assert_eq!(text, "来自 A");
        // the status remembers the round
        let st = status(&b.lock().unwrap(), false, None);
        assert_eq!(st.last_ok_at, 200_000);
        assert_eq!(st.last_error, "");
        let _ = std::fs::remove_dir_all(&da);
        let _ = std::fs::remove_dir_all(&dbb);
    }

    #[test]
    fn the_first_round_makes_a_full_copy_first_and_only_the_first() {
        let mem = Memory::new();
        let m = mem.clone();
        let make = move |_: &str, _: &str, _: &str, _: &str| -> Result<Box<dyn Remote>, String> { Ok(Box::new(m.clone())) };
        let (a, s) = (db(), MemSecrets::default());
        connect(&a, &s, &make, &params("create", "pw"), FAST).unwrap();
        put_note(&a, "n1", "x", 5_000);
        let dir = temp("backup");
        run(&a, &s, &make, &dir, 100_000).unwrap();
        let copies = |d: &Path| std::fs::read_dir(d.join("backups")).unwrap().flatten().count();
        assert_eq!(copies(&dir), 1);
        let copy = std::fs::read_dir(dir.join("backups")).unwrap().flatten().next().unwrap().path();
        let c = Connection::open(&copy).unwrap();
        let n: i64 = c.query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "the copy holds the data as it was");
        run(&a, &s, &make, &dir, 200_000).unwrap();
        assert_eq!(copies(&dir), 1, "no second copy");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failing_round_is_remembered_and_a_missing_secret_says_so() {
        let mem = Memory::new();
        let m = mem.clone();
        let make = move |_: &str, _: &str, _: &str, _: &str| -> Result<Box<dyn Remote>, String> { Ok(Box::new(m.clone())) };
        let (a, s) = (db(), MemSecrets::default());
        connect(&a, &s, &make, &params("create", "pw"), FAST).unwrap();
        let dir = temp("fail");
        s.delete("data_key");
        let err = run(&a, &s, &make, &dir, 1000).unwrap_err();
        assert!(err.contains("找不到保存的同步密钥"));
        assert!(status(&a.lock().unwrap(), false, None).last_error.contains("同步密钥"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_runs_when_sync_is_off_and_disconnecting_forgets_everything_but_the_data() {
        let mem = Memory::new();
        let m = mem.clone();
        let make = move |_: &str, _: &str, _: &str, _: &str| -> Result<Box<dyn Remote>, String> { Ok(Box::new(m.clone())) };
        let (a, s) = (db(), MemSecrets::default());
        assert_eq!(run(&a, &s, &make, &temp("off"), 1).unwrap_err(), "同步还没有开启");
        connect(&a, &s, &make, &params("create", "pw"), FAST).unwrap();
        put_note(&a, "n1", "x", 5_000);
        run(&a, &s, &make, &temp("on"), 100_000).unwrap();
        disconnect(&a, &s).unwrap();
        assert!(s.get("data_key").is_none() && s.get("webdav_password").is_none());
        let st = status(&a.lock().unwrap(), false, None);
        assert!(!st.connected);
        assert_eq!(st.last_ok_at, 0);
        let n: i64 = a.lock().unwrap().query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "the notes stay");
        assert!(run(&a, &s, &make, &temp("off2"), 2).is_err());
    }
    /// The single-device backup story: everything one device wrote comes back on an empty device that joins with the same password.
    #[test]
    fn an_empty_device_gets_everything_back_from_the_cloud() {
        let mem = Memory::new();
        let m = mem.clone();
        let make = move |_: &str, _: &str, _: &str, _: &str| -> Result<Box<dyn Remote>, String> { Ok(Box::new(m.clone())) };
        let (a, sa) = (db(), MemSecrets::default());
        connect(&a, &sa, &make, &params("create", "pw"), FAST).unwrap();
        put_note(&a, "n1", "第一条", 5_000);
        put_note(&a, "n2", "第二条", 5_100);
        {
            let c = a.lock().unwrap();
            c.execute("INSERT INTO goals(id, title, kind, created_at, updated_at) VALUES('g1', '读书', 'month', 1, 5000)", []).unwrap();
            c.execute("INSERT INTO tasks(id, title, created_at, updated_at) VALUES('t1', '待办', 1, 5000)", []).unwrap();
            c.execute("INSERT INTO task_goals(task_id, goal_id) VALUES('t1', 'g1')", []).unwrap();
            c.execute("INSERT INTO note_links(id, a, b, label, created_at, updated_at) VALUES('l1', 'n1', 'n2', '相关', 1, 5000)", []).unwrap();
            c.execute("INSERT INTO books(id, data, updated_at) VALUES('bk', '{\"id\":\"bk\",\"title\":\"书\",\"progress\":0.5,\"rating\":4}', 5000)", []).unwrap();
            c.execute("INSERT INTO review_items(note_id, level, due, updated_at) VALUES('n1', 3, '2026-12-01', 5000)", []).unwrap();
            c.execute("INSERT INTO tag_meta(tag, pinned, updated_at) VALUES('读书', 1, 5000)", []).unwrap();
            c.execute("INSERT INTO goal_snaps(day, goal_id, percent, updated_at) VALUES('2026-11-08', 'g1', 30, 5000)", []).unwrap();
            c.execute("INSERT INTO graph_pos(note_id, x, y, w, h, updated_at) VALUES('n1', 10, 20, 0, 0, 5000)", []).unwrap();
            crate::reading::add(&c, "2026-11-14", "bk", 600, 0.2).unwrap();
        }
        run(&a, &sa, &make, &temp("restore-a"), 100_000).unwrap();

        // a fresh install: empty database, no secrets, only the account and the sync password
        let (b, sb) = (db(), MemSecrets::default());
        connect(&b, &sb, &make, &params("join", "pw"), FAST).unwrap();
        run(&b, &sb, &make, &temp("restore-b"), 200_000).unwrap();

        let dump = |d: &Mutex<Connection>| -> Vec<String> {
            let c = d.lock().unwrap();
            let mut out = vec![];
            for sql in [
                "SELECT 'note', id || '|' || note || '|' || updated_at FROM notes",
                "SELECT 'goal', id || '|' || title || '|' || kind FROM goals",
                "SELECT 'task', id || '|' || title FROM tasks",
                "SELECT 'task_goal', task_id || '|' || goal_id FROM task_goals",
                "SELECT 'link', id || '|' || a || '|' || b || '|' || label FROM note_links",
                "SELECT 'book', id FROM books",
                "SELECT 'review', note_id || '|' || level || '|' || due FROM review_items",
                "SELECT 'pin', tag || '|' || pinned FROM tag_meta",
                "SELECT 'snap', day || '|' || goal_id || '|' || percent FROM goal_snaps",
                "SELECT 'pos', note_id || '|' || x || '|' || y FROM graph_pos",
                "SELECT 'read', day || '|' || book_id || '|' || sum(secs) FROM (SELECT day, book_id, secs FROM reading_days UNION ALL SELECT day, book_id, secs FROM reading_remote) GROUP BY day, book_id",
            ] {
                let mut st = c.prepare(sql).unwrap();
                out.extend(st.query_map([], |r| Ok(format!("{}:{}", r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap().filter_map(Result::ok));
            }
            // a book's description is JSON: compare what it says, not the order of its keys
            let mut st = c.prepare("SELECT data FROM books ORDER BY id").unwrap();
            let datas: Vec<serde_json::Value> = st.query_map([], |r| r.get::<_, String>(0)).unwrap().filter_map(Result::ok).map(|d| serde_json::from_str(&d).unwrap()).collect();
            out.push(format!("books:{}", serde_json::to_string(&datas).unwrap()));
            out.sort();
            out
        };
        let (da, db_) = (dump(&a), dump(&b));
        assert!(da.len() >= 12, "the source holds something of every kind: {da:?}");
        assert_eq!(da, db_, "the empty device ends up with the same data");
    }

    /// Against a real WebDAV account (nothing runs unless asked): back up on one device, restore on an empty one.
    ///   PowerShell:  $env:DAV_USER="..."; $env:DAV_PASS="<application password>"; $env:DAV_SYNC_PW="<any test password>"
    ///                cargo test --lib real_webdav_backup_and_restore -- --ignored --nocapture
    /// Writes only under a folder called `我的坚果云/墨边-测试-<time>`; delete it afterwards. The account is read from the environment only.
    #[test]
    #[ignore]
    fn real_webdav_backup_and_restore() {
        let (user, pass) = (std::env::var("DAV_USER").expect("DAV_USER"), std::env::var("DAV_PASS").expect("DAV_PASS"));
        let pw = std::env::var("DAV_SYNC_PW").unwrap_or_else(|_| "test-sync-password".into());
        let url = std::env::var("DAV_URL").unwrap_or_else(|_| DEFAULT_URL.into());
        let root = format!("我的坚果云/墨边-测试-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs());
        println!("folder: {root}");
        let make = web_dav();
        let mk = |mode: &str| Connect { url: url.clone(), root: root.clone(), user: user.clone(), password: pass.clone(), sync_password: pw.clone(), mode: mode.into(), recovery: None, device_name: "test".into() };
        let (a, sa) = (db(), MemSecrets::default());
        connect(&a, &sa, &make, &mk("create"), FAST).unwrap();
        for i in 0..20 {
            put_note(&a, &format!("n{i}"), &format!("第 {i} 条"), 5_000 + i);
        }
        let t = std::time::Instant::now();
        let r = run(&a, &sa, &make, &temp("real-a"), 100_000).unwrap();
        println!("device A synced in {:?}: {r:?}", t.elapsed());
        let (b, sb) = (db(), MemSecrets::default());
        connect(&b, &sb, &make, &mk("join"), FAST).unwrap();
        let t = std::time::Instant::now();
        run(&b, &sb, &make, &temp("real-b"), 200_000).unwrap();
        println!("empty device restored in {:?}", t.elapsed());
        let n: i64 = b.lock().unwrap().query_row("SELECT count(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 20, "all notes came back from the real server");
    }

}
