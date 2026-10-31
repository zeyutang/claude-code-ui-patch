// Scenario for scripts/cdp-driver.mjs: the prompt history's last turn delete,
// on the REAL webview bundle booted against a stub host into a session of
// six prompts, the last two sent seconds before the boot, with real mouse
// events and a page clock the scenario sets. The checks assert:
//   uuid      every sticky header carries its message's data-ccup-uuid
//   button    every entry has a delete button, and only the last one works,
//             the others greyed out: hidden until the row is hovered, one line
//             square on the second line's axis with an icon 1.25em of the text
//             (so it follows chat.fontSize), after the text, inside the row,
//             and 20px in from the list's right edge, clear of the overlay
//             scrollbar even hovered
//   tip       hovering a button shows the shared hover tip, what a click does
//             on the working one and why nothing happens on a greyed-out one,
//             and a click on a greyed-out one shows its tip, arming nothing
//   arm       a first click shows "sure?" in bold red over the button,
//             right-aligned to its right edge, the icon hidden, and sends
//             nothing; leaving the button disarms it
//   delete    a second click sends one ccup_rewind_turn naming the session
//             and the last prompt's uuid, the turn leaves the transcript, the
//             list rebuilds one entry shorter with the new last entry's button
//             working, unarmed, and the todo list falls back to the kept
//             turns' last TodoWrite (a tool that leaves the window open)
//   marks     hidden marks from the deleted position on are dropped
//   refuse    a host answer of rewound:false keeps the turn, says why in a
//             notification, and leaves the row usable
//   unpatched a host without the handler ("Unknown request type.") keeps the
//             turn and asks for a reload
//   again     deleting again walks one more turn back, to a turn sent minutes
//             ago, whose button is greyed out for its age
//   live      a prompt sent from the input box, deleted while its reply still
//             streams: the stop goes out before the rewind, which names the
//             prompt's own uuid, and the turn, its partial reply and the
//             interrupt marker the stop brings all leave the view
//   tool      an Edit streaming into a running turn greys its button out,
//             naming the tool
//   timer     with nothing else moving, the button greys out once 30 seconds
//             have passed since its prompt was sent
//   race      a Write the stop comes too late for keeps the turn: no rewind
//             goes out, a notification names the tool, the button greys out
//   queue     a prompt sent while a turn runs stays out of the list until
//             Claude starts on it, and its button then works for a full 30
//             seconds, however long it waited, before greying out
//
//   node scripts/cdp-driver.mjs scripts/repro/turn-delete.mjs 760 620
//
// The bundle served is the compiled patcher's own output for the live install
// (turnRewindWebview, then promptHistWebview, out/, so compile first), so the
// scenario runs exactly what an apply writes and doubles as the drift canary
// for the webview half. The live bundle is found under ~/.vscode/extensions
// (newest Claude Code install) or via $CCUP_BUNDLE (the webview directory,
// with extension.js beside it for the host half's gate).
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const PROMPTS = [
  "Summarize the README in one paragraph.",
  "Add tests for the parser.",
  "Plan the refactor as a todo list.",
  "go on",
  "Rename the helper to fetchAll.\nThen update every call site.",
  "Oops, this prompt was meant for another session.",
];
const uuidOf = (i) =>
  `${String(i).padStart(8, "0")}-0000-4000-8000-00000000000${i % 10}`;
// How long before the boot each prompt was sent: the last two within the
// delete window, so both can go in turn while the page clock is held at the
// boot, the rest minutes before.
const AGO = [360e3, 300e3, 240e3, 180e3, 4e3, 2e3];
// Turn 2 (index 2) writes a todo list and turn 4 (index 4) rewrites it, so
// deleting turn 6 keeps turn 5's list and deleting turn 5 as well falls back
// to turn 3's.
const TODO_AT = {
  2: ["write the plan"],
  4: ["rename fetchAll", "update call sites"],
};

const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:"SF Mono",monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-chat-font-family:system-ui;
--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#cccccc;
--vscode-descriptionForeground:#9d9d9d;--vscode-sideBar-background:#181818;
--vscode-editor-background:#1f1f1f;--vscode-input-background:#262626;--vscode-input-border:#3c3c3c;
--vscode-input-foreground:#cccccc;--vscode-focusBorder:#0078d4;--vscode-errorForeground:#f48771;
--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;
--vscode-list-hoverBackground:#2a2d2e;--vscode-widget-border:#313131;--vscode-menu-background:#1f1f1f;
--vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-icon-foreground:#cccccc;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${R}"></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
const R = "${R}", NOW = Date.now();
// The page clock: __at(ms) makes Date.now read the boot time plus ms from
// then on, and __skew = 0 restores the real one.
const realNow = Date.now.bind(Date);
window.__skew = 0;
Date.now = () => realNow() + window.__skew;
window.__at = (ms) => { window.__skew = NOW + ms - realNow(); };
const PROMPTS = ${JSON.stringify(PROMPTS)};
const UUIDS = ${JSON.stringify(PROMPTS.map((_, i) => uuidOf(i)))};
const TODO_AT = ${JSON.stringify(TODO_AT)};
const AGO = ${JSON.stringify(AGO)};
const at = (i) => new Date(NOW - AGO[i]).toISOString();
const MESSAGES = PROMPTS.flatMap((p, i) => [
  { type: "user", uuid: UUIDS[i], session_id: R, parent_tool_use_id: null, timestamp: at(i),
    message: { role: "user", content: [{ type: "text", text: p }] } },
  { type: "assistant", uuid: "a" + UUIDS[i].slice(1), session_id: R, parent_tool_use_id: null,
    timestamp: at(i),
    message: { id: "msg_" + i, type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text: "Reply " + (i + 1) + ". " + "Long enough to wrap. ".repeat(6) },
        ...(TODO_AT[i] ? [{ type: "tool_use", id: "toolu_" + i, name: "TodoWrite",
          input: { todos: TODO_AT[i].map((c) => ({ content: c, status: "pending", activeForm: c })) } }] : [])],
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } },
]);
const SESSION = { id: R, summary: "Turn delete", customTitle: "Turn delete",
  lastModified: NOW, lastActivity: NOW, archived: false, fileSize: 4096,
  gitBranch: "develop", isCurrentWorkspace: true };
const deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
const MODEL = { value: "default", label: "Default", resolvedModel: "claude-fable-5",
  supportsAutoMode: true, supportsFastMode: false, supportedEffortLevels: [] };
// What the page posted, and how the stub answers a rewind: "ok", "refuse",
// or "unknown" (a host without the handler).
window.__sent = []; window.__notes = []; window.__rewindMode = "ok";
// A prompt sent from the input box starts a turn the stub keeps running, as
// the CLI would: its init, the prompt's echo, and a reply streaming in as
// partial-message events, until an interrupt ends it with the partial reply
// as a message, the CLI's interrupt marker, and an error result.
// __streamTool(name) streams a tool call into the running reply, and a tool
// named in __stopTool streams in as the stop lands, ahead of the turn's end.
// A prompt sent while a turn runs waits in the stub's queue, as in the CLI's,
// until __pickUp() finishes the running turn and starts on it, the CLI's echo
// of it being the pickup.
const io = (channelId, message) =>
  deliver({ type: "io_message", channelId, message, done: false });
const LIVE_TEXT = "Counting " + "one two three ".repeat(3);
window.__stopTool = null;
window.__queued = [];
const toolEvents = (ev, name) => {
  ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use",
    id: "toolu_live", name, input: {} } });
  ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta",
    partial_json: "{}" } });
};
window.__streamTool = (name) => toolEvents(window.__live.ev, name);
const live = (msg) => {
  const ch = msg.channelId, m = msg.message, mid = "msg_" + crypto.randomUUID().slice(0, 8);
  const ev = (event) => io(ch, { type: "stream_event", event, session_id: R,
    parent_tool_use_id: null, uuid: crypto.randomUUID() });
  window.__live = { ch, uuid: m.uuid, ev, mid };
  setTimeout(() => {
    io(ch, { type: "system", subtype: "init", session_id: R, model: "claude-fable-5",
      permissionMode: "default", tools: [], mcp_servers: [], slash_commands: [], uuid: crypto.randomUUID() });
    io(ch, { ...m, session_id: R, isReplay: true });
    ev({ type: "message_start", message: { id: mid, type: "message", role: "assistant",
      model: "claude-fable-5", content: [], stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 } } });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: LIVE_TEXT } });
  }, 50);
};
const stopped = () => {
  const { ch, ev, mid } = window.__live;
  const tool = window.__stopTool;
  window.__live = null;
  window.__stopTool = null;
  if (tool) toolEvents(ev, tool);
  setTimeout(() => {
    io(ch, { type: "assistant", uuid: crypto.randomUUID(), session_id: R, parent_tool_use_id: null,
      message: { id: mid, type: "message", role: "assistant", model: "claude-fable-5",
        content: [{ type: "text", text: LIVE_TEXT },
          ...(tool ? [{ type: "tool_use", id: "toolu_live", name: tool, input: {} }] : [])],
        stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    io(ch, { type: "user", uuid: crypto.randomUUID(), session_id: R, parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    io(ch, { type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 10,
      duration_api_ms: 10, num_turns: 1, session_id: R, total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 }, uuid: crypto.randomUUID() });
  }, 50);
};
window.__pickUp = () => {
  const L = window.__live, next = window.__queued.shift();
  window.__live = null;
  if (L) {
    io(L.ch, { type: "assistant", uuid: crypto.randomUUID(), session_id: R, parent_tool_use_id: null,
      message: { id: L.mid, type: "message", role: "assistant", model: "claude-fable-5",
        content: [{ type: "text", text: LIVE_TEXT }], stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 } } });
    io(L.ch, { type: "result", subtype: "success", is_error: false, duration_ms: 10,
      duration_api_ms: 10, num_turns: 1, result: LIVE_TEXT, session_id: R, total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 }, uuid: crypto.randomUUID() });
  }
  if (next) live(next);
};
window.acquireVsCodeApi = () => ({
  getState() { return undefined; },
  setState() {},
  postMessage(msg) {
    if (msg && msg.type === "launch_claude") window.__chan = msg.channelId;
    if (msg && msg.type !== "request") window.__sent.push({ type: msg.type, channelId: msg.channelId });
    if (msg && msg.type === "io_message" && msg.message && msg.message.type === "user") {
      if (window.__live) window.__queued.push(msg);
      else live(msg);
    }
    if (msg && msg.type === "interrupt_claude" && window.__live) stopped();
    if (!msg || msg.type !== "request") return;
    const r = msg.request;
    window.__sent.push({ type: "request:" + r.type, channelId: msg.channelId, request: r });
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
      case "show_notification":
        window.__notes.push(r.message);
        resp = { type: "show_notification_response" };
        break;
      case "ccup_rewind_turn":
        if (window.__rewindMode === "unknown") resp = { type: "error", error: "Unknown request type." };
        else if (window.__rewindMode === "refuse")
          resp = { type: "ccup_rewind_turn_response", rewound: false, error: "turn running" };
        else resp = { type: "ccup_rewind_turn_response", rewound: true, cleaned: true };
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

const BTN = ".ccup-hist-btn";
const PANE = ".ccup-hist-pane";
const DEL = `${PANE} .ccup-hist-del`;
const delOf = (i) => `${PANE} .ccup-hist-item[data-i="${i}"] .ccup-hist-del`;
const TIP = ".ccup-hover-tip";

export async function run(ctx) {
  const dir = liveBundleDir();
  const P = loadPatcher();
  const native = readFileSync(join(dir, "index.js"), "utf8");
  const host = readFileSync(join(dirname(dir), "extension.js"), "utf8");
  const halved = P.turnRewindWebview(native, host);
  const serve = halved && P.promptHistWebview(halved, true, true);
  const cls = (key) =>
    native.match(new RegExp(`${key}:"(${key}_[-\\w]+)"`))?.[1];
  const HDR = `.${cls("stickyHeader")}`;
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
      "the patcher builds both the webview half and the list on top",
      !!halved && !!serve,
    )
  )
    return false;

  const server = createServer((req, res) => {
    const rel = req.url.split("?")[0];
    if (rel === "/wv/index.js") {
      res.writeHead(200, { "content-type": TYPES[".js"] }).end(serve);
    } else if (rel.startsWith("/wv/")) {
      let body;
      try {
        body = readFileSync(join(dir, rel.slice(4)));
      } catch {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, {
          "content-type": TYPES[extname(rel)] ?? "application/octet-stream",
        })
        .end(body);
    } else res.writeHead(200, { "content-type": "text/html" }).end(page);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const until = async (expr, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      const v = await ctx.evaluate(expr);
      if (v) return v;
      await ctx.sleep(100);
    }
    return null;
  };
  const json = async (expr) =>
    JSON.parse(await ctx.evaluate(`JSON.stringify(${expr})`));
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const rect = (sel) =>
    json(
      `(function(){var e=${q(sel)};if(!e)return null;var r=e.getBoundingClientRect();` +
        `return{x:r.x,y:r.y,w:r.width,h:r.height,r:r.right,b:r.bottom}})()`,
    );
  const mouse = (type, p) =>
    ctx.cdp("Input.dispatchMouseEvent", {
      type,
      x: p.x,
      y: p.y,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  const click = async (p) => {
    await mouse("mouseMoved", p);
    await mouse("mousePressed", p);
    await mouse("mouseReleased", p);
  };
  const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const headers = () =>
    json(
      `[...document.querySelectorAll(${JSON.stringify(HDR)})].map(function(h){return h.getAttribute("data-ccup-uuid")})`,
    );
  const rows = () =>
    ctx.evaluate(`document.querySelectorAll("${PANE} .ccup-hist-row").length`);
  const sent = () =>
    json(
      "window.__sent.filter(function(m){return m.type==='request:ccup_rewind_turn'})",
    );
  const notes = () => json("window.__notes");
  const todos = () =>
    ctx.evaluate(
      `(function(){var t=window.__ccupTodosProbe;return t?t():null})()`,
    );
  const open = async () => {
    if (!(await ctx.evaluate(`!!${q(PANE)}`)))
      await click(center(await rect(BTN)));
    return until(`!!${q(PANE)}`);
  };
  // The last entry's button, hovered, measured against its row and the list.
  const measure = async (i) => {
    const row = `${PANE} .ccup-hist-item[data-i="${i}"]`;
    await ctx.evaluate(
      `(function(){var p=${q(PANE)};p.scrollTop=p.scrollHeight})()`,
    );
    await mouse("mouseMoved", center(await rect(`${row} .ccup-hist-txt`)));
    await ctx.sleep(60);
    return json(
      `(function(){var b=${q(`${row} .ccup-hist-del`)};if(!b)return null;` +
        `var r=b.getBoundingClientRect(),it=b.closest(".ccup-hist-item"),w=it.getBoundingClientRect(),` +
        `t=it.querySelector(".ccup-hist-txt"),tr=t.getBoundingClientRect(),cs=getComputedStyle(it),` +
        `p=${q(PANE)}.getBoundingClientRect(),s=b.querySelector("svg").getBoundingClientRect(),` +
        `fs=parseFloat(getComputedStyle(b).fontSize);` +
        `return{vis:getComputedStyle(b).visibility,w:r.width,h:r.height,lh:parseFloat(getComputedStyle(t).lineHeight),` +
        `top:r.top-tr.top,afterText:r.left>=tr.right-0.5,inRow:r.right<=w.right-parseFloat(cs.paddingRight)+0.5,` +
        `fromRight:p.right-r.right,icon:Math.round(s.width/fs*1e3)/1e3+"x"+Math.round(s.height/fs*1e3)/1e3}})()`,
    );
  };
  // An entry's button: whether it is greyed out, and the tip it carries.
  const stateOf = (i) =>
    json(
      `(function(){var b=${q(delOf(i))};return b?{off:b.hasAttribute("data-off"),` +
        `arm:b.hasAttribute("data-arm"),tip:b.getAttribute("data-tip")}:null})()`,
    );
  // The shared hover tip while it shows, and whether it sits above the button.
  const tipNow = (sel) =>
    json(
      `(function(){var t=${q(TIP)},b=${q(sel)};if(!t||!b||getComputedStyle(t).display==="none")return null;` +
        `return{text:t.textContent,above:t.getBoundingClientRect().bottom<=b.getBoundingClientRect().top+0.5}})()`,
    );
  // Hover a button, its row scrolled into the list's view, for longer than
  // the tip's delay. The pointer crosses the row's text first, as a real one
  // does: until the row is hovered the button is hidden, and hit testing
  // passes a hidden element by.
  const hoverTip = async (sel) => {
    await ctx.evaluate(
      `${q(sel)}.closest(".ccup-hist-item").scrollIntoView({block:"nearest"})`,
    );
    await mouse("mouseMoved", { x: 5, y: 5 });
    await ctx.sleep(60);
    await mouse(
      "mouseMoved",
      center(
        await rect(`${sel.replace(/ \.ccup-hist-del$/, "")} .ccup-hist-txt`),
      ),
    );
    await ctx.sleep(60);
    await mouse("mouseMoved", center(await rect(sel)));
    await ctx.sleep(400);
    return tipNow(sel);
  };
  const count = () =>
    ctx.evaluate(`document.querySelectorAll(${JSON.stringify(HDR)}).length`);

  try {
    await ctx.navigate(base);
    check(
      "boot: the transcript and the button mount",
      !!(await until(
        `document.querySelectorAll(${JSON.stringify(HDR)}).length===${PROMPTS.length}&&` +
          `!!${q(`${BTN}[data-show]`)}&&getComputedStyle(${q(HDR)}).visibility==="visible"`,
      )),
    );
    await ctx.sleep(300);
    // A probe for the active session's todo list, which the view keeps in a
    // signal the panel renders from: read it through React's own props.
    await ctx.evaluate(
      `window.__ccupTodosProbe=function(){var h=document.querySelector(${JSON.stringify(HDR)});` +
        `var k=h&&Object.keys(h).find(function(k){return k.indexOf("__reactFiber$")===0});` +
        `for(var f=k&&h[k];f;f=f.return){var s=f.memoizedProps&&f.memoizedProps.session;` +
        `if(s&&s.todos)return JSON.stringify(s.todos.value.map(function(t){return t.content}))}return null}`,
    );
    const ids = await headers();
    check(
      "uuid: every header carries its message's uuid",
      ids.length === PROMPTS.length && ids.every((u, i) => u === uuidOf(i)),
      ids.join(" "),
    );
    check(
      "boot: the todo list is the last TodoWrite's",
      (await todos()) === JSON.stringify(TODO_AT[4]),
      await todos(),
    );

    // The page clock at the boot, where the last two prompts are seconds old.
    await ctx.evaluate("window.__at(0)");
    await open();
    check(
      "open: the list shows every prompt",
      (await rows()) === PROMPTS.length,
    );
    const dels = await json(
      `[...document.querySelectorAll(${JSON.stringify(DEL)})].map(function(b){return[b.closest(".ccup-hist-item").getAttribute("data-i"),b.hasAttribute("data-off")]})`,
    );
    check(
      "button: every entry has one, and only the last works",
      dels.length === PROMPTS.length &&
        dels.every(([i, off]) => off === (i !== String(PROMPTS.length - 1))),
      JSON.stringify(dels),
    );
    const LAST = delOf(PROMPTS.length - 1);
    const hidden = await ctx.evaluate(
      `getComputedStyle(${q(LAST)}).visibility`,
    );
    await ctx.evaluate(`${q(PANE)}.scrollTop=0`);
    await mouse("mouseMoved", { x: 5, y: 5 });
    await ctx.sleep(60);
    check(
      "button: hidden until its row is hovered",
      (await ctx.evaluate(`getComputedStyle(${q(LAST)}).visibility`)) ===
        "hidden",
      hidden,
    );
    const greyed = await json(
      `(function(){var b=${q(delOf(1))};b.closest(".ccup-hist-item").scrollIntoView({block:"nearest"});` +
        `return{op:getComputedStyle(b).opacity,cur:getComputedStyle(b).cursor}})()`,
    );
    check(
      "button: an earlier entry's is greyed out",
      Math.abs(+greyed.op - 0.35) < 0.01 && greyed.cur === "default",
      JSON.stringify(greyed),
    );

    // Tips: what a click on the working button does, why a greyed-out one
    // does nothing, and a click on that one, which shows its tip at once.
    const tipLast = await hoverTip(LAST);
    check(
      "tip: the working button says what a click does",
      tipLast?.text === "Delete this turn" && tipLast.above,
      JSON.stringify(tipLast),
    );
    const tipEarly = await hoverTip(delOf(1));
    check(
      "tip: a greyed-out button says why it does nothing",
      tipEarly?.text === "Only the last turn can be deleted" && tipEarly.above,
      JSON.stringify(tipEarly),
    );
    await mouse("mouseMoved", { x: 5, y: 5 });
    await ctx.sleep(60);
    const sent0 = (await sent()).length;
    await click(center(await rect(delOf(1))));
    await ctx.sleep(60);
    const clicked = {
      tip: await tipNow(delOf(1)),
      state: await stateOf(1),
      sent: (await sent()).length - sent0,
    };
    check(
      "tip: a click on a greyed-out button shows its tip at once and arms nothing",
      clicked.tip?.text === "Only the last turn can be deleted" &&
        clicked.state?.off &&
        !clicked.state.arm &&
        clicked.sent === 0,
      JSON.stringify(clicked),
    );
    await mouse("mouseMoved", { x: 5, y: 5 });
    await ctx.sleep(60);

    const m = await measure(PROMPTS.length - 1);
    check("button: shows on hover", m?.vis === "visible", m?.vis);
    check(
      "button: one line square, its icon 1.25em of the text",
      m &&
        Math.abs(m.w - m.lh) < 0.6 &&
        Math.abs(m.h - m.lh) < 0.6 &&
        m.icon === "1.25x1.25",
      m && `${m.w}x${m.h}, line ${m.lh}, icon ${m.icon}em`,
    );
    check(
      "button: on the second line, after the text, inside the row",
      m && Math.abs(m.top - m.lh) < 0.6 && m.afterText && m.inRow,
      m &&
        JSON.stringify({ top: m.top, afterText: m.afterText, inRow: m.inRow }),
    );
    // VS Code's overlay scrollbar covers the list's last 16px once hovered
    // (1.143 on macOS); headless runs draw none, so this reads the inset.
    check(
      "button: clear of the list's right edge, where the scrollbar draws",
      m && m.fromRight >= 20,
      m && `${m.fromRight}px`,
    );
    await ctx.shot("hover");

    // Arm, leave, arm again.
    const before = (await sent()).length;
    await click(center(await rect(LAST)));
    await ctx.sleep(80);
    const armed = await json(
      `(function(){var b=${q(LAST)},s=b.querySelector(".ccup-hist-sure"),r=b.getBoundingClientRect(),` +
        `sr=s.getBoundingClientRect(),cs=getComputedStyle(s);` +
        `return{arm:b.hasAttribute("data-arm"),text:s.textContent,shown:cs.display!=="none",bold:cs.fontWeight,` +
        `color:cs.color,right:sr.right-r.right,top:sr.top-r.top,h:sr.height-r.height,` +
        `icon:getComputedStyle(b.querySelector("svg")).visibility,label:b.getAttribute("aria-label")}})()`,
    );
    check(
      "arm: a first click shows sure? and sends nothing",
      armed.arm &&
        armed.shown &&
        armed.text === "sure?" &&
        (await sent()).length === before,
      JSON.stringify(armed),
    );
    check(
      "arm: bold red, right-aligned to the button, icon hidden",
      +armed.bold >= 700 &&
        armed.color === "rgb(244, 135, 113)" &&
        Math.abs(armed.right) < 0.6 &&
        Math.abs(armed.top) < 0.6 &&
        Math.abs(armed.h) < 0.6 &&
        armed.icon === "hidden",
      JSON.stringify(armed),
    );
    await ctx.shot("armed");
    const pane = await rect(PANE);
    await mouse("mouseMoved", { x: pane.x + 30, y: pane.y + 10 });
    await ctx.sleep(60);
    check(
      "arm: leaving the button disarms it",
      !(await ctx.evaluate(`${q(LAST)}.hasAttribute("data-arm")`)),
    );

    // Seed a stale hidden mark at the last position, then delete the turn.
    await ctx.evaluate(
      `(function(){var o={};o[${JSON.stringify(R)}]={t:Date.now(),k:["${PROMPTS.length - 1}:stale","1:keep"]};` +
        `localStorage.setItem("ccup-prompt-history-hidden",JSON.stringify(o))})()`,
    );
    await ctx.evaluate("window.__at(0)");
    await measure(PROMPTS.length - 1);
    await click(center(await rect(LAST)));
    await ctx.sleep(60);
    await click(center(await rect(LAST)));
    const gone = await until(
      `document.querySelectorAll(${JSON.stringify(HDR)}).length===${PROMPTS.length - 1}`,
    );
    const req = (await sent()).slice(before);
    check(
      "delete: a second click sends one ccup_rewind_turn for the last prompt",
      req.length === 1 &&
        req[0].request.sessionId === R &&
        req[0].request.targetUuid === uuidOf(PROMPTS.length - 1) &&
        typeof req[0].channelId === "string",
      JSON.stringify(req.map((x) => ({ ch: x.channelId, ...x.request }))),
    );
    check("delete: the turn leaves the transcript", !!gone);
    await ctx.sleep(200);
    check(
      "delete: the list rebuilds one entry shorter",
      (await rows()) === PROMPTS.length - 1,
      await rows(),
    );
    const next = await json(
      `[...document.querySelectorAll(${JSON.stringify(DEL)})].filter(function(b){return!b.hasAttribute("data-off")})` +
        `.map(function(b){return[b.closest(".ccup-hist-item").getAttribute("data-i"),b.hasAttribute("data-arm")]})`,
    );
    check(
      "delete: the new last entry's button works, unarmed, and no other",
      next.length === 1 &&
        next[0][0] === String(PROMPTS.length - 2) &&
        next[0][1] === false,
      JSON.stringify(next),
    );
    check(
      "delete: the todo list keeps the kept turns' last TodoWrite",
      (await todos()) === JSON.stringify(TODO_AT[4]),
      await todos(),
    );
    const marks = await json(
      `JSON.parse(localStorage.getItem("ccup-prompt-history-hidden")||"{}")[${JSON.stringify(R)}]`,
    );
    check(
      "marks: the deleted position's mark is dropped, earlier ones stay",
      JSON.stringify(marks?.k) === JSON.stringify(["1:keep"]),
      JSON.stringify(marks),
    );
    check(
      "delete: no notification on success",
      (await notes()).length === 0,
      JSON.stringify(await notes()),
    );

    // Refusal and an unpatched host keep the turn and say why.
    for (const [mode, want] of [
      ["refuse", "Could not delete the turn: turn running."],
      ["unknown", "Reload the window to start using turn delete."],
    ]) {
      await ctx.evaluate(
        `window.__rewindMode=${JSON.stringify(mode)};window.__notes=[];window.__at(0)`,
      );
      const n0 = await count();
      if (!(await ctx.evaluate(`!!${q(PANE)}`))) await open();
      const last = n0 - 1;
      await measure(last);
      await click(center(await rect(delOf(last))));
      await ctx.sleep(60);
      await click(center(await rect(delOf(last))));
      const said = await until(`window.__notes.length>0`, 4000);
      await ctx.sleep(150);
      const n1 = await count();
      const row = await ctx.evaluate(
        `(function(){var r=document.querySelector('${PANE} .ccup-hist-item[data-i="${last}"]');return r?!r.hasAttribute("data-going"):null})()`,
      );
      const st = await stateOf(last);
      check(
        `${mode}: the turn stays, the row is usable again, and a notification says why`,
        !!said &&
          n1 === n0 &&
          row === true &&
          st?.off === false &&
          (await notes())[0] === want,
        JSON.stringify({ n0, n1, row, st, notes: await notes() }),
      );
    }

    // One more turn back: turn 5 had rewritten the todos, so turn 3's return.
    // The new last entry, turn 4, was sent minutes ago.
    await ctx.evaluate(
      `window.__rewindMode="ok";window.__notes=[];window.__at(0)`,
    );
    await measure(PROMPTS.length - 2);
    await click(center(await rect(delOf(PROMPTS.length - 2))));
    await ctx.sleep(60);
    await click(center(await rect(delOf(PROMPTS.length - 2))));
    check(
      "again: a second delete walks one more turn back",
      !!(await until(
        `document.querySelectorAll(${JSON.stringify(HDR)}).length===${PROMPTS.length - 2}`,
      )),
    );
    await ctx.sleep(200);
    check(
      "again: the todo list falls back to turn 3's",
      (await todos()) === JSON.stringify(TODO_AT[2]),
      await todos(),
    );
    const aged = await stateOf(PROMPTS.length - 3);
    check(
      "again: the new last entry, sent minutes ago, is greyed out for its age",
      aged?.off === true && aged.tip === "Started more than 30 seconds ago",
      JSON.stringify(aged),
    );
    await ctx.shot("after");

    // A turn still running: a prompt sent from the input box, its reply
    // streaming, deleted from the list. The stop goes out first, the rewind
    // once the interrupted turn has ended, and the view keeps nothing of it.
    // The page clock runs true from here, and the prompts sent from the
    // input box take their time from it.
    await ctx.evaluate(`window.__notes=[];window.__skew=0`);
    // The active session, read through React's own props.
    await ctx.evaluate(
      `window.__ccupSessionProbe=function(){var h=document.querySelector(${JSON.stringify(HDR)});` +
        `var k=h&&Object.keys(h).find(function(k){return k.indexOf("__reactFiber$")===0});` +
        `for(var f=k&&h[k];f;f=f.return){var s=f.memoizedProps&&f.memoizedProps.session;` +
        `if(s&&s.busy)return s}return null}`,
    );
    const busy = () =>
      ctx.evaluate(
        `(function(){var s=window.__ccupSessionProbe();return s?s.busy.value:null})()`,
      );
    // Type a prompt into the input box and send it, with the list closed;
    // resolves once its header carries the uuid the stub saw.
    const sendPrompt = async (text) => {
      if (await ctx.evaluate(`!!${q(PANE)}`))
        await click(center(await rect(BTN)));
      const n = await count();
      await ctx.evaluate(`${q('[aria-label="Message input"]')}.focus()`);
      await ctx.insertText(text);
      for (const type of ["keyDown", "keyUp"])
        await ctx.cdp("Input.dispatchKeyEvent", {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
      const started = await until(
        `window.__live&&document.querySelectorAll(${JSON.stringify(HDR)}).length===${n + 1}&&` +
          `[...document.querySelectorAll(${JSON.stringify(HDR)})].pop().getAttribute("data-ccup-uuid")===window.__live.uuid`,
      );
      return { n, started: !!started };
    };
    // Stop the running turn the way the stop button does, and wait it out.
    const endTurn = async () => {
      await ctx.evaluate(
        `(function(){var s=window.__ccupSessionProbe();if(s)s.interrupt()})()`,
      );
      return until(`window.__ccupSessionProbe().busy.value===false`);
    };
    const n0 = await count();
    const { started } = await sendPrompt(
      "Count from 1 to 400, one number per line.",
    );
    check(
      "live: a sent prompt's header carries its uuid while the turn runs",
      started && (await busy()) === true,
    );
    // The transcript proper, not the screen reader's live region, which keeps
    // the last text it announced.
    const shows = (text) =>
      ctx.evaluate(
        `${q(`.${cls("messagesContainer")}`)}.innerText.indexOf(${JSON.stringify(text)})>=0`,
      );
    check(
      "live: the reply streams into the transcript",
      !!(await until(
        `${q(`.${cls("messagesContainer")}`)}.innerText.indexOf("Counting one two")>=0`,
      )),
    );
    const liveUuid = await ctx.evaluate("window.__live&&window.__live.uuid");
    const mark0 = (await json("window.__sent")).length;
    await open();
    await measure(n0);
    await click(center(await rect(delOf(n0))));
    await ctx.sleep(60);
    await click(center(await rect(delOf(n0))));
    const back = await until(
      `document.querySelectorAll(${JSON.stringify(HDR)}).length===${n0}`,
    );
    await ctx.sleep(300);
    const order = (await json("window.__sent"))
      .slice(mark0)
      .map((m) => m.type)
      .filter(
        (t) => t === "interrupt_claude" || t === "request:ccup_rewind_turn",
      );
    const lastReq = (await sent()).pop();
    check(
      "live: the stop goes out before the rewind, which names the sent prompt",
      order[0] === "interrupt_claude" &&
        order.includes("request:ccup_rewind_turn") &&
        lastReq?.request.targetUuid === liveUuid,
      JSON.stringify({ order, target: lastReq?.request.targetUuid, liveUuid }),
    );
    const left = {
      interrupted: await ctx.evaluate(
        `document.querySelectorAll(".${cls("interruptedMessage")}").length`,
      ),
      reply: await shows("Counting one two"),
      prompt: await shows("Count from 1 to 400"),
      busy: await busy(),
    };
    check(
      "live: the turn, its partial reply and the interrupt marker all leave the view",
      !!back &&
        left.interrupted === 0 &&
        !left.reply &&
        !left.prompt &&
        left.busy === false,
      JSON.stringify(left),
    );

    // An Edit streaming into a running turn greys its button out at once.
    const t2 = await sendPrompt("Fix the typo in the README.");
    await ctx.sleep(300);
    await open();
    const open2 = await stateOf(t2.n);
    await ctx.evaluate(`window.__streamTool("Edit")`);
    const shut2 = await until(
      `${q(delOf(t2.n))}.hasAttribute("data-off")`,
      3000,
    );
    const tool2 = await stateOf(t2.n);
    check(
      "tool: an Edit streaming into the running turn greys its button out, naming the tool",
      t2.started &&
        open2?.off === false &&
        !!shut2 &&
        tool2?.tip === "Used Edit, which can leave changes behind",
      JSON.stringify({ open2, tool2 }),
    );
    await endTurn();

    // A running turn that only streams prose: two seconds before its window
    // closes, one pass books the timer, and then nothing moves.
    const t3 = await sendPrompt("Say hello.");
    await ctx.sleep(300);
    await open();
    await ctx.evaluate(
      `(function(){var s=window.__ccupSessionProbe(),m=s.messages.value,u=window.__live.uuid,p;` +
        `for(var i=m.length-1;i>=0;i--)if(m[i].uuid===u){p=m[i];break}` +
        `window.__skew=p.createdAt+28000-Date.now()+window.__skew;document.dispatchEvent(new Event("scroll"))})()`,
    );
    await ctx.sleep(300);
    const before3 = await stateOf(t3.n);
    const shut3 = await until(
      `${q(delOf(t3.n))}.hasAttribute("data-off")`,
      4000,
    );
    const after3 = await stateOf(t3.n);
    check(
      "timer: with nothing else moving, the button greys out once 30 seconds have passed",
      t3.started &&
        before3?.off === false &&
        !!shut3 &&
        after3?.tip === "Started more than 30 seconds ago",
      JSON.stringify({ before3, after3 }),
    );
    await ctx.evaluate("window.__skew=0");
    await endTurn();

    // A Write the stop comes too late for: the turn stays, and no rewind goes.
    await ctx.evaluate(`window.__notes=[]`);
    const t4 = await sendPrompt("Write the changelog entry.");
    await ctx.sleep(300);
    await ctx.evaluate(`window.__stopTool="Write"`);
    const rewinds4 = (await sent()).length;
    const mark4 = (await json("window.__sent")).length;
    await open();
    await measure(t4.n);
    await click(center(await rect(delOf(t4.n))));
    await ctx.sleep(60);
    await click(center(await rect(delOf(t4.n))));
    const said4 = await until(`window.__notes.length>0`, 6000);
    await ctx.sleep(300);
    const race = {
      notes: await notes(),
      rewinds: (await sent()).length - rewinds4,
      stop: (await json("window.__sent"))
        .slice(mark4)
        .some((x) => x.type === "interrupt_claude"),
      headers: await count(),
      state: await stateOf(t4.n),
      busy: await busy(),
    };
    check(
      "race: a Write the stop comes too late for keeps the turn, says so, and sends no rewind",
      t4.started &&
        !!said4 &&
        race.notes[0] ===
          "Could not delete the turn: it used Write, which can leave changes behind." &&
        race.rewinds === 0 &&
        race.stop &&
        race.headers === t4.n + 1 &&
        race.state?.off === true &&
        race.state.tip === "Used Write, which can leave changes behind" &&
        race.busy === false,
      JSON.stringify(race),
    );

    // A prompt queued while a turn runs stays out of the list until Claude
    // starts on it, 40 seconds later on the page clock, and its window then
    // runs from that moment.
    const qa = await sendPrompt("Start a long task.");
    const qn = await count();
    await ctx.evaluate(`${q('[aria-label="Message input"]')}.focus()`);
    await ctx.insertText("And then a second one.");
    for (const type of ["keyDown", "keyUp"])
      await ctx.cdp("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    const held = await until(
      `window.__ccupSessionProbe().heldPrompts.value.length===1&&window.__queued.length===1`,
    );
    await open();
    await ctx.sleep(200);
    const waiting = { headers: await count(), last: await stateOf(qa.n) };
    check(
      "queue: a queued prompt stays out of the list, and the running turn's button says why",
      qa.started &&
        !!held &&
        waiting.headers === qn &&
        waiting.last?.off === true &&
        waiting.last.tip === "A queued message waits to be sent",
      JSON.stringify(waiting),
    );
    await ctx.evaluate("window.__skew+=40000;window.__pickUp()");
    const joined = await until(
      `document.querySelectorAll(${JSON.stringify(HDR)}).length===${qn + 1}`,
    );
    await ctx.sleep(300);
    const fresh = await stateOf(qn);
    check(
      "queue: once Claude starts on it, its button works, however long it waited",
      !!joined && fresh?.off === false && fresh.tip === "Delete this turn",
      JSON.stringify(fresh),
    );
    await ctx.evaluate(
      `window.__skew+=31000;document.dispatchEvent(new Event("scroll"))`,
    );
    const late = await until(`${q(delOf(qn))}.hasAttribute("data-off")`, 3000);
    const lateState = await stateOf(qn);
    check(
      "queue: 30 seconds after Claude started on it, its button greys out",
      !!late && lateState?.tip === "Started more than 30 seconds ago",
      JSON.stringify(lateState),
    );
    await endTurn();
  } finally {
    server.close();
  }
  return ok;
}
