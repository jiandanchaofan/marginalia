// After `npm run tauri build -- --bundles nsis`: make the installer carry on by itself once the user has confirmed
// the "an older version is installed" page, and rebuild the setup .exe from the patched script.
//
// Tauri's NSIS template already has a "passive" mode (progress bar only, no further pages, closes when done). It is
// switched on from the command line (/P). Here it is also switched on at the moment the user leaves the reinstall page
// (whatever they picked), so the old version is removed without a second prompt, the directory / finish pages are
// skipped, the progress bar runs, the installer closes, and the new version starts.
//
// usage: node scripts/patch-installer.mjs
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const nsisDir = "src-tauri/target/release/nsis/x64";
const script = join(nsisDir, "installer.nsi");
const makensis = join(process.env.LOCALAPPDATA ?? "", "tauri", "NSIS", "makensis.exe");
if (!existsSync(script)) throw new Error(`no ${script}: build the installer first`);
if (!existsSync(makensis)) throw new Error(`makensis not found at ${makensis}`);

let s = readFileSync(script, "utf8");
if (s.includes("AutoFlow")) {
  console.log("already patched");
} else {
  const must = (cond, what) => {
    if (!cond) throw new Error(`the installer template changed, can't patch: ${what}`);
  };
  must(s.includes("Var PassiveMode"), "Var PassiveMode");
  s = s.replace("Var PassiveMode", "Var PassiveMode\nVar AutoFlow");

  must(/Function PageLeaveReinstall\r?\n/.test(s), "PageLeaveReinstall");
  s = s.replace(/Function PageLeaveReinstall(\r?\n)/, "Function PageLeaveReinstall$1  ; the user has decided: carry on without asking anything else$1  StrCpy $PassiveMode 1$1  StrCpy $AutoFlow 1$1  ; the app may be running in the tray / as desktop cards: end it quietly, or the old files stay locked$1  nsExec::Exec 'taskkill /F /IM \"${MAINBINARYNAME}.exe\"'$1  Sleep 900$1");

  must(/Function \.onInstSuccess\r?\n/.test(s), ".onInstSuccess");
  s = s.replace(/Function \.onInstSuccess(\r?\n)/, 'Function .onInstSuccess$1  ${If} $AutoFlow = 1$1    nsis_tauri_utils::RunAsUser "$INSTDIR\\${MAINBINARYNAME}.exe" ""$1  ${EndIf}$1');
  writeFileSync(script, s, "utf8");
  console.log("patched", script);
}

// rebuild exactly the way Tauri does (from the folder of the script), then put the result where the bundler left its own
const log = execFileSync(makensis, ["-INPUTCHARSET", "UTF8", "-OUTPUTCHARSET", "UTF8", "-V2", "installer.nsi"], { cwd: nsisDir, encoding: "utf8" });
console.log(log.split("\n").slice(-6).join("\n"));
const version = /!define VERSION "([^"]+)"/.exec(s)?.[1];
const out = readdirSync("src-tauri/target/release/bundle/nsis").find((f) => f.includes(`_${version}_`) && f.endsWith("-setup.exe"));
if (!out) throw new Error(`setup for ${version} not found in bundle/nsis`);
copyFileSync(join(nsisDir, "nsis-output.exe"), join("src-tauri/target/release/bundle/nsis", out));
console.log("replaced", out);
