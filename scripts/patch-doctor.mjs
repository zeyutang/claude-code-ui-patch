// Patch doctor: is THIS install, right now, in the state MY settings ask for?
//
// anchor-audit answers a different question. It normalizes a throwaway copy to
// native, re-applies with every setting forced on, and reports which anchors
// still bite. That is the right check after a Claude Code release, but it never
// looks at the live install's actual bytes and never uses the real settings, so
// a bundle that is silently out of step with the user's configuration passes it.
//
// This script closes that gap, and exists because of a failure mode the panel
// cannot show: every status dot read "current" while a patched feature was dead
// in the running webview. The dots compare disk against settings; they cannot
// see what the webview actually loaded, nor whether the dir being patched is the
// dir the extension host booted from. So the checks below are deliberately
// about disk truth and install identity, and the last section hands over to a
// runtime probe for the one question disk cannot answer.
//
// It never writes to the install it inspects: the at-target check runs against
// a throwaway copy in the system temp dir.
//
// Dev-only tooling: git-tracked for diagnosis, excluded from the VSIX via
// .vscodeignore (scripts/**), and intentionally absent from the README.
//
// Usage:
//   npm run patch-doctor
//   node scripts/patch-doctor.mjs [<install dir>]
//
// Settings come from the VS Code stable user dir for the platform. Override with
// $CCUP_USER_DIR (the "User" folder), or $CCUP_SETTINGS / $CCUP_KEYBINDINGS for
// the individual files, to point at a fork or a second profile. Installs are
// scanned under ~/.vscode/extensions unless $CCUP_EXTENSIONS is set.
//
// It exercises out/patcher.js, so compile first if src/ has moved on.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FILES = ["extension.js", "webview/index.js", "webview/index.css"];
const VER_RE = /^anthropic\.claude-code-(\d+(?:\.\d+)*)/;

// Globals each toggle's injected code installs in the webview, for the runtime
// probe at the end. Keyed by the public setting name so this survives renames of
// the internal point ids. "late" marks a global that only appears once the
// feature's surface has rendered, so its absence alone proves nothing.
const PROBES = [
  ["chatFindBar", "window.__ccupFindCfg"],
  ["chatScrollToBottomDot", "window.__ccupScrollDot"],
  ["chatScrollToBottomDot", "window.__ccupPermGlide"],
  ["chatJumpToMessageButtons", "window.__ccupJumpMsg"],
  ["chatDiffCardLineNumbers", "window.__ccupAbsLn"],
  ["chatMathRendering", "window.__ccupMathW"],
  ["chatMathRendering", "window.__ccupMathR"],
  ["chatDiffCardThemeSync", "window.__ccupThemeObs", "late"],
];

function userDir() {
  if (process.env.CCUP_USER_DIR) return process.env.CCUP_USER_DIR;
  const p = platform();
  if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", "Code", "User");
  }
  if (p === "win32") {
    return join(process.env.APPDATA ?? homedir(), "Code", "User");
  }
  return join(homedir(), ".config", "Code", "User");
}
const settingsPath =
  process.env.CCUP_SETTINGS ?? join(userDir(), "settings.json");
const keybindingsPath =
  process.env.CCUP_KEYBINDINGS ?? join(userDir(), "keybindings.json");

// Comments and trailing commas, the way VS Code writes them.
function parseJsonc(raw) {
  let out = "";
  let i = 0;
  let inStr = false;
  let esc = false;
  while (i < raw.length) {
    const ch = raw[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      const nl = raw.indexOf("\n", i);
      i = nl < 0 ? raw.length : nl;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      const end = raw.indexOf("*/", i + 2);
      i = end < 0 ? raw.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function readObsolete(base) {
  try {
    const raw = JSON.parse(readFileSync(join(base, ".obsolete"), "utf8"));
    return new Set(Object.keys(raw).filter((k) => raw[k] === true));
  } catch {
    return new Set();
  }
}

// Every Claude Code install on disk, newest first, each flagged with whether the
// extensions root has it pending deletion. findLatestClaudeExt picks the highest
// non-obsolete one, so that is the dir the patcher writes to.
function findInstalls(argv) {
  if (argv.length) {
    return argv.map((dir) => ({
      dir,
      version: basename(dir).match(VER_RE)?.[1] ?? "unknown",
      obsolete: false,
    }));
  }
  const roots = (
    process.env.CCUP_EXTENSIONS ?? join(homedir(), ".vscode", "extensions")
  ).split(":");
  const found = [];
  for (const base of roots) {
    let entries = [];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    const obsolete = readObsolete(base);
    for (const entry of entries) {
      const version = entry.match(VER_RE)?.[1];
      const dir = join(base, entry);
      if (version && existsSync(join(dir, "extension.js"))) {
        found.push({ dir, version, obsolete: obsolete.has(entry) });
      }
    }
  }
  return found.sort((a, b) => compareVersions(b.version, a.version));
}

// The patcher is a VS Code extension module: hand it the real settings and let
// it report nowhere.
function loadPatcher(config, notices) {
  const conf = (ns) => ({
    get: (key, dflt) => {
      const full = ns ? `${ns}.${key}` : key;
      return full in config ? config[full] : dflt;
    },
    inspect: (key) => ({ globalValue: config[ns ? `${ns}.${key}` : key] }),
    update: async (key, value) => {
      const full = ns ? `${ns}.${key}` : key;
      if (value === undefined) delete config[full];
      else config[full] = value;
    },
  });
  const stub = {
    workspace: {
      getConfiguration: conf,
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
      showErrorMessage: (m) => notices.push(m),
      showWarningMessage: (m) => notices.push(m),
      showInformationMessage: (m) => notices.push(m),
    },
    commands: {
      executeCommand: async () => {},
      registerCommand: () => ({ dispose() {} }),
    },
    extensions: {
      getExtension: () => undefined,
      onDidChange: () => ({ dispose() {} }),
    },
    EventEmitter: class {
      constructor() {
        this.event = () => ({ dispose() {} });
      }
      fire() {}
      dispose() {}
    },
    Disposable: { from: () => ({ dispose() {} }) },
    ConfigurationTarget: { Global: 1 },
  };
  const Module = require("node:module");
  const load = Module._load;
  Module._load = (request, ...rest) =>
    request === "vscode" ? stub : load(request, ...rest);
  return require(join(root, "out", "patcher.js"));
}

function states(P, ext) {
  const label = (kind) => (s) => ({ kind, ...s });
  // A fresh cache per analyzer, so every read comes off disk rather than from
  // the map applyPatch seeds with its own intended output.
  return [
    ...P.analyze(ext, P.readSizes(), {}).map(label("size")),
    ...P.analyzeToggles(ext, P.readToggles()).map(label("toggle")),
    ...P.analyzeAlways(ext).map(label("always")),
    ...P.analyzeInjects(ext).map(label("inject")),
  ];
}

// What an apply pass would do to the install as it stands. Zero changes is the
// healthy answer: the bytes on disk already are what the settings ask for. Any
// entry means the live bundle is out of step even if every dot reads current.
function atTargetCheck(P, install) {
  const work = mkdtempSync(join(tmpdir(), "ccup-doctor-"));
  try {
    mkdirSync(join(work, "webview"));
    for (const rel of FILES)
      copyFileSync(join(install.dir, rel), join(work, rel));
    // The math toggle syncs webfont FILES too, so carry them over or the copy
    // reports a font sync that the real install does not need.
    const fonts = join(install.dir, "webview", "fonts");
    if (existsSync(fonts)) {
      mkdirSync(join(work, "webview", "fonts"), { recursive: true });
      for (const f of readdirSync(fonts)) {
        copyFileSync(join(fonts, f), join(work, "webview", "fonts", f));
      }
    }
    const ext = { dir: work, version: install.version };
    return P.applyPatch(ext, P.readSizes(), P.readToggles(), {}).changed;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function mtimes(dir) {
  const out = [];
  for (const rel of [".vsixmanifest", ...FILES]) {
    try {
      out.push({ rel, mtime: statSync(join(dir, rel)).mtime });
    } catch {
      out.push({ rel, mtime: undefined });
    }
  }
  return out;
}

function markerCounts(dir) {
  const counts = new Map();
  for (const rel of FILES) {
    const found =
      readFileSync(join(dir, rel), "utf8").match(
        /\/\*(?:ccup|cc-ui-patch)[^*]*\*\//g,
      ) ?? [];
    for (const m of found) counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  return counts;
}

const argv = process.argv.slice(2);
const installs = findInstalls(argv);
if (!installs.length) {
  console.error(
    "No Claude Code install found. Pass one, or set $CCUP_EXTENSIONS.",
  );
  process.exit(2);
}

let config;
try {
  config = parseJsonc(readFileSync(settingsPath, "utf8"));
} catch (e) {
  console.error(`Could not read settings from ${settingsPath}: ${e.message}`);
  process.exit(2);
}

const notices = [];
const P = loadPatcher(config, notices);
await P.migrateLegacyKeys();
P.initMathAssets(root);
P.initFindKeys(keybindingsPath);

let failed = false;
const line = (text, ok) =>
  console.log(`  ${text.padEnd(52)}${ok ? "ok" : "FAIL"}`);

console.log(`\nsettings     ${settingsPath}`);
console.log(
  `keybindings  ${keybindingsPath}${existsSync(keybindingsPath) ? "" : "  (absent: built-in chords)"}`,
);

// Which install the patcher targets, and whether anything could be confused
// with it. Two live installs is normal for a few minutes after an update, but
// while it lasts the host is still running the older one and the panel reports
// on the newer, so a green dot says nothing about the running webview.
const live = installs.filter((i) => !i.obsolete);
console.log(`\ninstalls`);
for (const i of installs) {
  const tag =
    i === live[0] ? "  <- patch target" : i.obsolete ? "  (obsolete)" : "";
  console.log(`  ${i.version.padEnd(12)}${i.dir}${tag}`);
}
line(
  `installs     ${live.length} live, ${installs.length - live.length} obsolete`,
  live.length <= 1,
);
if (live.length > 1) {
  console.log(
    "    more than one live install: the host may be running a different",
  );
  console.log(
    "    one than the patcher writes to, so statuses can read green while",
  );
  console.log("    the running webview is native. Reload the window.");
  failed = true;
}

const target = live[0] ?? installs[0];
const ext = { dir: target.dir, version: target.version };

console.log(`\nClaude Code ${target.version}  ${target.dir}`);

// Forensics: the bundle files are rewritten in place by the patch, so an
// index.js older than the manifest it shipped with has never been patched.
for (const { rel, mtime } of mtimes(target.dir)) {
  console.log(`  ${rel.padEnd(20)}${mtime ? mtime.toISOString() : "(absent)"}`);
}

const st = states(P, ext);
const notCurrent = st.filter((s) => s.status !== "current");
line(
  `status       ${st.length - notCurrent.length} current of ${st.length}`,
  !notCurrent.length,
);
for (const s of notCurrent) {
  console.log(
    `    ${s.status.toUpperCase()} ${s.kind} ${s.id}: ${s.label ?? ""}`,
  );
}
if (notCurrent.length) failed = true;

const changed = atTargetCheck(P, target);
line(
  `at target    ${changed.length} edits an apply pass would make`,
  !changed.length,
);
for (const c of changed) console.log(`    would change: ${c}`);
if (changed.length) {
  console.log(
    "    the bytes on disk are not what the settings ask for, whatever the",
  );
  console.log(
    "    panel dots say. Change any claudeCodeUiPatch setting to force a pass.",
  );
  failed = true;
}

const counts = markerCounts(target.dir);
const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`  markers    ${counts.size} distinct, ${total} occurrences`);

// The one question disk cannot answer. Every check above can pass while the
// running webview executes an older copy of index.js, which is what a dead
// feature over green dots looks like.
console.log(`\nruntime probe`);
console.log(
  '  Run "Developer: Open Webview Developer Tools" on the Claude Code',
);
console.log(
  "  view and evaluate these. Defined means the patched bundle is the one",
);
console.log(
  "  actually running; all undefined means the webview loaded an older",
);
console.log("  copy and only a reload (or a forced rewrite) will help.");
for (const [key, global, late] of PROBES) {
  const on = config[`claudeCodeUiPatch.${key}`];
  if (!on) continue;
  console.log(
    `    ${global}${late ? "   (only after a diff card renders)" : ""}`,
  );
}

for (const n of notices) console.log(`\npatcher reported: ${n}`);
console.log(failed ? "\nFAIL" : "\nOK");
process.exit(failed ? 1 : 0);
