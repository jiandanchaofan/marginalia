//! The flomo plugin: send the text of a new note to the user's flomo through flomo's API (an "incoming webhook" address,
//! `https://flomoapp.com/iwh/…/…/`, POST `{"content": "…"}`). The address itself is the secret (anyone who has it can post
//! into that account), so it is kept in the system credential store, never in the database or a settings file.
//! Which notes are sent and when is decided by the page (src/flomo/outbox.ts); this side only stores the address and posts.

use crate::web::Http;
use serde::Serialize;

#[cfg(any(windows, target_os = "macos"))]
mod store {
    const SERVICE: &str = "com.shengmin.reader.flomo";
    const KEY: &str = "api";
    pub fn get() -> Option<String> {
        keyring::Entry::new(SERVICE, KEY).ok()?.get_password().ok()
    }
    pub fn set(v: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, KEY).and_then(|e| e.set_password(v)).map_err(|e| format!("不能保存到系统凭据库：{e}"))
    }
    pub fn delete() {
        if let Ok(e) = keyring::Entry::new(SERVICE, KEY) {
            let _ = e.delete_credential();
        }
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
mod store {
    pub fn get() -> Option<String> {
        None
    }
    pub fn set(_: &str) -> Result<(), String> {
        Err("这个系统上没有可用的凭据库".into())
    }
    pub fn delete() {}
}

const BAD_ADDRESS: &str = "这不是 flomo 的 API 地址。请在 flomo 网页版「设置 → API」里复制，形如 https://flomoapp.com/iwh/…";

/// The address as it will be stored: trimmed, https, on flomoapp.com, under /iwh/.
pub fn check_api(url: &str) -> Result<String, String> {
    let u = url.trim();
    let p = reqwest::Url::parse(u).map_err(|_| BAD_ADDRESS.to_string())?;
    let host = p.host_str().unwrap_or("");
    let flomo = host == "flomoapp.com" || host.ends_with(".flomoapp.com");
    if p.scheme() != "https" || !flomo || !p.path().starts_with("/iwh/") || p.path().len() <= "/iwh/".len() {
        return Err(BAD_ADDRESS.into());
    }
    Ok(u.to_string())
}

/// What the settings show of the stored address: enough to recognise it, not enough to use it.
pub fn mask(u: &str) -> String {
    let tail: String = u.trim_end_matches('/').chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("https://flomoapp.com/iwh/••••{tail}")
}

/// How a post turned out. `Err` starts with "net:" when it is worth trying again later (no connection, server busy),
/// and with "api:" when flomo refused it (wrong address, no PRO membership…) — trying again will not help until it is fixed.
pub fn read_reply(status: u16, body: &str) -> Result<(), String> {
    if status == 429 || status >= 500 {
        return Err(format!("net:flomo 暂时不可用（HTTP {status}）"));
    }
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or(serde_json::Value::Null);
    let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("").trim().to_string();
    if !(200..300).contains(&status) {
        return Err(format!("api:{}", if msg.is_empty() { format!("flomo 拒绝了请求（HTTP {status}）") } else { msg }));
    }
    match v.get("code").and_then(|c| c.as_i64()) {
        Some(0) => Ok(()),
        Some(_) => Err(format!("api:{}", if msg.is_empty() { "flomo 拒绝了这条笔记".into() } else { msg })),
        // not the reply flomo gives: the address is probably not an API address
        None => Err("api:flomo 没有给出预期的回复，请检查 API 地址".into()),
    }
}

#[derive(Serialize)]
pub struct FlomoState {
    configured: bool,
    hint: Option<String>,
}

fn state() -> FlomoState {
    let api = store::get();
    FlomoState { configured: api.is_some(), hint: api.as_deref().map(mask) }
}

#[tauri::command]
pub fn flomo_state() -> FlomoState {
    state()
}

#[tauri::command]
pub fn flomo_set_api(url: String) -> Result<FlomoState, String> {
    store::set(&check_api(&url)?)?;
    Ok(state())
}

#[tauri::command]
pub fn flomo_clear_api() -> FlomoState {
    store::delete();
    state()
}

/// Post one memo. Text only: flomo's API has no field for pictures (see the plugin's settings for why).
#[tauri::command]
pub async fn flomo_send(http: tauri::State<'_, Http>, content: String) -> Result<(), String> {
    let api = store::get().ok_or_else(|| "api:还没有填写 flomo API".to_string())?;
    let body = serde_json::json!({ "content": content }).to_string();
    let res = http
        .0
        .post(&api)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("net:连不上 flomo：{e}"))?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    read_reply(status, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_flomo_api_addresses() {
        assert_eq!(check_api("  https://flomoapp.com/iwh/MTk/abc123/ ").unwrap(), "https://flomoapp.com/iwh/MTk/abc123/");
        assert!(check_api("https://v.flomoapp.com/iwh/x/y/").is_ok());
        for bad in ["http://flomoapp.com/iwh/x/y/", "https://flomoapp.com/mine", "https://evil.com/iwh/x/", "https://flomoapp.com.evil.com/iwh/x/", "https://flomoapp.com/iwh/", "flomoapp.com/iwh/x", ""] {
            assert!(check_api(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn mask_keeps_only_the_tail() {
        let m = mask("https://flomoapp.com/iwh/MTk2NDU/0f1e2d3c4b5a/");
        assert_eq!(m, "https://flomoapp.com/iwh/••••4b5a");
        assert!(!m.contains("MTk2NDU"));
    }

    #[test]
    fn replies() {
        assert!(read_reply(200, r#"{"code":0,"message":"已记录","memo":{}}"#).is_ok());
        assert_eq!(read_reply(200, r#"{"code":-1,"message":"本功能需 PRO 会员"}"#).unwrap_err(), "api:本功能需 PRO 会员");
        assert!(read_reply(200, "<html>").unwrap_err().starts_with("api:"));
        assert!(read_reply(404, "").unwrap_err().starts_with("api:"));
        assert!(read_reply(502, "").unwrap_err().starts_with("net:"));
        assert!(read_reply(429, "").unwrap_err().starts_with("net:"));
    }
}
