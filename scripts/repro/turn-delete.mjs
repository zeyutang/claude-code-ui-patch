// Scenario for scripts/cdp-driver.mjs: the prompt history's last turn delete,
// on the REAL webview bundle booted against a stub host into a session of
// six prompts, with real mouse events. The checks assert:
//   uuid      every sticky header carries its message's data-ccup-uuid
//   button    the last entry, and no other, has a delete button: hidden until
//             the row is hovered, one line square on the second line's axis,
//             after the text, inside the row, and 20px in from the list's
//             right edge, clear of the overlay scrollbar even hovered
//   arm       a first click shows "sure?" in bold red over the button,
//             right-aligned to its right edge, the icon hidden, and sends
//             nothing; leaving the button disarms it
//   delete    a second click sends one ccup_rewind_turn naming the session
//             and the last prompt's uuid, the turn leaves the transcript, the
//             list rebuilds one entry shorter with the button on the new last
//             entry, unarmed, and the todo list falls back to the kept turns'
//             last TodoWrite; deleting again walks one more turn back
//   marks     hidden marks from the deleted position on are dropped
//   refuse    a host answer of rewound:false keeps the turn, says why in a
//             notification, and leaves the row usable
//   unpatched a host without the handler ("Unknown request type.") keeps the
//             turn and asks for a reload
//   live      a prompt sent from the input box, deleted while its reply still
//             streams: the stop goes out before the rewind, which names the
//             prompt's own uuid, and the turn, its partial reply and the
//             interrupt marker the stop brings all leave the view
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
const PROMPTS = ${JSON.stringify(PROMPTS)};
const UUIDS = ${JSON.stringify(PROMPTS.map((_, i) => uuidOf(i)))};
const TODO_AT = ${JSON.stringify(TODO_AT)};
const at = (i) => new Date(NOW - (PROMPTS.length - i) * 60e3).toISOString();
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
const io = (channelId, message) =>
  deliver({ type: "io_message", channelId, message, done: false });
const LIVE_TEXT = "Counting " + "one two three ".repeat(3);
const live = (msg) => {
  const ch = msg.channelId, m = msg.message;
  window.__live = { ch, uuid: m.uuid };
  const ev = (event, k) => io(ch, { type: "stream_event", event, session_id: R,
    parent_tool_use_id: null, uuid: "e" + k + m.uuid.slice(2) });
  setTimeout(() => {
    io(ch, { type: "system", subtype: "init", session_id: R, model: "claude-fable-5",
      permissionMode: "default", tools: [], mcp_servers: [], slash_commands: [], uuid: "i" + m.uuid.slice(1) });
    io(ch, { ...m, session_id: R, isReplay: true });
    ev({ type: "message_start", message: { id: "msg_live", type: "message", role: "assistant",
      model: "claude-fable-5", content: [], stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 } } }, 1);
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, 2);
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: LIVE_TEXT } }, 3);
  }, 50);
};
const stopped = () => {
  const { ch, uuid } = window.__live;
  window.__live = null;
  setTimeout(() => {
    io(ch, { type: "assistant", uuid: "b" + uuid.slice(1), session_id: R, parent_tool_use_id: null,
      message: { id: "msg_live", type: "message", role: "assistant", model: "claude-fable-5",
        content: [{ type: "text", text: LIVE_TEXT }], stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 } } });
    io(ch, { type: "user", uuid: "c" + uuid.slice(1), session_id: R, parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
    io(ch, { type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 10,
      duration_api_ms: 10, num_turns: 1, session_id: R, total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 }, uuid: "d" + uuid.slice(1) });
  }, 50);
};
window.acquireVsCodeApi = () => ({
  getState() { return undefined; },
  setState() {},
  postMessage(msg) {
    if (msg && msg.type === "launch_claude") window.__chan = msg.channelId;
    if (msg && msg.type !== "request") window.__sent.push({ type: msg.type, channelId: msg.channelId });
    if (msg && msg.type === "io_message" && msg.message && msg.message.type === "user") live(msg);
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
  const lastRow = () =>
    `${PANE} .ccup-hist-item[data-i="${PROMPTS.length - 1}"]`;
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
        `p=${q(PANE)}.getBoundingClientRect(),s=b.querySelector("svg").getBoundingClientRect();` +
        `return{vis:getComputedStyle(b).visibility,w:r.width,h:r.height,lh:parseFloat(getComputedStyle(t).lineHeight),` +
        `top:r.top-tr.top,afterText:r.left>=tr.right-0.5,inRow:r.right<=w.right-parseFloat(cs.paddingRight)+0.5,` +
        `fromRight:p.right-r.right,icon:s.width+"x"+s.height}})()`,
    );
  };

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

    await open();
    check(
      "open: the list shows every prompt",
      (await rows()) === PROMPTS.length,
    );
    const dels = await json(
      `[...document.querySelectorAll(${JSON.stringify(DEL)})].map(function(b){return b.closest(".ccup-hist-item").getAttribute("data-i")})`,
    );
    check(
      "button: only the last entry has one",
      dels.length === 1 && dels[0] === String(PROMPTS.length - 1),
      dels.join(","),
    );
    const hidden = await ctx.evaluate(`getComputedStyle(${q(DEL)}).visibility`);
    await ctx.evaluate(`${q(PANE)}.scrollTop=0`);
    await mouse("mouseMoved", { x: 5, y: 5 });
    await ctx.sleep(60);
    check(
      "button: hidden until its row is hovered",
      (await ctx.evaluate(`getComputedStyle(${q(DEL)}).visibility`)) ===
        "hidden",
      hidden,
    );
    const m = await measure(PROMPTS.length - 1);
    check("button: shows on hover", m?.vis === "visible", m?.vis);
    check(
      "button: one line square",
      m && Math.abs(m.w - m.lh) < 0.6 && Math.abs(m.h - m.lh) < 0.6,
      m && `${m.w}x${m.h}, line ${m.lh}`,
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
    await click(center(await rect(DEL)));
    await ctx.sleep(80);
    const armed = await json(
      `(function(){var b=${q(DEL)},s=b.querySelector(".ccup-hist-sure"),r=b.getBoundingClientRect(),` +
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
      !(await ctx.evaluate(`${q(DEL)}.hasAttribute("data-arm")`)),
    );

    // Seed a stale hidden mark at the last position, then delete the turn.
    await ctx.evaluate(
      `(function(){var o={};o[${JSON.stringify(R)}]={t:Date.now(),k:["${PROMPTS.length - 1}:stale","1:keep"]};` +
        `localStorage.setItem("ccup-prompt-history-hidden",JSON.stringify(o))})()`,
    );
    await measure(PROMPTS.length - 1);
    await click(center(await rect(DEL)));
    await ctx.sleep(60);
    await click(center(await rect(DEL)));
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
      `[...document.querySelectorAll(${JSON.stringify(DEL)})].map(function(b){return[b.closest(".ccup-hist-item").getAttribute("data-i"),b.hasAttribute("data-arm")]})`,
    );
    check(
      "delete: the new last entry has the button, unarmed",
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

    // One more turn back: turn 5 had rewritten the todos, so turn 3's return.
    await measure(PROMPTS.length - 2);
    await click(center(await rect(DEL)));
    await ctx.sleep(60);
    await click(center(await rect(DEL)));
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
    await ctx.shot("after");

    // Refusal and an unpatched host keep the turn and say why.
    for (const [mode, want] of [
      ["refuse", "Could not delete the turn: turn running."],
      ["unknown", "Reload the window to start using turn delete."],
    ]) {
      await ctx.evaluate(
        `window.__rewindMode=${JSON.stringify(mode)};window.__notes=[]`,
      );
      const n0 = await ctx.evaluate(
        `document.querySelectorAll(${JSON.stringify(HDR)}).length`,
      );
      if (!(await ctx.evaluate(`!!${q(PANE)}`))) await open();
      const last = n0 - 1;
      await measure(last);
      await click(center(await rect(DEL)));
      await ctx.sleep(60);
      await click(center(await rect(DEL)));
      const said = await until(`window.__notes.length>0`, 4000);
      await ctx.sleep(150);
      const n1 = await ctx.evaluate(
        `document.querySelectorAll(${JSON.stringify(HDR)}).length`,
      );
      const row = await ctx.evaluate(
        `(function(){var r=document.querySelector('${PANE} .ccup-hist-item[data-i="${last}"]');return r?!r.hasAttribute("data-going"):null})()`,
      );
      check(
        `${mode}: the turn stays, the row is usable again, and a notification says why`,
        !!said && n1 === n0 && row === true && (await notes())[0] === want,
        JSON.stringify({ n0, n1, row, notes: await notes() }),
      );
    }

    // A turn still running: a prompt sent from the input box, its reply
    // streaming, deleted from the list. The stop goes out first, the rewind
    // once the interrupted turn has ended, and the view keeps nothing of it.
    await ctx.evaluate(`window.__rewindMode="ok";window.__notes=[]`);
    if (await ctx.evaluate(`!!${q(PANE)}`))
      await click(center(await rect(BTN)));
    const n0 = await ctx.evaluate(
      `document.querySelectorAll(${JSON.stringify(HDR)}).length`,
    );
    await ctx.evaluate(`${q('[aria-label="Message input"]')}.focus()`);
    await ctx.insertText("Count from 1 to 400, one number per line.");
    for (const type of ["keyDown", "keyUp"])
      await ctx.cdp("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    const started = await until(
      `window.__live&&document.querySelectorAll(${JSON.stringify(HDR)}).length===${n0 + 1}&&` +
        `[...document.querySelectorAll(${JSON.stringify(HDR)})].pop().getAttribute("data-ccup-uuid")===window.__live.uuid`,
    );
    const busy = () =>
      ctx.evaluate(
        `(function(){var h=document.querySelector(${JSON.stringify(HDR)});` +
          `var k=h&&Object.keys(h).find(function(k){return k.indexOf("__reactFiber$")===0});` +
          `for(var f=k&&h[k];f;f=f.return){var s=f.memoizedProps&&f.memoizedProps.session;` +
          `if(s&&s.busy)return s.busy.value}return null})()`,
      );
    check(
      "live: a sent prompt's header carries its uuid while the turn runs",
      !!started && (await busy()) === true,
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
    await click(center(await rect(DEL)));
    await ctx.sleep(60);
    await click(center(await rect(DEL)));
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
  } finally {
    server.close();
  }
  return ok;
}
