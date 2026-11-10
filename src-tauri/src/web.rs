//! Web clipping: fetch an article page, fetch its images, and store an offline snapshot.
//! Extraction (Readability, site adapters) happens in the web layer; Rust does networking,
//! charset decoding and storage so pages from any origin can be fetched without CORS.

use base64::Engine;
use encoding_rs::{Encoding, UTF_8};
use reqwest::{header, Url};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::time::Duration;
use tauri::AppHandle;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_PAGE: usize = 10 * 1024 * 1024;
const MAX_IMAGE: usize = 15 * 1024 * 1024;

pub struct Http(pub reqwest::Client);

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(8))
        .build()
        .expect("http client")
}

pub fn check_url(raw: &str) -> Result<Url, String> {
    let u = Url::parse(raw.trim()).map_err(|_| "网址格式不正确".to_string())?;
    match u.scheme() {
        "http" | "https" if u.host_str().is_some() => Ok(u),
        _ => Err("只支持 http / https 网址".into()),
    }
}

/// Canonical form used for de-duplication: no fragment, no tracking parameters.
/// WeChat article links carry many volatile parameters; only the identifying ones are kept.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let mut u = check_url(raw)?;
    u.set_fragment(None);
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    let keep: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| {
            if host == "mp.weixin.qq.com" {
                matches!(k.as_ref(), "__biz" | "mid" | "idx" | "sn")
            } else {
                !(k.starts_with("utm_") || matches!(k.as_ref(), "spm" | "from" | "share_token" | "ref" | "ref_src" | "fbclid" | "gclid"))
            }
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if keep.is_empty() {
        u.set_query(None);
    } else {
        u.query_pairs_mut().clear().extend_pairs(keep);
    }
    Ok(u.to_string())
}

pub fn article_id(url: &str) -> Result<String, String> {
    Ok(hex::encode(Sha256::digest(normalize_url(url)?.as_bytes()).as_slice()))
}

/// Decide the page encoding: BOM → Content-Type charset → <meta charset> in the first 4 KB → UTF-8.
pub fn sniff_charset(content_type: Option<&str>, body: &[u8]) -> &'static Encoding {
    if let Some((enc, _)) = Encoding::for_bom(body) {
        return enc;
    }
    let label_after = |s: &str| -> Option<&'static Encoding> {
        let i = s.find("charset")?;
        let rest = s[i + 7..].trim_start_matches(|c: char| c == ' ' || c == '=' || c == '"' || c == '\'');
        let label: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
        Encoding::for_label(label.as_bytes())
    };
    if let Some(enc) = content_type.map(|c| c.to_ascii_lowercase()).as_deref().and_then(label_after) {
        return enc;
    }
    let head = String::from_utf8_lossy(&body[..body.len().min(4096)]).to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = head[from..].find("<meta") {
        let start = from + i;
        let end = head[start..].find('>').map(|e| start + e).unwrap_or(head.len());
        if let Some(enc) = label_after(&head[start..end]) {
            // A page that declares UTF-16 in a meta tag is really ASCII-compatible; treat as UTF-8.
            return if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE { UTF_8 } else { enc };
        }
        from = end;
    }
    UTF_8
}

fn friendly(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "连接超时，请稍后重试".into()
    } else if e.is_connect() {
        "无法连接到该网站，请检查网络或代理设置".into()
    } else if e.is_redirect() {
        "跳转次数过多".into()
    } else {
        format!("网络错误：{e}")
    }
}

async fn read_limited(mut resp: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if resp.content_length().is_some_and(|n| n as usize > max) {
        return Err("内容过大".into());
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(friendly)? {
        out.extend_from_slice(&chunk);
        if out.len() > max {
            return Err("内容过大".into());
        }
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    final_url: String,
    html: String,
}

#[tauri::command]
pub async fn fetch_page(http: tauri::State<'_, Http>, url: String) -> Result<Page, String> {
    let u = check_url(&url)?;
    let resp = http
        .0
        .get(u)
        .header(header::ACCEPT, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
        .header(header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(friendly)?;
    if !resp.status().is_success() {
        return Err(format!("网页返回错误 {}", resp.status().as_u16()));
    }
    let final_url = resp.url().to_string();
    let ct = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map(String::from);
    if ct.as_deref().is_some_and(|c| !(c.contains("html") || c.contains("xml") || c.starts_with("text/"))) {
        return Err("这个网址不是网页（可能是文件下载链接）".into());
    }
    let bytes = read_limited(resp, MAX_PAGE).await?;
    let (text, _, _) = sniff_charset(ct.as_deref(), &bytes).decode(&bytes);
    Ok(Page { final_url, html: text.into_owned() })
}

fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        [_, _, _, _, b'f', b't', b'y', b'p', b'a', b'v', b'i', b'f', ..] => Some("image/avif"),
        _ if bytes.len() > 4 && String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).contains("<svg") => Some("image/svg+xml"),
        _ => None,
    }
}

/// Download an image and return it as a data URI so the snapshot works offline.
#[tauri::command]
pub async fn fetch_image(http: tauri::State<'_, Http>, url: String, referer: Option<String>) -> Result<String, String> {
    let u = check_url(&url)?;
    let mut req = http.0.get(u).header(header::ACCEPT, "image/avif,image/webp,image/apng,image/*,*/*;q=0.8");
    if let Some(r) = referer {
        req = req.header(header::REFERER, r);
    }
    let resp = req.send().await.map_err(friendly)?;
    if !resp.status().is_success() {
        return Err(format!("图片返回错误 {}", resp.status().as_u16()));
    }
    let declared = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or("").trim().to_ascii_lowercase());
    let bytes = read_limited(resp, MAX_IMAGE).await?;
    let mime = match declared.as_deref() {
        Some(m) if m.starts_with("image/") => m.to_string(),
        _ => sniff_image(&bytes).ok_or("不是图片")?.to_string(),
    };
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedArticle {
    id: String,
    ext: String,
    file_name: String,
    size: u64,
    existed: bool,
}

/// Id of an already-saved article for this URL, if any (checked before fetching).
#[tauri::command]
pub fn article_lookup(app: AppHandle, url: String) -> Result<Option<String>, String> {
    let id = article_id(&url)?;
    let path = crate::app_dir(&app)?.join("books").join(format!("{id}.html"));
    Ok(path.exists().then_some(id))
}

#[tauri::command]
pub fn save_article(app: AppHandle, url: String, html: String) -> Result<SavedArticle, String> {
    let id = article_id(&url)?;
    let dir = crate::app_dir(&app)?.join("books");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}.html"));
    let existed = path.exists();
    if !existed {
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, html.as_bytes()).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }
    let host = check_url(&url)?.host_str().unwrap_or("web").to_string();
    Ok(SavedArticle {
        id,
        ext: "html".into(),
        file_name: format!("{host}.html"),
        size: fs::metadata(&path).map(|m| m.len()).unwrap_or(0),
        existed,
    })
}

/// `marginalia://clip?url=…` → the article URL.
pub fn clip_target(link: &Url) -> Option<String> {
    if link.scheme() != "marginalia" {
        return None;
    }
    let is_clip = link.host_str() == Some("clip") || link.path().trim_matches('/') == "clip";
    if !is_clip {
        return None;
    }
    link.query_pairs().find(|(k, _)| k == "url").map(|(_, v)| v.into_owned()).filter(|u| check_url(u).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_charsets() {
        let gbk = b"<html><head><meta http-equiv=\"Content-Type\" content=\"text/html; charset=gb2312\"></head>";
        assert_eq!(sniff_charset(None, gbk).name(), "GBK");
        assert_eq!(sniff_charset(None, b"<meta charset='GBK'>").name(), "GBK");
        assert_eq!(sniff_charset(Some("text/html; charset=Big5"), b"").name(), "Big5");
        assert_eq!(sniff_charset(Some("text/html"), b"<p>plain</p>").name(), "UTF-8");
        let (s, _, _) = sniff_charset(None, b"<meta charset=gbk>\xd6\xd0\xce\xc4").decode(b"<meta charset=gbk>\xd6\xd0\xce\xc4");
        assert!(s.ends_with("中文"));
    }

    #[test]
    fn normalizes_urls() {
        assert_eq!(
            normalize_url("https://example.com/a?id=3&utm_source=x&spm=1#top").unwrap(),
            "https://example.com/a?id=3"
        );
        assert_eq!(normalize_url("https://example.com/a?utm_medium=y").unwrap(), "https://example.com/a");
        assert_eq!(
            normalize_url("https://mp.weixin.qq.com/s?__biz=MzA&mid=22&idx=1&sn=ab&chksm=zz&scene=21#wechat_redirect").unwrap(),
            "https://mp.weixin.qq.com/s?__biz=MzA&mid=22&idx=1&sn=ab"
        );
        assert_eq!(article_id("https://x.org/p?utm_x=1").unwrap(), article_id("https://x.org/p#frag").unwrap());
        assert!(check_url("file:///C:/x").is_err());
        assert!(check_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn parses_clip_links() {
        let l = Url::parse("marginalia://clip?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1").unwrap();
        assert_eq!(clip_target(&l).as_deref(), Some("https://example.com/a?b=1"));
        assert!(clip_target(&Url::parse("marginalia://clip?url=file%3A%2F%2F%2Fx").unwrap()).is_none());
        assert!(clip_target(&Url::parse("https://clip?url=https://a.b").unwrap()).is_none());
    }
}
