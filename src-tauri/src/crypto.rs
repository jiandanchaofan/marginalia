//! Encryption for what goes to the cloud (see docs/cloud-sync-plan.md). Nothing here touches the local database.
//!
//! * A random 256-bit **data key** encrypts every file. The sync password never encrypts files itself: it is stretched with
//!   Argon2id into a key that only wraps the data key, so changing the password does not mean re-encrypting the cloud.
//!   A random **recovery key** wraps the same data key a second way (shown once, for a forgotten password).
//! * Files are sealed with XChaCha20-Poly1305 (random 192-bit nonce, so devices never need to coordinate). The file's kind and
//!   name are bound in as associated data: a file moved under another name, or opened as another kind, fails to open.
//! * Compression (deflate) happens before encryption. The remote names of books and pictures are an HMAC of their content
//!   hash, not the hash itself, so nobody who holds the same file can find out that it is in the library.
//!
//! Only well-known primitives from the RustCrypto crates are used; the format carries a version so it can change later.

#![allow(dead_code)] // used by the sync module (S2); for now only the tests call it

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use zeroize::Zeroize;

type HmacSha256 = Hmac<sha2_010::Sha256>;

const MAGIC: &[u8; 4] = b"MGC1";
const VERSION: u8 = 1;
const FLAG_DEFLATE: u8 = 1;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 4 + 1 + 1 + NONCE_LEN;
/// A sealed file never expands to more than this (guards against a "zip bomb" in a damaged or hostile file).
pub const MAX_PLAIN: usize = 512 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub enum CryptoError {
    /// The password (or recovery key) does not open the key file.
    BadPassword,
    /// Altered, truncated or not ours: it does not authenticate.
    Corrupt,
    /// Written by a newer version of the format.
    Unsupported(u8),
    Other(String),
}
impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::BadPassword => write!(f, "同步密码不对"),
            CryptoError::Corrupt => write!(f, "文件已损坏或被改动，不能解密"),
            CryptoError::Unsupported(v) => write!(f, "文件来自更新的版本（格式 {v}），请先升级应用"),
            CryptoError::Other(s) => write!(f, "{s}"),
        }
    }
}
impl std::error::Error for CryptoError {}

/// The key that encrypts files. Wiped from memory when dropped.
#[derive(Clone)]
pub struct DataKey([u8; 32]);
impl Drop for DataKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
impl DataKey {
    pub fn random() -> DataKey {
        let mut k = [0u8; 32];
        fill_random(&mut k);
        DataKey(k)
    }
    fn from_slice(b: &[u8]) -> Option<DataKey> {
        <[u8; 32]>::try_from(b).ok().map(DataKey)
    }
    /// A key kept elsewhere (the system credential store), read back.
    pub fn from_bytes(b: &[u8]) -> Option<DataKey> {
        DataKey::from_slice(b)
    }
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
    /// Separate keys for separate jobs, so no key is ever used for two things.
    fn sub(&self, label: &str) -> [u8; 32] {
        hmac(&self.0, format!("marginalia/{label}/v1").as_bytes())
    }
}

fn fill_random(buf: &mut [u8]) {
    use chacha20poly1305::aead::rand_core::RngCore;
    OsRng.fill_bytes(buf);
}
fn hmac(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC takes any key length");
    m.update(data);
    m.finalize().into_bytes().into()
}

// ---------------------------------------------------------------- files

/// Encrypt `plain` as a file of `kind` (e.g. "change", "snapshot", "book") called `name`.
pub fn seal(key: &DataKey, kind: &str, name: &str, plain: &[u8], compress: bool) -> Result<Vec<u8>, CryptoError> {
    let (flags, body) = if compress {
        let mut enc = DeflateEncoder::new(Vec::new(), Compression::new(6));
        enc.write_all(plain).map_err(|e| CryptoError::Other(e.to_string()))?;
        (FLAG_DEFLATE, enc.finish().map_err(|e| CryptoError::Other(e.to_string()))?)
    } else {
        (0, plain.to_vec())
    };
    let mut enc_key = key.sub("files");
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&enc_key));
    enc_key.zeroize();
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let mut out = Vec::with_capacity(HEADER_LEN + body.len() + 16);
    out.extend_from_slice(MAGIC);
    out.push(VERSION);
    out.push(flags);
    out.extend_from_slice(&nonce);
    let aad = aad_for(VERSION, flags, kind, name);
    let ct = cipher.encrypt(&nonce, Payload { msg: &body, aad: &aad }).map_err(|_| CryptoError::Other("加密失败".into()))?;
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypt a sealed file. Fails (never returns wrong data) if anything about it was changed, or if `kind` / `name` differ.
pub fn open(key: &DataKey, kind: &str, name: &str, sealed: &[u8]) -> Result<Vec<u8>, CryptoError> {
    open_limited(key, kind, name, sealed, MAX_PLAIN)
}

fn open_limited(key: &DataKey, kind: &str, name: &str, sealed: &[u8], limit: usize) -> Result<Vec<u8>, CryptoError> {
    if sealed.len() < HEADER_LEN + 16 || &sealed[..4] != MAGIC {
        return Err(CryptoError::Corrupt);
    }
    let (version, flags) = (sealed[4], sealed[5]);
    if version != VERSION {
        return Err(if version > VERSION { CryptoError::Unsupported(version) } else { CryptoError::Corrupt });
    }
    let nonce = XNonce::from_slice(&sealed[6..6 + NONCE_LEN]);
    let mut enc_key = key.sub("files");
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&enc_key));
    enc_key.zeroize();
    let aad = aad_for(version, flags, kind, name);
    let body = cipher.decrypt(nonce, Payload { msg: &sealed[HEADER_LEN..], aad: &aad }).map_err(|_| CryptoError::Corrupt)?;
    if flags & FLAG_DEFLATE == 0 {
        return if body.len() <= limit { Ok(body) } else { Err(CryptoError::Corrupt) };
    }
    let mut out = Vec::new();
    DeflateDecoder::new(&body[..]).take(limit as u64 + 1).read_to_end(&mut out).map_err(|_| CryptoError::Corrupt)?;
    if out.len() > limit {
        return Err(CryptoError::Corrupt);
    }
    Ok(out)
}

fn aad_for(version: u8, flags: u8, kind: &str, name: &str) -> Vec<u8> {
    let mut a = Vec::with_capacity(8 + kind.len() + name.len());
    a.extend_from_slice(MAGIC);
    a.push(version);
    a.push(flags);
    a.extend_from_slice(kind.as_bytes());
    a.push(0);
    a.extend_from_slice(name.as_bytes());
    a
}

/// The name a book or picture gets in the cloud: a keyed hash of its content hash. The same file always gets the same name
/// (so devices agree and nothing is uploaded twice), but without the key the name cannot be matched to the file.
pub fn remote_name(key: &DataKey, kind: &str, content_hash: &str) -> String {
    let mut nk = key.sub("names");
    let mac = hmac(&nk, format!("{kind}\0{content_hash}").as_bytes());
    nk.zeroize();
    hex::encode(mac)
}

// ---------------------------------------------------------------- the key file

/// Cost of stretching the password. The defaults take about a second on a phone; the numbers live in the key file, so they
/// can be raised later without breaking existing libraries.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct KdfParams {
    pub mem_kib: u32,
    pub iters: u32,
    pub lanes: u32,
}
impl Default for KdfParams {
    fn default() -> Self {
        KdfParams { mem_kib: 64 * 1024, iters: 3, lanes: 1 }
    }
}

/// What is kept in the cloud (`keys.json`) so a new device can join with the password: the data key, wrapped twice.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct KeyFile {
    pub v: u32,
    pub kdf: KdfParams,
    /// base64
    pub salt: String,
    /// base64(nonce ‖ data key sealed with the password key)
    pub wrapped: String,
    /// base64(nonce ‖ data key sealed with the recovery key)
    pub recovery_wrapped: String,
}

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

fn stretch(password: &str, salt: &[u8], p: KdfParams) -> Result<[u8; 32], CryptoError> {
    let params = Params::new(p.mem_kib, p.iters, p.lanes, Some(32)).map_err(|e| CryptoError::Other(e.to_string()))?;
    let mut out = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|e| CryptoError::Other(e.to_string()))?;
    Ok(out)
}

fn wrap(wrapping_key: &[u8; 32], context: &str, data: &DataKey) -> Result<String, CryptoError> {
    let cipher = XChaCha20Poly1305::new(Key::from_slice(wrapping_key));
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher.encrypt(&nonce, Payload { msg: data.as_bytes(), aad: context.as_bytes() }).map_err(|_| CryptoError::Other("加密失败".into()))?;
    let mut all = nonce.to_vec();
    all.extend_from_slice(&ct);
    Ok(B64.encode(all))
}

fn unwrap(wrapping_key: &[u8; 32], context: &str, wrapped: &str) -> Result<DataKey, CryptoError> {
    let all = B64.decode(wrapped).map_err(|_| CryptoError::Corrupt)?;
    if all.len() < NONCE_LEN + 16 {
        return Err(CryptoError::Corrupt);
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(wrapping_key));
    let mut plain = cipher.decrypt(XNonce::from_slice(&all[..NONCE_LEN]), Payload { msg: &all[NONCE_LEN..], aad: context.as_bytes() }).map_err(|_| CryptoError::BadPassword)?;
    let key = DataKey::from_slice(&plain).ok_or(CryptoError::Corrupt);
    plain.zeroize();
    key
}

const CTX_PASSWORD: &str = "marginalia/key/password/v1";
const CTX_RECOVERY: &str = "marginalia/key/recovery/v1";

/// A new library: a fresh data key, wrapped by the password and by a fresh recovery key. Returns the recovery key as text,
/// to show once.
pub fn create_keys(password: &str, kdf: KdfParams) -> Result<(KeyFile, DataKey, String), CryptoError> {
    let data = DataKey::random();
    let mut salt = [0u8; 16];
    fill_random(&mut salt);
    let mut pw = stretch(password, &salt, kdf)?;
    let wrapped = wrap(&pw, CTX_PASSWORD, &data)?;
    pw.zeroize();
    let mut rec = [0u8; 32];
    fill_random(&mut rec);
    let recovery_wrapped = wrap(&rec, CTX_RECOVERY, &data)?;
    let text = recovery_text(&rec);
    rec.zeroize();
    Ok((KeyFile { v: 1, kdf, salt: B64.encode(salt), wrapped, recovery_wrapped }, data, text))
}

/// Open the key file with the sync password.
pub fn unlock(kf: &KeyFile, password: &str) -> Result<DataKey, CryptoError> {
    if kf.v > 1 {
        return Err(CryptoError::Unsupported(kf.v.min(255) as u8));
    }
    let salt = B64.decode(&kf.salt).map_err(|_| CryptoError::Corrupt)?;
    let mut pw = stretch(password, &salt, kf.kdf)?;
    let key = unwrap(&pw, CTX_PASSWORD, &kf.wrapped);
    pw.zeroize();
    key
}

/// Open the key file with the recovery key (as shown by `create_keys`; spaces, dashes and case do not matter).
pub fn unlock_with_recovery(kf: &KeyFile, recovery: &str) -> Result<DataKey, CryptoError> {
    let mut rec = parse_recovery(recovery).ok_or(CryptoError::BadPassword)?;
    let key = unwrap(&rec, CTX_RECOVERY, &kf.recovery_wrapped);
    rec.zeroize();
    key
}

/// A new password for the same data key: nothing already in the cloud has to be encrypted again.
pub fn change_password(kf: &KeyFile, old: &str, new: &str) -> Result<KeyFile, CryptoError> {
    let data = unlock(kf, old)?;
    let mut salt = [0u8; 16];
    fill_random(&mut salt);
    let mut pw = stretch(new, &salt, kf.kdf)?;
    let wrapped = wrap(&pw, CTX_PASSWORD, &data)?;
    pw.zeroize();
    Ok(KeyFile { salt: B64.encode(salt), wrapped, ..kf.clone() })
}

// ---------------------------------------------------------------- the recovery key as text

const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// 32 bytes as 52 base32 letters in groups of four, e.g. `ABCD-EFGH-…`.
fn recovery_text(bytes: &[u8; 32]) -> String {
    let (mut bits, mut have, mut out) = (0u32, 0u32, String::new());
    for &b in bytes {
        bits = (bits << 8) | b as u32;
        have += 8;
        while have >= 5 {
            out.push(ALPHABET[((bits >> (have - 5)) & 31) as usize] as char);
            have -= 5;
        }
    }
    if have > 0 {
        out.push(ALPHABET[((bits << (5 - have)) & 31) as usize] as char);
    }
    out.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
}

fn parse_recovery(text: &str) -> Option<[u8; 32]> {
    let (mut bits, mut have, mut out) = (0u32, 0u32, Vec::new());
    for c in text.chars().filter(|c| !c.is_whitespace() && *c != '-') {
        let v = ALPHABET.iter().position(|&a| a as char == c.to_ascii_uppercase())? as u32;
        bits = (bits << 5) | v;
        have += 5;
        if have >= 8 {
            out.push(((bits >> (have - 8)) & 0xff) as u8);
            have -= 8;
        }
    }
    <[u8; 32]>::try_from(out.as_slice()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cheap stretching, so the tests run in milliseconds (the real cost is the default).
    const FAST: KdfParams = KdfParams { mem_kib: 8, iters: 1, lanes: 1 };

    fn key() -> DataKey {
        DataKey::random()
    }

    #[test]
    fn a_file_comes_back_as_it_went_in() {
        let k = key();
        for plain in [&b""[..], b"hello", "笔记、待办和目标".as_bytes(), &vec![7u8; 100_000]] {
            for compress in [false, true] {
                let sealed = seal(&k, "change", "a/1", plain, compress).unwrap();
                assert_eq!(open(&k, "change", "a/1", &sealed).unwrap(), plain);
            }
        }
    }

    #[test]
    fn the_same_text_never_gives_the_same_bytes() {
        let k = key();
        let a = seal(&k, "change", "n", b"same", false).unwrap();
        let b = seal(&k, "change", "n", b"same", false).unwrap();
        assert_ne!(a, b); // a fresh random nonce each time
        assert!(!a.windows(4).any(|w| w == b"same"), "the text is not visible in the file");
    }

    #[test]
    fn changing_any_single_byte_is_noticed() {
        let k = key();
        let sealed = seal(&k, "change", "n", b"important notes", true).unwrap();
        for i in 0..sealed.len() {
            let mut bad = sealed.clone();
            bad[i] ^= 1;
            assert!(open(&k, "change", "n", &bad).is_err(), "byte {i} changed without being noticed");
        }
        assert_eq!(open(&k, "change", "n", &sealed[..sealed.len() - 1]), Err(CryptoError::Corrupt)); // cut short
        assert_eq!(open(&k, "change", "n", b"not ours at all, not ours at all, not ours at all"), Err(CryptoError::Corrupt));
    }

    #[test]
    fn another_key_a_moved_file_or_another_kind_does_not_open() {
        let (k1, k2) = (key(), key());
        let sealed = seal(&k1, "change", "dev1/7", b"x", false).unwrap();
        assert_eq!(open(&k2, "change", "dev1/7", &sealed), Err(CryptoError::Corrupt));
        assert_eq!(open(&k1, "change", "dev1/8", &sealed), Err(CryptoError::Corrupt), "moved to another name");
        assert_eq!(open(&k1, "snapshot", "dev1/7", &sealed), Err(CryptoError::Corrupt), "opened as another kind");
        assert!(open(&k1, "change", "dev1/7", &sealed).is_ok());
    }

    #[test]
    fn a_newer_format_is_refused_politely() {
        let k = key();
        let mut sealed = seal(&k, "change", "n", b"x", false).unwrap();
        sealed[4] = 9;
        assert_eq!(open(&k, "change", "n", &sealed), Err(CryptoError::Unsupported(9)));
    }

    #[test]
    fn compression_helps_and_cannot_blow_up() {
        let k = key();
        let plain = vec![0u8; 5_000_000];
        let sealed = seal(&k, "snapshot", "s", &plain, true).unwrap();
        assert!(sealed.len() < 50_000, "{}", sealed.len());
        assert_eq!(open_limited(&k, "snapshot", "s", &sealed, 1_000_000), Err(CryptoError::Corrupt)); // longer than allowed
        assert_eq!(open_limited(&k, "snapshot", "s", &sealed, 5_000_000).unwrap().len(), 5_000_000);
    }

    #[test]
    fn remote_names_are_steady_per_key_and_do_not_show_the_hash() {
        let (k1, k2) = (key(), key());
        let hash = "a3f1c2d4e5b60718";
        assert_eq!(remote_name(&k1, "book", hash), remote_name(&k1, "book", hash));
        assert_ne!(remote_name(&k1, "book", hash), remote_name(&k2, "book", hash));
        assert_ne!(remote_name(&k1, "book", hash), remote_name(&k1, "image", hash));
        assert!(!remote_name(&k1, "book", hash).contains(hash));
        assert_eq!(remote_name(&k1, "book", hash).len(), 64);
    }

    #[test]
    fn the_password_opens_the_key_file_and_a_wrong_one_does_not() {
        let (kf, data, _) = create_keys("correct horse battery", FAST).unwrap();
        let again = unlock(&kf, "correct horse battery").unwrap();
        assert_eq!(again.as_bytes(), data.as_bytes());
        assert_eq!(unlock(&kf, "correct horse battery ").err(), Some(CryptoError::BadPassword));
        assert_eq!(unlock(&kf, "").err(), Some(CryptoError::BadPassword));
        // the key file survives being saved and read back
        let json = serde_json::to_string(&kf).unwrap();
        let back: KeyFile = serde_json::from_str(&json).unwrap();
        assert!(unlock(&back, "correct horse battery").is_ok());
        assert!(!json.contains("correct"));
    }

    #[test]
    fn the_recovery_key_opens_it_too_however_it_is_typed() {
        let (kf, data, recovery) = create_keys("pw", FAST).unwrap();
        assert_eq!(recovery.len(), 52 + 12); // 52 letters, 12 dashes
        for typed in [recovery.clone(), recovery.to_lowercase(), recovery.replace('-', " "), format!("  {recovery}  ")] {
            assert_eq!(unlock_with_recovery(&kf, &typed).unwrap().as_bytes(), data.as_bytes(), "{typed}");
        }
        let mut wrong = recovery.clone().into_bytes();
        wrong[0] = if wrong[0] == b'A' { b'B' } else { b'A' };
        assert_eq!(unlock_with_recovery(&kf, std::str::from_utf8(&wrong).unwrap()).err(), Some(CryptoError::BadPassword));
        assert_eq!(unlock_with_recovery(&kf, "nonsense").err(), Some(CryptoError::BadPassword));
    }

    #[test]
    fn a_new_password_keeps_everything_already_encrypted_readable() {
        let (kf, data, recovery) = create_keys("old pw", FAST).unwrap();
        let sealed = seal(&data, "change", "x", b"written before the change", true).unwrap();
        let kf2 = change_password(&kf, "old pw", "new pw").unwrap();
        assert!(unlock(&kf2, "old pw").is_err());
        let k = unlock(&kf2, "new pw").unwrap();
        assert_eq!(open(&k, "change", "x", &sealed).unwrap(), b"written before the change");
        assert!(unlock_with_recovery(&kf2, &recovery).is_ok(), "the recovery key still works");
        assert_eq!(change_password(&kf, "not the password", "x").err(), Some(CryptoError::BadPassword));
    }

    #[test]
    fn the_same_password_in_two_libraries_gives_different_keys() {
        let (kf1, _, _) = create_keys("same", FAST).unwrap();
        let (kf2, _, _) = create_keys("same", FAST).unwrap();
        assert_ne!(kf1.salt, kf2.salt);
        assert_ne!(kf1.wrapped, kf2.wrapped);
    }

    #[test]
    fn the_recovery_text_round_trips() {
        for _ in 0..50 {
            let mut b = [0u8; 32];
            fill_random(&mut b);
            let t = recovery_text(&b);
            assert_eq!(parse_recovery(&t), Some(b));
        }
        assert_eq!(parse_recovery("ABCD"), None); // too short
        assert_eq!(parse_recovery("1111-1111"), None); // not in the alphabet
    }

    /// How long the real password stretching takes on this machine: `cargo test --release stretch_time -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn stretch_time() {
        let t = std::time::Instant::now();
        let (kf, _, _) = create_keys("a long enough password", KdfParams::default()).unwrap();
        let made = t.elapsed();
        let t = std::time::Instant::now();
        unlock(&kf, "a long enough password").unwrap();
        println!("create {:?}, unlock {:?}", made, t.elapsed());
    }

    #[test]
    fn the_real_cost_is_the_default_and_it_is_not_silly() {
        let d = KdfParams::default();
        assert!(d.mem_kib >= 32 * 1024 && d.iters >= 2);
    }
}
