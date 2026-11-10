//! Native side of 墨边 Reader.
//!
//! Responsibilities kept deliberately small so the web core stays portable:
//! - import books into the app data dir (content-addressed by SHA-256)
//! - read book bytes / small JSON data files
//! - deliver "open this file" requests (CLI arg, file association, second instance, macOS Opened)

mod backup;
mod feeds;
mod images;
mod notes;
mod web;

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const SUPPORTED: &[&str] = &["epub", "pdf", "txt", "md", "markdown", "html", "htm"];

/// File path passed on the command line at first launch (e.g. double-clicking a .epub).
struct StartupFile(Mutex<Option<String>>);

/// Article URL from a `marginalia://clip?url=…` link that launched the app.
struct StartupClip(Mutex<Option<String>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedBook {
    id: String,
    ext: String,
    file_name: String,
    size: u64,
}

/// App data directory. `READER_DATA_DIR` overrides it (used by automated tests).
pub(crate) fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = match std::env::var_os("READER_DATA_DIR") {
        Some(d) => PathBuf::from(d),
        None => app.path().app_data_dir().map_err(|e| e.to_string())?,
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Resolve a relative data path inside the app data dir, refusing anything that escapes it.
fn safe_join(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel.is_empty() || rel_path.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("invalid data path: {rel}"));
    }
    Ok(base.join(rel_path))
}

fn ext_of(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit())
}

#[tauri::command]
fn import_book(app: AppHandle, path: String) -> Result<ImportedBook, String> {
    let src = PathBuf::from(&path);
    let ext = ext_of(&src);
    if !SUPPORTED.contains(&ext.as_str()) {
        return Err(format!("暂不支持的格式: .{ext}"));
    }
    let bytes = fs::read(&src).map_err(|e| format!("读取文件失败: {e}"))?;
    let id = hex::encode(Sha256::digest(&bytes).as_slice());
    let books = app_dir(&app)?.join("books");
    fs::create_dir_all(&books).map_err(|e| e.to_string())?;
    let dest = books.join(format!("{id}.{ext}"));
    if !dest.exists() {
        fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    }
    Ok(ImportedBook {
        id,
        ext,
        file_name: src
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("untitled")
            .to_string(),
        size: bytes.len() as u64,
    })
}

#[tauri::command]
fn read_book(app: AppHandle, id: String, ext: String) -> Result<tauri::ipc::Response, String> {
    if !valid_id(&id) || !SUPPORTED.contains(&ext.as_str()) {
        return Err("invalid book".into());
    }
    let path = app_dir(&app)?.join("books").join(format!("{id}.{ext}"));
    let bytes = fs::read(path).map_err(|e| format!("书籍文件丢失: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn delete_book(app: AppHandle, id: String, ext: String) -> Result<(), String> {
    if !valid_id(&id) || !SUPPORTED.contains(&ext.as_str()) {
        return Err("invalid book".into());
    }
    let dir = app_dir(&app)?;
    let _ = fs::remove_file(dir.join("books").join(format!("{id}.{ext}")));
    let _ = fs::remove_file(dir.join("annotations").join(format!("{id}.json")));
    notes::delete_book_notes(&app.state::<notes::Db>(), &id)
}

#[tauri::command]
fn read_data(app: AppHandle, rel: String) -> Result<Option<String>, String> {
    let path = safe_join(&app_dir(&app)?, &rel)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Atomic write: temp file + rename, so a crash never leaves half-written annotations.
#[tauri::command]
fn write_data(app: AppHandle, rel: String, content: String) -> Result<(), String> {
    let path = safe_join(&app_dir(&app)?, &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Write a user-chosen export file (path comes from the native save dialog).
#[tauri::command]
fn export_text(path: String, content: String) -> Result<(), String> {
    fs::write(PathBuf::from(path), content).map_err(|e| e.to_string())
}

#[tauri::command]
fn startup_file(state: tauri::State<StartupFile>) -> Option<String> {
    state.0.lock().ok()?.take()
}

#[tauri::command]
fn startup_clip(state: tauri::State<StartupClip>) -> Option<String> {
    state.0.lock().ok()?.take()
}

fn file_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| {
            let p = Path::new(a.as_str());
            p.is_file() && SUPPORTED.contains(&ext_of(p).as_str())
        })
        .cloned()
}

fn focus_and_open(app: &AppHandle, path: Option<String>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    if let Some(p) = path {
        let _ = app.emit("open-file", p);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            focus_and_open(app, file_arg(&argv));
        }));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(StartupFile(Mutex::new(file_arg(&args))))
        .manage(StartupClip(Mutex::new(None)))
        .manage(web::Http(web::client()))
        .setup(|app| {
            let dir = app_dir(app.handle())?;
            let conn = notes::open(&dir).map_err(|e| format!("无法打开笔记数据库: {e}"))?;
            feeds::init(&conn).map_err(|e| format!("无法初始化订阅表: {e}"))?;
            app.manage(notes::Db(Mutex::new(conn)));
            backup::schedule(app.handle().clone());

            // marginalia://clip?url=… (browser bookmarklet). Installers register the scheme;
            // registering at runtime too keeps dev builds and portable copies working.
            use tauri_plugin_deep_link::DeepLinkExt;
            #[cfg(desktop)]
            let _ = app.deep_link().register_all();
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                if let Some(target) = urls.iter().find_map(web::clip_target) {
                    *app.state::<StartupClip>().0.lock().unwrap() = Some(target);
                }
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for target in event.urls().iter().filter_map(web::clip_target) {
                    focus_and_open(&handle, None);
                    let _ = handle.emit("clip-url", target);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_book,
            images::image_put,
            images::export_images,
            images::image_get,
            backup::backup_status,
            backup::backup_config_set,
            backup::backup_db_now,
            backup::backup_md_write,
            backup::open_dir,
            read_book,
            delete_book,
            read_data,
            write_data,
            export_text,
            startup_file,
            startup_clip,
            web::fetch_page,
            web::fetch_image,
            web::article_lookup,
            web::save_article,
            feeds::feed_fetch,
            feeds::sources_list,
            feeds::source_save,
            feeds::source_delete,
            feeds::items_upsert,
            feeds::items_query,
            feeds::items_set_status,
            feeds::items_mark_all_read,
            feeds::item_set_summary,
            feeds::item_unsave,
            feeds::items_prune,
            feeds::items_unread_count,
            notes::notes_for_book,
            notes::notes_put_book,
            notes::note_update,
            notes::note_delete,
            notes::notes_query,
            notes::tags_list,
            notes::tag_rename,
            notes::tag_delete,
            notes::tag_pin,
            notes::note_counts,
            notes::notes_stats,
            notes::note_doc_counts
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS delivers file-association opens as an event instead of argv.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &_event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        focus_and_open(_app, Some(path.to_string_lossy().into_owned()));
                    }
                }
            }
        });
}
