// Checks the three UI dictionaries: same keys (English may add plural forms `key_one` / `key_other`) and the same
// {placeholders}. Also lists Chinese text still written outside src/i18n (informational, `--strict` makes it an error).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = "src/i18n";
const load = (f) => {
  const map = new Map();
  for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
    const m = /^\s*"([^"]+)":\s*(".*"),?\s*$/.exec(line);
    if (m) map.set(m[1], JSON.parse(m[2].replace(/,$/, "")));
  }
  return map;
};
const hans = load("zh-Hans.ts");
const hant = load("zh-Hant.ts");
const en = load("en.ts");
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
let bad = 0;
const report = (msg) => (bad++, console.log("✗", msg));
for (const [name, d] of [["zh-Hant", hant], ["en", en]]) {
  for (const k of hans.keys()) if (!d.has(k)) report(`${name} is missing ${k}`);
  for (const k of d.keys()) if (!hans.has(k) && !/_(one|other)$/.test(k)) report(`${name} has an extra key ${k}`);
  for (const [k, v] of d) {
    const base = hans.get(k) ?? hans.get(k.replace(/_(one|other)$/, ""));
    if (base !== undefined && vars(v) !== vars(base)) report(`${name} ${k}: placeholders {${vars(v)}} differ from {${vars(base)}}`);
  }
}
console.log(`${hans.size} keys; ${bad ? bad + " problem(s)" : "dictionaries are consistent"}`);

const leaks = [];
const walk = (p) => {
  for (const f of readdirSync(p)) {
    const full = join(p, f);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(f) && !full.split("\\").join("/").includes("src/i18n/")) {
      readFileSync(full, "utf8").split("\n").forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "").trim();
        if (/[一-鿿]/.test(code) && !/^\*/.test(code)) leaks.push(`${full}:${i + 1}: ${code.slice(0, 90)}`);
      });
    }
  }
};
walk("src");
console.log(`${leaks.length} line(s) with Chinese text outside src/i18n (parser keywords and stored names are expected)`);
if (process.argv.includes("--list")) console.log(leaks.join("\n"));
process.exit(bad || (process.argv.includes("--strict") && leaks.length) ? 1 : 0);
