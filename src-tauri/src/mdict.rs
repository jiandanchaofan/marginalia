//! Reading MDict dictionaries (.mdx: headword -> entry; .mdd: files such as pictures, style sheets, sound).
//!
//! The dictionary file is never loaded whole: opening reads the header and the list of key blocks (the first and last
//! headword of each); a lookup finds the block, decodes it and then decodes the one record block that holds the entry.
//! Format (version 1.2 and 2.0): header (UTF-16 XML text) | key header | key block info | key blocks | record header |
//! record block info | record blocks. Blocks are zlib, LZO or stored; some dictionaries encrypt the key block info.
//! See docs/dictionary-plan.md.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_BLOCK: usize = 256 << 20; // refuse a block that claims to be bigger than this once decompressed

#[derive(Debug, Clone, PartialEq)]
pub enum Enc {
    Utf8,
    Utf16,
    Other(&'static encoding_rs::Encoding),
}

impl Enc {
    fn from_name(name: &str) -> Enc {
        match name.trim().to_ascii_uppercase().as_str() {
            "" | "UTF-8" | "UTF8" => Enc::Utf8,
            "UTF-16" | "UTF16" | "UTF-16LE" => Enc::Utf16,
            "GBK" | "GB2312" => Enc::Other(encoding_rs::GBK),
            "GB18030" => Enc::Other(encoding_rs::GB18030),
            "BIG5" | "BIG-5" => Enc::Other(encoding_rs::BIG5),
            other => encoding_rs::Encoding::for_label(other.as_bytes()).map(Enc::Other).unwrap_or(Enc::Utf8),
        }
    }
    /// Width of one terminator unit in bytes.
    fn unit(&self) -> usize {
        if *self == Enc::Utf16 {
            2
        } else {
            1
        }
    }
    fn decode(&self, bytes: &[u8]) -> String {
        match self {
            Enc::Utf8 => String::from_utf8_lossy(bytes).into_owned(),
            Enc::Utf16 => encoding_rs::UTF_16LE.decode_without_bom_handling(bytes).0.into_owned(),
            Enc::Other(e) => e.decode_without_bom_handling(bytes).0.into_owned(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Header {
    pub title: String,
    pub description: String,
    pub engine: f32,
    pub encoding: Enc,
    pub encrypted: u32,
    pub strip_key: bool,
    pub case_sensitive: bool,
    pub style_sheet: String,
    pub is_mdd: bool,
}

#[derive(Debug)]
struct KeyBlock {
    entries: u64,
    first: String,
    last: String,
    comp: u64,
    decomp: u64,
    /// Offset of the compressed block in the file.
    at: u64,
}

#[derive(Debug)]
struct RecordBlock {
    comp: u64,
    decomp: u64,
    at: u64,
    /// Offset of the first byte of this block in the stream of all decompressed record data.
    start: u64,
}

type Entries = Arc<Vec<(u64, String)>>;

#[derive(Debug, Clone)]
struct Hit {
    off: u64,
    key: String,
    end: u64,
}

pub struct Mdict {
    pub path: PathBuf,
    pub header: Header,
    pub entries: u64,
    wide: bool, // 8-byte numbers (2.0) instead of 4-byte (1.2)
    keys: Vec<KeyBlock>,
    records: Vec<RecordBlock>,
    total: u64,
    sorted: bool,
    file: Mutex<File>,
    cache: Mutex<HashMap<usize, Entries>>,
    /// Built only for a dictionary whose key blocks are not in the order we search by.
    full: Mutex<Option<Arc<HashMap<String, Vec<Hit>>>>>,
}

// ---------------------------------------------------------------- bytes

fn be(b: &[u8]) -> u64 {
    b.iter().fold(0u64, |a, &x| (a << 8) | x as u64)
}

struct Cur<'a> {
    b: &'a [u8],
    at: usize,
}
impl<'a> Cur<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.at + n > self.b.len() {
            return Err("词典文件的索引不完整".into());
        }
        let s = &self.b[self.at..self.at + n];
        self.at += n;
        Ok(s)
    }
    fn num(&mut self, wide: bool) -> Result<u64, String> {
        Ok(be(self.take(if wide { 8 } else { 4 })?))
    }
}

/// Decode one block as stored in the file: 4 bytes of compression type, 4 bytes of checksum, then the data.
fn unpack(raw: &[u8], decomp: u64, decrypt: bool) -> Result<Vec<u8>, String> {
    if raw.len() < 8 {
        return Err("词典里有一个损坏的数据块".into());
    }
    if decomp as usize > MAX_BLOCK {
        return Err("词典里有一个过大的数据块，已拒绝".into());
    }
    let kind = raw[0];
    let mut data = raw[8..].to_vec();
    if decrypt {
        use ripemd::{Digest, Ripemd128};
        let mut h = Ripemd128::new();
        h.update(&raw[4..8]);
        h.update([0x95, 0x36, 0x00, 0x00]);
        let key = h.finalize();
        let mut prev = 0x36u8;
        for (i, b) in data.iter_mut().enumerate() {
            let cipher = *b;
            let t = (cipher >> 4 | cipher << 4) ^ prev ^ (i as u8) ^ key[i % key.len()];
            prev = cipher;
            *b = t;
        }
    }
    match kind {
        0 => Ok(data),
        1 => {
            let mut out = vec![0u8; decomp as usize];
            lzokay_native::decompress_all(&data, Some(decomp as usize)).map(|v| {
                out = v;
                out
            }).map_err(|e| format!("词典的 LZO 数据块解压失败：{e:?}"))
        }
        2 => {
            let mut out = Vec::with_capacity(decomp as usize);
            flate2::read::ZlibDecoder::new(&data[..]).take(MAX_BLOCK as u64).read_to_end(&mut out).map_err(|e| format!("词典的数据块解压失败：{e}"))?;
            Ok(out)
        }
        k => Err(format!("词典用了不认识的压缩方式（{k}）")),
    }
}

fn attr(text: &str, name: &str) -> String {
    let needle = format!("{name}=\"");
    // attribute names are matched whole and ignoring case (Stripkey / StripKey)
    let lower = text.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(&needle.to_ascii_lowercase()) {
        let at = from + i;
        let boundary = at == 0 || !lower.as_bytes()[at - 1].is_ascii_alphanumeric();
        if boundary {
            let rest = &text[at + needle.len()..];
            let end = rest.find('"').unwrap_or(rest.len());
            return rest[..end].replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
        }
        from = at + needle.len();
    }
    String::new()
}

// ---------------------------------------------------------------- opening

impl Mdict {
    pub fn open(path: &Path) -> Result<Mdict, String> {
        let mut file = File::open(path).map_err(|e| format!("打不开词典文件：{e}"))?;
        let mut head4 = [0u8; 4];
        file.read_exact(&mut head4).map_err(|e| format!("读取词典失败：{e}"))?;
        let hlen = be(&head4) as usize;
        if hlen == 0 || hlen > (4 << 20) {
            return Err("这不是 MDict 词典文件（文件头不对）".into());
        }
        let mut hbytes = vec![0u8; hlen];
        file.read_exact(&mut hbytes).map_err(|e| format!("读取词典失败：{e}"))?;
        let text = encoding_rs::UTF_16LE.decode_without_bom_handling(&hbytes).0.into_owned();
        if !text.contains("Dictionary") && !text.contains("Library_Data") {
            return Err("这不是 MDict 词典文件（文件头不对）".into());
        }
        let engine: f32 = attr(&text, "GeneratedByEngineVersion").parse().unwrap_or(1.0);
        if engine >= 3.0 {
            return Err("这是 MDict 3.0 版的词典，目前还不支持".into());
        }
        let encrypted: u32 = attr(&text, "Encrypted").parse().unwrap_or(0);
        if encrypted & 1 != 0 {
            return Err("这本词典需要注册码才能打开，目前不支持".into());
        }
        let is_mdd = path.extension().map(|e| e.eq_ignore_ascii_case("mdd")).unwrap_or(false);
        let encoding = if is_mdd { Enc::Utf16 } else { Enc::from_name(&attr(&text, "Encoding")) };
        let yes = |s: String| matches!(s.to_ascii_lowercase().as_str(), "yes" | "true" | "1");
        let header = Header {
            title: attr(&text, "Title"),
            description: attr(&text, "Description"),
            engine,
            encoding: encoding.clone(),
            encrypted,
            strip_key: attr(&text, "StripKey").is_empty() || yes(attr(&text, "StripKey")),
            case_sensitive: yes(attr(&text, "KeyCaseSensitive")),
            style_sheet: attr(&text, "StyleSheet"),
            is_mdd,
        };
        let wide = engine >= 2.0;
        let pos = 4 + hlen as u64 + 4; // the header is followed by its checksum

        // key header
        file.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
        let kh_len = if wide { 40 + 4 } else { 16 };
        let mut kh = vec![0u8; kh_len];
        file.read_exact(&mut kh).map_err(|e| format!("读取词典失败：{e}"))?;
        let mut c = Cur { b: &kh, at: 0 };
        let key_blocks = c.num(wide)?;
        let entries = c.num(wide)?;
        let info_decomp = if wide { c.num(wide)? } else { 0 };
        let info_size = c.num(wide)?;
        let blocks_size = c.num(wide)?;
        if key_blocks > 50_000_000 || info_size > (256 << 20) || blocks_size > (1u64 << 40) {
            return Err("词典的索引数据异常，已拒绝".into());
        }
        // key block info
        let mut info_raw = vec![0u8; info_size as usize];
        file.read_exact(&mut info_raw).map_err(|e| format!("读取词典失败：{e}"))?;
        let info = if wide { unpack(&info_raw, info_decomp, encrypted & 2 != 0)? } else { info_raw };
        let unit = encoding.unit();
        let mut keys = Vec::with_capacity(key_blocks as usize);
        let mut ic = Cur { b: &info, at: 0 };
        let mut at = pos + kh_len as u64 + info_size;
        for _ in 0..key_blocks {
            let n = ic.num(wide)?;
            let mut text = |ic: &mut Cur| -> Result<String, String> {
                let len = if wide { be(ic.take(2)?) } else { be(ic.take(1)?) } as usize;
                // sizes count characters; UTF-8 headwords are counted in bytes, UTF-16 in 2-byte units
                let bytes = ic.take(len * unit)?.to_vec();
                if wide {
                    ic.take(unit)?; // terminator
                }
                Ok(encoding.decode(&bytes))
            };
            let first = text(&mut ic)?;
            let last = text(&mut ic)?;
            let comp = ic.num(wide)?;
            let decomp = ic.num(wide)?;
            keys.push(KeyBlock { entries: n, first, last, comp, decomp, at });
            at += comp;
        }
        // record header
        let rh_pos = pos + kh_len as u64 + info_size + blocks_size;
        file.seek(SeekFrom::Start(rh_pos)).map_err(|e| e.to_string())?;
        let rh_len = if wide { 32 } else { 16 };
        let mut rh = vec![0u8; rh_len];
        file.read_exact(&mut rh).map_err(|e| format!("读取词典失败：{e}"))?;
        let mut rc = Cur { b: &rh, at: 0 };
        let rec_blocks = rc.num(wide)?;
        let _rec_entries = rc.num(wide)?;
        let rec_info_size = rc.num(wide)?;
        let _rec_blocks_size = rc.num(wide)?;
        if rec_blocks > 100_000_000 || rec_info_size > (1 << 30) {
            return Err("词典的记录数据异常，已拒绝".into());
        }
        let mut rinfo = vec![0u8; rec_info_size as usize];
        file.read_exact(&mut rinfo).map_err(|e| format!("读取词典失败：{e}"))?;
        let mut rcur = Cur { b: &rinfo, at: 0 };
        let mut records = Vec::with_capacity(rec_blocks as usize);
        let mut rat = rh_pos + rh_len as u64 + rec_info_size;
        let mut start = 0u64;
        for _ in 0..rec_blocks {
            let comp = rcur.num(wide)?;
            let decomp = rcur.num(wide)?;
            records.push(RecordBlock { comp, decomp, at: rat, start });
            rat += comp;
            start += decomp;
        }
        let mut d = Mdict { path: path.to_path_buf(), header, entries, wide, keys, records, total: start, sorted: true, file: Mutex::new(file), cache: Mutex::new(HashMap::new()), full: Mutex::new(None) };
        // can the blocks be searched by the first / last headword? (only if they are in order under our comparison)
        let norm: Vec<(String, String)> = d.keys.iter().map(|k| (d.norm(&k.first), d.norm(&k.last))).collect();
        d.sorted = norm.windows(2).all(|w| w[0].1 <= w[1].0 || w[0].1 <= w[1].1) && norm.iter().all(|(a, b)| a <= b);
        Ok(d)
    }

    /// The form of a headword that is compared (case and, usually, punctuation and spaces do not matter).
    pub fn norm(&self, s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for ch in s.chars() {
            if self.header.strip_key && !ch.is_alphanumeric() {
                continue;
            }
            if self.header.case_sensitive {
                out.push(ch);
            } else {
                out.extend(ch.to_lowercase());
            }
        }
        out
    }

    fn read_at(&self, at: u64, len: u64) -> Result<Vec<u8>, String> {
        let mut f = self.file.lock().map_err(|_| "词典文件被占用".to_string())?;
        f.seek(SeekFrom::Start(at)).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; len as usize];
        f.read_exact(&mut buf).map_err(|e| format!("读取词典失败：{e}"))?;
        Ok(buf)
    }

    fn block(&self, i: usize) -> Result<Entries, String> {
        if let Some(e) = self.cache.lock().map_err(|_| "x".to_string())?.get(&i) {
            return Ok(e.clone());
        }
        let kb = &self.keys[i];
        let raw = self.read_at(kb.at, kb.comp)?;
        let data = unpack(&raw, kb.decomp, false)?;
        let unit = self.header.encoding.unit();
        let mut c = Cur { b: &data, at: 0 };
        let mut out = Vec::with_capacity(kb.entries as usize);
        for _ in 0..kb.entries {
            let off = c.num(self.wide)?;
            let start = c.at;
            // up to the terminator (one zero unit)
            let mut end = start;
            loop {
                if end + unit > data.len() {
                    return Err("词典的词条数据不完整".into());
                }
                if data[end..end + unit].iter().all(|&b| b == 0) {
                    break;
                }
                end += unit;
            }
            out.push((off, self.header.encoding.decode(&data[start..end])));
            c.at = end + unit;
        }
        let out = Arc::new(out);
        let mut cache = self.cache.lock().map_err(|_| "x".to_string())?;
        if cache.len() > 24 {
            cache.clear();
        }
        cache.insert(i, out.clone());
        Ok(out)
    }

    /// Blocks that may hold a headword whose normal form is `q`.
    fn candidates(&self, q: &str) -> Vec<usize> {
        let mut out = Vec::new();
        for (i, k) in self.keys.iter().enumerate() {
            let (a, b) = (self.norm(&k.first), self.norm(&k.last));
            if a.as_str() <= q && q <= b.as_str() {
                out.push(i);
            } else if a.as_str() > q {
                break;
            }
        }
        out
    }

    /// Every entry, in file order, as (normal form -> [(offset, spelling, end of its record)]); only for dictionaries whose
    /// key blocks are not in the order we search by.
    fn all(&self) -> Result<Arc<HashMap<String, Vec<Hit>>>, String> {
        let mut g = self.full.lock().map_err(|_| "x".to_string())?;
        if let Some(m) = g.as_ref() {
            return Ok(m.clone());
        }
        let mut list: Vec<(u64, String)> = Vec::new();
        for i in 0..self.keys.len() {
            list.extend(self.block(i)?.iter().cloned());
        }
        let mut map: HashMap<String, Vec<Hit>> = HashMap::new();
        for (n, (off, k)) in list.iter().enumerate() {
            let end = list.get(n + 1).map(|x| x.0).unwrap_or(self.total);
            map.entry(self.norm(k)).or_default().push(Hit { off: *off, key: k.clone(), end: self.sane_end(*off, end) });
        }
        self.cache.lock().map_err(|_| "x".to_string())?.clear();
        let m = Arc::new(map);
        *g = Some(m.clone());
        Ok(m)
    }

    /// Records follow each other in key order, so an entry ends where the next one starts. If a dictionary breaks that
    /// (the next offset is not larger), the entry ends with its record block instead.
    fn sane_end(&self, off: u64, next: u64) -> u64 {
        if next > off {
            return next.min(self.total);
        }
        match self.records.binary_search_by(|r| r.start.cmp(&off)) {
            Ok(i) => self.records[i].start + self.records[i].decomp,
            Err(0) => self.total,
            Err(i) => self.records[i - 1].start + self.records[i - 1].decomp,
        }
    }

    /// The entries for a headword, the exact spelling first.
    fn find(&self, word: &str) -> Result<Vec<Hit>, String> {
        let q = self.norm(word);
        if q.is_empty() {
            return Ok(vec![]);
        }
        let mut hits: Vec<Hit> = Vec::new();
        if self.sorted {
            for i in self.candidates(&q) {
                let es = self.block(i)?;
                for (j, (off, k)) in es.iter().enumerate() {
                    if self.norm(k) == q {
                        let next = match es.get(j + 1) {
                            Some(n) => n.0,
                            None if i + 1 < self.keys.len() => self.block(i + 1)?.first().map(|x| x.0).unwrap_or(self.total),
                            None => self.total,
                        };
                        hits.push(Hit { off: *off, key: k.clone(), end: self.sane_end(*off, next) });
                    }
                }
            }
        } else if let Some(v) = self.all()?.get(&q) {
            hits = v.clone();
        }
        hits.sort_by_key(|h| if h.key == word { 0 } else if h.key.eq_ignore_ascii_case(word) { 1 } else { 2 });
        Ok(hits)
    }

    /// The bytes of the record from `offset` to `end` in the stream of all record data.
    fn record(&self, offset: u64, end: u64) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        let mut at = offset;
        while at < end {
            let bi = match self.records.binary_search_by(|r| r.start.cmp(&at)) {
                Ok(i) => i,
                Err(0) => return Err("词典的记录位置不对".into()),
                Err(i) => i - 1,
            };
            let rb = &self.records[bi];
            let raw = self.read_at(rb.at, rb.comp)?;
            let data = unpack(&raw, rb.decomp, false)?;
            let from = (at - rb.start) as usize;
            let to = ((end - rb.start) as usize).min(data.len());
            if from >= data.len() {
                break;
            }
            out.extend_from_slice(&data[from..to]);
            at = rb.start + to as u64;
            if to == data.len() && at >= self.total {
                break;
            }
        }
        Ok(out)
    }

    fn text_of(&self, bytes: &[u8]) -> String {
        let mut s = self.header.encoding.decode(bytes);
        while s.ends_with('\0') {
            s.pop();
        }
        s
    }

    /// The entry for a word as the dictionary stores it (usually HTML), following "@@@LINK=" redirects.
    pub fn lookup(&self, word: &str) -> Result<Option<(String, String)>, String> {
        let mut word = word.to_string();
        for _ in 0..6 {
            let hits = self.find(&word)?;
            let Some(hit) = hits.into_iter().next() else { return Ok(None) };
            let (spelled, text) = (hit.key.clone(), self.text_of(&self.record(hit.off, hit.end)?));
            if let Some(rest) = text.trim().strip_prefix("@@@LINK=") {
                word = rest.trim().to_string();
                continue;
            }
            return Ok(Some((spelled, text)));
        }
        Ok(None)
    }

    /// A file stored in an .mdd (or any entry as raw bytes). The name is as the .mdd spells it, `\\dir\\file`.
    pub fn resource(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let wanted = name.replace('/', "\\");
        let wanted = if wanted.starts_with('\\') { wanted } else { format!("\\{wanted}") };
        let hits = self.find(&wanted)?;
        match hits.into_iter().next() {
            Some(h) => Ok(Some(self.record(h.off, h.end)?)),
            None => Ok(None),
        }
    }

    /// Headwords that start with `prefix`, in the dictionary's order.
    pub fn prefix(&self, prefix: &str, limit: usize) -> Result<Vec<String>, String> {
        let q = self.norm(prefix);
        if q.is_empty() {
            return Ok(vec![]);
        }
        let mut out: Vec<String> = Vec::new();
        for (i, k) in self.keys.iter().enumerate() {
            if self.sorted && self.norm(&k.last).as_str() < q.as_str() {
                continue;
            }
            for (_, w) in self.block(i)?.iter() {
                if self.norm(w).starts_with(&q) && !out.contains(w) {
                    out.push(w.clone());
                    if out.len() >= limit {
                        return Ok(out);
                    }
                }
            }
            if self.sorted && !out.is_empty() && self.norm(&k.last).as_str() > q.as_str() && !self.norm(&k.last).starts_with(&q) {
                break;
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::ZlibEncoder, Compression};
    use std::io::Write;

    fn adler(data: &[u8]) -> u32 {
        let (mut a, mut b) = (1u32, 0u32);
        for &x in data {
            a = (a + x as u32) % 65521;
            b = (b + a) % 65521;
        }
        (b << 16) | a
    }

    fn zlib(data: &[u8]) -> Vec<u8> {
        let mut e = ZlibEncoder::new(Vec::new(), Compression::default());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    /// 4 bytes of type, 4 of checksum, the data.
    fn pack(data: &[u8], kind: u8) -> Vec<u8> {
        let body = if kind == 2 { zlib(data) } else { data.to_vec() };
        let mut out = vec![kind, 0, 0, 0];
        out.extend_from_slice(&adler(data).to_be_bytes());
        out.extend_from_slice(&body);
        out
    }

    /// A version 2.0 dictionary written the way MDict does, for the tests. Entries are (headword, record bytes).
    fn build(entries: &[(&str, Vec<u8>)], utf16: bool, per_key_block: usize, per_record_block: usize, title: &str, kind: u8) -> Vec<u8> {
        let enc = |s: &str| -> Vec<u8> { if utf16 { s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect() } else { s.as_bytes().to_vec() } };
        let unit = if utf16 { 2 } else { 1 };
        let mut sorted: Vec<(&str, &Vec<u8>)> = entries.iter().map(|(k, v)| (*k, v)).collect();
        sorted.sort_by_key(|(k, _)| k.to_lowercase());
        // records: the concatenation, cut into blocks
        let mut stream: Vec<u8> = Vec::new();
        let mut offsets = Vec::new();
        for (_, v) in &sorted {
            offsets.push(stream.len() as u64);
            stream.extend_from_slice(v);
        }
        let mut rec_blocks: Vec<(u64, Vec<u8>)> = Vec::new();
        let mut i = 0;
        let mut starts = Vec::new();
        while i < sorted.len() {
            let j = (i + per_record_block).min(sorted.len());
            let from = offsets[i] as usize;
            let to = if j < sorted.len() { offsets[j] as usize } else { stream.len() };
            starts.push(from);
            rec_blocks.push(((to - from) as u64, pack(&stream[from..to], kind)));
            i = j;
        }
        // key blocks
        let mut key_blocks: Vec<(usize, String, String, Vec<u8>, usize)> = Vec::new();
        let mut i = 0;
        while i < sorted.len() {
            let j = (i + per_key_block).min(sorted.len());
            let mut data = Vec::new();
            for k in i..j {
                data.extend_from_slice(&offsets[k].to_be_bytes());
                data.extend_from_slice(&enc(sorted[k].0));
                data.extend(std::iter::repeat(0u8).take(unit));
            }
            key_blocks.push((j - i, sorted[i].0.to_string(), sorted[j - 1].0.to_string(), pack(&data, kind), data.len()));
            i = j;
        }
        // key block info
        let mut info = Vec::new();
        for (n, first, last, packed, decomp) in &key_blocks {
            info.extend_from_slice(&(*n as u64).to_be_bytes());
            for t in [first, last] {
                let chars = if utf16 { t.encode_utf16().count() } else { t.len() };
                info.extend_from_slice(&(chars as u16).to_be_bytes());
                info.extend_from_slice(&enc(t));
                info.extend(std::iter::repeat(0u8).take(unit));
            }
            info.extend_from_slice(&(packed.len() as u64).to_be_bytes());
            info.extend_from_slice(&(*decomp as u64).to_be_bytes());
        }
        let info_packed = pack(&info, kind);
        let key_blocks_bytes: Vec<u8> = key_blocks.iter().flat_map(|k| k.3.clone()).collect();
        // header
        let header_text = format!("<Dictionary GeneratedByEngineVersion=\"2.0\" RequiredEngineVersion=\"2.0\" Encrypted=\"0\" Encoding=\"{}\" Format=\"Html\" Stripkey=\"Yes\" KeyCaseSensitive=\"No\" Title=\"{}\" Description=\"a test\" StyleSheet=\"\"/>\r\n\0", if utf16 { "UTF-16" } else { "UTF-8" }, title);
        let header: Vec<u8> = header_text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let mut out = Vec::new();
        out.extend_from_slice(&(header.len() as u32).to_be_bytes());
        out.extend_from_slice(&header);
        out.extend_from_slice(&adler(&header).to_le_bytes());
        // key header
        let mut kh = Vec::new();
        for n in [key_blocks.len() as u64, sorted.len() as u64, info.len() as u64, info_packed.len() as u64, key_blocks_bytes.len() as u64] {
            kh.extend_from_slice(&n.to_be_bytes());
        }
        out.extend_from_slice(&kh);
        out.extend_from_slice(&adler(&kh).to_be_bytes());
        out.extend_from_slice(&info_packed);
        out.extend_from_slice(&key_blocks_bytes);
        // record header + info + blocks
        let mut rinfo = Vec::new();
        for (decomp, packed) in &rec_blocks {
            rinfo.extend_from_slice(&(packed.len() as u64).to_be_bytes());
            rinfo.extend_from_slice(&decomp.to_be_bytes());
        }
        let rblocks: Vec<u8> = rec_blocks.iter().flat_map(|r| r.1.clone()).collect();
        for n in [rec_blocks.len() as u64, sorted.len() as u64, rinfo.len() as u64, rblocks.len() as u64] {
            out.extend_from_slice(&n.to_be_bytes());
        }
        out.extend_from_slice(&rinfo);
        out.extend_from_slice(&rblocks);
        out
    }

    fn html(s: &str, utf16: bool) -> Vec<u8> {
        let mut b: Vec<u8> = if utf16 { s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect() } else { s.as_bytes().to_vec() };
        b.extend(std::iter::repeat(0u8).take(if utf16 { 2 } else { 1 }));
        b
    }

    fn tmp(name: &str, bytes: &[u8]) -> PathBuf {
        let p = std::env::temp_dir().join(format!("marginalia-mdict-{name}-{}", std::process::id()));
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn words() -> Vec<(String, String)> {
        // enough words that there are several key blocks and several record blocks
        let mut v: Vec<(String, String)> = (0..120).map(|i| (format!("word{i:03}"), format!("<p>meaning of word {i}</p>"))).collect();
        v.push(("Apple".into(), "<b>apple</b> a fruit".into()));
        v.push(("apple pie".into(), "<b>apple pie</b>".into()));
        v.push(("run".into(), "to move fast".into()));
        v.push(("ran".into(), "@@@LINK=run".into()));
        v.push(("naïve".into(), "innocent".into()));
        v.push(("词典".into(), "<p>dictionary，字典</p>".into()));
        v
    }

    #[test]
    fn looks_words_up_across_many_blocks_ignoring_case_and_spaces() {
        let w = words();
        let entries: Vec<(&str, Vec<u8>)> = w.iter().map(|(k, v)| (k.as_str(), html(v, false))).collect();
        let path = tmp("a.mdx", &build(&entries, false, 16, 20, "Test dictionary", 2));
        let d = Mdict::open(&path).unwrap();
        assert_eq!(d.header.title, "Test dictionary");
        assert_eq!(d.entries, w.len() as u64);
        assert!(d.keys.len() > 5 && d.records.len() > 4, "{} key blocks, {} record blocks", d.keys.len(), d.records.len());
        assert!(d.sorted);
        for (k, v) in &w {
            if v.starts_with("@@@") {
                continue;
            }
            let (spelled, text) = d.lookup(k).unwrap().unwrap_or_else(|| panic!("{k} not found"));
            assert_eq!((spelled.as_str(), text.as_str()), (k.as_str(), v.as_str()));
        }
        assert_eq!(d.lookup("APPLE").unwrap().unwrap().1, "<b>apple</b> a fruit", "case does not matter");
        assert_eq!(d.lookup("applepie").unwrap().unwrap().0, "apple pie", "spaces do not matter");
        assert_eq!(d.lookup("naive").unwrap().map(|x| x.0), None, "accents are not folded");
        assert_eq!(d.lookup("nothing here").unwrap(), None);
        assert_eq!(d.lookup("").unwrap(), None);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn follows_redirects_and_gives_the_last_entry_whole() {
        let w = words();
        let entries: Vec<(&str, Vec<u8>)> = w.iter().map(|(k, v)| (k.as_str(), html(v, false))).collect();
        let path = tmp("b.mdx", &build(&entries, false, 16, 20, "T", 2));
        let d = Mdict::open(&path).unwrap();
        assert_eq!(d.lookup("ran").unwrap().unwrap(), ("run".to_string(), "to move fast".to_string()), "@@@LINK= goes to the word it names");
        // the entry that comes last in the file
        let last = d.lookup("词典").unwrap().unwrap();
        assert_eq!(last.1, "<p>dictionary，字典</p>");
        assert_eq!(d.lookup("word119").unwrap().unwrap().1, "<p>meaning of word 119</p>");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn utf16_and_stored_blocks_read_the_same() {
        let w = words();
        let entries: Vec<(&str, Vec<u8>)> = w.iter().map(|(k, v)| (k.as_str(), html(v, true))).collect();
        let path = tmp("c.mdx", &build(&entries, true, 25, 30, "UTF-16 one", 0));
        let d = Mdict::open(&path).unwrap();
        assert_eq!(d.header.encoding, Enc::Utf16);
        assert_eq!(d.lookup("词典").unwrap().unwrap().1, "<p>dictionary，字典</p>");
        assert_eq!(d.lookup("word042").unwrap().unwrap().1, "<p>meaning of word 42</p>");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn suggests_words_by_their_start() {
        let w = words();
        let entries: Vec<(&str, Vec<u8>)> = w.iter().map(|(k, v)| (k.as_str(), html(v, false))).collect();
        let path = tmp("d.mdx", &build(&entries, false, 16, 20, "T", 2));
        let d = Mdict::open(&path).unwrap();
        assert_eq!(d.prefix("app", 10).unwrap(), vec!["Apple".to_string(), "apple pie".to_string()]);
        assert_eq!(d.prefix("word10", 20).unwrap().len(), 10);
        assert_eq!(d.prefix("word10", 3).unwrap().len(), 3);
        assert!(d.prefix("zzz", 5).unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn an_mdd_gives_back_its_files() {
        // an .mdd has UTF-16 names like \\style.css and raw bytes
        let files: Vec<(String, Vec<u8>)> = vec![("\\oald.css".into(), b"body{color:red}".to_vec()), ("\\img\\a.png".into(), vec![137, 80, 78, 71, 0, 1, 2, 255]), ("\\sound\\x.mp3".into(), vec![0xff, 0xfb, 0x90, 0])];
        let entries: Vec<(&str, Vec<u8>)> = files.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        let path = {
            let p = std::env::temp_dir().join(format!("marginalia-mdict-e-{}.mdd", std::process::id()));
            std::fs::write(&p, build(&entries, true, 2, 2, "Res", 2)).unwrap();
            p
        };
        let d = Mdict::open(&path).unwrap();
        assert!(d.header.is_mdd);
        assert_eq!(d.resource("oald.css").unwrap().unwrap(), b"body{color:red}");
        assert_eq!(d.resource("img/a.png").unwrap().unwrap(), vec![137, 80, 78, 71, 0, 1, 2, 255]);
        assert_eq!(d.resource("\\sound\\x.mp3").unwrap().unwrap(), vec![0xff, 0xfb, 0x90, 0]);
        assert_eq!(d.resource("nope.gif").unwrap(), None);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn refuses_what_is_not_a_dictionary_without_crashing() {
        let junk = tmp("junk", &[0, 0, 0, 5, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        assert!(Mdict::open(&junk).is_err());
        let empty = tmp("empty", &[]);
        assert!(Mdict::open(&empty).is_err());
        let text = tmp("text", b"hello this is a text file and not a dictionary at all");
        assert!(Mdict::open(&text).is_err());
        assert!(Mdict::open(Path::new("/no/such/file.mdx")).is_err());
        // a real one that has been cut short
        let w = words();
        let entries: Vec<(&str, Vec<u8>)> = w.iter().map(|(k, v)| (k.as_str(), html(v, false))).collect();
        let full = build(&entries, false, 16, 20, "T", 2);
        let cut = tmp("cut", &full[..full.len() / 2]);
        let r = Mdict::open(&cut).and_then(|d| d.lookup("word100"));
        assert!(r.is_err(), "a truncated dictionary gives an error, not a panic");
        for p in [junk, empty, text, cut] {
            let _ = std::fs::remove_file(p);
        }
    }

    /// With a real dictionary: `MDX_FILE=path cargo test --release real_dictionary -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_dictionary() {
        let Ok(path) = std::env::var("MDX_FILE") else { return };
        let t = std::time::Instant::now();
        let d = Mdict::open(Path::new(&path)).unwrap();
        println!("opened in {:?}: {:?} v{} {:?} entries={} keyblocks={} recordblocks={} sorted={} strip={} case={}", t.elapsed(), d.header.title, d.header.engine, d.header.encoding, d.entries, d.keys.len(), d.records.len(), d.sorted, d.header.strip_key, d.header.case_sensitive);
        for w in ["hello", "the", "run", "ran", "ephemeral", "apple", "Apple", "set", "你好", "zzzzqq"] {
            let t = std::time::Instant::now();
            match d.lookup(w) {
                Ok(Some((k, text))) => println!("{w:>10} -> {k:?} ({} chars) in {:?}: {}", text.chars().count(), t.elapsed(), text.chars().take(120).collect::<String>().replace('\n', " ")),
                Ok(None) => println!("{w:>10} -> not found ({:?})", t.elapsed()),
                Err(e) => println!("{w:>10} -> ERROR {e}"),
            }
        }
        println!("prefix 'eph': {:?}", d.prefix("eph", 8));
    }
}
