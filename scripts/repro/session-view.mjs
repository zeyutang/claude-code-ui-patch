// Scenario for scripts/cdp-driver.mjs: the always-on session view on return,
// on the REAL webview bundle booted as the sidebar against a stub host with
// two long sessions in Focus view, each turn a prompt, a fold holding one tool
// call, and a reply. The chat remounts for every session it shows, and its
// scroll effect lands each mount at the transcript's end, so natively a
// session you had scrolled up in comes back at its end, its folds closed. The
// session cards (built in here) and the Session history dialog do the
// switching. The checks assert:
//   native   the unpatched bundle brings a session left scrolled up back at
//            its end, and an opened fold back closed (the report reproduced)
//   back     patched, a session left scrolled up comes back with the same
//            reply at the same offset from the first frame on, and stays
//   end      a session left at its end comes back at its end
//   dialog   the same holds for a switch through the Session history dialog
//   folds    a fold left open comes back open, with the view inside it where
//            it was, and one open at the end comes back open at the end
//   stick    a view left within the chat's stick zone of the end (scrolled up
//            by less than 50px) comes back at the end
//   prompt   a session left scrolled up that asks for a permission while away
//            comes back where it was (the scroll-to-bottom button's guard on
//            the permission glide holds it there after; without the guard,
//            Claude Code's own glide to the prompt takes it to the end)
//   undo     stripping the fragments gives back the native bytes, and a
//            second build changes nothing
// The native pass has to reproduce the landing: once it stops, Claude Code
// itself keeps the view, and the point can be retired.
//
//   node scripts/cdp-driver.mjs scripts/repro/session-view.mjs 760 900
//
// The patched bundle served is the compiled patcher's own output for the live
// install (viewKeepWebview, out/, so compile first), so the scenario runs
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
const FRAG_RE = /\/\*ccup:viewKeep:[-\w]+\*\/[\s\S]*?\/\*ccup:viewKeepEnd\*\//g;
const GUARD = "/*ccup:permYankGuard*/";

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
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${S.A}"></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
const S = ${JSON.stringify(S)}, TITLES = ${JSON.stringify(TITLES)}, TURNS = ${TURNS}, NOW = Date.now();
const at = (m) => new Date(NOW - m * 60e3).toISOString();
const entry = (k, m) => ({ id: S[k], summary: TITLES[k], customTitle: TITLES[k],
  lastModified: NOW - m * 60e3, lastActivity: NOW - m * 60e3, archived: false,
  fileSize: 4096, gitBranch: "main", isCurrentWorkspace: true });
// TURNS prompts, each answered by one tool call (which Focus view folds) and
// a reply of a few paragraphs, so the transcript scrolls well past a screen.
const USAGE = { input_tokens: 1, output_tokens: 1 };
const msgs = (sid) => {
  const k = sid === S.A ? "A" : sid === S.B ? "B" : null;
  if (!k) return [];
  const out = [];
  for (let i = 0; i < TURNS; i++) {
    out.push({ type: "user", uuid: "u" + i + k, session_id: sid, parent_tool_use_id: null,
      timestamp: at(90 - i * 2), origin: { kind: "human" },
      message: { role: "user", content: [{ type: "text", text: "Prompt " + i + " in " + TITLES[k] }] } });
    out.push({ type: "assistant", uuid: "t" + i + k, session_id: sid, parent_tool_use_id: null,
      timestamp: at(89.6 - i * 2),
      message: { id: "msg_t" + k + i, type: "message", role: "assistant", model: "claude-fable-5",
        content: [{ type: "tool_use", id: "toolu_" + k + i, name: "Bash",
          input: { command: "ls -la /tmp/" + i, description: "List files " + i } }],
        stop_reason: "tool_use", usage: USAGE } });
    out.push({ type: "user", uuid: "r" + i + k, session_id: sid, parent_tool_use_id: null,
      timestamp: at(89.4 - i * 2),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_" + k + i,
        content: Array.from({ length: 12 }, (_, j) => "file" + j + ".txt").join("\\n") }] } });
    const para = "Reply " + i + " in " + TITLES[k] + ", a paragraph long enough to wrap onto more than one line of the chat column at this width.";
    out.push({ type: "assistant", uuid: "a" + i + k, session_id: sid, parent_tool_use_id: null,
      timestamp: at(89 - i * 2),
      message: { id: "msg_" + k + i, type: "message", role: "assistant", model: "claude-fable-5",
        content: [{ type: "text", text: [para, para, para].join("\\n\\n") }], stop_reason: "end_turn",
        usage: USAGE } });
  }
  return out;
};
const deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
// Each session's channel, as its launch names it, and a permission prompt on
// one, and its withdrawal as the host cancels one.
window.__chan = {};
window.__permit = (sid) => { const requestId = "q" + Math.random();
  deliver({ type: "request", channelId: window.__chan[sid], requestId,
    request: { type: "tool_permission_request", toolName: "Bash", inputs: { command: "ls", description: "List" },
      suggestions: [], toolUseId: "toolu_p" + Math.random().toString(36).slice(2) } });
  return requestId; };
window.__unpermit = (requestId) => deliver({ type: "cancel_request", targetRequestId: requestId });
const MODEL = { value: "default", label: "Default", resolvedModel: "claude-fable-5",
  supportsAutoMode: true, supportsFastMode: false, supportedEffortLevels: [] };
window.acquireVsCodeApi = () => ({
  getState() { return undefined; },
  setState() {},
  postMessage(msg) {
    if (msg && msg.type === "launch_claude" && msg.resume) window.__chan[msg.resume] = msg.channelId;
    if (!msg || msg.type !== "request") return;
    const r = msg.request;
    let resp = {};
    switch (r.type) {
      case "init":
        resp = { type: "init_response", state: { sweptStaleChannels: false,
          authStatus: { authMethod: "claude_ai" }, claudeSettings: { effective: {}, errors: [] },
          experimentGates: {}, useCtrlEnterToSend: false, speechToTextEnabled: false,
          focusViewEnabled: true } };
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
const sc = () => document.querySelector('[class*="messagesContainer_"]');
// The view: the session on screen, the scroll position and its range, and
// the first message row (a reply, or a tool call inside an open fold) whose
// bottom is below the scroller's top, with its offset there.
window.__view = () => {
  const s = sc();
  const title = (document.querySelector('[class*="titleTextInner_"]') || {}).textContent || "";
  if (!s) return { title };
  const top = s.getBoundingClientRect().top;
  let first = null;
  for (const r of s.querySelectorAll("[data-bookmark-uuid]")) {
    const b = r.getBoundingClientRect();
    if (b.height && b.bottom > top) { first = { id: r.getAttribute("data-bookmark-uuid"), off: Math.round(b.top - top) }; break; }
  }
  return { title, top: Math.round(s.scrollTop), max: Math.round(s.scrollHeight - s.clientHeight), first,
    open: [...s.querySelectorAll('[data-testid="focus-fold-row"][aria-expanded="true"]')].length };
};
// Every animation frame's view from the next mousedown on, for ms.
window.__frames = (ms) => new Promise((resolve) => {
  const out = [];
  let t0 = null;
  addEventListener("mousedown", () => { t0 = performance.now(); }, { capture: true, once: true });
  const tick = () => {
    if (t0 !== null) {
      out.push({ t: Math.round(performance.now() - t0), ...__view() });
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
  const kept = P.viewKeepWebview(native);
  const serve = {
    stock: P.sessionCardsWebview(native, "line"),
    kept: kept && P.sessionCardsWebview(kept, "line"),
  };
  const guard = native.includes(GUARD);
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
  const tags = (kept?.match(FRAG_RE) || []).map(
    (f) => f.match(/viewKeep:([-\w]+)/)[1],
  );
  if (
    !check(
      "build: the patcher writes the save, folds and back fragments into this bundle, with the cards to switch by",
      ["save", "folds", "back"].every((t) => tags.includes(t)) &&
        tags.length === 3 &&
        !!serve.stock &&
        !!serve.kept,
      tags.join(","),
    )
  )
    return false;
  check(
    "undo: stripping the fragments gives back the native bytes, and a second build changes nothing",
    kept.replace(FRAG_RE, "") === native && P.viewKeepWebview(kept) === kept,
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
  const J = JSON.stringify;
  const shows = (k) =>
    `(document.querySelector('[class*="titleTextInner_"]')||{}).textContent===${J(TITLES[k])}`;
  const view = () => ctx.evaluate("__view()");
  const click = async (x, y) => {
    await ctx.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    for (const type of ["mousePressed", "mouseReleased"])
      await ctx.cdp("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        clickCount: 1,
      });
  };
  // A card click, recorded frame by frame: the frames from the first one
  // showing session k on, once the view has been still for a while.
  const switchTo = async (k) => {
    const c = await ctx.evaluate(
      `(function(){var b=document.querySelector('.ccup-card[data-id="${S[k]}"]');if(!b)return null;var r=b.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`,
    );
    if (!c) return null;
    await ctx.evaluate("window.__framesP = __frames(1200), 1");
    await click(c[0], c[1]);
    const fr = (
      await ctx.cdp("Runtime.evaluate", {
        expression: "__framesP",
        awaitPromise: true,
        returnByValue: true,
      })
    ).result.value;
    await until(shows(k));
    await ctx.sleep(300);
    return fr.filter((f) => f.title === TITLES[k]);
  };
  // A pick in the Session history dialog.
  const pick = async (k) => {
    await ctx.evaluate(
      `document.querySelector('[aria-label="Session history"]').click()`,
    );
    const DLG = `[role=dialog][aria-label="Past conversations"]`;
    if (!(await until(`!!document.querySelector('${DLG}')`))) return false;
    const hit = await ctx.evaluate(`(() => {
      const row = [...document.querySelectorAll('${DLG} button[id]')]
        .find((b) => b.textContent.includes(${J(TITLES[k])}));
      if (row) row.click();
      return !!row;
    })()`);
    await until(shows(k));
    await ctx.sleep(600);
    return hit;
  };
  // One notch of the wheel up over the transcript (20px at this scale), as
  // the user scrolls away from the end.
  const notchUp = async () => {
    const c = await ctx.evaluate(
      `(function(){var r=document.querySelector('[class*="messagesContainer_"]').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/3]})()`,
    );
    await ctx.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: c[0],
      y: c[1],
      deltaX: 0,
      deltaY: -40,
    });
    await ctx.sleep(400);
  };
  // The transcript scrolled to a share of its range, then a notch up.
  const park = async (frac) => {
    await ctx.evaluate(
      `(function(){var s=document.querySelector('[class*="messagesContainer_"]');s.scrollTop=Math.round((s.scrollHeight-s.clientHeight)*${frac});return 1})()`,
    );
    await ctx.sleep(150);
    await notchUp();
    return view();
  };
  // The transcript at its end, as the user scrolls down to it.
  const toEnd = async () => {
    await ctx.evaluate(
      `(function(){var s=document.querySelector('[class*="messagesContainer_"]');s.scrollTop=s.scrollHeight;return 1})()`,
    );
    await ctx.sleep(400);
    return view();
  };
  // The i-th fold row: opened by a click on it, with the tool call's row
  // inside it then put at `off` from the scroller's top.
  const openFold = async (i, off) => {
    const c = await ctx.evaluate(`(function(){
      var s=document.querySelector('[class*="messagesContainer_"]');
      var f=s.querySelectorAll('[data-testid="focus-fold-row"]')[${i}];
      if(!f)return null;
      s.scrollTop+=f.getBoundingClientRect().top-s.getBoundingClientRect().top-200;
      var r=f.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
    if (!c) return null;
    await ctx.sleep(200);
    await click(c[0], c[1]);
    await ctx.sleep(400);
    if (off === null) return view();
    await ctx.evaluate(`(function(){
      var s=document.querySelector('[class*="messagesContainer_"]');
      var t=s.querySelector('[data-bookmark-uuid="t${i}A"]');
      if(t)s.scrollTop+=t.getBoundingClientRect().top-s.getBoundingClientRect().top-(${off});
      return 1})()`);
    await ctx.sleep(200);
    await notchUp();
    return view();
  };
  const same = (a, b) =>
    !!a?.first &&
    !!b?.first &&
    a.first.id === b.first.id &&
    Math.abs(a.first.off - b.first.off) <= 1;
  const atEnd = (v) => !!v && v.max > 0 && v.max - v.top <= 1;
  const brief = (v) =>
    v
      ? `${v.first?.id ?? "-"}@${v.first?.off ?? "-"} top ${v.top}/${v.max}${v.open ? ` open ${v.open}` : ""}`
      : "none";

  try {
    const runs = {};
    for (const v of ["stock", "kept"]) {
      variant = v;
      const R = (runs[v] = {});
      await ctx.navigate(base);
      if (
        !(await until(
          `!!document.querySelector('.ccup-card[data-id="${S.B}"]')`,
        )) ||
        !(await until(shows("A")))
      ) {
        check(
          `boot (${v}): the strip shows both sessions`,
          false,
          await ctx.evaluate(
            `document.getElementById("claude-error").textContent`,
          ),
        );
        return false;
      }
      await ctx.sleep(1200);
      // Both chats shown once, each left at its end.
      await switchTo("B");
      await switchTo("A");

      // A left scrolled up, B at its end.
      R.parked = await park(0.4);
      await switchTo("B");
      R.b = await view();
      R.backFrames = await switchTo("A");
      await ctx.sleep(600);
      R.back = await view();
      await switchTo("B");
      R.bAgain = await view();

      // Through the dialog: A moved on, B and back.
      await switchTo("A");
      R.parked2 = await park(0.2);
      R.picked = (await pick("B")) && (await pick("A"));
      R.dialog = await view();

      // A fold opened, the view inside it: its tool call's row first in view,
      // a few pixels below the scroller's top once the notch is in.
      R.inFold = await openFold(12, -16);
      await switchTo("B");
      await switchTo("A");
      R.foldBack = await view();

      // The last fold opened, the view at the end.
      await toEnd();
      await openFold(TURNS - 1, null);
      R.endFold = await toEnd();
      await switchTo("B");
      await switchTo("A");
      R.endFoldBack = await view();

      // Left within the stick zone.
      await toEnd();
      await notchUp();
      R.stick = await view();
      await switchTo("B");
      await switchTo("A");
      R.stickBack = await view();

      // A permission prompt raised while away from a session left scrolled up.
      R.parked3 = await park(0.5);
      await switchTo("B");
      R.rid = await ctx.evaluate(`window.__permit(${J(S.A)})`);
      R.promptFrames = await switchTo("A");
      await ctx.sleep(1500);
      R.prompt = await view();
      await ctx.evaluate(`window.__unpermit(${J(R.rid)})`);
    }

    const st = runs.stock,
      kp = runs.kept;
    check(
      "native: a session left scrolled up comes back at its end",
      st.parked.first && !atEnd(st.parked) && atEnd(st.back),
      `left ${brief(st.parked)}, back ${brief(st.back)}`,
    );
    check(
      "native: an opened fold comes back closed",
      st.inFold?.open > 0 && st.foldBack?.open === 0,
      `left ${brief(st.inFold)}, back ${brief(st.foldBack)}`,
    );
    const moved = kp.backFrames.filter((f) => !same(f, kp.parked));
    check(
      "back: a session left scrolled up comes back with the same reply at the same offset, from the first frame on",
      kp.backFrames.length > 0 && moved.length === 0,
      `left ${brief(kp.parked)}, first frame ${brief(kp.backFrames[0])}, frames elsewhere ${moved.length}/${kp.backFrames.length}`,
    );
    check(
      "back: it stays there",
      same(kp.back, kp.parked) && kp.back.top === kp.parked.top,
      `left ${brief(kp.parked)}, after 600ms ${brief(kp.back)}`,
    );
    check(
      "end: a session left at its end comes back at its end",
      atEnd(st.b) && atEnd(kp.b) && atEnd(st.bAgain) && atEnd(kp.bAgain),
      `stock ${brief(st.bAgain)}, kept ${brief(kp.bAgain)}`,
    );
    check(
      "dialog: a switch through the Session history dialog brings the view back too",
      kp.picked &&
        !atEnd(kp.parked2) &&
        same(kp.dialog, kp.parked2) &&
        st.picked &&
        atEnd(st.dialog),
      `left ${brief(kp.parked2)}, back ${brief(kp.dialog)}; stock ${brief(st.dialog)}`,
    );
    check(
      "folds: a fold left open comes back open, with the view inside it where it was",
      kp.inFold?.first?.id === "t12A" &&
        kp.foldBack?.open === kp.inFold.open &&
        same(kp.foldBack, kp.inFold),
      `left ${brief(kp.inFold)}, back ${brief(kp.foldBack)}`,
    );
    check(
      "folds: a fold open at the end comes back open at the end",
      atEnd(kp.endFold) &&
        kp.endFold.open > 0 &&
        atEnd(kp.endFoldBack) &&
        kp.endFoldBack.open === kp.endFold.open &&
        st.endFoldBack?.open === 0,
      `left ${brief(kp.endFold)}, back ${brief(kp.endFoldBack)}; stock ${brief(st.endFoldBack)}`,
    );
    check(
      "stick: a view left less than 50px from the end comes back at the end",
      !atEnd(kp.stick) &&
        kp.stick.max - kp.stick.top < 50 &&
        atEnd(kp.stickBack),
      `left ${brief(kp.stick)}, back ${brief(kp.stickBack)}`,
    );
    const pmoved = kp.promptFrames.filter((f) => !same(f, kp.parked3));
    check(
      guard
        ? "prompt: a session that asked for a permission while away comes back where it was, and the guard keeps it there"
        : "prompt: a session that asked for a permission while away comes back where it was, then Claude Code's glide takes it to the prompt (no guard in this bundle)",
      kp.promptFrames.length > 0 &&
        same(kp.promptFrames[0], kp.parked3) &&
        (guard
          ? pmoved.length === 0 && same(kp.prompt, kp.parked3)
          : atEnd(kp.prompt)),
      `left ${brief(kp.parked3)}, first frame ${brief(kp.promptFrames[0])}, frames elsewhere ${pmoved.length}/${kp.promptFrames.length}, after 1.5s ${brief(kp.prompt)}; stock ${brief(st.prompt)}`,
    );
  } finally {
    server.close();
  }
  return ok;
}
