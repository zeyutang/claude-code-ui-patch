// Scenario for scripts/cdp-driver.mjs: the always-on session open landing, on
// the REAL webview bundle booted as the sidebar against a stub host with two
// long sessions. The chat keeps a spacer under the transcript as tall as the
// input box it overlays, from a height state that restarts at 0 whenever the
// chat remounts (every session switch), so natively the first frame of a
// switch lands at the transcript's end with that end hidden behind the input
// box, and the spacer's later growth scrolls it into view: a jump. Every
// animation frame of a switch is recorded from the click on. The session
// cards (built in here) do the switching, and the first switch after boot is
// skipped, since the first chat a webview shows starts at 0 either way. The
// checks assert:
//   native     the unpatched bundle's first frame hides the transcript's end
//              behind the input box, and a later frame scrolls to it
//   landing    patched, the first frame of a switch already holds the
//              spacer at the input box's height with the transcript's end in
//              view above the box, and nothing scrolls after it
//   undo       stripping the fragments gives back the native bytes, and a
//              second build changes nothing
// The native pass has to reproduce the jump: once it stops, Claude Code itself
// has fixed it, and the point can be retired.
//
//   node scripts/cdp-driver.mjs scripts/repro/session-open.mjs 760 900
//
// The patched bundle served is the compiled patcher's own output for the live
// install (inputSeedWebview, out/, so compile first), so the scenario runs
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
const S = { A: id("a"), B: id("b") };
const TITLES = { A: "A long session", B: "Another long session" };
const TURNS = 30;
const FRAG_RE =
  /\/\*ccup:inputSeed:[-\w]+\*\/[\s\S]*?\/\*ccup:inputSeedEnd\*\//g;

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
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${S.A}"></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
const S = ${JSON.stringify(S)}, TITLES = ${JSON.stringify(TITLES)}, TURNS = ${TURNS}, NOW = Date.now();
const at = (m) => new Date(NOW - m * 60e3).toISOString();
const entry = (k, m) => ({ id: S[k], summary: TITLES[k], customTitle: TITLES[k],
  lastModified: NOW - m * 60e3, lastActivity: NOW - m * 60e3, archived: false,
  fileSize: 4096, gitBranch: "main", isCurrentWorkspace: true });
// TURNS prompts, each answered with a few paragraphs, so the transcript
// scrolls well past one screen.
const msgs = (sid) => {
  const k = sid === S.A ? "A" : sid === S.B ? "B" : null;
  if (!k) return [];
  const out = [];
  for (let i = 0; i < TURNS; i++) {
    out.push({ type: "user", uuid: "u" + i + k, session_id: sid, parent_tool_use_id: null,
      timestamp: at(90 - i * 2), origin: { kind: "human" },
      message: { role: "user", content: [{ type: "text", text: "Prompt " + i + " in " + TITLES[k] }] } });
    const para = "Reply " + i + " in " + TITLES[k] + ", a paragraph long enough to wrap onto more than one line of the chat column at this width.";
    out.push({ type: "assistant", uuid: "a" + i + k, session_id: sid, parent_tool_use_id: null,
      timestamp: at(89 - i * 2),
      message: { id: "msg_" + k + i, type: "message", role: "assistant", model: "claude-fable-5",
        content: [{ type: "text", text: [para, para, para].join("\\n\\n") }], stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 } } });
  }
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
        resp = { type: "list_sessions_response", sessions: [entry("A", 10), entry("B", 20)], folderKey: "k" };
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
// Every animation frame from the next mousedown on, for ms: the spacer (the
// transcript's last child), the scroll position, and how far the last turn
// ends below the input box's top (positive: hidden behind the box).
window.__frames = (ms) => new Promise((resolve) => {
  const out = [];
  let t0 = null;
  addEventListener("mousedown", () => { t0 = performance.now(); }, { capture: true, once: true });
  const tick = () => {
    if (t0 !== null) {
      const sc = document.querySelector('[class*="messagesContainer_"]');
      const box = document.querySelector('[class*="inputContainer_"]');
      const title = (document.querySelector('[class*="titleTextInner_"]') || {}).textContent || "";
      if (sc && box) {
        const turns = sc.querySelectorAll(':scope > [class*="turn_"]');
        const last = turns[turns.length - 1];
        out.push({ t: Math.round(performance.now() - t0), title,
          spacer: Math.round(sc.lastElementChild.getBoundingClientRect().height * 10) / 10,
          box: Math.round(box.getBoundingClientRect().height * 10) / 10,
          top: Math.round(sc.scrollTop), max: Math.round(sc.scrollHeight - sc.clientHeight),
          under: last ? Math.round(last.getBoundingClientRect().bottom - box.getBoundingClientRect().top) : null });
      }
      if (performance.now() - t0 > ms) return resolve(out);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
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
  const seeded = P.inputSeedWebview(native);
  const serve = {
    stock: P.sessionCardsWebview(native, "line"),
    seeded: seeded && P.sessionCardsWebview(seeded, "line"),
  };
  let variant = "stock";
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
      "build: the patcher writes both fragments into this bundle, with the cards to switch by",
      !!seeded &&
        (seeded.match(FRAG_RE) || []).length === 2 &&
        !!serve.stock &&
        !!serve.seeded,
    )
  )
    return false;
  check(
    "undo: stripping the fragments gives back the native bytes, and a second build changes nothing",
    seeded.replace(FRAG_RE, "") === native &&
      P.inputSeedWebview(seeded) === seeded,
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
    `(document.querySelector('[class*="titleTextInner_"]')||{}).textContent===${JSON.stringify(TITLES[k])}`;
  // A card click, recorded frame by frame: the frames from the first one
  // showing session k on.
  const switchTo = async (k) => {
    const c = await ctx.evaluate(
      `(function(){var b=document.querySelector('.ccup-card[data-id="${S[k]}"]');if(!b)return null;var r=b.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`,
    );
    if (!c) return null;
    await ctx.evaluate("window.__framesP = __frames(1500), 1");
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
    const fr = (
      await ctx.cdp("Runtime.evaluate", {
        expression: "__framesP",
        awaitPromise: true,
        returnByValue: true,
      })
    ).result.value;
    await until(shows(k));
    return fr.filter((f) => f.title === TITLES[k]);
  };
  // The frames' story: the first frame, whether any frame hid the end, and
  // whether the scroll position moved after the first frame.
  const story = (fr) => {
    const first = fr[0];
    return {
      n: fr.length,
      first,
      hid: fr.some((f) => f.under > 0),
      moved: fr.some((f) => f.top !== first.top),
      final: fr[fr.length - 1],
    };
  };

  try {
    const runs = {};
    for (const v of ["stock", "seeded"]) {
      variant = v;
      await ctx.navigate(base);
      if (
        !(await until(
          `!!document.querySelector('.ccup-card[data-id="${S.B}"]')`,
        ))
      ) {
        check(`boot (${v}): the strip shows both sessions`, false);
        return false;
      }
      await until(shows("A"));
      await ctx.sleep(1200);
      const toB = await switchTo("B");
      await ctx.sleep(800);
      const toA = await switchTo("A");
      if (!toB?.length || !toA?.length) {
        check(`switch (${v}): the cards switch between the sessions`, false);
        return false;
      }
      runs[v] = { toB: story(toB), toA: story(toA) };
    }
    const st = runs.stock.toA,
      sd = runs.seeded.toA;
    check(
      "native: the first frame of a switch hides the transcript's end behind the input box, and a later frame scrolls to it",
      st.first.spacer === 0 && st.first.under > 0 && st.moved,
      JSON.stringify({ first: st.first, final: st.final }),
    );
    check(
      "landing: patched, the first frame of a switch holds the spacer at the input box's height",
      sd.first.spacer > 0 && sd.first.spacer === sd.final.spacer,
      JSON.stringify({ first: sd.first, final: sd.final }),
    );
    check(
      "landing: patched, no frame hides the transcript's end and nothing scrolls after the first frame",
      !sd.hid &&
        !sd.moved &&
        !runs.seeded.toB.hid &&
        !runs.seeded.toB.moved &&
        sd.first.top === sd.first.max,
      JSON.stringify({
        toA: [sd.hid, sd.moved],
        toB: [runs.seeded.toB.hid, runs.seeded.toB.moved],
      }),
    );
  } finally {
    server.close();
  }
  return ok;
}
