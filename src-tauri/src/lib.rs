//! Native side of 墨边 Reader.
//!
//! Responsibilities kept deliberately small so the web core stays portable:
//! - import books into the app data dir (content-addressed by SHA-256)
//! - read book bytes / small JSON data files
//! - deliver "open this file" requests (CLI arg, file association, second instance, macOS Opened)

mod backup;
mod bookindex;
mod crypto;
mod desk;
mod feeds;
mod filesync;
mod images;
mod library;
mod mdict;
mod dict;
mod notes;
mod reading;
mod records;
mod remote;
mod review;
mod snaps;
mod sync;
mod syncapp;
mod syncer;
mod tasks;
mod trash;
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
        None => {
            // The identifier names the folder Tauri picks. A machine that already has it keeps using it; a fresh
            // install gets a plain "Marginalia" folder next to it, so people never see the identifier.
            let legacy = app.path().app_data_dir().map_err(|e| e.to_string())?;
            if legacy.exists() {
                legacy
            } else {
                legacy.parent().map(|p| p.join("Marginalia")).unwrap_or(legacy)
            }
        }
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

#[derive(Serialize, Clone)]
struct ImportProgress {
    name: String,
    done: u64,
    total: u64,
}

/// Copy a file into the library without holding it in memory: it is read in 1 MB pieces, hashed (SHA-256 = the
/// book id) and written to a temp file on the way, then renamed. Progress goes out as `import-progress` events.
/// Runs on a worker thread, so a multi-hundred-MB PDF never freezes the window.
#[tauri::command]
async fn import_book(app: AppHandle, path: String) -> Result<ImportedBook, String> {
    tauri::async_runtime::spawn_blocking(move || import_book_blocking(&app, &path))
        .await
        .map_err(|e| e.to_string())?
}

fn import_book_blocking(app: &AppHandle, path: &str) -> Result<ImportedBook, String> {
    use std::io::{Read, Write};
    let src = PathBuf::from(path);
    let ext = ext_of(&src);
    if !SUPPORTED.contains(&ext.as_str()) {
        return Err(format!("暂不支持的格式: .{ext}"));
    }
    let file_name = src.file_name().and_then(|n| n.to_str()).unwrap_or("untitled").to_string();
    let mut input = fs::File::open(&src).map_err(|e| format!("读取文件失败: {e}"))?;
    let total = input.metadata().map_err(|e| e.to_string())?.len();
    let books = app_dir(app)?.join("books");
    fs::create_dir_all(&books).map_err(|e| e.to_string())?;
    let tmp = books.join(format!("import-{}.tmp", std::process::id()));
    let result = (|| -> Result<(String, u64), String> {
        let mut out = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        let mut done = 0u64;
        let mut last_emit = std::time::Instant::now();
        loop {
            let n = input.read(&mut buf).map_err(|e| format!("读取文件失败: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            if total > 8 << 20 && last_emit.elapsed() > std::time::Duration::from_millis(120) {
                last_emit = std::time::Instant::now();
                let _ = app.emit("import-progress", ImportProgress { name: file_name.clone(), done, total });
            }
        }
        out.flush().map_err(|e| e.to_string())?;
        Ok((hex::encode(hasher.finalize().as_slice()), done))
    })();
    let (id, size) = match result {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            return Err(e);
        }
    };
    let dest = books.join(format!("{id}.{ext}"));
    if dest.exists() {
        let _ = fs::remove_file(&tmp); // already in the library
    } else {
        fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("import-progress", ImportProgress { name: file_name.clone(), done: size, total: size });
    Ok(ImportedBook { id, ext, file_name, size })
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

/// Size of a stored book in bytes.
#[tauri::command(async)]
fn book_size(app: AppHandle, id: String, ext: String) -> Result<u64, String> {
    if !valid_id(&id) || !SUPPORTED.contains(&ext.as_str()) {
        return Err("invalid book".into());
    }
    let path = app_dir(&app)?.join("books").join(format!("{id}.{ext}"));
    fs::metadata(path).map(|m| m.len()).map_err(|e| format!("书籍文件丢失: {e}"))
}

/// `len` bytes of a stored book starting at `offset` (clamped to the end of the file): a PDF is read piece by piece
/// as pages are needed instead of being moved into the page as a whole.
#[tauri::command(async)]
fn read_book_range(app: AppHandle, id: String, ext: String, offset: u64, len: u64) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};
    if !valid_id(&id) || !SUPPORTED.contains(&ext.as_str()) {
        return Err("invalid book".into());
    }
    let path = app_dir(&app)?.join("books").join(format!("{id}.{ext}"));
    let mut f = fs::File::open(path).map_err(|e| format!("书籍文件丢失: {e}"))?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let start = offset.min(size);
    let n = len.min(size - start).min(32 << 20) as usize; // never more than 32 MB per request
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; n];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(buf))
}

#[tauri::command]
fn delete_book(app: AppHandle, id: String, ext: String) -> Result<(), String> {
    if !valid_id(&id) || !SUPPORTED.contains(&ext.as_str()) {
        return Err("invalid book".into());
    }
    let dir = app_dir(&app)?;
    let _ = fs::remove_file(dir.join("books").join(format!("{id}.{ext}")));
    let _ = fs::remove_file(dir.join("annotations").join(format!("{id}.json")));
    if let Ok(mut c) = app.state::<bookindex::BookIdx>().0.lock() {
        let _ = bookindex::remove(&mut c, &id);
    }
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

/// A desktop card was just made (or shown): tool window, and at the bottom of the stacking order.
#[tauri::command]
fn card_prepare(app: AppHandle, label: String) {
    if let Some(w) = app.get_webview_window(&label) {
        let win = w.as_ref().window();
        desk::tool_window(&win);
        desk::to_bottom(&win);
    }
}

/// Quit the whole application (the tray menu's "Exit": closing the main window may only hide it).
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn focus_and_open(app: &AppHandle, path: Option<String>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
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
        // start with the system: only the tray and the desktop cards come up (see `--minimized` in setup)
        builder = builder.plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            // a card that was clicked comes to the front for a moment: send it straight back under the other windows
            if let tauri::WindowEvent::Focused(true) = event {
                if window.label().starts_with("card-") {
                    desk::to_bottom(window);
                }
            }
        })
        .manage(StartupFile(Mutex::new(file_arg(&args))))
        .manage(StartupClip(Mutex::new(None)))
        .manage(web::Http(web::client()))
        .manage(syncapp::App::new())
        .setup(|app| {
            let dir = app_dir(app.handle())?;
            let conn = notes::open(&dir).map_err(|e| format!("无法打开笔记数据库: {e}"))?;
            feeds::init(&conn).map_err(|e| format!("无法初始化订阅表: {e}"))?;
            app.manage(notes::Db(Mutex::new(conn)));
            // the book-text index is a rebuildable cache: if it cannot be opened, start from an empty one
            let idx = bookindex::open(&dir).or_else(|_| {
                let _ = std::fs::remove_file(dir.join("book_text.db"));
                bookindex::open(&dir)
            });
            app.manage(bookindex::BookIdx(Mutex::new(idx.map_err(|e| format!("无法打开书籍全文索引: {e}"))?)));
            app.manage(dict::DictState::default());
            backup::schedule(app.handle().clone());
            syncapp::start_scheduler(app.handle().clone());

            // The main window starts hidden; show it unless the app was started by the system at login.
            if !std::env::args().any(|a| a == "--minimized") {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                }
            }

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
            book_size,
            read_book_range,
            delete_book,
            read_data,
            write_data,
            export_text,
            startup_file,
            quit_app,
            reading::reading_add,
            reading::reading_all,
            reading::reading_clear,
            snaps::goal_snaps_save,
            review::review_all,
            review::review_put,
            review::review_log_put,
            review::review_reset,
            bookindex::bidx_status,
            bookindex::bidx_replace,
            bookindex::bidx_remove,
            bookindex::bidx_clear,
            bookindex::bidx_search,
            bookindex::bidx_size,
            library::books_all,
            library::books_replace,
            sync::sync_device,
            filesync::files_present,
            syncapp::sync_download_book,
            syncapp::sync_quota,
            dict::dict_list,
            dict::dict_add,
            dict::dict_remove,
            dict::dict_set_enabled,
            dict::dict_shift,
            dict::dict_lookup,
            dict::dict_resource,
            syncapp::sync_status,
            syncapp::sync_connect,
            syncapp::sync_now,
            syncapp::sync_disconnect,
            sync::sync_tombstones,
            trash::trash_all,
            trash::trash_put,
            trash::trash_delete,
            trash::trash_purge,
            snaps::goal_snaps_all,
            card_prepare,
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
            notes::notes_by_ref,
            notes::notes_put_book,
            notes::note_update,
            notes::note_delete,
            notes::links_all,
            notes::links_put,
            notes::link_delete,
            notes::notes_by_ids,
            notes::graph_pos_all,
            notes::graph_pos_put,
            tasks::tasks_all,
            tasks::tasks_apply,
            tasks::goals_all,
            tasks::goals_apply,
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
