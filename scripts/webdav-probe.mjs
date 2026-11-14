// Probe a WebDAV server (made for 坚果云) before the sync is built on it: what it allows, how fast it is, where it pushes back.
//
//   PowerShell:  $env:DAV_USER = "you@example.com"; $env:DAV_PASS = "<application password>"; node scripts/webdav-probe.mjs
//   (optional)   $env:DAV_URL  = "https://dav.jianguoyun.com/dav/"
//   (optional)   $env:DAV_BIG_MB = "5"     size of the big transfer, default 5
//   (optional)   $env:DAV_EXTRA = "1"      also test Range requests, repeated and parallel downloads, a correct If-Match, a longer burst (about 160 more requests)
//
// It makes one folder called marginalia-probe-<time>, uses it, and deletes it again. About 70 requests (about 230 with DAV_EXTRA).
// The account and the password are only read from the environment and are never printed.

const URL_BASE = (process.env.DAV_URL || "https://dav.jianguoyun.com/dav/").replace(/\/?$/, "/");
const USER = process.env.DAV_USER;
const PASS = process.env.DAV_PASS;
const BIG_MB = Math.max(1, Number(process.env.DAV_BIG_MB) || 5);
if (!USER || !PASS) {
  console.error("Set DAV_USER and DAV_PASS first (see the top of this file).");
  process.exit(2);
}
const AUTH = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
const enc = (p) => p.split("/").map(encodeURIComponent).join("/");
const report = { server: URL_BASE, steps: [] };
let requests = 0;

async function dav(method, path, { body, headers = {}, timeout = 60000 } = {}) {
  requests++;
  const t0 = performance.now();
  try {
    const res = await fetch(URL_BASE + enc(path), { method, body, headers: { Authorization: AUTH, ...headers }, signal: AbortSignal.timeout(timeout), redirect: "manual" });
    const buf = method === "GET" || method === "PROPFIND" ? Buffer.from(await res.arrayBuffer()) : (await res.arrayBuffer(), Buffer.alloc(0));
    return { status: res.status, ms: Math.round(performance.now() - t0), headers: res.headers, body: buf };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), error: String(e?.cause?.code || e?.message || e), headers: new Headers(), body: Buffer.alloc(0) };
  }
}
const step = (name, ok, detail = {}) => {
  report.steps.push({ name, ok, ...detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${Object.keys(detail).length ? "  " + JSON.stringify(detail) : ""}`);
  return ok;
};
const props = (xml) => [...xml.matchAll(/<(?:\w+:)?response>([\s\S]*?)<\/(?:\w+:)?response>/g)].map((m) => {
  const g = (tag) => m[1].match(new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`))?.[1];
  return { href: decodeURIComponent(g("href") || ""), etag: g("getetag"), modified: g("getlastmodified"), size: g("getcontentlength"), isDir: /<(?:\w+:)?collection\b/.test(m[1]) };
});

const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
let dir = `marginalia-probe-${stamp}`;

// 1. who am I, and what is at the top
const root = await dav("PROPFIND", "", { headers: { Depth: "1", "Content-Type": "application/xml" }, body: '<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>' });
if (!step("list the top folder (PROPFIND, Depth 1)", root.status === 207, { status: root.status, ms: root.ms, error: root.error })) {
  if (root.status === 401) console.error("401: the account or the application password is wrong (use an *application* password, not the login password).");
  process.exit(1);
}
const top = props(root.body.toString("utf8"));
report.topFolders = top.filter((p) => p.isDir).map((p) => p.href.replace(/^.*\/dav\//, "")).slice(0, 12);
console.log("     folders at the top:", report.topFolders.join(" | ") || "(none)");
report.dav = root.headers.get("dav") || undefined;
report.allow = root.headers.get("allow") || undefined;

// 2. make a folder at the top; if that is not allowed, inside the first folder there
let mk = await dav("MKCOL", dir);
if (mk.status !== 201 && mk.status !== 200) {
  const first = top.find((p) => p.isDir && p.href.replace(/\/$/, "") !== URL_BASE.replace(/^https?:\/\/[^/]+/, "").replace(/\/$/, ""));
  const name = first && decodeURIComponent(first.href).replace(/^.*\/dav\//, "").replace(/\/$/, "");
  step("make a folder at the top (MKCOL)", false, { status: mk.status });
  if (name) {
    dir = `${name}/${dir}`;
    mk = await dav("MKCOL", dir);
  }
}
if (!step(`make the probe folder${dir.includes("/") ? " inside a sync folder" : ""} (MKCOL)`, mk.status === 201 || mk.status === 200, { status: mk.status, ms: mk.ms })) process.exit(1);
report.probeFolder = dir.includes("/") ? "inside a sync folder" : "at the top";

try {
  // 3. small file: put, get, headers
  const small = Buffer.from("hello 墨边 " + stamp);
  const put = await dav("PUT", `${dir}/a.txt`, { body: small, headers: { "Content-Type": "application/octet-stream" } });
  step("upload a small file (PUT)", put.status === 201 || put.status === 204 || put.status === 200, { status: put.status, ms: put.ms, etagInPut: !!put.headers.get("etag") });
  const get = await dav("GET", `${dir}/a.txt`);
  step("download it and compare (GET)", get.status === 200 && get.body.equals(small), { status: get.status, ms: get.ms });
  const head = await dav("PROPFIND", `${dir}/a.txt`, { headers: { Depth: "0" } });
  const p0 = props(head.body.toString("utf8"))[0] || {};
  step("modification time and ETag are given (PROPFIND)", !!p0.modified && !!p0.etag, { modified: p0.modified, etag: p0.etag, size: p0.size });
  const etag1 = p0.etag;

  // 4. overwrite changes the ETag
  await new Promise((r) => setTimeout(r, 1500));
  await dav("PUT", `${dir}/a.txt`, { body: Buffer.from(small + "!") });
  const p1 = props((await dav("PROPFIND", `${dir}/a.txt`, { headers: { Depth: "0" } })).body.toString("utf8"))[0] || {};
  step("overwriting changes the ETag and the time", !!etag1 && p1.etag !== etag1 && p1.modified !== p0.modified, { before: etag1, after: p1.etag });

  // 5. conditional writes (needed to avoid overwriting somebody else's change)
  const ifMatch = await dav("PUT", `${dir}/a.txt`, { body: Buffer.from("x"), headers: { "If-Match": '"definitely-not-the-etag"' } });
  step("a PUT with a wrong If-Match is refused (412)", ifMatch.status === 412, { status: ifMatch.status });
  const ifNone = await dav("PUT", `${dir}/a.txt`, { body: Buffer.from("x"), headers: { "If-None-Match": "*" } });
  step("a PUT with If-None-Match: * on an existing file is refused (412)", ifNone.status === 412, { status: ifNone.status });

  // 6. names: Chinese, spaces, long
  for (const [label, name] of [["Chinese file name", "笔记 一.json"], ["a long name (150 chars)", "n".repeat(146) + ".enc"], ["nested folder", "sub/deeper/file.bin"]]) {
    if (name.includes("/")) {
      await dav("MKCOL", `${dir}/sub`);
      await dav("MKCOL", `${dir}/sub/deeper`);
    }
    const r = await dav("PUT", `${dir}/${name}`, { body: Buffer.from("1") });
    const back = await dav("GET", `${dir}/${name}`);
    step(`${label}`, [200, 201, 204].includes(r.status) && back.status === 200, { put: r.status, get: back.status });
  }

  // 7. listing a folder with several files
  const list = await dav("PROPFIND", dir, { headers: { Depth: "1" } });
  step("list a folder (PROPFIND, Depth 1)", list.status === 207 && props(list.body.toString("utf8")).length >= 4, { status: list.status, entries: props(list.body.toString("utf8")).length });

  // 8. a big file: speed up and down
  const big = Buffer.alloc(BIG_MB * 1024 * 1024, 7);
  const up = await dav("PUT", `${dir}/big.bin`, { body: big, timeout: 10 * 60000 });
  step(`upload ${BIG_MB} MB`, [200, 201, 204].includes(up.status), { status: up.status, seconds: +(up.ms / 1000).toFixed(1), MBps: +(BIG_MB / (up.ms / 1000)).toFixed(2), error: up.error });
  const down = await dav("GET", `${dir}/big.bin`, { timeout: 10 * 60000 });
  step(`download ${BIG_MB} MB`, down.status === 200 && down.body.length === big.length, { status: down.status, seconds: +(down.ms / 1000).toFixed(1), MBps: +(BIG_MB / (down.ms / 1000)).toFixed(2) });

  // 9. a burst of small requests: where does it start to push back?
  const codes = {};
  let slowest = 0;
  let total = 0;
  const t0 = performance.now();
  for (let i = 0; i < 50; i++) {
    const r = await dav("PUT", `${dir}/burst-${i}.json`, { body: Buffer.from(JSON.stringify({ i })) });
    codes[r.status] = (codes[r.status] || 0) + 1;
    slowest = Math.max(slowest, r.ms);
    total++;
    if (![200, 201, 204].includes(r.status)) {
      report.firstRefusal = { afterRequests: i + 1, status: r.status, retryAfter: r.headers.get("retry-after") || undefined, body: r.body.toString("utf8").slice(0, 120) };
      break;
    }
  }
  step("50 small uploads in a row", Object.keys(codes).every((c) => [200, 201, 204].includes(Number(c))), { statuses: codes, seconds: +((performance.now() - t0) / 1000).toFixed(1), slowestMs: slowest });

  // ---- the second round: what the sync needs to move big files and to update a file safely
  if (process.env.DAV_EXTRA) {
    const mbps = (bytes, ms) => +(bytes / 1048576 / (ms / 1000)).toFixed(2);
    // Range: needed to resume a download and to fetch pieces in parallel
    const rg = await dav("GET", `${dir}/big.bin`, { headers: { Range: "bytes=0-99" } });
    step("a Range request (bytes 0-99) answers 206 with 100 bytes", rg.status === 206 && rg.body.length === 100, { status: rg.status, bytes: rg.body.length, contentRange: rg.headers.get("content-range") || undefined });
    // is the slow download steady?
    const speeds = [];
    for (let i = 0; i < 3; i++) {
      const d = await dav("GET", `${dir}/big.bin`, { timeout: 10 * 60000 });
      speeds.push(d.status === 200 ? mbps(d.body.length, d.ms) : `status ${d.status}`);
    }
    step(`download ${BIG_MB} MB three times in a row (MB/s)`, speeds.every((x) => typeof x === "number"), { speeds });
    // four pieces at once
    if (rg.status === 206) {
      const n = 4;
      const len = Math.floor(big.length / n);
      const t1 = performance.now();
      const parts = await Promise.all(Array.from({ length: n }, (_, i) => dav("GET", `${dir}/big.bin`, { headers: { Range: `bytes=${i * len}-${i === n - 1 ? big.length - 1 : (i + 1) * len - 1}` }, timeout: 10 * 60000 })));
      const ms = performance.now() - t1;
      const got = parts.reduce((x, p) => x + p.body.length, 0);
      step(`download in ${n} pieces at once`, parts.every((p) => p.status === 206) && got === big.length, { statuses: parts.map((p) => p.status), seconds: +(ms / 1000).toFixed(1), MBps: mbps(got, ms) });
    }
    // a correct If-Match must succeed
    const cur = props((await dav("PROPFIND", `${dir}/a.txt`, { headers: { Depth: "0" } })).body.toString("utf8"))[0]?.etag;
    const ok = await dav("PUT", `${dir}/a.txt`, { body: Buffer.from("updated"), headers: { "If-Match": `"${cur}"` } });
    step("a PUT with the right If-Match goes through", [200, 201, 204].includes(ok.status), { status: ok.status });
    // a longer burst of cheap requests
    const codes2 = {};
    const t2 = performance.now();
    let n2 = 0;
    for (let i = 0; i < 150; i++) {
      const r = await dav("PROPFIND", `${dir}/a.txt`, { headers: { Depth: "0" } });
      codes2[r.status] = (codes2[r.status] || 0) + 1;
      n2++;
      if (r.status !== 207) {
        report.secondRefusal = { afterRequests: i + 1, status: r.status, retryAfter: r.headers.get("retry-after") || undefined, body: r.body.toString("utf8").slice(0, 160) };
        break;
      }
    }
    step(`${n2} cheap requests in a row (PROPFIND)`, Object.keys(codes2).every((c) => c === "207"), { statuses: codes2, seconds: +((performance.now() - t2) / 1000).toFixed(1) });
  }
  report.requestsSoFar = requests;
} finally {
  // clean up: delete the whole folder
  const del = await dav("DELETE", dir);
  step("delete the probe folder", [200, 204].includes(del.status), { status: del.status });
  report.requests = requests;
}

console.log("\n--- summary (safe to share: no account, no password) ---");
console.log(JSON.stringify(report, null, 2));
