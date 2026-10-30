// Scenario for scripts/cdp-driver.mjs: the always-on diff editor release, on
// the REAL webview bundle booted as the sidebar against a stub host with two
// sessions, one whose transcript is a run of Edit calls (a diff card each, so
// a Monaco diff editor each) and one plain. Natively Monaco's editor service
// keeps every diff editor it registered, so a switch away from the diff
// session leaves that whole transcript's DOM alive; patched, the cards' own
// disposal frees it. The session cards (built in here) do the switching. The
// checks assert, on both bundles unless marked:
//   render     the diff session mounts one diff editor per card
//   native     natively, a round trip between the two sessions keeps the
//              transcript it left: hundreds of nodes and their listeners
//              more after a GC, round after round
//   released   patched, a round trip keeps nothing: the node and listener
//              counts after a GC stay put
//   undo       stripping the fragment gives back the native bytes, and a
//              second build changes nothing
// The native pass has to reproduce the growth: once it stops, Claude Code
// itself has fixed it, and the point can be retired.
//
//   node scripts/cdp-driver.mjs scripts/repro/diff-editor-free.mjs 940 900
//
// The patched bundle served is the compiled patcher's own output for the live
// install (diffEdFreeWebview, out/, so compile first), so the scenario runs
// exactly what an apply writes and doubles as the drift canary. The live
// bundle is found under ~/.vscode/extensions (newest Claude Code install) or
// via $CCUP_BUNDLE (the webview directory).
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The compiled patcher. It reads vscode only inside functions, so an empty
// stand-in is enough to load the module.
function loadPatcher() {
  const require = createRequire(import.meta.url);
  const Module = require("node:module");
  const load = Module._load;
  Module._load = (request, ...rest) =>
    request === "vscode" ? {} : load(request, ...rest);
  try {
    const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
    return require(join(root, "out", "patcher.js"));
  } finally {
    Module._load = load;
  }
}

function liveBundleDir() {
  if (process.env.CCUP_BUNDLE) return process.env.CCUP_BUNDLE;
  const root = join(homedir(), ".vscode", "extensions");
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("anthropic.claude-code-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!dirs.length) throw new Error(`no Claude Code install under ${root}`);
  return join(root, dirs[dirs.length - 1], "webview");
}

const id = (d) =>
  `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
const S = { D: id("d"), P: id("e") };
const TITLES = { D: "Edits with diff cards", P: "A plain session" };
const EDITS = 8;
const ROUNDS = 3;
const FRAG_RE = /\/\*ccup:diffEdFree\*\/[\s\S]*?\/\*ccup:diffEdFreeEnd\*\//g;

const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:"SF Mono",monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-chat-font-family:system-ui;
--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#cccccc;
--vscode-sideBar-background:#181818;--vscode-editor-background:#1f1f1f;
--vscode-input-background:#313131;--vscode-focusBorder:#0078d4;
--vscode-editorGroupHeader-connectedTabsBackground:#2b2b2b;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${S.D}"></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
const S = ${JSON.stringify(S)}, TITLES = ${JSON.stringify(TITLES)}, EDITS = ${EDITS}, NOW = Date.now();
const at = (m) => new Date(NOW - m * 60e3).toISOString();
const entry = (k, m) => ({ id: S[k], summary: TITLES[k], customTitle: TITLES[k],
  lastModified: NOW - m * 60e3, lastActivity: NOW - m * 60e3, archived: false,
  fileSize: 4096, gitBranch: "main", isCurrentWorkspace: true });
// D: a prompt, then EDITS Edit calls with their results, then a reply. P: a
// prompt and a reply.
const msgs = (sid) => {
  const k = sid === S.D ? "D" : sid === S.P ? "P" : null;
  if (!k) return [];
  const out = [{ type: "user", uuid: "u0" + k, session_id: sid, parent_tool_use_id: null,
    timestamp: at(40), origin: { kind: "human" },
    message: { role: "user", content: [{ type: "text", text: "A prompt in " + TITLES[k] }] } }];
  for (let i = 0; k === "D" && i < EDITS; i++) {
    const file = "/tmp/ccup-demo/file" + i + ".ts";
    const a = "export const value" + i + " = " + i + ";\\n", b = "export const value" + i + " = " + (i + 1) + ";\\n";
    out.push({ type: "assistant", uuid: "a" + i + k, session_id: sid, parent_tool_use_id: null, timestamp: at(39 - i),
      message: { id: "msg_" + k + i, type: "message", role: "assistant", model: "claude-fable-5",
        content: [{ type: "tool_use", id: "toolu_" + k + i, name: "Edit", input: { file_path: file, old_string: a, new_string: b } }],
        stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } } });
    out.push({ type: "user", uuid: "r" + i + k, session_id: sid, parent_tool_use_id: null, timestamp: at(39 - i),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_" + k + i,
        content: "The file " + file + " has been updated." }] },
      toolUseResult: { filePath: file, oldString: a, newString: b, originalFile: a,
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-" + a.trim(), "+" + b.trim()] }],
        userModified: false, replaceAll: false } });
  }
  out.push({ type: "assistant", uuid: "z" + k, session_id: sid, parent_tool_use_id: null, timestamp: at(20),
    message: { id: "msg_z" + k, type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text: "A reply in " + TITLES[k] + "." }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } } });
  return out;
};
const deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
const MODEL = { value: "default", label: "Default", resolvedModel: "claude-fable-5",
  supportsAutoMode: true, supportsFastMode: false, supportedEffortLevels: [] };
window.acquireVsCodeApi = () => ({
  getState() { return undefined; },
  setState() {},
  postMessage(msg) {
    if (!msg || msg.type !== "request") return;
    const r = msg.request;
    let resp = {};
    switch (r.type) {
      case "init":
        resp = { type: "init_response", state: { sweptStaleChannels: false,
          authStatus: { authMethod: "claude_ai" }, claudeSettings: { effective: {}, errors: [] },
          experimentGates: {}, useCtrlEnterToSend: false, speechToTextEnabled: false } };
        break;
      case "get_claude_state":
        resp = { type: "get_claude_state_response",
          config: { experimentGates: {}, models: [MODEL], unavailable_models: [] } };
        break;
      case "list_sessions_request":
        resp = { type: "list_sessions_response", sessions: [entry("D", 20), entry("P", 30)], folderKey: "k" };
        break;
      case "list_remote_sessions":
        resp = { type: "list_remote_sessions_response", sessions: [] };
        break;
      case "get_session_groups":
        resp = { type: "get_session_groups_response", groups: [] };
        break;
      // Without the surface report every message waits on the plugins.
      case "engine_ui_state":
        resp = { available: false };
        setTimeout(() => deliver({ type: "request", channelId: msg.channelId,
          requestId: "s" + msg.requestId, request: { type: "engine_surface_state", available: false } }));
        break;
      case "get_session_request":
        resp = { type: "get_session_response", messages: msgs(r.sessionId), sessionDiffs: [] };
        break;
    }
    deliver({ type: "response", requestId: msg.requestId, response: resp });
  },
});
</script>
<script type="module" src="/wv/index.js"></script>
</body></html>`;

const TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

export async function run(ctx) {
  const dir = liveBundleDir();
  const P = loadPatcher();
  const native = readFileSync(join(dir, "index.js"), "utf8").replace(
    FRAG_RE,
    "",
  );
  const fixedOnly = P.diffEdFreeWebview(native);
  const serve = {
    stock: P.sessionCardsWebview(native, "line"),
    fixed: fixedOnly && P.sessionCardsWebview(fixedOnly, "line"),
  };
  let variant = "stock";
  const cls = (key) =>
    native.match(new RegExp(`${key}:"(${key}_[-\\w]+)"`))?.[1];
  const TITLE = `.${cls("titleTextInner")}`;
  console.log(`live bundle: ${dir}`);

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };
  if (
    !check(
      "build: the patcher writes the release into this bundle, with the cards to switch by",
      !!fixedOnly && !!serve.stock && !!serve.fixed,
    )
  )
    return false;
  check(
    "undo: stripping the fragment gives back the native bytes, and a second build changes nothing",
    fixedOnly.replace(FRAG_RE, "") === native &&
      P.diffEdFreeWebview(fixedOnly) === fixedOnly,
  );

  const server = createServer((req, res) => {
    const rel = req.url.split("?")[0];
    if (rel === "/wv/index.js") {
      res
        .writeHead(200, {
          "content-type": TYPES[".js"],
          "cache-control": "no-store",
        })
        .end(serve[variant]);
    } else if (rel.startsWith("/wv/")) {
      let data;
      try {
        data = readFileSync(join(dir, rel.slice(4)));
      } catch {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, {
          "content-type": TYPES[extname(rel)] ?? "application/octet-stream",
        })
        .end(data);
    } else res.writeHead(200, { "content-type": "text/html" }).end(page);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const until = async (expr, ms = 15000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await ctx.evaluate(expr)) return true;
      await ctx.sleep(100);
    }
    return false;
  };
  const shows = (k) =>
    `!!document.querySelector(${JSON.stringify(TITLE)})&&document.querySelector(${JSON.stringify(TITLE)}).textContent===${JSON.stringify(TITLES[k])}`;
  const editors = () =>
    ctx.evaluate('document.querySelectorAll(".monaco-diff-editor").length');
  const counts = async () => {
    await ctx.cdp("HeapProfiler.collectGarbage");
    const m = Object.fromEntries(
      (await ctx.cdp("Performance.getMetrics")).metrics.map((x) => [
        x.name,
        x.value,
      ]),
    );
    return { nodes: m.Nodes, listeners: m.JSEventListeners };
  };
  const open = async (k) => {
    const c = await ctx.evaluate(
      `(function(){var b=document.querySelector('.ccup-card[data-id="${S[k]}"]');if(!b)return null;var r=b.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`,
    );
    if (!c) return false;
    const [x, y] = c;
    await ctx.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"])
      await ctx.cdp("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    const done = await until(shows(k));
    await ctx.sleep(900);
    return done;
  };
  // Round trips from D: each ends on P, where nothing of D should be left.
  const trips = async () => {
    const left = [];
    let drawn = 0;
    for (let i = 0; i < ROUNDS; i++) {
      if (!(await open("P"))) return null;
      left.push(await counts());
      if (!(await open("D"))) return null;
      drawn = Math.max(drawn, await editors());
    }
    return { left, drawn };
  };
  const growth = (r, k) =>
    (r.left[ROUNDS - 1][k] - r.left[0][k]) / (ROUNDS - 1);

  try {
    await ctx.cdp("Performance.enable");
    await ctx.cdp("HeapProfiler.enable");
    const runs = {};
    for (const v of ["stock", "fixed"]) {
      variant = v;
      await ctx.navigate(base);
      if (
        !(await until(
          `!!document.querySelector('.ccup-card[data-id="${S.P}"]')`,
        ))
      ) {
        check(`boot (${v}): the strip shows both sessions`, false);
        return false;
      }
      await until(shows("D"));
      await ctx.sleep(1200);
      const first = await editors();
      const r = await trips();
      if (!r) {
        check(`switch (${v}): the cards switch between the sessions`, false);
        return false;
      }
      runs[v] = { ...r, first };
    }
    const st = runs.stock,
      fx = runs.fixed;
    const detail = (r) =>
      JSON.stringify({
        first: r.first,
        drawn: r.drawn,
        nodes: r.left.map((x) => x.nodes),
        listeners: r.left.map((x) => x.listeners),
      });
    check(
      "render: the diff session mounts one diff editor per card, on both bundles",
      st.first === EDITS &&
        fx.first === EDITS &&
        st.drawn === EDITS &&
        fx.drawn === EDITS,
      `${detail(st)} ${detail(fx)}`,
    );
    check(
      "native: a round trip keeps the transcript it left, nodes and listeners, after a GC",
      growth(st, "nodes") > 150 && growth(st, "listeners") > 20,
      detail(st),
    );
    check(
      "released: patched, a round trip keeps nothing after a GC",
      Math.abs(growth(fx, "nodes")) < 40 &&
        Math.abs(growth(fx, "listeners")) < 4,
      detail(fx),
    );
  } finally {
    server.close();
  }
  return ok;
}
