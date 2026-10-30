// Plain Node scenario (no browser, not for scripts/cdp-driver.mjs): the
// always-on revealIfOpen fix, run as the REAL openFile of Claude Code's
// extension host. The method is cut out of the host bundle and rebuilt in a
// with-scope whose minified module names resolve to a stand-in vscode (tab
// groups, show calls recorded), Node's path, and Node's fs over files in a
// temp dir. Each case lays out editor groups and tabs, opens a file the way a
// click on a file reference does, and compares the options that reach
// window.showTextDocument (or vscode.open, the binary fallback) with what the
// patch should pass: the view column of the group already holding the file,
// or nothing where VS Code's own handling stays in charge.
//
//   node scripts/repro/reveal-if-open.mjs
//
// The native method runs first and has to reproduce the bug: once it passes a
// view column for a file another group shows, Claude Code itself has fixed it,
// and the point can be retired. The patched bundle is the compiled patcher's
// own output for the live install (revealIfOpenHost, out/, so compile first),
// so the scenario runs exactly what an apply writes and doubles as the drift
// canary. The live install is found under ~/.vscode/extensions (newest Claude
// Code install) or via $CCUP_BUNDLE (the webview directory, with extension.js
// beside it).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// The compiled patcher. It reads vscode only inside functions, so an empty
// stand-in is enough to load the module.
function loadPatcher() {
  const Module = require("node:module");
  const load = Module._load;
  Module._load = (request, ...rest) =>
    request === "vscode" ? {} : load(request, ...rest);
  try {
    const root = path.dirname(
      path.dirname(path.dirname(fileURLToPath(import.meta.url))),
    );
    return require(path.join(root, "out", "patcher.js"));
  } finally {
    Module._load = load;
  }
}

function liveBundleDir() {
  if (process.env.CCUP_BUNDLE) return process.env.CCUP_BUNDLE;
  const root = path.join(homedir(), ".vscode", "extensions");
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("anthropic.claude-code-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!dirs.length) throw new Error(`no Claude Code install under ${root}`);
  return path.join(root, dirs[dirs.length - 1], "webview");
}

const FRAG_RE =
  /\/\*ccup:revealIfOpen:[-\w]+\*\/[\s\S]*?\/\*ccup:revealIfOpenEnd\*\//g;

// The one openFile method definition in a host bundle, brace-matched past
// strings, template literals and comments (the injected helper carries line
// comments). Regex literals are not lexed: openFile's own hold no brace,
// quote or backtick.
function cutOpenFile(c) {
  const at = [...c.matchAll(/(?<![\w$.])(?:async\s+)?openFile\(/g)].map(
    (m) => m.index,
  );
  if (at.length !== 1) throw new Error(`${at.length} openFile definitions`);
  const open = c.indexOf("{", c.indexOf(")", at[0]));
  // "{" a code brace, "`" inside a template, "${" a template's expression.
  const stack = ["{"];
  for (let i = open + 1; i < c.length; i++) {
    const ch = c[i];
    if (stack[stack.length - 1] === "`") {
      if (ch === "\\") i++;
      else if (ch === "`") stack.pop();
      else if (ch === "$" && c[i + 1] === "{") {
        stack.push("${");
        i++;
      }
      continue;
    }
    if (ch === "/" && c[i + 1] === "/") {
      i = c.indexOf("\n", i);
      if (i < 0) break;
    } else if (ch === "/" && c[i + 1] === "*") {
      i = c.indexOf("*/", i + 2) + 1;
      if (i <= 0) break;
    } else if (ch === '"' || ch === "'") {
      for (i++; i < c.length && c[i] !== ch; i++) if (c[i] === "\\") i++;
    } else if (ch === "`" || ch === "{") stack.push(ch);
    else if (ch === "}") {
      stack.pop();
      if (!stack.length) return c.slice(at[0], i + 1);
    }
  }
  throw new Error("unterminated openFile");
}

// The stand-in vscode: just the API openFile and the helper touch.
class TabInputText {
  constructor(uri) {
    this.uri = uri;
  }
}
class TabInputTextDiff {
  constructor(original, modified) {
    this.original = original;
    this.modified = modified;
  }
}
class TabInputCustom {
  constructor(uri, viewType) {
    this.uri = uri;
    this.viewType = viewType;
  }
}
const fileUri = (p) => ({
  scheme: "file",
  fsPath: p,
  path: p,
  toString: () => `file://${p}`,
});
class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
class Selection extends Range {}

function makeVscode(world) {
  const editor = (uri) => ({
    document: {
      uri,
      getText: () => readFileSync(uri.fsPath, "utf8"),
      positionAt: (o) => new Position(o, 0),
    },
    revealRange() {},
    selection: undefined,
  });
  return {
    Uri: { file: fileUri },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    TabInputText,
    TabInputTextDiff,
    TabInputCustom,
    Position,
    Range,
    Selection,
    TextEditorRevealType: { InCenter: 2 },
    workspace: {
      workspaceFolders: [{ name: "ws", uri: { fsPath: world.cwd } }],
      getConfiguration: (section) => ({
        get: (key) => world.settings[`${section}.${key}`],
      }),
    },
    window: {
      tabGroups: {
        get all() {
          return world.groups;
        },
        get activeTabGroup() {
          return world.groups.find((g) => g.isActive);
        },
      },
      showTextDocument(uri, opts) {
        world.calls.push({ api: "showTextDocument", path: uri.fsPath, opts });
        if (world.binary.has(uri.fsPath))
          return Promise.reject(new Error("binary"));
        world.editor = editor(uri);
        return Promise.resolve(world.editor);
      },
      showWarningMessage() {},
    },
    commands: {
      executeCommand(command, uri, opts) {
        world.calls.push({ api: command, path: uri?.fsPath, opts });
        return Promise.resolve();
      },
    },
  };
}

// openFile rebuilt over the stand-ins: every free name of the method (the
// bundle's minified module bindings) resolves through `scope`, read off how
// the method uses it; anything else reads as a no-op function.
function buildOpenFile(method, vscode, platform) {
  const as = (re) => method.match(re)?.[1];
  const names = {
    [as(/([\w$]+)\.window\.showTextDocument\(/)]: vscode,
    [as(/([\w$]+)\.isAbsolute\(/)]: path,
    [as(/([\w$]+)\.existsSync\(/)]: fs,
    require: (m) => (m === "vscode" ? vscode : require(m)),
    process: { platform },
  };
  const scope = new Proxy(names, {
    has: (t, k) => k in t || (typeof k === "string" && !(k in globalThis)),
    get: (t, k) =>
      k === Symbol.unscopables ? undefined : k in t ? t[k] : () => undefined,
  });
  const make = new Function(
    "scope",
    `with(scope){return ({${method}}).openFile}`,
  );
  return make(scope);
}

const dir = mkdtempSync(path.join(tmpdir(), "ccup-rio-"));
const P = (rel) => path.join(dir, rel);
mkdirSync(P("src"));
mkdirSync(P("folder"));
writeFileSync(
  P("a.md"),
  Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n"),
);
writeFileSync(P("b.md"), "b\n");
writeFileSync(P("src/c.ts"), "c\n");
writeFileSync(P("img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(P("blob.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));

// A layout: groups in view column order, the active one marked `*`, each tab
// [kind, path, active-in-group]; kind "text", "diff" (modified side),
// "untitled", "custom" (an extension's editor), or "unknown", the kind VS
// Code's own image preview reaches the API as (1.144): no input at all.
function layout(spec) {
  const input = (kind, rel) => {
    if (kind === "text") return new TabInputText(fileUri(P(rel)));
    if (kind === "diff")
      return new TabInputTextDiff(fileUri(P(`${rel}.orig`)), fileUri(P(rel)));
    if (kind === "untitled")
      return new TabInputText({
        scheme: "untitled",
        fsPath: P(rel),
        path: P(rel),
      });
    if (kind === "custom")
      return new TabInputCustom(fileUri(P(rel)), "hexEditor.hexedit");
    return undefined;
  };
  return spec.map(({ col, active, tabs }) => ({
    viewColumn: col,
    isActive: !!active,
    tabs: tabs.map(([kind, rel, on]) => ({
      isActive: !!on,
      label: path.basename(rel),
      input: input(kind, rel),
    })),
  }));
}

// Each case: the layout, the click (path as the response wrote it, location,
// options), the options the patched show should get, and whether native
// opens a second tab there (`bug`). `last` names the call to compare when a
// show falls back to vscode.open, and `needs` what the build must have for
// the case to apply: the pinned option (2.1.280 on) or that fallback (2.1.285
// on).
const CASES = [
  {
    name: "not open anywhere: active group, as native",
    groups: [{ col: 1, active: 1, tabs: [["text", "b.md", 1]] }],
    open: ["a.md", { startLine: 256 }],
    want: undefined,
  },
  {
    name: "shown in the active group only: unchanged",
    groups: [
      { col: 1, tabs: [["text", "b.md", 1]] },
      { col: 2, active: 1, tabs: [["text", "a.md", 1]] },
    ],
    open: ["a.md", { startLine: 256 }],
    want: undefined,
  },
  {
    name: "shown in another group: that group",
    groups: [
      { col: 1, tabs: [["text", "a.md", 1]] },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
    ],
    open: ["a.md", { startLine: 256 }],
    want: { viewColumn: 1 },
    bug: true,
  },
  {
    name: "behind another tab in another group: that group",
    groups: [
      {
        col: 1,
        tabs: [
          ["text", "a.md", 0],
          ["text", "src/c.ts", 1],
        ],
      },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
    ],
    open: ["a.md", { startLine: 256 }],
    want: { viewColumn: 1 },
    bug: true,
  },
  {
    name: "behind a tab here, shown there: the group showing it",
    groups: [
      {
        col: 1,
        active: 1,
        tabs: [
          ["text", "a.md", 0],
          ["text", "b.md", 1],
        ],
      },
      { col: 2, tabs: [["text", "src/c.ts", 1]] },
      { col: 3, tabs: [["text", "a.md", 1]] },
    ],
    open: ["a.md", { startLine: 256 }],
    want: { viewColumn: 3 },
    bug: true,
  },
  {
    name: "behind a tab here and there: the active group",
    groups: [
      {
        col: 1,
        tabs: [
          ["text", "a.md", 0],
          ["text", "b.md", 1],
        ],
      },
      {
        col: 2,
        active: 1,
        tabs: [
          ["text", "a.md", 0],
          ["text", "src/c.ts", 1],
        ],
      },
    ],
    open: ["a.md", { startLine: 256 }],
    want: undefined,
  },
  {
    name: "shown in two other groups: the first in column order",
    groups: [
      { col: 1, tabs: [["text", "a.md", 1]] },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
      { col: 3, tabs: [["text", "a.md", 1]] },
    ],
    open: ["a.md", { startLine: 256 }],
    want: { viewColumn: 1 },
    bug: true,
  },
  {
    name: "absolute path with a dot segment: the tab of the same file",
    groups: [
      { col: 1, tabs: [["text", "a.md", 1]] },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
    ],
    open: [`${dir}/src/../a.md`, { startLine: 256 }],
    want: { viewColumn: 1 },
    bug: true,
  },
  {
    name: "only in a diff tab elsewhere: active group, as native",
    groups: [
      { col: 1, tabs: [["diff", "a.md", 1]] },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
    ],
    open: ["a.md", { startLine: 256 }],
    want: undefined,
  },
  {
    name: "only in a custom editor elsewhere: no text show into it",
    groups: [
      { col: 1, tabs: [["custom", "a.md", 1]] },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
    ],
    open: ["a.md", { startLine: 256 }],
    want: undefined,
  },
  {
    name: "an untitled tab of the same path does not count",
    groups: [
      { col: 1, tabs: [["untitled", "a.md", 1]] },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
    ],
    open: ["a.md", { startLine: 256 }],
    want: undefined,
  },
  {
    name: "workbench.editor.revealIfOpen on: left to VS Code",
    settings: { "workbench.editor.revealIfOpen": true },
    groups: [
      { col: 1, tabs: [["text", "a.md", 1]] },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
    ],
    open: ["a.md", { startLine: 256 }],
    want: undefined,
  },
  {
    name: "pinned open (plan or memory file) keeps preview off",
    groups: [
      { col: 1, tabs: [["text", "a.md", 1]] },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
    ],
    open: ["a.md", undefined, { pinned: true }],
    needs: "pinned",
    want: { preview: false, viewColumn: 1 },
    bug: true,
  },
  {
    name: "path case differs: same editor on macOS and Windows",
    groups: [
      { col: 1, tabs: [["text", "a.md", 1]] },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
    ],
    open: ["A.MD", { startLine: 1 }],
    abs: true,
    platform: "darwin",
    want: { viewColumn: 1 },
  },
  {
    name: "path case differs: a different file on Linux",
    groups: [
      { col: 1, tabs: [["text", "a.md", 1]] },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
    ],
    open: ["A.MD", { startLine: 1 }],
    abs: true,
    platform: "linux",
    want: undefined,
  },
  {
    name: "binary file in a custom editor elsewhere: fallback goes there",
    groups: [
      { col: 1, tabs: [["custom", "blob.bin", 1]] },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
    ],
    open: ["blob.bin", undefined],
    last: "vscode.open",
    needs: "fallback",
    want: { viewColumn: 1 },
    bug: true,
  },
  {
    name: "binary file not open: fallback in the active group",
    groups: [{ col: 1, active: 1, tabs: [["text", "b.md", 1]] }],
    open: ["blob.bin", undefined],
    last: "vscode.open",
    needs: "fallback",
    want: undefined,
  },
  {
    name: "image in VS Code's own preview: no uri to find, as native",
    groups: [
      { col: 1, tabs: [["unknown", "img.png", 1]] },
      { col: 2, active: 1, tabs: [["text", "b.md", 1]] },
    ],
    open: ["img.png", undefined],
    last: "vscode.open",
    needs: "fallback",
    want: undefined,
  },
];

const host = readFileSync(
  path.join(path.dirname(liveBundleDir()), "extension.js"),
  "utf8",
);
const patcher = loadPatcher();
const patchedHost = patcher.revealIfOpenHost(host);
const methods = {
  native: cutOpenFile(host.replace(FRAG_RE, "")),
  patched: patchedHost && cutOpenFile(patchedHost),
};
const results = [];
const check = (pass, name, ok, detail) =>
  results.push({ pass, name, ok, detail });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const settle = () => new Promise((r) => setTimeout(r, 0));

try {
  if (!patchedHost) {
    check("patched", "revealIfOpenHost finds its sites", false, "null");
  }
  const has = {
    pinned: /\.pinned\b/.test(methods.native),
    fallback: methods.native.includes('"vscode.open"'),
  };
  const cases = CASES.filter((k) => !k.needs || has[k.needs]);
  for (const pass of ["native", "patched"]) {
    const method = methods[pass];
    if (!method) continue;
    let reproduced = 0;
    for (const k of cases) {
      const world = {
        cwd: dir,
        settings: k.settings ?? {},
        groups: layout(k.groups),
        calls: [],
        binary: new Set([P("img.png"), P("blob.bin")]),
        editor: null,
      };
      const vscode = makeVscode(world);
      const openFile = buildOpenFile(
        method,
        vscode,
        k.platform ?? process.platform,
      );
      const self = { cwd: dir, warnCouldNotOpen() {}, output: { warn() {} } };
      const [rel, location, options] = k.open;
      const target = k.abs ? P(rel) : rel;
      await openFile.call(self, target, location, options);
      await settle();
      await settle();
      const call = world.calls.find(
        (c) => c.api === (k.last ?? "showTextDocument"),
      );
      const got = call?.opts;
      if (pass === "native") {
        // Native passes the options it builds and no view column at all.
        const nativeOpts =
          has.pinned && options?.pinned ? { preview: false } : undefined;
        check(
          pass,
          `own options only: ${k.name}`,
          same(got, nativeOpts),
          JSON.stringify(got),
        );
        if (k.bug && got?.viewColumn === undefined) reproduced++;
      } else {
        check(pass, k.name, same(got, k.want), JSON.stringify(got));
        // The show's own follow-up still runs: the selection lands on the
        // line a location names.
        if (location?.startLine && !k.last) {
          const line = world.editor?.selection?.start?.line;
          check(
            pass,
            `${k.name} (selection)`,
            line === location.startLine - 1,
            `line ${line}`,
          );
        }
      }
    }
    if (pass === "native") {
      const bugs = cases.filter((k) => k.bug).length;
      check(
        pass,
        "native reproduces the duplicate open",
        reproduced === bugs,
        `${reproduced}/${bugs}`,
      );
    }
  }
  // A directory still reveals in the Explorer, with no show at all.
  if (methods.patched) {
    const world = {
      cwd: dir,
      settings: {},
      groups: layout([{ col: 1, active: 1, tabs: [] }]),
      calls: [],
      binary: new Set(),
    };
    const openFile = buildOpenFile(
      methods.patched,
      makeVscode(world),
      process.platform,
    );
    await openFile.call({ cwd: dir, warnCouldNotOpen() {} }, P("folder"));
    check(
      "patched",
      "a folder still reveals in the Explorer",
      same(
        world.calls.map((c) => c.api),
        ["revealInExplorer"],
      ),
      JSON.stringify(world.calls.map((c) => c.api)),
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(
    `${r.ok ? "ok  " : "FAIL"} ${r.pass.padEnd(7)} ${r.name}${r.ok ? "" : `: ${r.detail}`}`,
  );
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
