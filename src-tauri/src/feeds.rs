//! Subscriptions: fetch feeds (RSS / Atom / JSON Feed, WeChat 公众号 合集) into an inbox of
//! lightweight items (title, time, first paragraph). Saving an item hands it to the clipper.

use crate::notes::Db;
use crate::web::{article_id, check_url, Http};
use reqwest::header;
use rusqlite::{params, params_from_iter, types::Value as Sql, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS feed_sources(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  site_url TEXT NOT NULL DEFAULT '',
  feed_url TEXT NOT NULL,
  kind TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  last_fetched INTEGER,
  last_error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feed_items(
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES feed_sources(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  published_at INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_items_time ON feed_items(published_at DESC);
CREATE INDEX IF NOT EXISTS feed_items_source ON feed_items(source_id, published_at DESC);
";

pub fn init(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(SCHEMA)?;
    // v0.2: reading interests per source (JSON array of strings). Older databases are upgraded in place.
    let has_interests = conn
        .prepare("PRAGMA table_info(feed_sources)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|c| c == "interests");
    if !has_interests {
        conn.execute("ALTER TABLE feed_sources ADD COLUMN interests TEXT NOT NULL DEFAULT '[]'", [])?;
    }
    Ok(())
}

type R<T> = Result<T, String>;
fn e<E: std::fmt::Display>(err: E) -> String {
    err.to_string()
}
fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ---------------------------------------------------------------- fetching

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RawItem {
    url: String,
    title: String,
    author: String,
    published_at: i64,
    /// Full content or summary HTML — the web layer turns it into a first paragraph.
    html: String,
    image: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    not_modified: bool,
    etag: Option<String>,
    last_modified: Option<String>,
    final_url: String,
    kind: String,
    title: String,
    site_url: String,
    items: Vec<RawItem>,
}

fn friendly(err: reqwest::Error) -> String {
    if err.is_timeout() {
        "连接超时".into()
    } else if err.is_connect() {
        "无法连接（请检查网络或代理）".into()
    } else {
        format!("网络错误：{err}")
    }
}

/// WeChat 合集 page → the public JSON endpoint behind it.
fn wechat_album_api(u: &reqwest::Url) -> Option<String> {
    if u.host_str() != Some("mp.weixin.qq.com") || !u.path().starts_with("/mp/appmsgalbum") {
        return None;
    }
    let get = |k: &str| u.query_pairs().find(|(q, _)| q == k).map(|(_, v)| v.into_owned());
    let (biz, album) = (get("__biz")?, get("album_id")?);
    Some(format!(
        "https://mp.weixin.qq.com/mp/appmsgalbum?action=getalbum&__biz={}&album_id={}&count=20&f=json",
        urlencode(&biz),
        urlencode(&album)
    ))
}
fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn parse_wechat_album(json: &str) -> R<(String, Vec<RawItem>)> {
    let v: Value = serde_json::from_str(json).map_err(|_| "公众号合集返回了无法识别的内容".to_string())?;
    if v.pointer("/base_resp/ret").and_then(Value::as_i64).unwrap_or(0) != 0 {
        return Err("公众号合集暂时无法访问（可能需要稍后重试）".into());
    }
    let resp = v.get("getalbum_resp").ok_or("公众号合集返回了无法识别的内容")?;
    let title = resp.pointer("/base_info/title").and_then(Value::as_str).unwrap_or("公众号合集").to_string();
    // A single article comes back as an object rather than an array.
    let list: Vec<&Value> = match resp.get("article_list") {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(o @ Value::Object(_)) => vec![o],
        _ => vec![],
    };
    let num = |x: Option<&Value>| x.and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0);
    let items = list
        .into_iter()
        .filter_map(|a| {
            let url = a.get("url")?.as_str()?.replace("&amp;", "&");
            Some(RawItem {
                url,
                title: a.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
                author: String::new(),
                published_at: num(a.get("create_time")) * 1000,
                html: String::new(),
                image: a.get("cover_img_1_1").and_then(Value::as_str).unwrap_or("").to_string(),
            })
        })
        .collect();
    Ok((title, items))
}

fn parse_feed(bytes: &[u8], base: &str) -> R<(String, String, Vec<RawItem>)> {
    let feed = feed_rs::parser::parse(bytes).map_err(|_| "不是有效的 RSS / Atom 订阅源".to_string())?;
    let title = feed.title.map(|t| t.content.trim().to_string()).unwrap_or_default();
    let site = feed
        .links
        .iter()
        .find(|l| l.rel.as_deref() != Some("self"))
        .map(|l| l.href.clone())
        .unwrap_or_default();
    let base_url = reqwest::Url::parse(base).ok();
    let items = feed
        .entries
        .into_iter()
        .filter_map(|en| {
            let link = en
                .links
                .iter()
                .find(|l| l.rel.as_deref().is_none_or(|r| r == "alternate"))
                .or(en.links.first())
                .map(|l| l.href.clone())
                .or_else(|| en.id.starts_with("http").then(|| en.id.clone()))?;
            let url = base_url.as_ref().and_then(|b| b.join(&link).ok()).map(|u| u.to_string()).unwrap_or(link);
            check_url(&url).ok()?;
            let html = en
                .content
                .and_then(|c| c.body)
                .filter(|b| !b.trim().is_empty())
                .or_else(|| en.summary.map(|s| s.content))
                .unwrap_or_default();
            let image = en
                .media
                .iter()
                .flat_map(|m| m.thumbnails.iter().map(|t| t.image.uri.clone()).chain(m.content.iter().filter_map(|c| c.url.as_ref().map(|u| u.to_string()))))
                .next()
                .unwrap_or_default();
            Some(RawItem {
                url,
                title: en.title.map(|t| t.content.trim().to_string()).unwrap_or_default(),
                author: en.authors.into_iter().filter_map(|p| p.name).next().unwrap_or_default(),
                published_at: en.published.or(en.updated).map(|d| d.timestamp_millis()).unwrap_or(0),
                html,
                image,
            })
        })
        .collect();
    Ok((title, site, items))
}

/// Fetch a feed (conditional GET when etag/last-modified are known).
#[tauri::command]
pub async fn feed_fetch(http: tauri::State<'_, Http>, url: String, etag: Option<String>, last_modified: Option<String>) -> R<FetchResult> {
    let u = check_url(&url)?;
    let album_api = wechat_album_api(&u);
    let target = album_api.clone().unwrap_or_else(|| u.to_string());
    let mut req = http
        .0
        .get(&target)
        .header(header::ACCEPT, "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5");
    if album_api.is_some() {
        req = req.header(header::REFERER, u.as_str());
    }
    if let Some(t) = &etag {
        req = req.header(header::IF_NONE_MATCH, t);
    }
    if let Some(t) = &last_modified {
        req = req.header(header::IF_MODIFIED_SINCE, t);
    }
    let resp = req.send().await.map_err(friendly)?;
    if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(FetchResult { not_modified: true, etag, last_modified, final_url: url, ..Default::default() });
    }
    if !resp.status().is_success() {
        return Err(format!("服务器返回 {}", resp.status().as_u16()));
    }
    let hdr = |k: header::HeaderName| resp.headers().get(k).and_then(|v| v.to_str().ok()).map(String::from);
    let (new_etag, new_lm) = (hdr(header::ETAG), hdr(header::LAST_MODIFIED));
    let final_url = resp.url().to_string();
    let bytes = resp.bytes().await.map_err(friendly)?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("订阅源过大".into());
    }
    if album_api.is_some() {
        let (title, items) = parse_wechat_album(&String::from_utf8_lossy(&bytes))?;
        return Ok(FetchResult {
            etag: new_etag,
            last_modified: new_lm,
            final_url: url.clone(),
            kind: "wechat-album".into(),
            title,
            site_url: url,
            items,
            ..Default::default()
        });
    }
    let (title, site_url, items) = parse_feed(&bytes, &final_url)?;
    Ok(FetchResult { etag: new_etag, last_modified: new_lm, final_url, kind: "feed".into(), title, site_url, items, ..Default::default() })
}

// ---------------------------------------------------------------- storage

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub site_url: String,
    pub feed_url: String,
    pub kind: String,
    #[serde(default)]
    pub etag: Option<String>,
    #[serde(default)]
    pub last_modified: Option<String>,
    #[serde(default)]
    pub last_fetched: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub error_count: i64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub unread: i64,
    #[serde(default)]
    pub total: i64,
    /// Reading interests ("基督教", "AI", …) — a source can have several.
    #[serde(default)]
    pub interests: Vec<String>,
}

#[tauri::command]
pub fn sources_list(db: tauri::State<Db>) -> R<Vec<Source>> {
    let conn = db.0.lock().map_err(e)?;
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.title, s.site_url, s.feed_url, s.kind, s.etag, s.last_modified, s.last_fetched, s.last_error, s.error_count, s.created_at,
               (SELECT count(*) FROM feed_items i WHERE i.source_id = s.id AND i.status = 'new'),
               (SELECT count(*) FROM feed_items i WHERE i.source_id = s.id),
               s.interests
             FROM feed_sources s ORDER BY s.created_at",
        )
        .map_err(e)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Source {
                id: r.get(0)?,
                title: r.get(1)?,
                site_url: r.get(2)?,
                feed_url: r.get(3)?,
                kind: r.get(4)?,
                etag: r.get(5)?,
                last_modified: r.get(6)?,
                last_fetched: r.get(7)?,
                last_error: r.get(8)?,
                error_count: r.get(9)?,
                created_at: r.get(10)?,
                unread: r.get(11)?,
                total: r.get(12)?,
                interests: serde_json::from_str::<Vec<String>>(&r.get::<_, String>(13)?).unwrap_or_default(),
            })
        })
        .map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

/// Trim, drop empties and duplicates, keep the user's order.
fn clean_interests(list: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in list.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if !out.iter().any(|x| x == t) {
            out.push(t.chars().take(24).collect());
        }
    }
    out
}

#[tauri::command]
pub fn source_save(db: tauri::State<Db>, source: Source) -> R<()> {
    let conn = db.0.lock().map_err(e)?;
    conn.execute(
        "INSERT INTO feed_sources(id, title, site_url, feed_url, kind, etag, last_modified, last_fetched, last_error, error_count, created_at, interests)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, site_url = excluded.site_url, feed_url = excluded.feed_url, kind = excluded.kind,
           etag = excluded.etag, last_modified = excluded.last_modified, last_fetched = excluded.last_fetched,
           last_error = excluded.last_error, error_count = excluded.error_count, interests = excluded.interests",
        params![
            source.id,
            source.title,
            source.site_url,
            source.feed_url,
            source.kind,
            source.etag,
            source.last_modified,
            source.last_fetched,
            source.last_error,
            source.error_count,
            if source.created_at > 0 { source.created_at } else { now_ms() },
            serde_json::to_string(&clean_interests(&source.interests)).unwrap_or_else(|_| "[]".into())
        ],
    )
    .map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn source_delete(db: tauri::State<Db>, id: String) -> R<()> {
    let conn = db.0.lock().map_err(e)?;
    conn.execute("DELETE FROM feed_items WHERE source_id = ?1", [&id]).map_err(e)?;
    conn.execute("DELETE FROM feed_sources WHERE id = ?1", [&id]).map_err(e)?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemIn {
    url: String,
    title: String,
    #[serde(default)]
    author: String,
    published_at: i64,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    image: String,
}

/// Insert new items; existing ones keep their status (a refresh never resurrects dismissed items).
/// Items without a date get the fetch time. Returns how many were new.
fn upsert_items(conn: &Connection, source_id: &str, items: &[ItemIn]) -> R<usize> {
    let now = now_ms();
    let mut added = 0;
    for it in items {
        let Ok(id) = article_id(&it.url) else { continue };
        let published = if it.published_at > 0 { it.published_at } else { now };
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO feed_items(id, source_id, url, title, author, published_at, summary, image, status, fetched_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'new', ?9)",
                params![id, source_id, it.url, it.title, it.author, published, it.summary, it.image, now],
            )
            .map_err(e)?;
        if n == 0 {
            // Fill in a summary that was missing before (e.g. title-only feeds).
            conn.execute(
                "UPDATE feed_items SET summary = ?2, title = CASE WHEN title = '' THEN ?3 ELSE title END WHERE id = ?1 AND summary = '' AND ?2 <> ''",
                params![id, it.summary, it.title],
            )
            .map_err(e)?;
        }
        added += n;
    }
    Ok(added)
}

#[tauri::command]
pub fn items_upsert(db: tauri::State<Db>, source_id: String, items: Vec<ItemIn>) -> R<usize> {
    let mut conn = db.0.lock().map_err(e)?;
    let tx = conn.transaction().map_err(e)?;
    let n = upsert_items(&tx, &source_id, &items)?;
    tx.commit().map_err(e)?;
    Ok(n)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    id: String,
    source_id: String,
    url: String,
    title: String,
    author: String,
    published_at: i64,
    summary: String,
    image: String,
    status: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ItemQuery {
    source_id: Option<String>,
    /// Several sources at once (e.g. every source tagged with a chosen interest). Empty list → no results.
    source_ids: Option<Vec<String>>,
    /// "unread" | "all" (everything except dismissed) | "saved" | "dismissed"
    view: Option<String>,
    q: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Serialize)]
pub struct ItemPage {
    items: Vec<Item>,
    total: i64,
}

fn query_items(conn: &Connection, q: &ItemQuery) -> R<ItemPage> {
    let mut clauses = vec!["1 = 1".to_string()];
    let mut args: Vec<Sql> = vec![];
    if let Some(s) = &q.source_id {
        clauses.push("source_id = ?".into());
        args.push(Sql::Text(s.clone()));
    }
    if let Some(ids) = &q.source_ids {
        if ids.is_empty() {
            clauses.push("0 = 1".into());
        } else {
            clauses.push(format!("source_id IN ({})", vec!["?"; ids.len()].join(", ")));
            args.extend(ids.iter().cloned().map(Sql::Text));
        }
    }
    clauses.push(
        match q.view.as_deref() {
            Some("unread") => "status = 'new'",
            Some("saved") => "status = 'saved'",
            Some("dismissed") => "status = 'dismissed'",
            _ => "status <> 'dismissed'",
        }
        .into(),
    );
    for term in q.q.as_deref().unwrap_or("").split_whitespace() {
        clauses.push("(instr(lower(title), lower(?)) > 0 OR instr(lower(summary), lower(?)) > 0)".into());
        args.push(Sql::Text(term.into()));
        args.push(Sql::Text(term.into()));
    }
    let w = clauses.join(" AND ");
    let total: i64 = conn
        .query_row(&format!("SELECT count(*) FROM feed_items WHERE {w}"), params_from_iter(args.clone()), |r| r.get(0))
        .map_err(e)?;
    let sql = format!(
        "SELECT id, source_id, url, title, author, published_at, summary, image, status FROM feed_items WHERE {w}
         ORDER BY published_at DESC LIMIT {} OFFSET {}",
        q.limit.unwrap_or(60),
        q.offset.unwrap_or(0)
    );
    let mut stmt = conn.prepare(&sql).map_err(e)?;
    let items = stmt
        .query_map(params_from_iter(args), |r| {
            Ok(Item {
                id: r.get(0)?,
                source_id: r.get(1)?,
                url: r.get(2)?,
                title: r.get(3)?,
                author: r.get(4)?,
                published_at: r.get(5)?,
                summary: r.get(6)?,
                image: r.get(7)?,
                status: r.get(8)?,
            })
        })
        .map_err(e)?
        .collect::<Result<_, _>>()
        .map_err(e)?;
    Ok(ItemPage { items, total })
}

#[tauri::command]
pub fn items_query(db: tauri::State<Db>, query: ItemQuery) -> R<ItemPage> {
    let conn = db.0.lock().map_err(e)?;
    query_items(&conn, &query)
}

#[tauri::command]
pub fn items_set_status(db: tauri::State<Db>, ids: Vec<String>, status: String) -> R<()> {
    if !matches!(status.as_str(), "new" | "read" | "saved" | "dismissed") {
        return Err("invalid status".into());
    }
    let conn = db.0.lock().map_err(e)?;
    for id in ids {
        conn.execute("UPDATE feed_items SET status = ?2 WHERE id = ?1", params![id, status]).map_err(e)?;
    }
    Ok(())
}

/// Mark everything unread (optionally of one source) as read.
#[tauri::command]
pub fn items_mark_all_read(db: tauri::State<Db>, source_id: Option<String>) -> R<usize> {
    let conn = db.0.lock().map_err(e)?;
    let n = match source_id {
        Some(s) => conn.execute("UPDATE feed_items SET status = 'read' WHERE status = 'new' AND source_id = ?1", [s]),
        None => conn.execute("UPDATE feed_items SET status = 'read' WHERE status = 'new'", []),
    }
    .map_err(e)?;
    Ok(n)
}

/// The saved article was removed from the library: hand-added entries disappear with it; feed entries
/// become "dismissed" (not deleted — the next refresh would otherwise bring them back as unread).
fn unsave_item(conn: &Connection, id: &str) -> R<()> {
    conn.execute("DELETE FROM feed_items WHERE id = ?1 AND source_id = 'manual'", [id]).map_err(e)?;
    conn.execute("UPDATE feed_items SET status = 'dismissed' WHERE id = ?1 AND status = 'saved'", [id]).map_err(e)?;
    Ok(())
}

#[tauri::command]
pub fn item_unsave(db: tauri::State<Db>, id: String) -> R<()> {
    let conn = db.0.lock().map_err(e)?;
    unsave_item(&conn, &id)
}

#[tauri::command]
pub fn item_set_summary(db: tauri::State<Db>, id: String, summary: String) -> R<()> {
    let conn = db.0.lock().map_err(e)?;
    conn.execute("UPDATE feed_items SET summary = ?2 WHERE id = ?1", params![id, summary]).map_err(e)?;
    Ok(())
}

/// Drop unsaved items older than `before` (ms) — the inbox is a stream, the library is the archive.
#[tauri::command]
pub fn items_prune(db: tauri::State<Db>, before: i64) -> R<usize> {
    let conn = db.0.lock().map_err(e)?;
    conn.execute("DELETE FROM feed_items WHERE status <> 'saved' AND published_at < ?1", [before]).map_err(e)
}

#[tauri::command]
pub fn items_unread_count(db: tauri::State<Db>) -> R<i64> {
    let conn = db.0.lock().map_err(e)?;
    conn.query_row("SELECT count(*) FROM feed_items WHERE status = 'new'", [], |r| r.get(0)).map_err(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RSS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>北美保守评论</title><link>https://nacr.info/WordPress</link>
<item><title>第一篇</title><link>https://nacr.info/WordPress/index.php/2026/11/08/a/</link>
<pubDate>Sun, 08 Nov 2026 22:54:32 +0000</pubDate><dc:creator><![CDATA[志愿者]]></dc:creator>
<description><![CDATA[短摘要 [&#8230;]]]></description>
<content:encoded><![CDATA[<p>正文第一段。</p>]]></content:encoded></item>
<item><title>第二篇</title><link>/rel/b</link><pubDate>Sat, 07 Nov 2026 13:20:25 +0000</pubDate></item>
</channel></rss>"#;

    #[test]
    fn parses_rss_with_content_and_relative_links() {
        let (title, site, items) = parse_feed(RSS.as_bytes(), "https://nacr.info/WordPress/index.php/feed/").unwrap();
        assert_eq!(title, "北美保守评论");
        assert_eq!(site, "https://nacr.info/WordPress");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].author, "志愿者");
        assert!(items[0].html.contains("正文第一段"));
        assert_eq!(items[1].url, "https://nacr.info/rel/b");
        assert!(items[0].published_at > items[1].published_at);
    }

    #[test]
    fn parses_wechat_album_json() {
        let api = wechat_album_api(&reqwest::Url::parse("https://mp.weixin.qq.com/mp/appmsgalbum?__biz=MzA5&action=getalbum&album_id=123#wechat_redirect").unwrap()).unwrap();
        assert!(api.contains("action=getalbum") && api.contains("__biz=MzA5") && api.contains("album_id=123") && api.contains("f=json"));
        let json = r#"{"base_resp":{"ret":0},"getalbum_resp":{"base_info":{"title":"教会论"},
          "article_list":[{"title":"A","url":"http://mp.weixin.qq.com/s?__biz=MzA5&amp;mid=1&amp;idx=1&amp;sn=x","create_time":"1731150000","cover_img_1_1":"https://mmbiz.qpic.cn/c.jpg"}]}}"#;
        let (title, items) = parse_wechat_album(json).unwrap();
        assert_eq!(title, "教会论");
        assert_eq!(items[0].url, "http://mp.weixin.qq.com/s?__biz=MzA5&mid=1&idx=1&sn=x");
        assert_eq!(items[0].published_at, 1_731_150_000_000);
        let single = r#"{"base_resp":{"ret":0},"getalbum_resp":{"article_list":{"title":"B","url":"https://mp.weixin.qq.com/s/b","create_time":1}}}"#;
        assert_eq!(parse_wechat_album(single).unwrap().1.len(), 1);
    }

    #[test]
    fn upgrades_old_schema_and_filters_by_source_set() {
        // A database created before interests existed.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE feed_sources(id TEXT PRIMARY KEY, title TEXT NOT NULL, site_url TEXT NOT NULL DEFAULT '', feed_url TEXT NOT NULL,
               kind TEXT NOT NULL, etag TEXT, last_modified TEXT, last_fetched INTEGER, last_error TEXT, error_count INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL);
             INSERT INTO feed_sources(id, title, feed_url, kind, created_at) VALUES('old', 'Old', 'https://o.x/feed', 'feed', 0);",
        )
        .unwrap();
        init(&conn).unwrap();
        init(&conn).unwrap(); // idempotent
        let v: String = conn.query_row("SELECT interests FROM feed_sources WHERE id = 'old'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "[]");

        conn.execute("INSERT INTO feed_sources(id, title, feed_url, kind, created_at) VALUES('b', 'B', 'https://b.x/feed', 'feed', 0)", []).unwrap();
        let mk = |u: &str| ItemIn { url: u.into(), title: u.into(), author: String::new(), published_at: 5, summary: String::new(), image: String::new() };
        upsert_items(&conn, "old", &[mk("https://o.x/1")]).unwrap();
        upsert_items(&conn, "b", &[mk("https://b.x/1"), mk("https://b.x/2")]).unwrap();
        let by = |ids: Option<Vec<&str>>| {
            query_items(&conn, &ItemQuery { source_ids: ids.map(|v| v.into_iter().map(String::from).collect()), ..Default::default() }).unwrap().total
        };
        assert_eq!(by(None), 3);
        assert_eq!(by(Some(vec!["b"])), 2);
        assert_eq!(by(Some(vec!["b", "old"])), 3);
        assert_eq!(by(Some(vec![])), 0);
        assert_eq!(clean_interests(&[" AI ".into(), "".into(), "AI".into(), "法律".into()]), vec!["AI", "法律"]);
    }

    #[test]
    fn removing_a_saved_article_cleans_the_inbox() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        conn.execute("INSERT INTO feed_sources(id, title, feed_url, kind, created_at) VALUES('manual', '手动添加', 'manual:', 'manual', 0), ('s', 'S', 'https://a.b/feed', 'feed', 0)", []).unwrap();
        let mk = |u: &str| ItemIn { url: u.into(), title: u.into(), author: String::new(), published_at: 5, summary: String::new(), image: String::new() };
        upsert_items(&conn, "manual", &[mk("https://m.x/1")]).unwrap();
        upsert_items(&conn, "s", &[mk("https://a.b/1")]).unwrap();
        conn.execute("UPDATE feed_items SET status = 'saved'", []).unwrap();
        let ids: Vec<String> = ["https://m.x/1", "https://a.b/1"].iter().map(|u| article_id(u).unwrap()).collect();
        for id in &ids {
            unsave_item(&conn, id).unwrap();
        }
        // Manual entry is gone; the feed entry is dismissed, and a refresh doesn't resurrect it.
        assert_eq!(query_items(&conn, &ItemQuery { view: Some("all".into()), ..Default::default() }).unwrap().total, 0);
        assert_eq!(query_items(&conn, &ItemQuery { view: Some("dismissed".into()), ..Default::default() }).unwrap().total, 1);
        upsert_items(&conn, "s", &[mk("https://a.b/1")]).unwrap();
        assert_eq!(query_items(&conn, &ItemQuery { view: Some("unread".into()), ..Default::default() }).unwrap().total, 0);
    }

    #[test]
    fn upsert_keeps_status_and_queries() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        init(&conn).unwrap();
        conn.execute("INSERT INTO feed_sources(id, title, feed_url, kind, created_at) VALUES('s', 'S', 'https://a.b/feed', 'feed', 0)", []).unwrap();
        let mk = |u: &str, t: i64, s: &str| ItemIn { url: u.into(), title: u.into(), author: String::new(), published_at: t, summary: s.into(), image: String::new() };
        assert_eq!(upsert_items(&conn, "s", &[mk("https://a.b/1", 10, ""), mk("https://a.b/2", 20, "两")]).unwrap(), 2);
        conn.execute("UPDATE feed_items SET status = 'dismissed' WHERE url = 'https://a.b/2'", []).unwrap();
        // Re-fetch: no duplicates, dismissed stays dismissed, missing summary gets filled.
        assert_eq!(upsert_items(&conn, "s", &[mk("https://a.b/1?utm_source=x", 10, "一"), mk("https://a.b/2", 20, "两")]).unwrap(), 0);
        let all = query_items(&conn, &ItemQuery::default()).unwrap();
        assert_eq!(all.total, 1);
        assert_eq!(all.items[0].summary, "一");
        assert_eq!(query_items(&conn, &ItemQuery { view: Some("dismissed".into()), ..Default::default() }).unwrap().total, 1);
        assert_eq!(query_items(&conn, &ItemQuery { q: Some("A.B/1".into()), ..Default::default() }).unwrap().total, 1);
    }
}
