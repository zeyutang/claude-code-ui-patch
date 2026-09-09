// Anchor audit: which of the patcher's edits still land on an installed Claude
// Code build. Every release reshuffles the minified bundle, and a drifted
// anchor fails one of two ways. Either the point's status flips to "missing",
// which the amber status bar already reports, or the edit is skipped SILENTLY,
// because two places degrade on purpose rather than half-apply: the
// absolute-line-number block behind chatDiffCardLineNumbers (six fragments,
// all or nothing), and the permission-popup auto-scroll guard riding the
// scroll-to-bottom button. A status sweep alone therefore under-reports
// (Claude Code 2.1.245 broke three things and named one), so this also checks
// every marker the patcher can emit against the ones that actually landed.
//
// The audit patches a THROWAWAY COPY in the system temp dir. It never writes to
// the install it is auditing.
//
// Dev-only tooling: git-tracked for post-update checks, excluded from the VSIX
// via .vscodeignore (scripts/**), and intentionally absent from the README.
//
// Usage:
//   npm run anchor-audit
//   node scripts/anchor-audit.mjs [<install dir> ...]
//
// With no arguments it audits every anthropic.claude-code-* install under
// ~/.vscode/extensions (override with $CCUP_EXTENSIONS, colon-separated),
// newest first, and diffs the newest one's marker counts against the version
// before it. That comparison is the sharpest signal available and it is why an
// .obsolete leftover from an update is worth auditing rather than skipping: it
// is the last build known to work. Exits nonzero on any finding.
//
// It exercises out/patcher.js, so compile first if src/ has moved on.
//
// What it does not cover: whether a landed edit still behaves (see
// scripts/repro/ for the runtime canaries), and byte-identical restore.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FILES = ["extension.js", "webview/index.js", "webview/index.css"];
const VER_RE = /^anthropic\.claude-code-(\d+(?:\.\d+)*)/;

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Installs to audit, newest first. Explicit dirs win, and take their version
// from the folder name, so a copy parked anywhere still reports something.
function findInstalls(argv) {
  if (argv.length) {
    return argv.map((dir) => ({
      dir,
      version: basename(dir).match(VER_RE)?.[1] ?? "unknown",
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
      continue; // root not present on this machine
    }
    for (const entry of entries) {
      const version = entry.match(VER_RE)?.[1];
      const dir = join(base, entry);
      if (version && existsSync(join(dir, "extension.js"))) {
        found.push({ dir, version });
      }
    }
  }
  return found.sort((a, b) => compareVersions(b.version, a.version));
}

// The patcher is a VS Code extension module: hand it just enough API to read
// settings out of a plain object and to report nothing anywhere.
function loadPatcher(config, notices) {
  const conf = (ns) => ({
    get: (key, dflt) => {
      const full = ns ? `${ns}.${key}` : key;
      return full in config ? config[full] : dflt;
    },
    inspect: (key) => ({ globalValue: config[ns ? `${ns}.${key}` : key] }),
    update: async () => {},
  });
  const stub = {
    workspace: {
      getConfiguration: conf,
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    window: {
      showErrorMessage: (m) => notices.push(m),
      showWarningMessage: (m) => notices.push(m),
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

// Every setting on, so nothing is skipped for being unwanted: each number goes
// to its schema maximum (never the default, and never the 0/1 "off" value),
// each boolean to true, the align enum to its last choice, and each font family
// to a placeholder (only the injection's presence is under test). The chord
// settings stay empty so the find bar bakes its built-in defaults, which keeps
// the audit independent of the machine's keybindings.json. The native
// claudeCode.useCtrlEnterToSend comes along because ctrlEnterEverywhere folds
// it into the plan-comment toggle.
function everythingOn() {
  const props = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).contributes.configuration.properties;
  const config = { "claudeCode.useCtrlEnterToSend": true };
  for (const [key, schema] of Object.entries(props)) {
    if (schema.type === "boolean") config[key] = true;
    else if (schema.type === "number") config[key] = schema.maximum;
    else if (schema.enum) config[key] = schema.enum[schema.enum.length - 1];
    else config[key] = /Keys$/.test(key) ? "" : "AuditFont";
  }
  return config;
}

// Every marker the patcher can emit, read out of the compiled patcher so this
// never needs maintaining: the string and template literals, the escaped copies
// inside the readback regexes (some markers appear only there), and the
// concrete tags handed to the absLn/math fragment builders (whose own literal
// is interpolated, so the per-tag markers have to be rebuilt here).
function expectedMarkers() {
  const src = readFileSync(join(root, "out", "patcher.js"), "utf8");
  const markers = new Set();
  const add = (m) => {
    if (!m.includes("${")) markers.add(m);
    return m;
  };
  const quoted = /["'`]\/\*(?:ccup|cc-ui-patch)[^"'`]*?\*\//g;
  for (const m of src.match(quoted) ?? []) {
    add(m.slice(1).match(/^\/\*[\s\S]*?\*\//)[0]);
  }
  const escaped = /\\\/\\\*(?:ccup|cc-ui-patch)[^\\]*?\\\*\\\//g;
  for (const m of src.match(escaped) ?? []) add(m.replace(/\\(.)/g, "$1"));
  for (const [, tag] of src.matchAll(/absLnFrag\(\s*"([-\w]+)"/g)) {
    add(`/*ccup:absLn:${tag}*/`);
  }
  for (const [, tag] of src.matchAll(/mathFrag\(\s*"([-\w]+)"/g)) {
    add(`/*ccup:math:${tag}*/`);
  }
  return markers;
}

// Markers a point emits only while it still has to patch the feature in. When a
// Claude Code build absorbs the feature the point reports "native" (see nativeOn
// in the patcher) and emits nothing, so these are expected to be absent on that
// install and must not count as drift. Keyed by point id; add an entry whenever
// a point gains a nativeOn.
const NATIVE_MARKERS = {
  diffThemeSync: ["/*ccup-theme*/"],
};

// "<file> <marker>" -> occurrences. Counts, not just presence, so a block that
// loses some of its fragments shows up in the version-to-version diff.
function inventory(dir) {
  const counts = new Map();
  for (const rel of FILES) {
    const found =
      readFileSync(join(dir, rel), "utf8").match(
        /\/\*(?:ccup|cc-ui-patch)[^*]*\*\//g,
      ) ?? [];
    for (const marker of found) {
      const key = `${rel} ${marker}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function pointStates(P, ext) {
  const label = (kind) => (s) => ({ kind, ...s });
  return [
    ...P.analyze(ext, P.readSizes(), {}).map(label("size")),
    ...P.analyzeToggles(ext, P.readToggles()).map(label("toggle")),
    ...P.analyzeAlways(ext).map(label("always")),
    ...P.analyzeInjects(ext).map(label("inject")),
  ];
}

function auditInstall(P, install, expected) {
  const work = mkdtempSync(join(tmpdir(), "ccup-audit-"));
  try {
    mkdirSync(join(work, "webview"));
    for (const rel of FILES) {
      copyFileSync(join(install.dir, rel), join(work, rel));
    }
    const ext = { dir: work, version: install.version };
    P.initMathAssets(root);
    P.initFindKeys(join(work, "no-keybindings.json"));

    // The install arrives patched, so normalize to native first: which anchors
    // are patchable at all is a question about the stock bundle.
    P.restorePatch(ext, {});
    const states = pointStates(P, ext);
    const unpatchable = states.filter((s) => s.status === "missing");

    P.applyPatch(ext, P.readSizes(), P.readToggles(), {});
    const applied = pointStates(P, ext);
    // Anything the apply left off its target, missing anchors aside: the point
    // was patchable and still did not reach the requested state. "native" is on
    // target by definition: this build ships the feature, so there is no edit.
    const stale = applied.filter(
      (s) =>
        s.status !== "current" &&
        s.status !== "missing" &&
        s.status !== "native",
    );
    const native = applied.filter((s) => s.status === "native");
    // A native point emits none of its markers, legitimately, so they drop out
    // of this install's expected set and out of the regression diff below.
    // Otherwise absorbing a feature upstream would read as anchor drift forever.
    const exempt = new Set(
      native.flatMap((s) => NATIVE_MARKERS[s.id] ?? []).map((m) => m),
    );

    const counts = inventory(work);
    const landed = new Set([...counts.keys()].map((k) => k.split(" ")[1]));
    const missing = [...expected].filter(
      (m) => !landed.has(m) && !exempt.has(m),
    );
    const broken = [];
    for (const rel of FILES.filter((f) => f.endsWith(".js"))) {
      try {
        new Script(readFileSync(join(work, rel), "utf8"), { filename: rel });
      } catch (e) {
        broken.push(`${rel}: ${e.message}`);
      }
    }
    return {
      ...install,
      total: states.length,
      unpatchable,
      stale,
      native,
      exempt,
      missing,
      landed: landed.size,
      counts,
      broken,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Markers the previous build emitted that this one emits fewer of. The
// direction matters: a marker gaining occurrences is a new feature, losing
// them is drift.
function regressions(older, newer) {
  const lost = [];
  for (const [key, was] of older.counts) {
    const now = newer.counts.get(key) ?? 0;
    // Not drift when the newer build ships the feature itself: the marker is
    // absent because nothing needed injecting.
    if (newer.exempt.has(key.split(" ")[1])) continue;
    if (now < was) lost.push({ key, was, now });
  }
  return lost;
}

const argv = process.argv.slice(2);
const installs = findInstalls(argv);
if (!installs.length) {
  console.error(
    "No Claude Code install found. Pass one, or set $CCUP_EXTENSIONS.",
  );
  process.exit(2);
}

// Status column at 47, but never flush against a label that outgrew it.
const pad = (s) => s.padEnd(46) + (s.length >= 46 ? "  " : "");

const notices = [];
const P = loadPatcher(everythingOn(), notices);
const expected = expectedMarkers();
const results = installs.map((i) => auditInstall(P, i, expected));
let failed = false;

for (const r of results) {
  console.log(`\nClaude Code ${r.version}  ${r.dir}`);
  const bad = r.unpatchable.length;
  const nat = r.native.length;
  console.log(
    pad(
      `  points     ${r.total - bad - nat} patchable, ${bad} unpatchable${nat ? `, ${nat} native` : ""}`,
    ) + (bad ? "FAIL" : "ok"),
  );
  for (const s of r.unpatchable) {
    console.log(`    ${s.kind} ${s.id}: ${s.label}`);
  }
  for (const s of r.stale) {
    console.log(
      `    ${s.kind} ${s.id} did not apply (${s.status}): ${s.label}`,
    );
  }
  for (const s of r.native) {
    console.log(`    ${s.kind} ${s.id} built in here: ${s.label}`);
  }
  // Exempted markers are not owed on this install, so they leave the denominator
  // rather than sitting in it as a permanent shortfall.
  const want = [...expected].filter((m) => !r.exempt.has(m)).length;
  console.log(
    `  markers    ${r.landed} landed of ${want} expected`.padEnd(46) +
      (r.missing.length ? "FAIL" : "ok"),
  );
  for (const m of r.missing) console.log(`    never landed: ${m}`);
  console.log(
    `  syntax     patched bundle parses`.padEnd(46) +
      (r.broken.length ? "FAIL" : "ok"),
  );
  for (const b of r.broken) console.log(`    ${b}`);
  if (bad || r.stale.length || r.missing.length || r.broken.length) {
    failed = true;
  }
}

if (results.length > 1) {
  const [newer, older] = results;
  const lost = regressions(older, newer);
  console.log(`\n${newer.version} against ${older.version}`);
  console.log(
    `  markers    ${lost.length} regressed`.padEnd(46) +
      (lost.length ? "FAIL" : "ok"),
  );
  for (const l of lost) console.log(`    ${l.key}: ${l.was} -> ${l.now}`);
  if (lost.length) failed = true;
} else {
  console.log("\nOnly one install audited, so no version-to-version diff.");
}

for (const n of notices) console.log(`\npatcher reported: ${n}`);
console.log(failed ? "\nFAIL" : "\nOK");
process.exit(failed ? 1 : 0);
