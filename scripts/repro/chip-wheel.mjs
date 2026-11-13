// Scenario for scripts/cdp-driver.mjs: the always-on attachment chip wheel, on
// the REAL webview bundle booted as the sidebar against a stub host, with a
// transcript scrolled up from its end and image files pasted into the input
// box until the attachment chips overflow their row. The checks assert:
//   native   a wheel turned up or down over the row moves neither the row
//            nor the transcript, and a sideways wheel scrolls the row (the
//            report reproduced: only Shift with the wheel moves it)
//   turn     patched, a turn down moves the row right by the wheel's delta,
//            as far as the same turn sideways scrolls it natively, and a turn
//            up moves it back, with each event canceled and the transcript
//            still
//   ends     at either end a turn on is canceled and moves nothing, and a turn
//            back moves the row at once
//   native   a sideways wheel still scrolls the row natively, uncanceled,
//            while Ctrl with the wheel (a pinch), an uncancelable event, and
//            an event more sideways than up or down are left alone
//   fits     with too few chips to overflow, a turn passes uncanceled
//   carry    small or fractional steps add up as their sum, where the row's
//            whole-pixel offset would drop each step's fraction
//   rows     a row that remounts (the chips removed, then added) takes the
//            wheel again, and re-renders leave one listener on it
//   undo     stripping the fragments gives back the native bytes, and a
//            second build changes nothing
// The native pass has to reproduce the dead wheel: once a plain turn moves the
// row natively, Claude Code does this itself and the point can be retired.
//
//   node scripts/cdp-driver.mjs scripts/repro/chip-wheel.mjs 420 700
//
// It runs at a device scale factor of 1, not the driver's 2: an emulated scale
// factor divides a wheel event's DOM delta by it but not the native scroll the
// event makes (at 2, a 40px wheel reads deltaX 20 and scrolls 40), while a real
// one (--force-device-scale-factor=2) reads 40 and scrolls 40, as at 1. At 1 a
// turn's travel is comparable with a native sideways scroll's.
//
// The patched bundle served is the compiled patcher's own output for the live
// install (chipWheelWebview, out/, so compile first), so the scenario runs
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

const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FRAG_RE = /\/\*ccup:chipWheel\*\/[\s\S]*?\/\*ccup:chipWheelEnd\*\//g;
const ROW = '[class*="attachedFilesContainer_"]';
const CHAT = '[class*="messagesContainer_"]';

const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:"SF Mono",monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-chat-font-family:system-ui;
--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#cccccc;
--vscode-sideBar-background:#181818;--vscode-editor-background:#1f1f1f;
--vscode-input-background:#313131;--vscode-input-border:#3c3c3c;
--vscode-focusBorder:#0078d4;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${SID}"></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
const SID = ${JSON.stringify(SID)}, NOW = Date.now();
const at = (m) => new Date(NOW - m * 60e3).toISOString();
const USAGE = { input_tokens: 1, output_tokens: 1 };
// Twelve turns, each a prompt and a reply of three paragraphs, so the
// transcript scrolls well past a screen.
const msgs = () => {
  const out = [];
  for (let i = 0; i < 12; i++) {
    out.push({ type: "user", uuid: "u" + i, session_id: SID, parent_tool_use_id: null,
      timestamp: at(90 - i * 2), origin: { kind: "human" },
      message: { role: "user", content: [{ type: "text", text: "Prompt " + i }] } });
    const para = "Reply " + i + ", a paragraph long enough to wrap onto more than one line of the chat column at this width.";
    out.push({ type: "assistant", uuid: "a" + i, session_id: SID, parent_tool_use_id: null,
      timestamp: at(89 - i * 2),
      message: { id: "msg_" + i, type: "message", role: "assistant", model: "claude-fable-5",
        content: [{ type: "text", text: [para, para, para].join("\\n\\n") }], stop_reason: "end_turn",
        usage: USAGE } });
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
        resp = { type: "list_sessions_response", folderKey: "k", sessions: [{ id: SID,
          summary: "Chips", customTitle: "Chips", lastModified: NOW, lastActivity: NOW,
          archived: false, fileSize: 4096, gitBranch: "main", isCurrentWorkspace: true }] };
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
        resp = { type: "get_session_response", messages: msgs(), sessionDiffs: [] };
        break;
    }
    deliver({ type: "response", requestId: msg.requestId, response: resp });
  },
});
// n PNG files pasted into the input box, as a paste of copied images.
window.__paste = async (n) => {
  const box = document.querySelector('[aria-label="Message input"]');
  const dt = new DataTransfer();
  for (let i = 0; i < n; i++) {
    const c = document.createElement("canvas");
    c.width = 40 + i;
    c.height = 30;
    const g = c.getContext("2d");
    g.fillStyle = "#4a6" + (i % 10);
    g.fillRect(0, 0, c.width, c.height);
    const b = await new Promise((r) => c.toBlob(r, "image/png"));
    dt.items.add(new File([b], "Screenshot_2026Nov13_" + String(i).padStart(2, "0") + ".png", { type: "image/png" }));
  }
  box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  return n;
};
// Every chip removed, one remove button at a time.
window.__clear = async () => {
  for (let i = 0; i < 60; i++) {
    const b = document.querySelector('[class*="removeButton_"]');
    if (!b) return true;
    b.click();
    await new Promise((r) => setTimeout(r, 40));
  }
  return false;
};
// What each wheel event came to, read after every listener of the row ran.
window.__wheels = [];
addEventListener("wheel", (e) => window.__wheels.push({ dx: e.deltaX, dy: e.deltaY,
  cancelable: e.cancelable, prevented: e.defaultPrevented }), { passive: true });
// A synthetic wheel event on the row, and whether it was canceled.
window.__synth = (init) => {
  const e = new WheelEvent("wheel", Object.assign({ bubbles: true, cancelable: true }, init));
  document.querySelector(${JSON.stringify(ROW)}).dispatchEvent(e);
  return e.defaultPrevented;
};
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
  const patched = P.chipWheelWebview(native);
  const serve = { native, patched };
  let variant = "native";
  console.log(`live bundle: ${dir}`);

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };
  const frags = patched?.match(FRAG_RE) ?? [];
  if (
    !check(
      "build: the patcher gives this bundle's attachment row its ref",
      frags.length >= 1,
      frags.length,
    )
  )
    return false;
  check(
    "undo: stripping the fragments gives back the native bytes, and a second build changes nothing",
    patched.replace(FRAG_RE, "") === native &&
      P.chipWheelWebview(patched) === patched,
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
  const url = `http://127.0.0.1:${server.address().port}/`;

  const until = async (expr, ms = 10000) => {
    for (let t = 0; t < ms; t += 100) {
      const v = await ctx.evaluate(expr);
      if (v) return v;
      await ctx.sleep(100);
    }
    return null;
  };
  const awaitIn = async (expression) =>
    (
      await ctx.cdp("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
    ).result.value;
  // The row's offset and range, and the transcript's offset.
  const state = async () =>
    JSON.parse(
      await ctx.evaluate(
        `JSON.stringify((function(){var r=document.querySelector('${ROW}'),s=document.querySelector('${CHAT}');` +
          `return r?{x:r.scrollLeft,max:r.scrollWidth-r.clientWidth,chat:s.scrollTop,ox:getComputedStyle(r).overflowX}:null})())`,
      ),
    );
  // A point in the middle of the row, where the wheel turns.
  const rowAt = async () =>
    JSON.parse(
      await ctx.evaluate(
        `JSON.stringify((function(){var b=document.querySelector('${ROW}').getBoundingClientRect();` +
          `return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})())`,
      ),
    );
  // Wheel events of the input pipeline at p, each its own sequence, and what
  // the page made of them.
  const wheel = async (p, n, dx, dy) => {
    await ctx.evaluate("window.__wheels=[],1");
    await ctx.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: p.x,
      y: p.y,
    });
    for (let i = 0; i < n; i++) {
      await ctx.cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: p.x,
        y: p.y,
        deltaX: dx,
        deltaY: dy,
      });
      await ctx.sleep(60);
    }
    await ctx.sleep(300);
    return JSON.parse(await ctx.evaluate("JSON.stringify(window.__wheels)"));
  };
  const sum = (ws, k) => ws.reduce((a, w) => a + w[k], 0);
  const all = (ws, f) => ws.length > 0 && ws.every(f);
  const boot = async (v) => {
    variant = v;
    await ctx.navigate(url);
    if (
      !(await until(
        `!!document.querySelector('[aria-label="Message input"]')&&document.querySelectorAll("[data-bookmark-uuid]").length>=12`,
      ))
    )
      return false;
    await ctx.sleep(500);
    return true;
  };
  // n images pasted, and whether the row then holds total chips.
  const chips = async (n, total = n) => {
    await awaitIn(`__paste(${n})`);
    const ok = await until(
      `document.querySelectorAll('${ROW} [class*="pill_"]').length===${total}`,
      5000,
    );
    await ctx.sleep(200);
    return !!ok;
  };
  // The transcript scrolled 300px up from its end, so a wheel that reached it
  // would move it.
  const chatUp = () =>
    ctx.evaluate(
      `(function(){var s=document.querySelector('${CHAT}');s.scrollTop=s.scrollHeight-s.clientHeight-300;return 1})()`,
    );

  try {
    await ctx.cdp("Emulation.setDeviceMetricsOverride", {
      ...ctx.viewport,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Native: the dead wheel the point exists for.
    check("native: the chat and the input box mount", await boot("native"));
    let n = await chips(10);
    let s = await state();
    check(
      "native: ten pasted images overflow the chip row, a sideways scroller",
      n && s?.max > 200 && s.ox === "auto",
      s && `range ${s.max}, overflow-x ${s.ox}`,
    );
    await chatUp();
    await ctx.sleep(200);
    let p = await rowAt();
    let s0 = await state();
    let ws = await wheel(p, 5, 0, 40);
    s = await state();
    check(
      "native: a turn down over the row moves neither the row nor the transcript",
      ws.length === 5 && s.x === s0.x && s.chat === s0.chat,
      `row ${s0.x} -> ${s.x}, transcript ${s0.chat} -> ${s.chat}`,
    );
    ws = await wheel(p, 5, 40, 0);
    s = await state();
    check(
      "native: a sideways wheel scrolls the row",
      s.x - s0.x === sum(ws, "dx") && s.x > s0.x,
      `row ${s0.x} -> ${s.x}, deltas ${sum(ws, "dx")}`,
    );

    // Patched: a turn up or down moves the row sideways.
    check("patched: the chat and the input box mount", await boot("patched"));
    n = await chips(10);
    s = await state();
    check("patched: the chip row overflows", n && s?.max > 200, s && s.max);
    check(
      "patched: the row's first render put the ref on the window",
      await ctx.evaluate(`typeof globalThis.__ccupChipWheel==="function"`),
    );
    await chatUp();
    await ctx.sleep(200);
    p = await rowAt();
    s0 = await state();
    ws = await wheel(p, 5, 0, 40);
    s = await state();
    const down = s.x - s0.x;
    check(
      "turn: down moves the row right by the wheel's delta",
      down === sum(ws, "dy") && down > 0,
      `row ${s0.x} -> ${s.x}, deltas ${sum(ws, "dy")}`,
    );
    check(
      "turn: each event canceled, and the transcript still",
      all(ws, (w) => w.cancelable && w.prevented) && s.chat === s0.chat,
      `${ws.filter((w) => w.prevented).length}/${ws.length} canceled, transcript ${s0.chat} -> ${s.chat}`,
    );
    s0 = s;
    ws = await wheel(p, 5, 40, 0);
    s = await state();
    check(
      "turn: as far as the same turn sideways scrolls it natively",
      s.x - s0.x === down,
      `sideways ${s.x - s0.x}, down ${down}`,
    );
    s0 = s;
    ws = await wheel(p, 2, 0, -40);
    s = await state();
    check(
      "turn: up moves it back left",
      s.x - s0.x === sum(ws, "dy") && s.x < s0.x,
      `row ${s0.x} -> ${s.x}, deltas ${sum(ws, "dy")}`,
    );

    // The ends.
    ws = await wheel(p, 12, 0, -40);
    s = await state();
    check(
      "ends: up past the start leaves the row at 0, canceled",
      s.x === 0 && all(ws, (w) => w.prevented) && s.chat === s0.chat,
      `row ${s.x}, ${ws.filter((w) => w.prevented).length}/${ws.length} canceled`,
    );
    for (let i = 0; i < 6 && s.x < s.max; i++) {
      await wheel(p, 20, 0, 40);
      s = await state();
    }
    check(
      "ends: turning down reaches the end",
      s.x === s.max,
      `${s.x}/${s.max}`,
    );
    s0 = s;
    ws = await wheel(p, 3, 0, 40);
    s = await state();
    check(
      "ends: down at the end is canceled and moves nothing",
      s.x === s0.x && all(ws, (w) => w.prevented) && s.chat === s0.chat,
      `row ${s0.x} -> ${s.x}, transcript ${s0.chat} -> ${s.chat}`,
    );
    ws = await wheel(p, 1, 0, -40);
    s = await state();
    check(
      "ends: a turn back moves the row at once",
      s0.x - s.x === -sum(ws, "dy") && s.x < s0.x,
      `row ${s0.x} -> ${s.x}`,
    );

    // Left native.
    s0 = s;
    ws = await wheel(p, 2, -40, 0);
    s = await state();
    check(
      "native: a sideways wheel still scrolls the row natively, uncanceled",
      s.x - s0.x === sum(ws, "dx") && all(ws, (w) => !w.prevented),
      `row ${s0.x} -> ${s.x}, ${ws.filter((w) => w.prevented).length} canceled`,
    );
    s0 = s;
    let prevented = await ctx.evaluate(`__synth({deltaY:40,ctrlKey:true})`);
    s = await state();
    check(
      "native: Ctrl with the wheel (a pinch) is left alone",
      !prevented && s.x === s0.x,
      `canceled ${prevented}, row ${s0.x} -> ${s.x}`,
    );
    prevented = await ctx.evaluate(`__synth({deltaY:40,cancelable:false})`);
    s = await state();
    check(
      "native: an uncancelable event (a sequence that began native) is left alone",
      s.x === s0.x,
      `row ${s0.x} -> ${s.x}`,
    );
    prevented = await ctx.evaluate(`__synth({deltaX:30,deltaY:20})`);
    s = await state();
    check(
      "native: an event more sideways than up or down is left alone",
      !prevented && s.x === s0.x,
      `canceled ${prevented}, row ${s0.x} -> ${s.x}`,
    );

    // Fractions add up.
    await ctx.evaluate(
      `(function(){document.querySelector('${ROW}').scrollLeft=100;return 1})()`,
    );
    s0 = await state();
    await ctx.evaluate(
      `(function(){for(var i=0;i<10;i++)__synth({deltaY:0.3});return 1})()`,
    );
    s = await state();
    check(
      "carry: ten steps of 0.3px move the row 3px",
      Math.abs(s.x - s0.x - 3) <= 0.5,
      `row ${s0.x} -> ${s.x}`,
    );
    s0 = s;
    await ctx.evaluate(
      `(function(){for(var i=0;i<8;i++)__synth({deltaY:1.25});return 1})()`,
    );
    s = await state();
    check(
      "carry: eight steps of 1.25px move it 10px",
      Math.abs(s.x - s0.x - 10) <= 0.5,
      `row ${s0.x} -> ${s.x}`,
    );
    s0 = s;
    await ctx.evaluate(
      `(function(){for(var i=0;i<4;i++)__synth({deltaY:-0.6});return 1})()`,
    );
    s = await state();
    check(
      "carry: a turn back starts afresh, four steps of -0.6px moving it 2.4px",
      Math.abs(s.x - s0.x + 2.4) <= 0.5,
      `row ${s0.x} -> ${s.x}`,
    );

    // A row that fits passes the wheel.
    check(
      "fits: removing the chips drops the row",
      !!(await awaitIn("__clear()")),
    );
    check(
      "fits: the row is gone",
      !(await ctx.evaluate(`!!document.querySelector('${ROW}')`)),
    );
    n = await chips(1);
    s = await state();
    check("fits: one chip fits its row", n && s?.max < 1, s && s.max);
    p = await rowAt();
    s0 = s;
    ws = await wheel(p, 2, 0, 40);
    s = await state();
    check(
      "fits: a turn over it passes uncanceled",
      all(ws, (w) => !w.prevented) && s.x === 0 && s.chat === s0.chat,
      `${ws.filter((w) => w.prevented).length}/${ws.length} canceled`,
    );

    // The remounted row takes the wheel, with one listener after re-renders.
    n = await chips(9, 10);
    s = await state();
    check(
      "rows: more chips overflow the remounted row",
      n && s?.max > 200,
      s && s.max,
    );
    p = await rowAt();
    s0 = s;
    ws = await wheel(p, 3, 0, 40);
    s = await state();
    check(
      "rows: the remounted row takes the wheel",
      s.x - s0.x === sum(ws, "dy") && s.x > 0 && all(ws, (w) => w.prevented),
      `row ${s0.x} -> ${s.x}, deltas ${sum(ws, "dy")}`,
    );
    check("rows: two more chips render", await chips(2, 12));
    s0 = await state();
    await ctx.evaluate(`__synth({deltaY:40})`);
    s = await state();
    check(
      "rows: after re-renders one event moves the row once",
      s.x - s0.x === 40,
      `row ${s0.x} -> ${s.x}`,
    );
    await ctx.shot("chip-wheel");
  } finally {
    server.close();
  }
  return ok;
}
