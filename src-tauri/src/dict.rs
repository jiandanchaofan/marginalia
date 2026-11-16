//! The dictionaries the person has added (MDict files), looking words up in them, and making an entry showable on its own:
//! the style sheets, pictures and scripts an entry refers to are found in the .mdd files (or next to the .mdx) and put into
//! the page, so it can be shown in a closed frame that is not allowed to reach anything else.
//! See docs/dictionary-plan.md.

use crate::mdict::Mdict;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_RESOURCE: usize = 3 << 20; // a picture or style sheet bigger than this is left out of a page
const MAX_PAGE: usize = 12 << 20; // everything put into one entry's page

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Config {
    pub id: String,
    pub path: String,
    pub enabled: bool,
}

/// A dictionary that has been opened: the .mdx, its .mdd files, and where it lives.
pub struct Opened {
    pub title: String,
    pub mdx: Mdict,
    pub mdds: Vec<Mdict>,
    pub dir: PathBuf,
    pub stem: String,
}

#[derive(Default)]
pub struct DictState {
    list: Mutex<Option<Vec<Config>>>,
    open: Mutex<HashMap<String, Arc<Opened>>>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub id: String,
    pub title: String,
    pub path: String,
    pub enabled: bool,
    pub entries: u64,
    pub resource_files: usize,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub dict_id: String,
    pub title: String,
    pub headword: String,
    /// The entry's HTML with its style sheets, pictures (and, if it needs them, scripts) put in.
    pub body: String,
    pub scripts: bool,
}

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub query: String,
    pub entries: Vec<Entry>,
    /// Words that start like the query, when nothing was found.
    pub suggestions: Vec<String>,
    /// Dictionaries that could not be opened (missing file, ...), with the reason.
    pub problems: Vec<String>,
}

pub fn id_of(path: &str) -> String {
    hex::encode(&Sha256::digest(path.as_bytes())[..6])
}

// ---------------------------------------------------------------- files next to a dictionary

/// The .mdd files that belong to `x.mdx`: `x.mdd`, `x.1.mdd`, `x.2.mdd`, ... in the same folder.
pub fn sibling_mdds(mdx: &Path) -> Vec<PathBuf> {
    let (Some(dir), Some(stem)) = (mdx.parent(), mdx.file_stem().and_then(|s| s.to_str())) else { return vec![] };
    let mut found: Vec<(u32, PathBuf)> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.extension().map(|x| x.eq_ignore_ascii_case("mdd")).unwrap_or(false) {
                continue;
            }
            let Some(name) = p.file_stem().and_then(|s| s.to_str()) else { continue };
            if name == stem {
                found.push((0, p));
            } else if let Some(n) = name.strip_prefix(stem).and_then(|r| r.strip_prefix('.')).and_then(|r| r.parse::<u32>().ok()) {
                found.push((n + 1, p));
            }
        }
    }
    found.sort_by_key(|f| f.0);
    found.into_iter().map(|f| f.1).collect()
}

pub fn open_dictionary(mdx: &Path) -> Result<Opened, String> {
    if !mdx.extension().map(|x| x.eq_ignore_ascii_case("mdx")).unwrap_or(false) {
        return Err("请选择 .mdx 词典文件".into());
    }
    let m = Mdict::open(mdx)?;
    let mut mdds = Vec::new();
    for p in sibling_mdds(mdx) {
        // a resource file that cannot be read only costs the pictures and sounds it has
        if let Ok(d) = Mdict::open(&p) {
            mdds.push(d);
        }
    }
    let title = {
        let t = m.header.title.trim();
        let t = if t.is_empty() || t.starts_with("Title (No HTML") { mdx.file_stem().and_then(|s| s.to_str()).unwrap_or("词典").to_string() } else { t.to_string() };
        t
    };
    Ok(Opened {
        title,
        mdx: m,
        mdds,
        dir: mdx.parent().map(|p| p.to_path_buf()).unwrap_or_default(),
        stem: mdx.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string(),
    })
}

fn mime_of(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "css" => "text/css",
        "js" => "text/javascript",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "spx" => "audio/ogg",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() + 0 && i + 2 <= b.len() - 1 + 0 {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

impl Opened {
    /// A file an entry refers to, by the name the entry uses: from an .mdd, or next to the .mdx (a style sheet or script
    /// called something else than the entry says is taken to be the one with the dictionary's own name).
    pub fn resource(&self, name: &str) -> Option<(Vec<u8>, &'static str)> {
        let clean = percent_decode(name.trim().trim_start_matches("file:///").trim_start_matches("file://").trim_start_matches("./"));
        let clean = clean.split(['#', '?']).next().unwrap_or("").to_string();
        if clean.is_empty() || clean.contains("://") {
            return None;
        }
        for m in &self.mdds {
            if let Ok(Some(b)) = m.resource(&clean) {
                return Some((b, mime_of(&clean)));
            }
        }
        // next to the dictionary
        let ext = clean.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        let beside = |n: &str| -> Option<Vec<u8>> {
            if n.contains("..") || n.contains('/') || n.contains('\\') {
                return None;
            }
            fs::read(self.dir.join(n)).ok()
        };
        if let Some(b) = beside(&clean) {
            return Some((b, mime_of(&clean)));
        }
        if ext == "css" || ext == "js" {
            if let Some(b) = beside(&format!("{}.{ext}", self.stem)) {
                return Some((b, mime_of(&clean)));
            }
        }
        None
    }

    fn data_uri(&self, name: &str, budget: &mut usize) -> Option<String> {
        let (bytes, mime) = self.resource(name)?;
        if bytes.len() > MAX_RESOURCE || bytes.len() > *budget {
            return None;
        }
        *budget -= bytes.len();
        Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    }
}

// ---------------------------------------------------------------- making an entry showable on its own

/// The value of an attribute inside a tag's text, and the span it occupies (quotes included).
fn attr_span(tag: &str, name: &str) -> Option<(usize, usize, String)> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        let before_ok = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace() || lower.as_bytes()[at - 1] == b'"' || lower.as_bytes()[at - 1] == b'\'';
        let mut j = at + name.len();
        while j < tag.len() && tag.as_bytes()[j] == b' ' {
            j += 1;
        }
        if before_ok && j < tag.len() && tag.as_bytes()[j] == b'=' {
            j += 1;
            while j < tag.len() && tag.as_bytes()[j] == b' ' {
                j += 1;
            }
            if j < tag.len() {
                let q = tag.as_bytes()[j];
                if q == b'"' || q == b'\'' {
                    if let Some(e) = tag[j + 1..].find(q as char) {
                        return Some((at, j + 1 + e + 1, tag[j + 1..j + 1 + e].to_string()));
                    }
                } else {
                    let e = tag[j..].find(|c: char| c.is_whitespace() || c == '>').unwrap_or(tag.len() - j);
                    return Some((at, j + e, tag[j..j + e].to_string()));
                }
            }
        }
        from = at + name.len();
    }
    None
}

/// Style sheet text with every `url(...)` that is a file of the dictionary turned into a data address.
fn inline_css_urls(open: &Opened, css: &str, budget: &mut usize) -> String {
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(i) = rest.find("url(") {
        out.push_str(&rest[..i + 4]);
        let after = &rest[i + 4..];
        let Some(end) = after.find(')') else {
            rest = after;
            break;
        };
        let raw = after[..end].trim().trim_matches(|c| c == '"' || c == '\'');
        if raw.starts_with("data:") || raw.starts_with('#') || raw.is_empty() {
            out.push_str(&after[..end]);
        } else if let Some(uri) = open.data_uri(raw, budget) {
            out.push_str(&uri);
        } else {
            out.push_str(&after[..end]);
        }
        out.push(')');
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// The entry with its files put in. Scripts are kept only when the entry uses any (and only the dictionary's own).
pub fn render(open: &Opened, html: &str) -> (String, bool) {
    let lower = html.to_ascii_lowercase();
    let scripts = lower.contains("<script") || lower.contains(" onclick=") || lower.contains(" onload=");
    let mut budget = MAX_PAGE;
    let mut out = String::with_capacity(html.len() + 1024);
    let mut i = 0;
    while i < html.len() {
        let Some(lt) = html[i..].find('<') else {
            out.push_str(&html[i..]);
            break;
        };
        out.push_str(&html[i..i + lt]);
        let at = i + lt;
        // a comment is copied as it is
        if html[at..].starts_with("<!--") {
            let end = html[at..].find("-->").map(|e| at + e + 3).unwrap_or(html.len());
            out.push_str(&html[at..end]);
            i = end;
            continue;
        }
        let Some(gt) = html[at..].find('>') else {
            out.push_str(&html[at..]);
            break;
        };
        let tag_end = at + gt + 1;
        let tag = &html[at..tag_end];
        let name: String = tag[1..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
        match name.as_str() {
            "link" => {
                let is_css = attr_span(tag, "rel").map(|(_, _, v)| v.to_ascii_lowercase().contains("stylesheet")).unwrap_or(false);
                match (is_css, attr_span(tag, "href")) {
                    (true, Some((_, _, href))) => {
                        if let Some((bytes, _)) = open.resource(&href) {
                            let css = String::from_utf8_lossy(&bytes).into_owned();
                            let css = inline_css_urls(open, &css, &mut budget);
                            out.push_str("<style>");
                            out.push_str(&css.replace("</style", "<\\/style"));
                            out.push_str("</style>");
                        }
                        // a style sheet that cannot be found is dropped (it could only be a web address)
                    }
                    _ => {}
                }
                i = tag_end;
            }
            "script" => {
                // up to the closing tag
                let close = lower[tag_end..].find("</script").map(|e| tag_end + e);
                let (body_end, after) = match close {
                    Some(c) => (c, lower[c..].find('>').map(|g| c + g + 1).unwrap_or(html.len())),
                    None => (html.len(), html.len()),
                };
                if scripts {
                    if let Some((_, _, src)) = attr_span(tag, "src") {
                        if let Some((bytes, _)) = open.resource(&src) {
                            out.push_str("<script>");
                            out.push_str(&String::from_utf8_lossy(&bytes).replace("</script", "<\\/script"));
                            out.push_str("</script>");
                        }
                    } else {
                        out.push_str("<script>");
                        out.push_str(&html[tag_end..body_end]);
                        out.push_str("</script>");
                    }
                }
                i = after;
            }
            "img" | "source" | "audio" | "video" | "image" => {
                let mut t = tag.to_string();
                if let Some((s, e, src)) = attr_span(&t, "src") {
                    if !src.starts_with("data:") {
                        if let Some(uri) = open.data_uri(&src, &mut budget) {
                            t.replace_range(s..e, &format!("src=\"{uri}\""));
                        }
                    }
                }
                out.push_str(&t);
                i = tag_end;
            }
            _ => {
                out.push_str(tag);
                i = tag_end;
            }
        }
    }
    (out, scripts)
}

// ---------------------------------------------------------------- looking up

/// The word as it should be looked up: no quotes or punctuation around it, spaces made single.
pub fn clean_query(q: &str) -> String {
    let t: String = q.split_whitespace().collect::<Vec<_>>().join(" ");
    t.trim_matches(|c: char| !(c.is_alphanumeric() || c == '\'' && false)).to_string()
}

pub fn lookup_in(open: &Opened, id: &str, query: &str) -> Result<Option<Entry>, String> {
    let mut tries = vec![query.to_string()];
    let lower = query.to_lowercase();
    if lower != query {
        tries.push(lower);
    }
    for q in tries {
        if let Some((headword, html)) = open.mdx.lookup(&q)? {
            let (body, scripts) = render(open, &html);
            return Ok(Some(Entry { dict_id: id.to_string(), title: open.title.clone(), headword, body, scripts }));
        }
    }
    Ok(None)
}

impl DictState {
    fn configs(&self, dir: &Path) -> Vec<Config> {
        let mut g = self.list.lock().unwrap();
        if g.is_none() {
            let list = fs::read_to_string(dir.join("dictionaries.json")).ok().and_then(|s| serde_json::from_str::<Vec<Config>>(&s).ok()).unwrap_or_default();
            *g = Some(list);
        }
        g.clone().unwrap()
    }

    fn save(&self, dir: &Path, list: Vec<Config>) -> Result<(), String> {
        let json = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
        fs::write(dir.join("dictionaries.json"), json).map_err(|e| format!("保存词典设置失败：{e}"))?;
        *self.list.lock().unwrap() = Some(list);
        Ok(())
    }

    fn opened(&self, cfg: &Config) -> Result<Arc<Opened>, String> {
        if let Some(o) = self.open.lock().unwrap().get(&cfg.id) {
            return Ok(o.clone());
        }
        let o = Arc::new(open_dictionary(Path::new(&cfg.path))?);
        self.open.lock().unwrap().insert(cfg.id.clone(), o.clone());
        Ok(o)
    }

    pub fn info(&self, dir: &Path) -> Vec<Info> {
        self.configs(dir)
            .into_iter()
            .map(|c| match self.opened(&c) {
                Ok(o) => Info { id: c.id.clone(), title: o.title.clone(), path: c.path.clone(), enabled: c.enabled, entries: o.mdx.entries, resource_files: o.mdds.len(), error: None },
                Err(e) => Info { id: c.id.clone(), title: Path::new(&c.path).file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string(), path: c.path.clone(), enabled: c.enabled, entries: 0, resource_files: 0, error: Some(e) },
            })
            .collect()
    }

    pub fn add(&self, dir: &Path, path: &str) -> Result<Vec<Info>, String> {
        let o = open_dictionary(Path::new(path))?; // refuses what cannot be read, with the reason
        let id = id_of(path);
        let mut list = self.configs(dir);
        if !list.iter().any(|c| c.id == id) {
            list.push(Config { id: id.clone(), path: path.to_string(), enabled: true });
            self.save(dir, list)?;
        }
        self.open.lock().unwrap().insert(id, Arc::new(o));
        Ok(self.info(dir))
    }

    pub fn remove(&self, dir: &Path, id: &str) -> Result<Vec<Info>, String> {
        let list: Vec<Config> = self.configs(dir).into_iter().filter(|c| c.id != id).collect();
        self.save(dir, list)?;
        self.open.lock().unwrap().remove(id);
        Ok(self.info(dir))
    }

    pub fn set_enabled(&self, dir: &Path, id: &str, on: bool) -> Result<Vec<Info>, String> {
        let mut list = self.configs(dir);
        if let Some(c) = list.iter_mut().find(|c| c.id == id) {
            c.enabled = on;
        }
        self.save(dir, list)?;
        Ok(self.info(dir))
    }

    /// Move a dictionary one place up (`-1`) or down (`1`) in the order they are shown in.
    pub fn shift(&self, dir: &Path, id: &str, by: i32) -> Result<Vec<Info>, String> {
        let mut list = self.configs(dir);
        if let Some(i) = list.iter().position(|c| c.id == id) {
            let j = (i as i32 + by).clamp(0, list.len() as i32 - 1) as usize;
            let c = list.remove(i);
            list.insert(j, c);
        }
        self.save(dir, list)?;
        Ok(self.info(dir))
    }

    pub fn lookup(&self, dir: &Path, query: &str) -> Found {
        let q = clean_query(query);
        let mut found = Found { query: q.clone(), ..Default::default() };
        if q.is_empty() {
            return found;
        }
        let mut first: Option<Arc<Opened>> = None;
        for c in self.configs(dir).into_iter().filter(|c| c.enabled) {
            match self.opened(&c) {
                Ok(o) => {
                    if first.is_none() {
                        first = Some(o.clone());
                    }
                    match lookup_in(&o, &c.id, &q) {
                        Ok(Some(e)) => found.entries.push(e),
                        Ok(None) => {}
                        Err(e) => found.problems.push(format!("{}：{e}", o.title)),
                    }
                }
                Err(e) => found.problems.push(format!("{}：{e}", Path::new(&c.path).file_stem().and_then(|s| s.to_str()).unwrap_or(""))),
            }
        }
        if found.entries.is_empty() {
            if let Some(o) = first {
                found.suggestions = o.mdx.prefix(&q, 8).unwrap_or_default();
            }
        }
        found
    }

    pub fn resource(&self, dir: &Path, id: &str, name: &str) -> Result<Option<(String, String)>, String> {
        let Some(c) = self.configs(dir).into_iter().find(|c| c.id == id) else { return Ok(None) };
        let o = self.opened(&c)?;
        Ok(o.resource(name).map(|(b, mime)| (mime.to_string(), base64::engine::general_purpose::STANDARD.encode(b))))
    }
}

// ---------------------------------------------------------------- commands

fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::app_dir(app)
}

#[tauri::command]
pub fn dict_list(app: tauri::AppHandle, st: tauri::State<DictState>) -> Result<Vec<Info>, String> {
    Ok(st.info(&dir(&app)?))
}
#[tauri::command]
pub fn dict_add(app: tauri::AppHandle, st: tauri::State<DictState>, path: String) -> Result<Vec<Info>, String> {
    st.add(&dir(&app)?, &path)
}
#[tauri::command]
pub fn dict_remove(app: tauri::AppHandle, st: tauri::State<DictState>, id: String) -> Result<Vec<Info>, String> {
    st.remove(&dir(&app)?, &id)
}
#[tauri::command]
pub fn dict_set_enabled(app: tauri::AppHandle, st: tauri::State<DictState>, id: String, on: bool) -> Result<Vec<Info>, String> {
    st.set_enabled(&dir(&app)?, &id, on)
}
#[tauri::command]
pub fn dict_shift(app: tauri::AppHandle, st: tauri::State<DictState>, id: String, by: i32) -> Result<Vec<Info>, String> {
    st.shift(&dir(&app)?, &id, by)
}
#[tauri::command]
pub fn dict_lookup(app: tauri::AppHandle, st: tauri::State<DictState>, query: String) -> Result<Found, String> {
    Ok(st.lookup(&dir(&app)?, &query))
}
#[tauri::command]
pub fn dict_resource(app: tauri::AppHandle, st: tauri::State<DictState>, id: String, name: String) -> Result<Option<(String, String)>, String> {
    st.resource(&dir(&app)?, &id, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("marginalia-dict-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn finds_the_mdd_files_that_belong_to_a_dictionary() {
        let d = temp("sib");
        for n in ["Oxford.mdx", "Oxford.mdd", "Oxford.1.mdd", "Oxford.2.mdd", "Oxford.10.mdd", "Other.mdd", "Oxford.css", "OxfordX.mdd"] {
            fs::write(d.join(n), b"x").unwrap();
        }
        let names: Vec<String> = sibling_mdds(&d.join("Oxford.mdx")).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["Oxford.mdd", "Oxford.1.mdd", "Oxford.2.mdd", "Oxford.10.mdd"], "the dictionary's own, then the numbered ones in order; not other dictionaries'");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn clean_query_takes_off_quotes_and_punctuation() {
        assert_eq!(clean_query("  “hello,” "), "hello");
        assert_eq!(clean_query("ice   cream."), "ice cream");
        assert_eq!(clean_query("(don't)"), "don't");
        assert_eq!(clean_query("词典。"), "词典");
        assert_eq!(clean_query("   "), "");
    }

    #[test]
    fn attributes_are_found_whatever_the_quotes() {
        let t = r#"<link rel="stylesheet" type='text/css' href=oald10.css>"#;
        assert_eq!(attr_span(t, "href").unwrap().2, "oald10.css");
        assert_eq!(attr_span(t, "type").unwrap().2, "text/css");
        assert_eq!(attr_span(t, "rel").unwrap().2, "stylesheet");
        assert!(attr_span(t, "src").is_none());
        let img = r#"<img data-src="no.png" src = "yes.png" alt="x">"#;
        assert_eq!(attr_span(img, "src").unwrap().2, "yes.png");
    }

    fn opened_in(dir: &Path, files: &[(&str, &[u8])]) -> Opened {
        // an Opened with no .mdd, only files beside the dictionary (enough to test the page making)
        for (n, b) in files {
            fs::write(dir.join(n), b).unwrap();
        }
        let m = crate::mdict::tests_support::tiny(dir);
        Opened { title: "T".into(), mdx: m, mdds: vec![], dir: dir.to_path_buf(), stem: "tiny".into() }
    }

    #[test]
    fn an_entry_is_made_self_contained() {
        let d = temp("render");
        let o = opened_in(&d, &[("tiny.css", b"body{background:url(bg.png)} .w{color:red}"), ("bg.png", &[137, 80, 78, 71]), ("pic.png", &[1, 2, 3, 4]), ("tiny.js", b"window.x=1;")]);
        let html = r#"<link rel="stylesheet" type="text/css" href="other.css"><script type="text/javascript" src="other.js"></script><div class="w">hi <img src="pic.png"> <a href="entry://hello">hello</a> <a href="sound://a.mp3">▶</a> <img src="http://evil.example/x.png"></div>"#;
        let (page, scripts) = render(&o, html);
        assert!(scripts, "it has a script");
        assert!(page.contains("<style>body{background:url(data:image/png;base64,"), "{page}");
        assert!(page.contains(".w{color:red}"), "the style sheet named other.css is the dictionary's own tiny.css");
        assert!(page.contains("<script>window.x=1;</script>"), "{page}");
        assert!(page.contains(r#"<img src="data:image/png;base64,AQIDBA==">"#), "{page}");
        assert!(page.contains(r#"href="entry://hello""#) && page.contains(r#"href="sound://a.mp3""#), "dictionary links stay for the page to handle");
        assert!(page.contains("http://evil.example/x.png"), "a web address is left as it is: the frame's rules block it");
        assert!(!page.contains("<link"), "no link tag is left");
        // without scripts in the entry nothing runs
        let (plain, scripts2) = render(&o, r#"<link rel="stylesheet" href="tiny.css"><div class="w">hi</div>"#);
        assert!(!scripts2 && !plain.contains("<script"));
        // an inline script of an entry that has scripts is kept, and one cannot close the style tag early
        let (p3, s3) = render(&o, "<script>var a=1;</script><p>x</p>");
        assert!(s3 && p3.contains("<script>var a=1;</script>"));
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn files_cannot_be_asked_for_outside_the_dictionary_folder() {
        let d = temp("escape");
        let secret = d.parent().unwrap().join(format!("secret-{}.txt", std::process::id()));
        fs::write(&secret, b"nope").unwrap();
        let o = opened_in(&d, &[("ok.png", &[9, 9])]);
        assert!(o.resource("ok.png").is_some());
        assert!(o.resource(&format!("../{}", secret.file_name().unwrap().to_string_lossy())).is_none());
        assert!(o.resource("..\\x.png").is_none());
        assert!(o.resource("C:/Windows/win.ini").is_none());
        assert!(o.resource("http://example.com/a.png").is_none());
        let _ = fs::remove_file(secret);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn the_list_is_kept_in_order_and_survives_a_restart() {
        let d = temp("list");
        let make = |n: &str| {
            let p = d.join(format!("{n}.mdx"));
            fs::write(&p, crate::mdict::tests_support::bytes()).unwrap();
            p.to_string_lossy().into_owned()
        };
        let st = DictState::default();
        let (a, b) = (make("A"), make("B"));
        st.add(&d, &a).unwrap();
        let list = st.add(&d, &b).unwrap();
        assert_eq!(list.iter().map(|i| i.title.as_str()).collect::<Vec<_>>(), vec!["Tiny test", "Tiny test"]);
        assert_eq!(list.iter().map(|i| i.path.clone()).collect::<Vec<_>>(), vec![a.clone(), b.clone()]);
        // adding the same path again changes nothing
        assert_eq!(st.add(&d, &a).unwrap().len(), 2);
        // order and switching off
        let ida = id_of(&a);
        let list = st.shift(&d, &ida, 1).unwrap();
        assert_eq!(list[1].path, a);
        let list = st.set_enabled(&d, &id_of(&b), false).unwrap();
        assert!(!list[0].enabled && list[1].enabled);
        // a new state reads it back from the file
        let again = DictState::default().info(&d);
        assert_eq!(again.iter().map(|i| (i.path.clone(), i.enabled)).collect::<Vec<_>>(), vec![(b.clone(), false), (a.clone(), true)]);
        // looking up uses only the enabled ones and gives each its own entry
        let found = DictState::default().lookup(&d, "“Hello,”");
        assert_eq!(found.query, "Hello");
        assert_eq!(found.entries.len(), 1);
        assert_eq!(found.entries[0].headword, "hello");
        assert!(found.entries[0].body.contains("a greeting"));
        let none = DictState::default().lookup(&d, "zebra");
        assert!(none.entries.is_empty() && none.suggestions.is_empty());
        let near = DictState::default().lookup(&d, "hel");
        assert!(near.entries.is_empty() && near.suggestions == vec!["hello".to_string()], "{:?}", near.suggestions);
        // remove
        let list = st.remove(&d, &ida).unwrap();
        assert_eq!(list.len(), 1);
        // a dictionary whose file went away is reported, not hidden
        fs::remove_file(&b).unwrap();
        let gone = DictState::default().info(&d);
        assert!(gone[0].error.is_some());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn not_a_dictionary_is_refused_with_a_reason() {
        let d = temp("refuse");
        let st = DictState::default();
        let txt = d.join("a.mdx");
        fs::write(&txt, b"plain text").unwrap();
        assert!(st.add(&d, &txt.to_string_lossy()).is_err());
        let pdf = d.join("b.pdf");
        fs::write(&pdf, b"x").unwrap();
        assert!(st.add(&d, &pdf.to_string_lossy()).unwrap_err().contains(".mdx"));
        assert!(st.info(&d).is_empty());
        let _ = fs::remove_dir_all(d);
    }

    /// Real dictionary through the whole pipeline: `MDX_FILE=... cargo test real_pipeline -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_pipeline() {
        let Ok(p) = std::env::var("MDX_FILE") else { return };
        let d = temp("real");
        let st = DictState::default();
        let list = st.add(&d, &p).unwrap();
        println!("{:?}", list.iter().map(|i| (i.title.clone(), i.entries, i.resource_files)).collect::<Vec<_>>());
        for w in ["hello", "run", "Ran", "ephemeral", "zzzzqq", "hel"] {
            let t = std::time::Instant::now();
            let f = st.lookup(&d, w);
            let e = f.entries.first();
            println!("{w}: {} entries, body {} bytes, scripts {:?}, suggestions {:?}, {:?}", f.entries.len(), e.map(|e| e.body.len()).unwrap_or(0), e.map(|e| e.scripts), f.suggestions, t.elapsed());
            if let Some(e) = e {
                println!("   has <link: {}  has data:image: {}  has <style>: {}  remote refs: {}", e.body.contains("<link"), e.body.contains("data:image"), e.body.contains("<style>"), e.body.matches("http://").count() + e.body.matches("https://").count());
            }
        }
        let _ = fs::remove_dir_all(d);
    }
}
