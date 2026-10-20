// Scenario for scripts/cdp-driver.mjs: the always-on input box redraw fix, on
// the REAL webview bundle booted against a stub host into a short transcript.
// React commits are counted through a stand-in DevTools hook, so every
// re-render of the input area shows up as one. Natively the mention and
// slash-command detector re-renders the input area on every selection change
// in the document; patched, only the ones that touch the input box do. The
// checks assert, on both bundles unless marked:
//   drag       a mouse drag across the transcript commits once per selection
//              change natively, and next to never patched
//   caret      arrow-key caret moves inside the input box re-render the same
//              in both
//   leave      patched, the selection change that leaves the box re-renders
//              once and the next one outside does not
//   slash      typing "/" still opens the command menu
//   undo       stripping the fragment gives back the native bytes, and a
//              second build changes nothing
// The native pass has to reproduce the per-move commits: once it stops,
// Claude Code itself has fixed it, and the point can be retired.
//
//   node scripts/cdp-driver.mjs scripts/repro/mention-redraw.mjs 460 900
//
// The patched bundle served is the compiled patcher's own output for the live
// install (mentionRedrawWebview, out/, so compile first), so the scenario
// runs exactly what an apply writes and doubles as the drift canary. The live
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

const FRAG_RE =
  /\/\*ccup:mentionRedraw\*\/[\s\S]*?\/\*ccup:mentionRedrawEnd\*\//g;
const R = "66666666-6666-4666-8666-666666666666";
const PARA =
  "The patch reads the bundle and writes each marked line where its anchor " +
  "sits, so a restore can strip it again without touching the native bytes, " +
  "and this paragraph runs long enough to wrap over several lines.";
const MESSAGES = (now) =>
  Array.from({ length: 4 }, (_, i) => [
    {
      type: "user",
      uuid: `u${i}-0000-4000-8000-000000000000`,
      session_id: R,
      parent_tool_use_id: null,
      timestamp: new Date(now - (8 - 2 * i) * 60e3).toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: `Prompt ${i + 1}.` }],
      },
    },
    {
      type: "assistant",
      uuid: `a${i}-0000-4000-8000-000000000000`,
      session_id: R,
      parent_tool_use_id: null,
      timestamp: new Date(now - (7 - 2 * i) * 60e3).toISOString(),
      message: {
        id: `msg_${i}`,
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: [PARA, PARA, PARA].join("\n\n") }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ]).flat();

// The stub host: just enough of the init state for the chat to mount (see the
// real-webview-mock notes), one session on disk and its transcript in SDK
// message form. The root names the session, so the view opens it at boot, and
// the host reports no plugins, without which every row stays hidden as
// "Waiting for your plugins". Responses go out synchronously, or the first
// render races ahead of get_claude_state. The DevTools stand-in is installed
// ahead of the bundle, where React looks for it once.
const page = (mode) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:"SF Mono",monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-chat-font-family:system-ui;
--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#cccccc;
--vscode-descriptionForeground:#9d9d9d;--vscode-sideBar-background:#181818;
--vscode-editor-background:#1f1f1f;--vscode-input-background:#262626;--vscode-input-border:#3c3c3c;
--vscode-input-foreground:#cccccc;--vscode-focusBorder:#0078d4;
--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;
--vscode-list-hoverBackground:#2a2d2e;--vscode-widget-border:#313131;--vscode-menu-background:#1f1f1f;
--vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-icon-foreground:#cccccc;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${R}"></div>
<script>
window.__commits = 0;
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  isDisabled: false, supportsFiber: true, renderers: new Map(),
  inject() { return 1; }, checkDCE() {},
  onCommitFiberRoot() { window.__commits++; }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
};
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
const R = "${R}", NOW = Date.now();
const MESSAGES = ${JSON.stringify(MESSAGES(Date.now()))};
const SESSION = { id: R, summary: "Redraw", customTitle: "Redraw", lastModified: NOW,
  lastActivity: NOW, archived: false, fileSize: 4096, gitBranch: "develop", isCurrentWorkspace: true };
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
<script type="module" src="/wv/index.js?mode=${mode}"></script>
</body></html>`;

const TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};
const INPUT = '[aria-label="Message input"]';
const MOVES = 40;

export async function run(ctx) {
  const dir = liveBundleDir();
  const P = loadPatcher();
  const native = readFileSync(join(dir, "index.js"), "utf8").replace(
    FRAG_RE,
    "",
  );
  const patched = P.mentionRedrawWebview(native);
  console.log(`live bundle: ${dir}`);

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };
  if (!check("the patcher locates the site", patched !== null)) return false;
  check(
    "undo: stripping the fragment gives back the native bytes",
    patched.replace(FRAG_RE, "") === native,
  );
  check(
    "undo: a second build changes nothing",
    P.mentionRedrawWebview(patched) === patched,
  );

  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/wv/index.js") {
      const body = u.searchParams.get("mode") === "native" ? native : patched;
      res
        .writeHead(200, {
          "content-type": TYPES[".js"],
          "cache-control": "no-store",
        })
        .end(body);
    } else if (u.pathname.startsWith("/wv/")) {
      let body;
      try {
        body = readFileSync(join(dir, u.pathname.slice(4)));
      } catch {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, {
          "content-type":
            TYPES[extname(u.pathname)] ?? "application/octet-stream",
        })
        .end(body);
    } else {
      res
        .writeHead(200, {
          "content-type": "text/html",
          "cache-control": "no-store",
        })
        .end(
          page(u.searchParams.get("mode") === "native" ? "native" : "patched"),
        );
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const until = async (expr, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      const v = await ctx.evaluate(expr);
      if (v) return v;
      await ctx.sleep(100);
    }
    return null;
  };
  const commits = () => ctx.evaluate("window.__commits");
  // Commits that land within a span, after the app has gone quiet.
  const settle = async () => {
    let last = await commits();
    for (let i = 0; i < 20; i++) {
      await ctx.sleep(150);
      const now = await commits();
      if (now === last) return now;
      last = now;
    }
    return last;
  };
  const mouse = (type, x, y, buttons) =>
    ctx.cdp("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: buttons || type !== "mouseMoved" ? "left" : "none",
      buttons,
      clickCount: 1,
    });
  const key = async (k, code, vk) => {
    for (const type of ["keyDown", "keyUp"]) {
      await ctx.cdp("Input.dispatchKeyEvent", {
        type,
        key: k,
        code,
        windowsVirtualKeyCode: vk,
      });
    }
  };
  const rect = (sel) =>
    ctx.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;const b=e.getBoundingClientRect();return{x:b.x,y:b.y,w:b.width,h:b.height}})()`,
    );

  const results = {};
  for (const mode of ["native", "patched"]) {
    await ctx.navigate(`${base}/?mode=${mode}`);
    const up = await until(
      `(()=>{const ps=[...document.querySelectorAll("p")].filter(p=>p.textContent.includes("marked line"));return ps.length>=8&&!!document.querySelector(${JSON.stringify(INPUT)})})()`,
    );
    if (!check(`${mode}: the transcript and the input box are up`, !!up)) break;
    await ctx.sleep(800);
    const out = (results[mode] = {});

    // drag: across two paragraphs of the transcript, one selection change a move
    const start =
      await ctx.evaluate(`(()=>{const p=[...document.querySelectorAll("p")].filter(p=>p.textContent.includes("marked line"))[5];
      p.scrollIntoView({block:"center"});const r=document.createRange();r.setStart(p.firstChild,0);r.setEnd(p.firstChild,1);
      const b=r.getBoundingClientRect();return{x:b.left+1,y:b.top+b.height/2}})()`);
    await ctx.sleep(300);
    // A click alone (press and release, no move) first: what the press, the
    // release and the focus change commit on their own, in either bundle.
    let c0 = await settle();
    await mouse("mousePressed", start.x, start.y, 1);
    await mouse("mouseReleased", start.x, start.y, 0);
    out.click = (await settle()) - c0;
    // The drag's path, walked with no button down and back to the start: what
    // the hover changes along it commit on their own.
    const path = async (buttons) => {
      let y = start.y;
      for (let k = 0; k < MOVES; k++) {
        y += 5;
        await mouse("mouseMoved", start.x + 30 + ((k * 23) % 200), y, buttons);
        await ctx.sleep(16);
      }
      return y;
    };
    c0 = await settle();
    await path(0);
    await mouse("mouseMoved", start.x, start.y, 0);
    out.hover = (await settle()) - c0;
    c0 = await settle();
    await mouse("mousePressed", start.x, start.y, 1);
    const y = await path(1);
    await mouse("mouseReleased", start.x + 30, y, 0);
    out.drag = (await settle()) - c0;
    out.dragSel = await ctx.evaluate("getSelection().toString().length");

    // caret: type into the input box, then walk the caret back with arrow keys
    const box = await rect(INPUT);
    await mouse("mousePressed", box.x + box.w / 2, box.y + box.h / 2, 1);
    await mouse("mouseReleased", box.x + box.w / 2, box.y + box.h / 2, 0);
    await ctx.cdp("Input.insertText", { text: "hello redraw world" });
    c0 = await settle();
    for (let k = 0; k < 10; k++) {
      await key("ArrowLeft", "ArrowLeft", 37);
      await ctx.sleep(40);
    }
    out.caret = (await settle()) - c0;

    // leave: move the selection out of the box, then three times more outside
    // it, each change settled on its own
    const para = `[...document.querySelectorAll("p")].filter(p=>p.textContent.includes("marked line"))`;
    c0 = await settle();
    await ctx.evaluate(`getSelection().selectAllChildren(${para}[2])`);
    out.leave = (await settle()) - c0;
    c0 = await settle();
    for (const i of [3, 4, 5]) {
      await ctx.evaluate(`getSelection().selectAllChildren(${para}[${i}])`);
      await settle();
    }
    out.outside = (await settle()) - c0;

    // slash: an empty box with "/" typed opens the command menu
    await mouse("mousePressed", box.x + box.w / 2, box.y + box.h / 2, 1);
    await mouse("mouseReleased", box.x + box.w / 2, box.y + box.h / 2, 0);
    await ctx.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(INPUT)});const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand("delete");return e.textContent})()`,
    );
    await ctx.cdp("Input.insertText", { text: "/" });
    out.slash = !!(await until(
      `document.body.innerText.includes("Switch model")`,
      3000,
    ));
    console.log(`  ${mode}: ${JSON.stringify(out)}`);
  }

  const n = results.native;
  const p = results.patched;
  if (n && p) {
    // The hook is the one difference between the bundles, so what it costs
    // reads as the native count less the patched one, and what the rest of
    // the app commits as the click and the hover pass alone.
    const own = (m) => m.drag - m.click - m.hover;
    check(
      "native: a transcript drag commits once a selection change",
      own(n) >= MOVES / 2,
      `${n.drag} commits over ${MOVES} moves: click ${n.click} + hover ${n.hover} + ${own(n)}, ${n.dragSel} chars selected`,
    );
    check(
      "patched: the same drag commits no more than its click and hover",
      own(p) <= 1 && p.dragSel === n.dragSel,
      `${p.drag} commits: click ${p.click} + hover ${p.hover} + ${own(p)}, ${p.dragSel} chars selected (native ${n.dragSel})`,
    );
    check(
      "caret moves in the input box re-render as natively",
      p.caret >= 5 && Math.abs(p.caret - n.caret) <= 2,
      `native=${n.caret} patched=${p.caret}`,
    );
    check(
      "leaving the box re-renders as natively",
      p.leave >= 1 && p.leave === n.leave,
      `native=${n.leave} patched=${p.leave}`,
    );
    // Natively React sometimes folds one of the three bumps into a neighbor's
    // commit, so the margin is two.
    check(
      "patched: changes that stay outside the box skip the re-render",
      n.outside - p.outside >= 2 && p.outside <= 1,
      `native=${n.outside} patched=${p.outside} over three changes`,
    );
    check(
      "typing / still opens the command menu",
      n.slash && p.slash,
      `native=${n.slash} patched=${p.slash}`,
    );
  }
  server.close();
  console.log(ok ? "\nall green" : "\nFAILURES above");
  return ok;
}
