//! Pictures attached to notes: content-addressed files under `<data dir>/images/`.
use base64::Engine;
use sha2::{Digest, Sha256};
use std::fs;
use tauri::AppHandle;

const MAX_BYTES: usize = 20 * 1024 * 1024;
const EXTS: [&str; 5] = ["png", "jpg", "gif", "webp", "bmp"];

pub(crate) fn valid_id(id: &str) -> bool {
    match id.split_once('.') {
        Some((h, ext)) => h.len() == 16 && h.bytes().all(|b| b.is_ascii_hexdigit()) && EXTS.contains(&ext),
        None => false,
    }
}

/// Save a picture (base64 bytes) and return its id (`<hash>.<ext>`); the same picture always maps to the same file.
#[tauri::command]
pub fn image_put(app: AppHandle, data: String, ext: String) -> Result<String, String> {
    let ext = match ext.to_lowercase().as_str() {
        "jpeg" | "jpg" => "jpg",
        e if EXTS.contains(&e) => EXTS.iter().find(|x| **x == e).unwrap(),
        _ => return Err("不支持的图片格式".into()),
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("图片为空或超过 20MB".into());
    }
    let id = format!("{}.{ext}", &hex::encode(Sha256::digest(&bytes))[..16]);
    let dir = crate::app_dir(&app)?.join("images");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(&id);
    if !path.exists() {
        fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    }
    Ok(id)
}

/// Read a saved picture back as a `data:` URI.
#[tauri::command]
pub fn image_get(app: AppHandle, id: String) -> Result<String, String> {
    if !valid_id(&id) {
        return Err("无效的图片 id".into());
    }
    let bytes = fs::read(crate::app_dir(&app)?.join("images").join(&id)).map_err(|e| e.to_string())?;
    let ext = id.rsplit('.').next().unwrap_or("png");
    let mime = match ext {
        "jpg" => "image/jpeg",
        e => return Ok(format!("data:image/{e};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes))),
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// Copy pictures into `<folder of the exported .md>/attachments/` so the Markdown's `![[file]]` embeds resolve
/// (Obsidian finds attachments by file name anywhere in the vault).
#[tauri::command]
pub fn export_images(app: AppHandle, md_path: String, ids: Vec<String>) -> Result<usize, String> {
    let src = crate::app_dir(&app)?.join("images");
    let dir = std::path::Path::new(&md_path).parent().ok_or("无效的导出路径")?.join("attachments");
    let mut n = 0;
    for id in ids.iter().filter(|i| valid_id(i)) {
        let from = src.join(id);
        if !from.exists() {
            continue;
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::copy(&from, dir.join(id)).map_err(|e| e.to_string())?;
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_validated() {
        assert!(valid_id("0123456789abcdef.png"));
        assert!(!valid_id("../secret.png"));
        assert!(!valid_id("0123456789abcdef.exe"));
        assert!(!valid_id("0123456789abcde.png"));
    }
}
