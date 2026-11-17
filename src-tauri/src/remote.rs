//! Where the encrypted files go. The sync only needs four things from a server: write a file, read it, list a folder, delete.
//! [`WebDav`] does them over WebDAV (made for 坚果云, see docs/cloud-sync-plan.md); [`Memory`] is an in-memory stand-in for tests,
//! which can also be made to fail part-way, to see what a sync does when the connection drops.

#[cfg(test)]
use std::collections::BTreeMap;
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum RemoteError {
    /// Could not reach the server, or it answered with an error that may pass (5xx, 429, timeouts).
    Network(String),
    /// The server refused for good (wrong account or password, no permission).
    Denied(String),
    /// Anything else.
    Other(String),
}
impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RemoteError::Network(s) => write!(f, "网络问题：{s}"),
            RemoteError::Denied(s) => write!(f, "服务器拒绝了请求：{s}"),
            RemoteError::Other(s) => write!(f, "{s}"),
        }
    }
}
impl std::error::Error for RemoteError {}

pub trait Remote {
    /// The file's bytes, or None if there is no such file.
    fn get(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError>;
    /// Write a file (the folders above it are made as needed). An existing file is replaced.
    fn put(&self, path: &str, data: &[u8]) -> Result<(), RemoteError>;
    /// The names (not paths) of what is directly in a folder; empty if the folder does not exist.
    fn list(&self, dir: &str) -> Result<Vec<String>, RemoteError>;
    fn delete(&self, path: &str) -> Result<(), RemoteError>;
}

// ---------------------------------------------------------------- in memory

/// A server in memory (tests). Cloning shares the same files, like two devices talking to one server.
#[cfg(test)]
#[derive(Clone, Default)]
pub struct Memory {
    inner: std::sync::Arc<Mutex<MemInner>>,
}
#[cfg(test)]
#[derive(Default)]
struct MemInner {
    files: BTreeMap<String, Vec<u8>>,
    /// Fail every write after this many more have worked (None: never).
    fail_puts_after: Option<usize>,
    puts: usize,
    gets: usize,
    bytes_up: usize,
}
#[cfg(test)]
impl Memory {
    pub fn new() -> Memory {
        Memory::default()
    }
    pub fn fail_puts_after(&self, n: Option<usize>) {
        self.inner.lock().unwrap().fail_puts_after = n;
    }
    pub fn paths(&self) -> Vec<String> {
        self.inner.lock().unwrap().files.keys().cloned().collect()
    }
    pub fn counts(&self) -> (usize, usize, usize) {
        let i = self.inner.lock().unwrap();
        (i.puts, i.gets, i.bytes_up)
    }
    pub fn corrupt(&self, path: &str) {
        if let Some(f) = self.inner.lock().unwrap().files.get_mut(path) {
            let mid = f.len() / 2;
            f[mid] ^= 0xff;
        }
    }
}
#[cfg(test)]
impl Remote for Memory {
    fn get(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
        let mut i = self.inner.lock().unwrap();
        i.gets += 1;
        Ok(i.files.get(path).cloned())
    }
    fn put(&self, path: &str, data: &[u8]) -> Result<(), RemoteError> {
        let mut i = self.inner.lock().unwrap();
        if let Some(n) = i.fail_puts_after {
            if i.puts >= n {
                return Err(RemoteError::Network("连接中断（测试）".into()));
            }
        }
        i.puts += 1;
        i.bytes_up += data.len();
        i.files.insert(path.to_string(), data.to_vec());
        Ok(())
    }
    fn list(&self, dir: &str) -> Result<Vec<String>, RemoteError> {
        let prefix = if dir.is_empty() { String::new() } else { format!("{}/", dir.trim_end_matches('/')) };
        let i = self.inner.lock().unwrap();
        let mut seen = HashSet::new();
        let mut out = vec![];
        for k in i.files.keys() {
            if let Some(rest) = k.strip_prefix(&prefix) {
                let name = rest.split('/').next().unwrap_or("").to_string();
                if !name.is_empty() && seen.insert(name.clone()) {
                    out.push(name);
                }
            }
        }
        Ok(out)
    }
    fn delete(&self, path: &str) -> Result<(), RemoteError> {
        let mut i = self.inner.lock().unwrap();
        let prefix = format!("{}/", path.trim_end_matches('/'));
        i.files.retain(|k, _| k != path && !k.starts_with(&prefix));
        Ok(())
    }
}

// ---------------------------------------------------------------- WebDAV

/// A WebDAV folder, e.g. `https://dav.jianguoyun.com/dav/` with the root `我的坚果云/墨边`. Plain `reqwest` over HTTPS.
/// Short hiccups (timeouts, 5xx, 429) are retried a few times with a growing pause; a refusal (401, 403) is not.
pub struct WebDav {
    client: reqwest::blocking::Client,
    base: reqwest::Url,
    root: Vec<String>,
    user: String,
    password: String,
    made: Mutex<HashSet<String>>,
}

impl WebDav {
    pub fn new(url: &str, root: &str, user: &str, password: &str) -> Result<WebDav, RemoteError> {
        let mut base = reqwest::Url::parse(url).map_err(|e| RemoteError::Other(format!("地址不对：{e}")))?;
        if !matches!(base.scheme(), "https" | "http") {
            return Err(RemoteError::Other("地址要以 https:// 开头".into()));
        }
        if !base.path().ends_with('/') {
            let p = format!("{}/", base.path());
            base.set_path(&p);
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(20))
            .user_agent("Marginalia-sync")
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| RemoteError::Other(e.to_string()))?;
        Ok(WebDav { client, base, root: root.split('/').filter(|s| !s.is_empty()).map(String::from).collect(), user: user.to_string(), password: password.to_string(), made: Mutex::new(HashSet::new()) })
    }

    fn url(&self, path: &str) -> Result<reqwest::Url, RemoteError> {
        let mut u = self.base.clone();
        {
            let mut segs = u.path_segments_mut().map_err(|_| RemoteError::Other("地址不对".into()))?;
            segs.pop_if_empty();
            for s in self.root.iter().map(String::as_str).chain(path.split('/').filter(|s| !s.is_empty())) {
                segs.push(s);
            }
        }
        Ok(u)
    }

    fn send(&self, method: &str, path: &str, body: Option<Vec<u8>>, headers: &[(&str, &str)]) -> Result<reqwest::blocking::Response, RemoteError> {
        let url = self.url(path)?;
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| RemoteError::Other(e.to_string()))?;
        let mut last = RemoteError::Network("没有回应".into());
        for attempt in 0..4u32 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(600 * 2u64.pow(attempt - 1)));
            }
            let mut req = self.client.request(method.clone(), url.clone()).basic_auth(&self.user, Some(&self.password));
            for (k, v) in headers {
                req = req.header(*k, *v);
            }
            if let Some(b) = &body {
                req = req.body(b.clone());
            }
            match req.send() {
                Ok(r) => {
                    let s = r.status().as_u16();
                    if s == 401 || s == 403 {
                        return Err(RemoteError::Denied(format!("{s}（账号或应用密码不对，或没有权限）")));
                    }
                    if s == 429 || s >= 500 {
                        last = RemoteError::Network(format!("服务器返回 {s}"));
                        continue;
                    }
                    return Ok(r);
                }
                Err(e) => last = RemoteError::Network(e.to_string()),
            }
        }
        Err(last)
    }

    /// Make the folders above `path`, one level at a time (a server does not make them for us).
    fn make_parents(&self, path: &str) -> Result<(), RemoteError> {
        let mut dir = String::new();
        let mut parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        parts.pop();
        // the root folders first
        let mut full: Vec<String> = vec![];
        for r in &self.root {
            full.push(r.clone());
            self.mkcol_once(&full.join("/"), true)?;
        }
        for p in parts {
            if !dir.is_empty() {
                dir.push('/');
            }
            dir.push_str(p);
            self.mkcol_once(&dir, false)?;
        }
        Ok(())
    }

    fn mkcol_once(&self, dir: &str, absolute: bool) -> Result<(), RemoteError> {
        if self.made.lock().unwrap().contains(&format!("{absolute}:{dir}")) {
            return Ok(());
        }
        let url_path = if absolute {
            // `dir` already starts at the top of the server: build it without the root
            let mut u = self.base.clone();
            {
                let mut segs = u.path_segments_mut().map_err(|_| RemoteError::Other("地址不对".into()))?;
                segs.pop_if_empty();
                for s in dir.split('/') {
                    segs.push(s);
                }
            }
            u
        } else {
            self.url(dir)?
        };
        let mut last = RemoteError::Network("没有回应".into());
        for attempt in 0..3u32 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(600 * 2u64.pow(attempt - 1)));
            }
            match self.client.request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), url_path.clone()).basic_auth(&self.user, Some(&self.password)).send() {
                Ok(r) => {
                    let s = r.status().as_u16();
                    // 201 made, 405 / 409-with-existing / 301 already there; a top-level folder that cannot be made is simply there or not allowed
                    if s == 201 || s == 405 || s == 200 || s == 301 || s == 302 {
                        self.made.lock().unwrap().insert(format!("{absolute}:{dir}"));
                        return Ok(());
                    }
                    if s == 401 || s == 403 {
                        return Err(RemoteError::Denied(format!("{s}（账号或应用密码不对，或没有权限）")));
                    }
                    if s == 400 && absolute && !dir.contains('/') {
                        // 坚果云 does not let anything be made at the very top: the first folder (「我的坚果云」) is already there
                        self.made.lock().unwrap().insert(format!("{absolute}:{dir}"));
                        return Ok(());
                    }
                    if s == 429 || s >= 500 {
                        last = RemoteError::Network(format!("服务器返回 {s}"));
                        continue;
                    }
                    return Err(RemoteError::Other(format!("不能创建文件夹 {dir}（{s}）")));
                }
                Err(e) => last = RemoteError::Network(e.to_string()),
            }
        }
        Err(last)
    }
}

impl Remote for WebDav {
    fn get(&self, path: &str) -> Result<Option<Vec<u8>>, RemoteError> {
        let r = self.send("GET", path, None, &[])?;
        match r.status().as_u16() {
            200 => Ok(Some(r.bytes().map_err(|e| RemoteError::Network(e.to_string()))?.to_vec())),
            404 => Ok(None),
            s => Err(RemoteError::Other(format!("读取 {path} 失败（{s}）"))),
        }
    }

    fn put(&self, path: &str, data: &[u8]) -> Result<(), RemoteError> {
        self.make_parents(path)?;
        let r = self.send("PUT", path, Some(data.to_vec()), &[("Content-Type", "application/octet-stream")])?;
        match r.status().as_u16() {
            200 | 201 | 204 => Ok(()),
            s => Err(RemoteError::Other(format!("写入 {path} 失败（{s}）"))),
        }
    }

    fn list(&self, dir: &str) -> Result<Vec<String>, RemoteError> {
        let body = r#"<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>"#;
        let r = self.send("PROPFIND", dir, Some(body.as_bytes().to_vec()), &[("Depth", "1"), ("Content-Type", "application/xml")])?;
        match r.status().as_u16() {
            207 => {
                let text = r.text().map_err(|e| RemoteError::Network(e.to_string()))?;
                Ok(parse_listing(&text, self.url(dir)?.path()))
            }
            404 => Ok(vec![]),
            s => Err(RemoteError::Other(format!("列出 {dir} 失败（{s}）"))),
        }
    }

    fn delete(&self, path: &str) -> Result<(), RemoteError> {
        let r = self.send("DELETE", path, None, &[])?;
        match r.status().as_u16() {
            200 | 204 | 404 => Ok(()),
            s => Err(RemoteError::Other(format!("删除 {path} 失败（{s}）"))),
        }
    }
}

/// The names directly inside a folder, from a PROPFIND (Depth 1) answer. `dir_path` is the folder's own path on the server
/// (its entry is skipped). Namespace prefixes (`d:`, `D:`, none) do not matter.
pub fn parse_listing(xml: &str, dir_path: &str) -> Vec<String> {
    let lower = xml.to_ascii_lowercase();
    let mut out = vec![];
    let dir = percent_decode(dir_path).trim_end_matches('/').to_string();
    let mut at = 0;
    while let Some(open) = lower[at..].find("href>") {
        let start = at + open + "href>".len();
        // the opening tag must be `<href>` or `<x:href>`, not the closing `</href>`
        let tag_start = lower[..at + open].rfind('<').unwrap_or(0);
        if lower[tag_start..].starts_with("</") {
            at = start;
            continue;
        }
        let Some(end) = lower[start..].find('<') else { break };
        let href = &xml[start..start + end];
        at = start + end;
        let path = href.split("://").last().map(|s| if href.contains("://") { s.find('/').map(|i| &s[i..]).unwrap_or("/") } else { href }).unwrap_or(href);
        let decoded = percent_decode(path);
        let trimmed = decoded.trim_end_matches('/');
        if trimmed == dir {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix(&format!("{dir}/")) {
            if !rest.is_empty() && !rest.contains('/') {
                out.push(rest.to_string());
            }
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16)) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_remote_behaves_like_a_server() {
        let m = Memory::new();
        assert_eq!(m.get("a/b.txt").unwrap(), None);
        m.put("changes/dev1/1.bin", b"x").unwrap();
        m.put("changes/dev1/2.bin", b"y").unwrap();
        m.put("changes/dev2/1.bin", b"z").unwrap();
        m.put("keys.json", b"{}").unwrap();
        let mut top = m.list("").unwrap();
        top.sort();
        assert_eq!(top, ["changes", "keys.json"]);
        let mut devs = m.list("changes").unwrap();
        devs.sort();
        assert_eq!(devs, ["dev1", "dev2"]);
        assert_eq!(m.list("changes/dev1").unwrap().len(), 2);
        assert!(m.list("nothing/here").unwrap().is_empty());
        m.put("keys.json", b"new").unwrap();
        assert_eq!(m.get("keys.json").unwrap().unwrap(), b"new");
        m.delete("changes/dev1").unwrap();
        assert!(m.list("changes/dev1").unwrap().is_empty());
        assert_eq!(m.get("changes/dev2/1.bin").unwrap().unwrap(), b"z");
    }

    #[test]
    fn a_memory_remote_can_drop_the_connection() {
        let m = Memory::new();
        m.fail_puts_after(Some(1));
        m.put("a", b"1").unwrap();
        assert!(matches!(m.put("b", b"2"), Err(RemoteError::Network(_))));
        assert_eq!(m.get("b").unwrap(), None);
    }

    #[test]
    fn a_propfind_answer_gives_the_names_inside_the_folder() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/%E5%A2%A8%E8%BE%B9/changes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
 <d:response><d:href>/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/%E5%A2%A8%E8%BE%B9/changes/dev%201/</d:href></d:response>
 <d:response><d:href>/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/%E5%A2%A8%E8%BE%B9/changes/0000000007.bin</d:href></d:response>
</d:multistatus>"#;
        let mut names = parse_listing(xml, "/dav/我的坚果云/墨边/changes");
        names.sort();
        assert_eq!(names, ["0000000007.bin", "dev 1"]);
        // without a prefix, and with a full address in the href
        let xml2 = "<multistatus><response><href>https://example.com/dav/a/</href></response><response><href>https://example.com/dav/a/b.txt</href></response></multistatus>";
        assert_eq!(parse_listing(xml2, "/dav/a/"), ["b.txt"]);
        assert!(parse_listing("<multistatus/>", "/dav/a").is_empty());
    }

    #[test]
    fn addresses_are_checked_and_paths_are_encoded() {
        assert!(WebDav::new("not a url", "", "u", "p").is_err());
        assert!(WebDav::new("ftp://example.com/dav/", "", "u", "p").is_err());
        let d = WebDav::new("https://dav.example.com/dav", "我的坚果云/墨边", "u", "p").unwrap();
        let u = d.url("changes/dev1/0000000001.bin").unwrap();
        assert_eq!(u.path(), "/dav/%E6%88%91%E7%9A%84%E5%9D%9A%E6%9E%9C%E4%BA%91/%E5%A2%A8%E8%BE%B9/changes/dev1/0000000001.bin");
    }
}
