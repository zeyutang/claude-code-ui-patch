// Scenario for scripts/cdp-driver.mjs: bookmark notes, on the REAL webview
// bundle booted against a stub host into a session of three replies, two of
// them bookmarked (one with a note already), under the webview's own content
// security policy, with real mouse and key events. The checks assert:
//   rows      every Bookmarks row has a notepad button after its time, and a
//             row with a note shows the note in place of the reply's opening
//             line, its button shown
//   button    hidden until its row is hovered, then shown in a 20px square
//             centered on the row, inside it and right of the time, without
//             growing the row
//   open      a click opens an empty, focused box over exactly the row,
//             capped at 200 characters, and leaves the row unselected
//   save      typing and Enter save: the row shows the note, its button
//             stays shown and takes focus back, one update_session_bookmark
//             carries the note in the record, and no analytics event goes
//   cancel    Enter on the focused button reopens the box with the note
//             selected, and Escape keeps the note and leaves the pane open
//   drop      emptying the box and leaving it drops the note from the record
//             and the row
//   unpatched a host that answers without the note brings the reload notice,
//             and the row falls back to the reply's line
//   fail      a host that fails the write shows why, and the reread list
//             stands
//   selected  a selected row's button reads in the selection's colors
//
//   node scripts/cdp-driver.mjs scripts/repro/bookmark-notes.mjs 460 760
//
// The bundle served is the compiled patcher's own output for the live install
// (bookmarkNoteWebview, out/, so compile first), so the scenario runs exactly
// what an apply writes and doubles as the drift canary for the webview half.
// The live bundle is found under ~/.vscode/extensions (newest Claude Code
// install) or via $CCUP_BUNDLE (the webview directory, with extension.js
// beside it for the host half's gate). At 460px the pane stacks under the
// chat, as in a sidebar.
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

const R = "66666666-6666-4666-8666-666666666666";
const NONCE = "ccupbnote";
const REPLIES = [
  "Plain opening line of the first reply.\n\nA second paragraph.",
  "The axis set, the map, and the twelve tables follow.\n\nMore below.",
  "The memory file now carries this as the single current statement.\n\nDone.",
];
const uuidOf = (i) =>
  `${String(i).padStart(8, "0")}-0000-4000-8000-00000000000${i % 10}`;
const replyOf = (i) => "a" + uuidOf(i).slice(1);
const NOTICE = "Reload the window to start using bookmark notes.";
const WRITE_ERR = "this session's bookmarks could not be written";

const page = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; script-src 'nonce-${NONCE}'; worker-src 'self'">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:"SF Mono",monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-chat-font-family:system-ui;
--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#cccccc;
--vscode-descriptionForeground:#9d9d9d;--vscode-sideBar-background:#181818;
--vscode-editor-background:#1f1f1f;--vscode-input-background:#262626;--vscode-input-border:#3c3c3c;
--vscode-input-foreground:#cccccc;--vscode-input-placeholderForeground:#989898;
--vscode-focusBorder:#0078d4;--vscode-inputOption-activeBorder:#2488db;--vscode-errorForeground:#f48771;
--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;
--vscode-list-hoverBackground:#2a2d2e;--vscode-widget-border:#313131;--vscode-menu-background:#1f1f1f;
--vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-icon-foreground:#cccccc;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${R}"></div>
<script nonce="${NONCE}">
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
const R = "${R}", NOW = Date.now();
const REPLIES = ${JSON.stringify(REPLIES)};
const UUIDS = ${JSON.stringify(REPLIES.map((_, i) => uuidOf(i)))};
const REPLY_IDS = ${JSON.stringify(REPLIES.map((_, i) => replyOf(i)))};
const at = (i) => new Date(NOW - (REPLIES.length - i) * 600e3).toISOString();
const MESSAGES = REPLIES.flatMap((text, i) => [
  { type: "user", uuid: UUIDS[i], session_id: R, parent_tool_use_id: null, timestamp: at(i),
    message: { role: "user", content: [{ type: "text", text: "Prompt " + (i + 1) }] } },
  { type: "assistant", uuid: REPLY_IDS[i], session_id: R, parent_tool_use_id: null, timestamp: at(i),
    message: { id: "msg_" + i, type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } } },
]);
// The host's bookmark file for the session: replies 2 and 3, the newer with a note.
window.__store = [
  { uuid: REPLY_IDS[1], addedAt: NOW - 1300e3, writtenAt: NOW - 1320e3 },
  { uuid: REPLY_IDS[2], addedAt: NOW - 360e3, writtenAt: NOW - 400e3, ccupNote: "memory statement" },
];
const SESSION = { id: R, summary: "Bookmark notes", customTitle: "Bookmark notes",
  lastModified: NOW, lastActivity: NOW, archived: false, fileSize: 4096,
  gitBranch: "develop", isCurrentWorkspace: true };
const deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
const MODEL = { value: "default", label: "Default", resolvedModel: "claude-fable-5",
  supportsAutoMode: true, supportsFastMode: false, supportedEffortLevels: [] };
// What the page posted, the notices it asked for, and how the stub host
// answers a bookmark write: "patched" (keeps the note), "unpatched" (a host
// schema without it), or "fail" (the write fails).
window.__sent = []; window.__notes = []; window.__hostMode = "patched";
const fields = (b) => ({ uuid: b.uuid, addedAt: b.addedAt,
  ...(b.writtenAt !== undefined && { writtenAt: b.writtenAt }),
  ...(window.__hostMode !== "unpatched" && typeof b.ccupNote === "string" && { ccupNote: b.ccupNote }) });
window.acquireVsCodeApi = () => ({
  getState() { return undefined; },
  setState() {},
  postMessage(msg) {
    if (msg && msg.type !== "request") window.__sent.push({ type: msg.type, msg });
    if (!msg || msg.type !== "request") return;
    const r = msg.request;
    window.__sent.push({ type: "request:" + r.type, request: r });
    let resp = {};
    switch (r.type) {
      case "init":
        resp = { type: "init_response", state: { sweptStaleChannels: false,
          authStatus: { authMethod: "claude_ai" }, claudeSettings: { effective: {}, errors: [] },
          experimentGates: {}, useCtrlEnterToSend: false, speechToTextEnabled: false,
          bookmarksSupported: true } };
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
      case "get_session_bookmarks":
        resp = { type: "get_session_bookmarks_response", bookmarks: window.__store.map(fields) };
        break;
      case "update_session_bookmark":
        if (window.__hostMode === "fail") {
          resp = { type: "error", error: "${WRITE_ERR}" };
          break;
        }
        window.__store = window.__store.filter((b) => b.uuid !== r.uuid);
        if (r.bookmark) window.__store.push(fields(r.bookmark));
        resp = { type: "update_session_bookmark_response", bookmarks: window.__store.map(fields) };
        break;
      case "get_bookmarked_responses":
        resp = { type: "get_bookmarked_responses_response",
          texts: Object.fromEntries(r.uuids.map((u) => [u, REPLIES[REPLY_IDS.indexOf(u)] ?? null])) };
        break;
      case "show_notification":
        window.__notes.push(r.message);
        resp = { type: "show_notification_response" };
        break;
    }
    deliver({ type: "response", requestId: msg.requestId, response: resp });
  },
});
</script>
<script type="module" nonce="${NONCE}" src="/wv/index.js"></script>
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
  const native = readFileSync(join(dir, "index.js"), "utf8");
  const host = readFileSync(join(dirname(dir), "extension.js"), "utf8");
  const serve = P.bookmarkNoteWebview(native, host);
  console.log(`live bundle: ${dir}`);

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };
  if (!check("the patcher builds the webview half", !!serve)) return false;

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
    await ctx.sleep(80);
  };
  const KEYS = {
    Enter: { code: "Enter", vk: 13, text: "\r" },
    Escape: { code: "Escape", vk: 27 },
    Backspace: { code: "Backspace", vk: 8 },
  };
  const key = async (name) => {
    const k = KEYS[name];
    const base = {
      key: name,
      code: k.code,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
    };
    await ctx.cdp("Input.dispatchKeyEvent", {
      type: k.text ? "keyDown" : "rawKeyDown",
      ...base,
      ...(k.text && { text: k.text, unmodifiedText: k.text }),
    });
    await ctx.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await ctx.sleep(80);
  };
  const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  // Row i of the list (0 is the older bookmark), measured.
  const LI = (i) =>
    `document.querySelectorAll("li:has(.ccup-bnote-btn)")[${i}]`;
  const row = (i) =>
    json(
      `(function(){var li=${LI(i)};if(!li)return null;var b=li.querySelector("button"),` +
        `s=b.querySelector(".ccup-bnote-btn"),t=b.querySelector("span"),` +
        `tm=t.nextElementSibling===s?null:t.nextElementSibling,box=li.querySelector(".ccup-bnote-input"),` +
        `R=function(e){if(!e)return null;var r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,r:r.right,b:r.bottom}};` +
        `return{text:t.textContent,on:s.hasAttribute("data-ccup-bnote-on"),title:s.title,` +
        `op:getComputedStyle(s).opacity,color:getComputedStyle(s).color,bg:getComputedStyle(s).backgroundColor,` +
        `rowColor:getComputedStyle(b).color,rowBg:getComputedStyle(b).backgroundColor,` +
        `current:b.getAttribute("aria-current"),li:R(li),row:R(b),btn:R(s),icon:R(s.querySelector("svg")),` +
        `time:R(tm),text_:R(t),box:box&&{r:R(box),value:box.value,ph:box.placeholder,max:box.maxLength,` +
        `focused:document.activeElement===box,sel:[box.selectionStart,box.selectionEnd],` +
        `inset:parseFloat(getComputedStyle(box).paddingLeft)+parseFloat(getComputedStyle(box).borderLeftWidth),` +
        `border:getComputedStyle(box).borderLeftStyle+" "+getComputedStyle(box).borderLeftColor},` +
        `btnFocused:document.activeElement===s}})()`,
    );
  const updates = () =>
    json(
      "window.__sent.filter(function(m){return m.type==='request:update_session_bookmark'}).map(function(m){return m.request})",
    );
  const analytics = () =>
    json(
      "window.__sent.filter(function(m){return JSON.stringify(m).indexOf('bookmark_')>=0&&m.type!=='request:update_session_bookmark'&&m.type!=='request:get_session_bookmarks'&&m.type!=='request:get_bookmarked_responses'}).map(function(m){return m.type})",
    );
  const notes = () => json("window.__notes");
  const paneOpen = () =>
    ctx.evaluate(`!!document.querySelector("li .ccup-bnote-btn")`);
  const away = () => mouse("mouseMoved", { x: 3, y: 3 });

  try {
    await ctx.navigate(base);
    check(
      "boot: the transcript and the Bookmarks button mount",
      !!(await until(
        `document.body.innerText.indexOf("Plain opening line")>=0&&!!document.querySelector('button[aria-label="Bookmarks"]')`,
      )),
    );
    await ctx.sleep(300);
    const bb = await json(
      `(function(){var r=document.querySelector('button[aria-label="Bookmarks"]').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()`,
    );
    await click(center(bb));
    check(
      "rows: the pane opens with both bookmarks, each with a button",
      !!(await until(
        `document.querySelectorAll("li:has(.ccup-bnote-btn)").length===2`,
      )),
    );
    await away();
    await ctx.sleep(120);
    let a = await row(0);
    let b = await row(1);
    check(
      "rows: a row without a note shows the reply's opening line",
      a?.text === "The axis set, the map, and the twelve tables follow." &&
        !a.on,
      a?.text,
    );
    check(
      "rows: a row with a note shows the note, its button on",
      b?.text === "memory statement" && b.on && b.title === "Edit note",
      `${b?.text} on=${b?.on} title=${b?.title}`,
    );
    check(
      "button: hidden on a row without a note, shown on one with a note",
      a.op === "0" && b.op === "1",
      `${a.op} / ${b.op}`,
    );
    await mouse("mouseMoved", center(a.text_));
    await ctx.sleep(120);
    a = await row(0);
    check("button: shows while its row is hovered", a.op === "1", a.op);
    const inRow =
      a.btn.x >= a.time.r &&
      a.btn.r <= a.row.r - 4 &&
      Math.abs(a.btn.y + a.btn.h / 2 - (a.row.y + a.row.h / 2)) < 0.75 &&
      a.btn.w === 20 &&
      a.btn.h === 20 &&
      a.icon.w === 14;
    check(
      "button: a 20px square centered on the row, right of the time, inside it",
      inRow,
      JSON.stringify({ btn: a.btn, time: a.time, row: a.row }),
    );
    const grown = await json(
      `(function(){var li=${LI(0)},s=li.querySelector(".ccup-bnote-btn"),b=li.querySelector("button");` +
        `var h=b.getBoundingClientRect().height;s.style.display="none";var n=b.getBoundingClientRect().height;` +
        `s.style.display="";return{h:h,n:n}})()`,
    );
    check(
      "button: the row keeps its height",
      grown.h === grown.n,
      `${grown.h} with, ${grown.n} without`,
    );
    await ctx.shot("hover");

    await click(center(a.btn));
    a = await row(0);
    check(
      "open: a click opens an empty, focused box over exactly the row",
      a.box?.focused &&
        a.box.value === "" &&
        a.box.ph === "Add a note" &&
        Math.abs(a.box.r.x - a.li.x) < 0.5 &&
        Math.abs(a.box.r.w - a.li.w) < 0.5 &&
        Math.abs(a.box.r.y - a.li.y) < 0.5 &&
        Math.abs(a.box.r.h - a.li.h) < 0.5,
      JSON.stringify(a.box),
    );
    check("open: the box takes 200 characters", a.box?.max === 200);
    check(
      "open: its text starts where the row's does, inside a shown border",
      Math.abs(a.box.r.x + a.box.inset - a.text_.x) < 0.5 &&
        a.box.border.startsWith("solid ") &&
        !/rgba\(0, 0, 0, 0\)/.test(a.box.border),
      `${a.box.r.x + a.box.inset} vs ${a.text_.x}, ${a.box.border}`,
    );
    check(
      "open: the row is not selected by it",
      a.current === "false",
      a.current,
    );
    await ctx.insertText("axis tables");
    await ctx.shot("editing");
    await key("Enter");
    a = await row(0);
    let up = await updates();
    check(
      "save: the row shows the note, its button on and focused",
      !a.box && a.text === "axis tables" && a.on && a.btnFocused,
      `${a.text} box=${!!a.box} on=${a.on} focus=${a.btnFocused}`,
    );
    check(
      "save: one update carries the note in the record",
      up.length === 1 &&
        up[0].uuid === replyOf(1) &&
        up[0].bookmark?.uuid === replyOf(1) &&
        up[0].bookmark.ccupNote === "axis tables" &&
        typeof up[0].bookmark.addedAt === "number" &&
        typeof up[0].bookmark.writtenAt === "number",
      JSON.stringify(up),
    );
    check(
      "save: no analytics event goes out",
      (await analytics()).length === 0,
      JSON.stringify(await analytics()),
    );

    await key("Enter");
    a = await row(0);
    check(
      "cancel: Enter on the focused button reopens with the note selected",
      a.box?.focused &&
        a.box.value === "axis tables" &&
        a.box.sel[0] === 0 &&
        a.box.sel[1] === 11,
      JSON.stringify(a.box),
    );
    await ctx.insertText("something else");
    await key("Escape");
    a = await row(0);
    check(
      "cancel: Escape keeps the note and the pane",
      !a.box &&
        a.text === "axis tables" &&
        (await paneOpen()) &&
        (await updates()).length === 1,
      `${a.text} pane=${await paneOpen()}`,
    );

    b = await row(1);
    await mouse("mouseMoved", center(b.text_));
    await click(center(b.btn));
    b = await row(1);
    check(
      "drop: the box opens on the note, selected",
      b.box?.value === "memory statement" && b.box.sel[1] === 16,
      JSON.stringify(b.box),
    );
    await key("Backspace");
    await click({ x: 20, y: 40 });
    b = await row(1);
    up = await updates();
    check(
      "drop: leaving the emptied box drops the note from the record and row",
      !b.box &&
        b.text ===
          "The memory file now carries this as the single current statement." &&
        !b.on &&
        up.length === 2 &&
        up[1].uuid === replyOf(2) &&
        up[1].bookmark &&
        !("ccupNote" in up[1].bookmark),
      `${b.text} on=${b.on} ${JSON.stringify(up[1])}`,
    );

    await ctx.evaluate(`window.__hostMode="unpatched"`);
    b = await row(1);
    await mouse("mouseMoved", center(b.text_));
    await click(center(b.btn));
    await ctx.insertText("lost on an old host");
    await key("Enter");
    await until(`window.__notes.length>0`, 2000);
    b = await row(1);
    check(
      "unpatched: the reload notice, and the row falls back",
      (await notes()).includes(NOTICE) &&
        b.text ===
          "The memory file now carries this as the single current statement." &&
        !b.on,
      `${JSON.stringify(await notes())} ${b.text}`,
    );

    await ctx.evaluate(`window.__hostMode="fail";window.__notes=[]`);
    a = await row(0);
    await mouse("mouseMoved", center(a.text_));
    await click(center(a.btn));
    await key("Backspace");
    await ctx.insertText("never written");
    await key("Enter");
    await until(`window.__notes.length>0`, 2000);
    await ctx.sleep(150);
    a = await row(0);
    check(
      "fail: the reason shows, and the reread list stands",
      (await notes()).some((n) => n.includes(WRITE_ERR)) &&
        a.text === "axis tables" &&
        a.on,
      `${JSON.stringify(await notes())} ${a.text}`,
    );

    await ctx.evaluate(`window.__hostMode="patched"`);
    await click(center(a.text_));
    await away();
    await ctx.sleep(120);
    a = await row(0);
    check(
      "selected: a selected row's button reads in the selection's colors",
      a.current === "true" && a.op === "1" && a.color === a.rowColor,
      `${a.current} ${a.color} vs row ${a.rowColor} on ${a.rowBg}`,
    );
    await ctx.shot("selected");
  } finally {
    server.close();
  }
  return ok;
}
