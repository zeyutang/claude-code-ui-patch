// Scenario for scripts/cdp-driver.mjs: chatDiffCardLineNumbers, on the REAL
// webview bundle booted against a stub host into a session holding two Edit
// cards. The first card's result carries the file as it was before the edit
// (tool_use_result.originalFile), whose edited text starts at line 42; the
// second card's result carries none. The checks assert:
//   card      the first card numbers its lines from the file (42 up), and the
//             second from 1, as a card without a known offset falls back to
//   modal     the expand modal numbers the first card from 42 too, and,
//             reused for the second card, goes back to 1
//   build     the line numbers point builds its whole absolute numbering block
//             for this bundle, which otherwise skips as a unit with no status
//             to show for it
//
//   node scripts/cdp-driver.mjs scripts/repro/diff-line-numbers.mjs 940 900
//
// The bundle served is the compiled patcher's own output for the live install
// (diffLinesWebview, out/, so compile first), so the scenario runs exactly
// what an apply writes and doubles as the drift canary. The live bundle is
// found under ~/.vscode/extensions (newest Claude Code install) or via
// $CCUP_BUNDLE (the webview directory). A card's tool body only shows from a
// 500px wide viewport, hence the width above.
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

const R = "44444444-4444-4444-8444-444444444444";
// The file before the edit: 60 numbered lines, the edit replacing 42 to 44.
const FILE = Array.from(
  { length: 60 },
  (_, i) => `const line${i + 1} = ${i + 1};`,
);
const OLD = FILE.slice(41, 44).join("\n");
const NEW = OLD.replace(/= 4(\d);/g, "= 4$1 * 2;");
const ORIGINAL = FILE.join("\n") + "\n";
const SHORT_OLD = "const a = 1;\nconst b = 2;";
const SHORT_NEW = "const a = 1;\nconst b = 3;";

const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:"SF Mono",monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-chat-font-family:system-ui;
--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#cccccc;
--vscode-sideBar-background:#181818;--vscode-editor-background:#1f1f1f;
--vscode-input-background:#262626;--vscode-input-border:#3c3c3c;
--vscode-menu-background:#1f1f1f;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${R}"></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
const R = "${R}", NOW = Date.now();
const at = (i) => new Date(NOW - (10 - i) * 60e3).toISOString();
const say = (k, content, stop) => ({ type: "assistant", uuid: "a" + k + "000000-0000-4000-8000-000000000000",
  session_id: R, parent_tool_use_id: null, timestamp: at(k),
  message: { id: "msg_" + k, type: "message", role: "assistant", model: "claude-fable-5",
    content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } } });
const user = (k, content, more) => ({ type: "user", uuid: "u" + k + "000000-0000-4000-8000-000000000000",
  session_id: R, parent_tool_use_id: null, timestamp: at(k), ...more,
  message: { role: "user", content } });
const edit = (k, id, file, a, b) => say(k, [{ type: "tool_use", id, name: "Edit",
  input: { file_path: file, old_string: a, new_string: b } }], "tool_use");
const done = (k, id, file, result) => user(k, [{ type: "tool_result", tool_use_id: id,
  content: "The file " + file + " has been updated." }], result ? { tool_use_result: result } : {});
const MESSAGES = [
  user(1, [{ type: "text", text: "Double the three constants, then fix b." }]),
  edit(2, "toolu_e1", "/tmp/ccup-demo/long.ts", ${JSON.stringify(OLD)}, ${JSON.stringify(NEW)}),
  done(3, "toolu_e1", "/tmp/ccup-demo/long.ts", { filePath: "/tmp/ccup-demo/long.ts",
    oldString: ${JSON.stringify(OLD)}, newString: ${JSON.stringify(NEW)},
    originalFile: ${JSON.stringify(ORIGINAL)}, replaceAll: false, userModified: false }),
  edit(4, "toolu_e2", "/tmp/ccup-demo/short.ts", ${JSON.stringify(SHORT_OLD)}, ${JSON.stringify(SHORT_NEW)}),
  done(5, "toolu_e2", "/tmp/ccup-demo/short.ts", null),
  say(6, [{ type: "text", text: "Both edits are in." }], "end_turn"),
];
const SESSION = { id: R, summary: "Line numbers", customTitle: "Line numbers",
  lastModified: NOW, lastActivity: NOW, archived: false, fileSize: 4096,
  gitBranch: "main", isCurrentWorkspace: true };
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
        resp = { type: "list_sessions_response", sessions: [{ ...SESSION }], folderKey: "k" };
        break;
      case "get_session_groups":
        resp = { type: "get_session_groups_response", groups: [] };
        break;
      case "engine_ui_state":
        resp = { available: false };
        setTimeout(() => deliver({ type: "request", channelId: msg.channelId,
          requestId: "s" + msg.requestId,
          request: { type: "engine_surface_state", available: false } }));
        break;
      case "get_session_request":
        resp = { type: "get_session_response",
          messages: r.sessionId === R ? MESSAGES : [], sessionDiffs: [] };
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
  const serve = P.diffLinesWebview(readFileSync(join(dir, "index.js"), "utf8"));
  console.log(`live bundle: ${dir}`);

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };
  if (!check("build: the whole absolute numbering block lands", !!serve))
    return false;

  const server = createServer((req, res) => {
    const rel = req.url.split("?")[0];
    if (rel === "/wv/index.js") {
      res.writeHead(200, { "content-type": TYPES[".js"] }).end(serve);
    } else if (rel.startsWith("/wv/")) {
      try {
        const file = join(dir, rel.slice(4));
        res
          .writeHead(200, {
            "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          })
          .end(readFileSync(file));
      } catch {
        res.writeHead(404).end();
      }
    } else res.writeHead(200, { "content-type": "text/html" }).end(page);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const until = async (expr, ms = 10000) => {
    for (let t = 0; t < ms; t += 100) {
      const v = await ctx.evaluate(expr);
      if (v) return v;
      await ctx.sleep(100);
    }
    return null;
  };
  const json = async (expr) =>
    JSON.parse(await ctx.evaluate(`JSON.stringify(${expr})`));
  // The numbers a diff editor's gutters show, in order, deduplicated (the
  // original and modified editors both number their lines).
  const numbers = (scope) =>
    json(
      `(function(){var s=${scope};if(!s)return null;` +
        `var a=[].map.call(s.querySelectorAll(".line-numbers"),function(e){return e.textContent.trim()}).filter(Boolean);` +
        `return a.filter(function(x,i){return a.indexOf(x)===i}).sort(function(x,y){return x-y})})()`,
    );
  const cards = `[...document.querySelectorAll('[class*="diffEditorContainer_"]')].filter(function(e){return !e.closest('[role="dialog"]')})`;

  try {
    await ctx.navigate(base);
    const two = await until(
      `${cards}.length===2&&${cards}.every(function(e){return e.querySelector(".line-numbers")})`,
    );
    check("card: both Edit cards render with gutters", !!two);
    const first = await numbers(`${cards}[0]`);
    const second = await numbers(`${cards}[1]`);
    check(
      "card: the card whose result knows the file numbers from line 42",
      !!first && first[0] === "42" && first[first.length - 1] === "44",
      JSON.stringify(first),
    );
    check(
      "card: the card whose result does not numbers from 1",
      !!second && second[0] === "1" && second.length <= 3,
      JSON.stringify(second),
    );
    // The expand modal, opened from each card in turn.
    const openModal = async (k) => {
      await ctx.evaluate(
        `(function(){var c=${cards}[${k}],o=c&&c.parentElement&&c.parentElement.querySelector('[class*="clickOverlay_"]');` +
          `(o||c).click()})()`,
      );
      return until(
        `(function(){var d=document.querySelector('[role="dialog"] [class*="diffEditorContainer_"]');return !!(d&&d.querySelector(".line-numbers"))})()`,
      );
    };
    const closeModal = async () => {
      await ctx.cdp("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await ctx.cdp("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await until(
        `!document.querySelector('[role="dialog"] [class*="diffEditorContainer_"]')`,
        3000,
      );
    };
    const modal = `document.querySelector('[role="dialog"] [class*="diffEditorContainer_"]')`;
    check("modal: the first card's expand opens", !!(await openModal(0)));
    await ctx.sleep(300);
    const m1 = await numbers(modal);
    check(
      "modal: it numbers the first card from line 42 too",
      !!m1 && m1[0] === "42" && m1[m1.length - 1] === "44",
      JSON.stringify(m1),
    );
    await ctx.shot("modal-first");
    await closeModal();
    check("modal: the second card's expand opens", !!(await openModal(1)));
    await ctx.sleep(300);
    const m2 = await numbers(modal);
    check(
      "modal: reused for the second card, it numbers from 1 again",
      !!m2 && m2[0] === "1" && m2.length <= 3,
      JSON.stringify(m2),
    );
    await closeModal();
    const err = await ctx.evaluate(
      `document.getElementById("claude-error").textContent`,
    );
    check("the app reported no error", !err, err.slice(0, 200));
  } finally {
    server.close();
  }
  return ok;
}
