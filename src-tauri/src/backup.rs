//! Automatic backups of the notes (notes, tags, subscriptions, tag pins) in two independent forms:
//! - the database itself, one file per day, keeping the newest 3 (+ a mirror of the note pictures);
//! - a Markdown export (`notes.md` + `images/`), one folder per run, keeping the last 3.
//! Each goes to its own folder, which the user can change in Settings (`backup.json` in the app data dir).
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, path::PathBuf, time::Duration};
use tauri::{AppHandle, Manager};

const KEEP_DB: usize = 3;
const KEEP_MD: usize = 3;
const DB_PREFIX: &str = "reader-";
const DB_SUFFIX: &str = ".db";
const MD_PREFIX: &str = "marginalia-notes-";

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Folder for the database backups; empty / absent = `<data dir>/backups`.
    pub db_dir: Option<String>,
    /// Folder for the Markdown backups; empty / absent = `<data dir>/backups/markdown`.
    pub md_dir: Option<String>,
    /// The Markdown backup is opt-in (the app itself produces the text, see `backup_md_write`).
    pub md_enabled: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub config: Config,
    pub db_dir: String,
    pub md_dir: String,
    pub default_db_dir: String,
    pub default_md_dir: String,
    /// Day of the newest database backup (`YYYY-MM-DD`) and how many are kept.
    pub db_last: Option<String>,
    pub db_count: usize,
    /// Timestamp of the newest Markdown backup (`YYYY-MM-DD_HHMMSS`) and how many are kept.
    pub md_last: Option<String>,
    pub md_count: usize,
}

fn config_path(base: &Path) -> PathBuf {
    base.join("backup.json")
}

pub fn load_config(base: &Path) -> Config {
    fs::read_to_string(config_path(base)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn pick(custom: &Option<String>, default: PathBuf) -> PathBuf {
    match custom.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => default,
    }
}

fn db_dir(base: &Path, cfg: &Config) -> PathBuf {
    pick(&cfg.db_dir, base.join("backups"))
}

fn md_dir(base: &Path, cfg: &Config) -> PathBuf {
    pick(&cfg.md_dir, base.join("backups").join("markdown"))
}

/// `reader-YYYY-MM-DD.db`: only files of exactly this shape are ever counted or pruned,
/// so pointing the folder at a directory with other things in it is safe.
fn is_db_name(n: &str) -> bool {
    n.len() == DB_PREFIX.len() + 10 + DB_SUFFIX.len()
        && n.starts_with(DB_PREFIX)
        && n.ends_with(DB_SUFFIX)
        && n[DB_PREFIX.len()..DB_PREFIX.len() + 10].chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() })
}

/// `marginalia-notes-YYYY-MM-DD_HHMMSS`
fn is_md_name(n: &str) -> bool {
    let Some(stamp) = n.strip_prefix(MD_PREFIX) else { return false };
    stamp.len() == 17 && stamp.chars().enumerate().all(|(i, c)| match i {
        4 | 7 => c == '-',
        10 => c == '_',
        _ => c.is_ascii_digit(),
    })
}

fn list_sorted(dir: &Path, keep: fn(&str) -> bool) -> Vec<String> {
    let mut all: Vec<String> = fs::read_dir(dir)
        .map(|d| d.flatten().filter_map(|f| f.file_name().into_string().ok()).filter(|n| keep(n)).collect())
        .unwrap_or_default();
    all.sort(); // timestamps in the names sort chronologically
    all
}

/// Write `reader-<day>.db` unless that day's already exists (or `force`), then drop all but the newest `KEEP_DB`.
/// Returns the file name when a backup was made.
pub fn backup_to(conn: &Connection, dir: &Path, today: &str, force: bool) -> Result<Option<String>, String> {
    let e = |x: &dyn std::fmt::Display| x.to_string();
    fs::create_dir_all(dir).map_err(|x| e(&x))?;
    let name = format!("{DB_PREFIX}{today}{DB_SUFFIX}");
    let target = dir.join(&name);
    if target.exists() && !force {
        return Ok(None);
    }
    // Copy to a temp name first so an interrupted backup never looks like a valid one.
    let tmp = dir.join(format!("{name}.tmp"));
    let _ = fs::remove_file(&tmp);
    conn.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()]).map_err(|x| e(&x))?;
    fs::rename(&tmp, &target).map_err(|x| e(&x))?;

    let mut all = list_sorted(dir, is_db_name);
    while all.len() > KEEP_DB {
        let old = all.remove(0);
        let _ = fs::remove_file(dir.join(old));
    }
    Ok(Some(name))
}

/// Mirror note pictures into `<db backup dir>/images/`. Pictures are content-addressed and never change, so only files
/// missing from the mirror are copied; the mirror is never pruned, so a restored older database still finds its pictures.
pub fn sync_images(src: &Path, dst: &Path) -> Result<usize, String> {
    let Ok(entries) = fs::read_dir(src) else { return Ok(0) };
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let mut copied = 0;
    for f in entries.flatten() {
        let name = f.file_name();
        let target = dst.join(&name);
        if f.path().is_file() && !target.exists() {
            let tmp = dst.join(format!("{}.tmp", name.to_string_lossy()));
            fs::copy(f.path(), &tmp).map_err(|e| e.to_string())?;
            fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// Write one Markdown backup: `<dir>/marginalia-notes-<stamp>/notes.md` plus an `images/` folder with the
/// pictures the notes embed (Obsidian `![[file]]`), then drop all but the newest `KEEP_MD` backup folders.
pub fn md_write(dir: &Path, stamp: &str, content: &str, images_src: &Path, ids: &[String]) -> Result<String, String> {
    let e = |x: &dyn std::fmt::Display| x.to_string();
    let name = format!("{MD_PREFIX}{stamp}");
    if !is_md_name(&name) {
        return Err("invalid backup name".into());
    }
    fs::create_dir_all(dir).map_err(|x| e(&x))?;
    let tmp = dir.join(format!("{name}.tmp"));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|x| e(&x))?;
    fs::write(tmp.join("notes.md"), content).map_err(|x| e(&x))?;
    for id in ids.iter().filter(|i| crate::images::valid_id(i)) {
        let from = images_src.join(id);
        if from.is_file() {
            fs::create_dir_all(tmp.join("images")).map_err(|x| e(&x))?;
            fs::copy(&from, tmp.join("images").join(id)).map_err(|x| e(&x))?;
        }
    }
    let target = dir.join(&name);
    let _ = fs::remove_dir_all(&target); // same-second rerun replaces itself
    fs::rename(&tmp, &target).map_err(|x| e(&x))?;

    let mut all = list_sorted(dir, is_md_name);
    while all.len() > KEEP_MD {
        let old = all.remove(0);
        let _ = fs::remove_dir_all(dir.join(old));
    }
    Ok(name)
}

fn now_stamp(conn: &Connection, fmt: &str) -> Result<String, String> {
    conn.query_row(&format!("SELECT strftime('{fmt}', 'now', 'localtime')"), [], |r| r.get(0)).map_err(|e| e.to_string())
}

fn status_of(base: &Path) -> Status {
    let cfg = load_config(base);
    let (db, md) = (db_dir(base, &cfg), md_dir(base, &cfg));
    let dbs = list_sorted(&db, is_db_name);
    let mds = list_sorted(&md, is_md_name);
    Status {
        db_last: dbs.last().map(|n| n[DB_PREFIX.len()..n.len() - DB_SUFFIX.len()].to_string()),
        db_count: dbs.len(),
        md_last: mds.last().map(|n| n[MD_PREFIX.len()..].to_string()),
        md_count: mds.len(),
        db_dir: db.to_string_lossy().into_owned(),
        md_dir: md.to_string_lossy().into_owned(),
        default_db_dir: base.join("backups").to_string_lossy().into_owned(),
        default_md_dir: base.join("backups").join("markdown").to_string_lossy().into_owned(),
        config: cfg,
    }
}

fn run_db(app: &AppHandle, force: bool) -> Result<Option<String>, String> {
    let base = crate::app_dir(app)?;
    let dir = db_dir(&base, &load_config(&base));
    sync_images(&base.join("images"), &dir.join("images"))?;
    let db = app.state::<crate::notes::Db>();
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let today = now_stamp(&conn, "%Y-%m-%d")?;
    backup_to(&conn, &dir, &today, force)
}

#[tauri::command]
pub fn backup_status(app: AppHandle) -> Result<Status, String> {
    Ok(status_of(&crate::app_dir(&app)?))
}

/// Save the folder choices. A chosen folder must be creatable and writable, so a typo or a missing drive is reported now.
#[tauri::command]
pub fn backup_config_set(app: AppHandle, config: Config) -> Result<Status, String> {
    let base = crate::app_dir(&app)?;
    for dir in [&config.db_dir, &config.md_dir].into_iter().flatten().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        fs::create_dir_all(dir).map_err(|e| format!("无法使用文件夹 {dir}：{e}"))?;
        let probe = Path::new(dir).join(".marginalia-write-test");
        fs::write(&probe, b"").map_err(|e| format!("文件夹 {dir} 不可写：{e}"))?;
        let _ = fs::remove_file(probe);
    }
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path(&base), json).map_err(|e| e.to_string())?;
    Ok(status_of(&base))
}

/// "Back up now": always writes a fresh copy of today's database file.
#[tauri::command]
pub fn backup_db_now(app: AppHandle) -> Result<Status, String> {
    run_db(&app, true)?;
    Ok(status_of(&crate::app_dir(&app)?))
}

/// The Markdown text is produced by the web side (it owns the note → Markdown formatting); this stores it.
#[tauri::command]
pub fn backup_md_write(app: AppHandle, content: String, ids: Vec<String>) -> Result<Status, String> {
    let base = crate::app_dir(&app)?;
    let dir = md_dir(&base, &load_config(&base));
    let stamp = {
        let db = app.state::<crate::notes::Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        now_stamp(&conn, "%Y-%m-%d_%H%M%S")?
    };
    md_write(&dir, &stamp, &content, &base.join("images"), &ids)?;
    Ok(status_of(&base))
}

/// Show a folder in the system file manager.
#[tauri::command]
pub fn open_dir(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

fn run(app: &AppHandle) {
    match run_db(app, false) {
        Ok(Some(n)) => eprintln!("[backup] wrote {n}"),
        Ok(None) => {}
        Err(err) => eprintln!("[backup] failed: {err}"),
    }
}

/// First backup shortly after launch (off the startup path), then an hourly check so an app left open past
/// midnight still gets a new day's copy.
pub fn schedule(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        loop {
            run(&app);
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("reader-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn keeps_three_skips_repeat_and_force_overwrites() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t(x); INSERT INTO t VALUES (1);").unwrap();
        let dir = tmp("backup-test");
        for d in 1..=9 {
            let day = format!("2026-11-{d:02}");
            assert!(backup_to(&conn, &dir, &day, false).unwrap().is_some());
        }
        assert!(backup_to(&conn, &dir, "2026-11-09", false).unwrap().is_none());
        conn.execute("INSERT INTO t VALUES (2)", []).unwrap();
        assert!(backup_to(&conn, &dir, "2026-11-09", true).unwrap().is_some());
        let names = list_sorted(&dir, is_db_name);
        assert_eq!(names.len(), 3);
        assert_eq!(names[0], "reader-2026-11-07.db");
        let copy = Connection::open(dir.join("reader-2026-11-09.db")).unwrap();
        assert_eq!(copy.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0)).unwrap(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mirrors_pictures_incrementally() {
        let root = tmp("img-backup");
        let (src, dst) = (root.join("images"), root.join("backups").join("images"));
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.png"), b"1").unwrap();
        assert_eq!(sync_images(&src, &dst).unwrap(), 1);
        assert_eq!(sync_images(&src, &dst).unwrap(), 0);
        fs::write(src.join("b.png"), b"2").unwrap();
        fs::remove_file(src.join("a.png")).unwrap();
        assert_eq!(sync_images(&src, &dst).unwrap(), 1);
        assert!(dst.join("a.png").exists() && dst.join("b.png").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn markdown_backup_keeps_three_and_only_touches_its_own_folders() {
        let root = tmp("md-backup");
        let (dir, imgs) = (root.join("out"), root.join("images"));
        fs::create_dir_all(&imgs).unwrap();
        fs::write(imgs.join("0123456789abcdef.png"), b"png").unwrap();
        fs::create_dir_all(dir.join("my-own-folder")).unwrap();
        fs::write(dir.join("reader-notes.txt"), b"keep me").unwrap();
        let ids = vec!["0123456789abcdef.png".to_string(), "missing000000000.png".to_string(), "../evil".to_string()];
        for h in 1..=5 {
            let stamp = format!("2026-11-0{h}_120000");
            md_write(&dir, &stamp, &format!("# {h}"), &imgs, &ids).unwrap();
        }
        let kept = list_sorted(&dir, is_md_name);
        assert_eq!(kept, vec!["marginalia-notes-2026-11-03_120000", "marginalia-notes-2026-11-04_120000", "marginalia-notes-2026-11-05_120000"]);
        let newest = dir.join(&kept[2]);
        assert_eq!(fs::read_to_string(newest.join("notes.md")).unwrap(), "# 5");
        assert!(newest.join("images").join("0123456789abcdef.png").exists());
        assert_eq!(fs::read_dir(newest.join("images")).unwrap().count(), 1); // missing / invalid ids skipped
        assert!(dir.join("my-own-folder").exists() && dir.join("reader-notes.txt").exists());
        assert!(md_write(&dir, "bad stamp", "x", &imgs, &[]).is_err());
        let _ = fs::remove_dir_all(&root);
    }
}
