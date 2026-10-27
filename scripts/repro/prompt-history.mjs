// Scenario for scripts/cdp-driver.mjs: the prompt history button, on the REAL
// webview bundle booted against a stub host into a session whose transcript
// holds fourteen prompts (multi-line ones, one with a blank line, a long one, a
// slash command, short ones) and replies long enough to scroll. Real clicks and
// keys drive it, and the checks assert:
//   row       the button sits one 30px slot left of the jump pair's up
//             button, or alone in the corner slot when the others are off
//   list      one entry per user message, numbered from 1, the text read back
//             with each run of line breaks as one muted \n per break (a slash
//             command as its command line), every entry at line-height 2 and
//             exactly two lines tall (one-line messages included, \n markers
//             not growing a line), the long prompt clamped, numbers in
//             Claude's clay except on the current entry, and a 1px divider
//             between entries that hides beside the current one
//   geometry  right edge on the input box's, width between min(260px, input
//             box) and the input box (a compact list of short prompts, a full
//             width one of long prompts, a narrow panel capping the floor),
//             list plus button row plus composer within two thirds of the
//             viewport, the list scrolling inside itself
//   jump      a click lands the transcript on the message's natural header
//             position, the same scrollTop the up button reaches, the list
//             stays open (the jump buttons too), and the current entry follows:
//             the clicked one, even where its jump clamps to the bottom, the
//             last one at the bottom, the stuck header's elsewhere
//   keys      Up/Down then Enter jump from the keyboard, and Escape closes and
//             hands focus back to the input box with its caret where it was
//   close     a click on the transcript closes it, and so does the button
//   hide      an entry's hover button, one line square on the second line
//             with an icon 1.25em of the text (the fold's chevron .9em),
//             under its number and clear of the list's right edge where the
//             scrollbar draws, as close to the row's left edge and the text
//             as to its bottom (2px) while the number keeps 8px to the text,
//             at 13px and at 15.25px chat text, folds it away without a jump,
//             a neighbor joins the same fold, which carries the dividers an
//             entry does and keeps the entries' columns, the other numbers
//             stay, the fold survives a reload
//             (stored under the conversation's id), and a click on it brings
//             the run back. From the keyboard, Delete hides and Enter on the
//             fold restores, and a hidden current entry hands its highlight
//             to the fold
//   popup     a permission request hiding the composer closes an open list,
//             and the button riding the popup's wrapper opens one aligned
//             to that wrapper
//   settle    an open list over an idle transcript mutates nothing
//   empty     with no user message the button dims and opens nothing
//
//   node scripts/cdp-driver.mjs scripts/repro/prompt-history.mjs 760 620
//
// The bundle served is the compiled patcher's own output for the live install
// (promptHistWebview, out/, so compile first), so the scenario runs exactly
// what an apply writes and doubles as the drift canary. The live bundle is
// found under ~/.vscode/extensions (newest Claude Code install) or via
// $CCUP_BUNDLE (the webview directory). The live stylesheet carries your own
// text settings, so every geometry check reads measured boxes, and the run
// passes on a pristine bundle's native sizes as well.
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

const R = "33333333-3333-4333-8333-333333333333";
const LONG =
  "Walk through the whole request pipeline, from the moment the webview " +
  "posts a message to the moment the host answers, and list every place a " +
  "message can be dropped, duplicated, or reordered along the way, with the " +
  "file and function for each, then propose the smallest change that makes " +
  "each of them impossible, and say which ones need a test before anything " +
  "else changes, because I would rather see the failing test first.";
// The prompts, in transcript order: index 1 and 6 carry line breaks, index 2
// is the long one, and index 9 is a slash command in the CLI's tag form, which
// the transcript echoes as its command line.
const PROMPTS = [
  "Summarize the README in one paragraph.",
  "Rename the helper to fetchAll.\nThen update every call site.\n\nKeep the old name as an alias.",
  LONG,
  "yes",
  "Add tests for the parser.",
  "go on",
  "Three things:\n1. fix the lint\n2. bump the lockfile\n3. rerun the build",
  "Why did the second test fail?",
  "Use the fixture from the other suite instead.",
  "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>",
  "Explain the retry logic in plain words.",
  "Now make the retry delay configurable.",
  "Ship it.",
  "Write the changelog entry.",
];
// A second session of short prompts only, for the width floor.
const SHORT = ["yes", "go on", "ok", "Ship it.", "thanks"];
// The last two replies are one paragraph each, so turns 13 and 14 share the
// final screen and entry 13's jump clamps to the bottom.
const reply = (i) =>
  Array.from(
    { length: i >= 12 ? 1 : 2 + (i % 3) },
    (_, k) =>
      `Reply ${i + 1}, paragraph ${k + 1}. ` +
      "This paragraph is long enough to wrap over a few lines in a narrow " +
      "chat, so that every turn takes up real height in the transcript and " +
      "the history has somewhere to scroll to.",
  ).join("\n\n");
// What an entry should read: each run of k breaks becomes k literal \n, and
// the slash command reads as its command line.
const shown = (p) => p.replace(/\n+/g, (m) => "\\n".repeat(m.length));
const EXPECT = PROMPTS.map((p, i) => (i === 9 ? "/model opus" : shown(p)));

// The stub host: just enough of the init state for the chat to mount (see the
// real-webview-mock notes), one session on disk and its transcript in SDK
// message form (?s=short picks the short one, ?s=empty none at all). The root names the session, so
// the view opens it at boot, and the host reports no plugins, without which
// every row stays hidden as "Waiting for your plugins". Responses go out
// synchronously, or the first render races ahead of get_claude_state.
const page = `<!doctype html><html><head><meta charset="utf-8">
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
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
const R = "${R}", NOW = Date.now();
const WHICH = new URLSearchParams(location.search).get("s");
const PROMPTS = WHICH === "short" ? ${JSON.stringify(SHORT)}
  : WHICH === "empty" ? [] : ${JSON.stringify(PROMPTS)};
const REPLIES = ${JSON.stringify(PROMPTS.map((_, i) => reply(i)))};
const at = (i) => new Date(NOW - (PROMPTS.length - i) * 60e3).toISOString();
const MESSAGES = PROMPTS.flatMap((p, i) => [
  { type: "user", uuid: "u" + i + "-0000-4000-8000-000000000000", session_id: R,
    parent_tool_use_id: null, timestamp: at(i),
    message: { role: "user", content: [{ type: "text", text: p }] } },
  { type: "assistant", uuid: "a" + i + "-0000-4000-8000-000000000000", session_id: R,
    parent_tool_use_id: null, timestamp: at(i),
    message: { id: "msg_" + i, type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text: REPLIES[i] }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } } },
]);
const SESSION = { id: R, summary: "History pane", customTitle: "History pane",
  lastModified: NOW, lastActivity: NOW, archived: false, fileSize: 4096,
  gitBranch: "develop", isCurrentWorkspace: true };
const deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
const MODEL = { value: "default", label: "Default", resolvedModel: "claude-fable-5",
  supportsAutoMode: true, supportsFastMode: false, supportedEffortLevels: [] };
window.acquireVsCodeApi = () => ({
  getState() { return undefined; },
  setState() {},
  postMessage(msg) {
    if (msg && msg.type === "launch_claude") window.__chan = msg.channelId;
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

const BTN = ".ccup-hist-btn";
const PANE = ".ccup-hist-pane";
const INPUT = '[aria-label="Message input"]';

export async function run(ctx) {
  const dir = liveBundleDir();
  const P = loadPatcher();
  const native = readFileSync(join(dir, "index.js"), "utf8");
  const variants = {
    full: P.promptHistWebview(native, true, true),
    alone: P.promptHistWebview(native, false, false),
  };
  const cls = (key) =>
    native.match(new RegExp(`${key}:"(${key}_[-\\w]+)"`))?.[1];
  const SC = `.${cls("messagesContainer")}`;
  const HDR = `.${cls("stickyHeader")}`;
  const WRAP = `.${cls("inputWrapper")}`;
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
      "the patcher builds the line in both slots",
      !!variants.full && !!variants.alone,
    )
  )
    return false;
  let serve = variants.full;

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
  const click = async (p) => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await ctx.cdp("Input.dispatchMouseEvent", {
        type,
        x: p.x,
        y: p.y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
  };
  const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
  const clickSel = async (sel) => click(center(await rect(sel)));
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
  // The headers' natural positions, read the way the jump buttons read them.
  const natural = () =>
    json(
      `(function(){var t=${q(SC)},h=t.querySelectorAll(${JSON.stringify(HDR)}),a=[],i;` +
        `for(i=0;i<h.length;i++){h[i].style.position="static";var y=0,n=h[i];` +
        `while(n&&n!==t){y+=n.offsetTop;n=n.offsetParent}h[i].style.position="";` +
        `a.push(Math.min(y,t.scrollHeight-t.clientHeight))}return a})()`,
    );
  const scrollTop = () => ctx.evaluate(`${q(SC)}.scrollTop`);
  const curEntry = () =>
    ctx.evaluate(
      `(function(){var c=${q(`${PANE} [data-cur]`)};return c?+c.getAttribute("data-i"):-1})()`,
    );
  const isOpen = () => ctx.evaluate(`!!${q(PANE)}&&${q(PANE)}.isConnected`);
  const entryBox = (i) => rect(`${PANE} .ccup-hist-item[data-i="${i}"]`);
  // Scroll entry i to the middle of the list, then click it.
  const clickEntry = async (i) => {
    await ctx.evaluate(
      `(function(){var p=${q(PANE)},it=p.querySelector('.ccup-hist-item[data-i="${i}"]');` +
        `p.scrollTop=it.offsetTop-(p.clientHeight-it.offsetHeight)/2})()`,
    );
    await click(center(await entryBox(i)));
  };
  const boot = async (query = "") => {
    await ctx.navigate(base + query);
    return until(
      `document.querySelectorAll(${JSON.stringify(HDR)}).length>0&&` +
        `!!${q(`${BTN}[data-show]`)}&&` +
        `getComputedStyle(${q(HDR)}).visibility==="visible"`,
    );
  };

  try {
    // Full row: history, up, down, scroll-to-bottom.
    check("full: the transcript and the button mount", !!(await boot()));
    await ctx.sleep(400);
    const row = await json(
      `[${JSON.stringify(BTN)},".ccup-nav-prev",".ccup-nav-next",".ccup-scroll-btn"]` +
        `.map(function(s){var r=document.querySelector(s).getBoundingClientRect();return[r.x,r.y]})`,
    );
    check(
      "full: one 30px slot left of the up button, same row",
      Math.abs(row[1][0] - row[0][0] - 30) < 0.5 &&
        Math.abs(row[1][1] - row[0][1]) < 0.5,
      `x ${row.map((p) => p[0]).join(", ")}`,
    );
    const nHeaders = await ctx.evaluate(
      `document.querySelectorAll(${JSON.stringify(HDR)}).length`,
    );
    check("full: one header per prompt", nHeaders === PROMPTS.length, nHeaders);

    // Open from the composer with a caret mid-text, to check the hand-back.
    await ctx.evaluate(`${q(INPUT)}.focus()`);
    await ctx.insertText("hello world");
    for (let i = 0; i < 5; i++) await key("ArrowLeft", "ArrowLeft", 37);
    const caret0 = await ctx.evaluate(
      `(function(){var s=getSelection();return s.anchorNode&&s.anchorNode.textContent+"|"+s.anchorOffset})()`,
    );
    await clickSel(BTN);
    await ctx.sleep(250);
    check("open: a click opens the list", await isOpen());
    check(
      "open: the button reads expanded",
      (await ctx.evaluate(`${q(BTN)}.getAttribute("aria-expanded")`)) ===
        "true",
    );
    check(
      "open: focus moves to the list itself",
      await ctx.evaluate(`document.activeElement===${q(PANE)}`),
    );
    await ctx.shot("open");

    // Entries: numbers, text, \n markers, two lines each, dividers. nat is
    // the text's own height with the fixed two-line box lifted, which shrinks
    // the list for a moment, so its scroll position is put back afterwards.
    const entries = await json(
      `(function(){var p=${q(PANE)},s0=p.scrollTop,` +
        `r=[...p.querySelectorAll(".ccup-hist-item")].map(function(it){` +
        `var t=it.querySelector(".ccup-hist-txt"),cs=getComputedStyle(t),lh=parseFloat(cs.lineHeight),` +
        `d=getComputedStyle(it,"::before"),num=it.querySelector(".ccup-hist-num");` +
        `t.style.height="auto";var nat=t.getBoundingClientRect().height;t.style.height="";` +
        `return{n:num.textContent,txt:t.textContent,nat:nat,rowH:it.getBoundingClientRect().height,` +
        `numColor:getComputedStyle(num).color,rowColor:getComputedStyle(it).color,` +
        `nl:[...t.querySelectorAll(".ccup-hist-nl")].map(function(e){return e.textContent}),` +
        `nlColor:t.querySelector(".ccup-hist-nl")?getComputedStyle(t.querySelector(".ccup-hist-nl")).color:"",` +
        `color:cs.color,h:t.getBoundingClientRect().height,lh:lh,fs:parseFloat(cs.fontSize),` +
        `clamped:t.scrollHeight>t.clientHeight+1,cur:it.hasAttribute("data-cur"),` +
        `div:{content:d.content,h:d.height,bg:d.backgroundColor,vis:d.visibility}}});` +
        `p.scrollTop=s0;return r})()`,
    );
    check(
      "list: one entry per user message",
      entries.length === PROMPTS.length,
      entries.length,
    );
    check(
      "list: numbered from 1",
      entries.every((e, i) => e.n === String(i + 1)),
      entries.map((e) => e.n).join(","),
    );
    const badText = entries.findIndex((e, i) => e.txt !== EXPECT[i]);
    check(
      "list: each entry reads its prompt, line breaks as \\n",
      badText < 0,
      badText < 0 ? undefined : JSON.stringify(entries[badText].txt),
    );
    check(
      "list: a break run is one muted marker per run",
      JSON.stringify(entries[1].nl) === JSON.stringify(["\\n", "\\n\\n"]) &&
        entries[6].nl.length === 3 &&
        entries[1].nlColor !== entries[1].color,
      `${JSON.stringify(entries[1].nl)} ${entries[1].nlColor} vs ${entries[1].color}`,
    );
    const off = entries.filter((e) => Math.abs(e.h - 2 * e.lh) > 0.5);
    const rows = entries.map((e) => e.rowH);
    check(
      "list: every entry exactly two lines tall, one-liners included",
      off.length === 0 && Math.max(...rows) - Math.min(...rows) < 0.5,
      off.map((e) => `${e.n}:${e.h.toFixed(1)}`).join(" ") ||
        `${entries[0].h}px text, ${rows[0]}px rows`,
    );
    const ones = entries.filter((e) => e.nat < 1.5 * e.lh);
    check(
      "list: a \\n marker leaves its line box at one line height",
      ones.includes(entries[1]) &&
        ones.every((e) => Math.abs(e.nat - e.lh) < 0.5),
      ones.map((e) => `${e.n}:${e.nat.toFixed(2)}`).join(" "),
    );
    check("list: the long prompt is clamped", entries[2].clamped);
    const clay = "rgb(217, 119, 87)";
    const numsOff = entries.filter((e) =>
      e.cur ? e.numColor !== e.rowColor : e.numColor !== clay,
    );
    check(
      "list: numbers in Claude's clay, the current one in its row's color",
      numsOff.length === 0,
      numsOff.map((e) => `${e.n}:${e.numColor}`).join(" ") || clay,
    );
    check(
      "list: entries at line-height 2",
      entries.every((e) => Math.abs(e.lh / e.fs - 2) < 0.01),
      `${entries[0].lh}px on ${entries[0].fs}px`,
    );
    check(
      "list: a 1px divider between entries, none above the first",
      entries[0].div.content === "none" &&
        entries
          .slice(1)
          .every(
            (e) =>
              e.div.content === '""' &&
              e.div.h === "1px" &&
              e.div.bg !== "rgba(0, 0, 0, 0)",
          ),
      `${entries[1].div.h} ${entries[1].div.bg}`,
    );
    const k = entries.findIndex((e) => e.cur);
    check(
      "list: the divider hides beside the current entry only",
      k > 1 &&
        entries[k].div.vis === "hidden" &&
        (k + 1 >= entries.length || entries[k + 1].div.vis === "hidden") &&
        entries
          .filter((_, i) => i > 0 && i !== k && i !== k + 1)
          .every((e) => e.div.vis === "visible"),
      `current ${k + 1}`,
    );

    // Geometry against the input box and the viewport.
    const g = await json(
      `(function(){var p=${q(PANE)},w=${q(WRAP)},f=w.querySelector("fieldset"),pr=p.getBoundingClientRect(),` +
        `wr=w.getBoundingClientRect(),fr=f.getBoundingClientRect();` +
        `return{pr:pr.right,pw:pr.width,pt:pr.top,pb:pr.bottom,fr:fr.right,fw:fr.width,fb:fr.bottom,wt:wr.top,wb:wr.bottom,` +
        `vh:innerHeight,sh:p.scrollHeight,ch:p.clientHeight,st:p.scrollTop}})()`,
    );
    check(
      "geometry: right edge on the input box's",
      Math.abs(g.pr - g.fr) < 0.6,
      `${g.pr} vs ${g.fr}`,
    );
    check(
      "geometry: long prompts widen it to the input box",
      Math.abs(g.pw - g.fw) < 0.6,
      `${g.pw} vs ${g.fw}`,
    );
    check(
      "geometry: list, row and composer within 2/3 of the viewport",
      g.wb - g.pt <= (g.vh * 2) / 3 + 1,
      `${(g.wb - g.pt).toFixed(1)} of ${((g.vh * 2) / 3).toFixed(1)}`,
    );
    check(
      "geometry: it clears the button row by 6px",
      Math.abs(g.wt - 34 - 6 - g.pb) < 0.6,
      `${(g.wt - g.pb).toFixed(1)}px above the wrapper`,
    );
    check(
      "geometry: it scrolls inside itself",
      g.sh > g.ch + 1,
      `${g.sh} > ${g.ch}`,
    );

    // The current entry at the bottom: the last one, though the stuck header
    // is the one before it (the last turn fits on the final screen).
    const nat = await natural();
    const cur = await curEntry();
    check(
      "open: at the bottom the last entry is current",
      cur === PROMPTS.length - 1,
      cur,
    );
    const cb = await entryBox(cur);
    check(
      "open: and it is in view in the list",
      !!cb && cb.y >= g.pt - 0.5 && cb.b <= g.pb + 0.5,
    );

    // Jump: a click lands on the header's natural position, the list stays.
    await clickEntry(2);
    await ctx.sleep(350);
    let st = await scrollTop();
    check(
      "jump: entry 3 lands on its header's natural position",
      Math.abs(st - nat[2]) < 1,
      `${st} vs ${nat[2]}`,
    );
    check("jump: the list stays open", await isOpen());
    await ctx.sleep(100);
    check("jump: the current entry follows", (await curEntry()) === 2);
    await ctx.shot("jumped");
    await clickEntry(1);
    await ctx.sleep(350);
    const viaList = await scrollTop();
    await clickEntry(2);
    await ctx.sleep(350);
    await clickSel(".ccup-nav-prev");
    await ctx.sleep(350);
    const viaUp = await scrollTop();
    check(
      "jump: the list and the up button land on the same scrollTop",
      Math.abs(viaList - viaUp) < 1,
      `${viaList} vs ${viaUp}`,
    );
    check("jump: the up button leaves the list open", await isOpen());
    await ctx.sleep(100);
    check(
      "jump: the current entry follows the up button",
      (await curEntry()) === 1,
    );
    await clickEntry(12);
    await ctx.sleep(350);
    st = await scrollTop();
    const bottom = await ctx.evaluate(
      `${q(SC)}.scrollHeight-${q(SC)}.clientHeight`,
    );
    check(
      "jump: entry 13's jump clamps to the bottom",
      Math.abs(st - bottom) < 1 && nat[12] === nat[13],
      `${st} vs ${bottom}`,
    );
    check(
      "jump: and entry 13, not 14, reads current",
      (await curEntry()) === 12,
      await curEntry(),
    );
    await clickEntry(1);
    await ctx.sleep(450);
    check("jump: back to entry 2 for the key checks", (await curEntry()) === 1);

    // Settle: an open list over an idle transcript writes nothing.
    await ctx.evaluate(
      `window.__mut=0;window.__mo=new MutationObserver(function(r){window.__mut+=r.length});` +
        `window.__mo.observe(document.body,{subtree:!0,childList:!0,attributes:!0,characterData:!0})`,
    );
    await ctx.sleep(600);
    const muts = await ctx.evaluate(`window.__mo.disconnect(),window.__mut`);
    check("settle: no mutations while open and idle", muts === 0, muts);

    // Keys: Down from the list lands on the current entry, Down again moves
    // on, Enter jumps, Escape closes and gives the caret back.
    await key("ArrowDown", "ArrowDown", 40);
    await key("ArrowDown", "ArrowDown", 40);
    const focused = await ctx.evaluate(
      `document.activeElement&&document.activeElement.getAttribute("data-i")`,
    );
    check(
      "keys: Down twice focuses the entry after the current",
      focused === "2",
      focused,
    );
    await key("Enter", "Enter", 13);
    await ctx.sleep(350);
    st = await scrollTop();
    check(
      "keys: Enter jumps to it",
      Math.abs(st - nat[2]) < 1,
      `${st} vs ${nat[2]}`,
    );
    await key("Escape", "Escape", 27);
    await ctx.sleep(100);
    check("keys: Escape closes", !(await isOpen()));
    check(
      "keys: the button reads collapsed",
      (await ctx.evaluate(`${q(BTN)}.getAttribute("aria-expanded")`)) ===
        "false",
    );
    const back = await ctx.evaluate(
      `(function(){var s=getSelection();return (document.activeElement===${q(INPUT)})+" "+(s.anchorNode&&s.anchorNode.textContent+"|"+s.anchorOffset)})()`,
    );
    check(
      "keys: focus is back in the input box, caret unmoved",
      back === `true ${caret0}`,
      `${back} vs ${caret0}`,
    );
    const st1 = await scrollTop();
    check(
      "keys: Escape left the transcript where it was",
      Math.abs(st1 - nat[2]) < 1,
    );

    // Close: a click on the transcript closes it, and so does the button.
    await clickSel(BTN);
    await ctx.sleep(200);
    check("close: reopened", await isOpen());
    const sc = await rect(SC);
    await click({ x: sc.x + sc.w / 2, y: sc.y + 80 });
    await ctx.sleep(150);
    check("close: a click on the transcript closes it", !(await isOpen()));
    await clickSel(BTN);
    await ctx.sleep(200);
    await clickSel(BTN);
    await ctx.sleep(150);
    check("close: the button toggles it shut", !(await isOpen()));

    // Hide: hover an entry, click its button, and read the folds back.
    const moveTo = (p) =>
      ctx.cdp("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: p.x,
        y: p.y,
      });
    const hideBtn = (i) =>
      `${PANE} .ccup-hist-item[data-i="${i}"] .ccup-hist-hide`;
    // Hovers entry i and reads its hide button: visibility, box and icon
    // size, the line it sits on, its air to the row's left and bottom edges
    // and to the text, and how far the number's digits end from the text.
    const hoverHide = async (i) => {
      await ctx.evaluate(
        `(function(){var p=${q(PANE)},it=p.querySelector('.ccup-hist-item[data-i="${i}"]');` +
          `p.scrollTop=it.offsetTop-(p.clientHeight-it.offsetHeight)/2})()`,
      );
      await moveTo(center(await entryBox(i)));
      await ctx.sleep(60);
      return json(
        `(function(){var b=${q(hideBtn(i))},r=b.getBoundingClientRect(),s=b.querySelector("svg").getBoundingClientRect(),` +
          `it=b.closest(".ccup-hist-item"),n=it.querySelector(".ccup-hist-num"),nr=n.getBoundingClientRect(),` +
          `t=it.querySelector(".ccup-hist-txt").getBoundingClientRect(),w=it.getBoundingClientRect(),` +
          `p=${q(PANE)}.getBoundingClientRect(),g=document.createRange();g.selectNodeContents(n);var d=g.getBoundingClientRect();` +
          `return{vis:getComputedStyle(b).visibility,w:r.width,h:r.height,lh:parseFloat(getComputedStyle(b).lineHeight),` +
          `fs:parseFloat(getComputedStyle(b).fontSize),iw:s.width,ih:s.height,line2:r.top-t.top,` +
          `under:r.top>=nr.bottom-0.5,beforeText:r.right<=t.left+0.5,` +
          `inRow:r.bottom<=w.bottom+0.5,fromRight:Math.round(p.right-r.right),` +
          `left:+(r.left-w.left).toFixed(2),bottom:+(w.bottom-r.bottom).toFixed(2),toText:+(t.left-r.right).toFixed(2),` +
          `numToText:+(t.left-d.right).toFixed(2),textX:+(t.left-w.left).toFixed(2)}})()`,
      );
    };
    // The square keeps the 2px it has below it (the row's padding) to the
    // row's left edge and to the text too, while the number's digits keep
    // the row's full 8px gap to the text.
    const airOk = (b) =>
      b.under &&
      b.beforeText &&
      b.inRow &&
      b.fromRight > 100 &&
      Math.abs(b.bottom - 2) < 0.6 &&
      Math.abs(b.left - b.bottom) < 0.6 &&
      Math.abs(b.toText - b.bottom) < 0.6 &&
      Math.abs(b.numToText - 8) < 0.6;
    // The icon is 1.25em of the list's text, whatever its size.
    const iconOk = (b) =>
      Math.abs(b.iw - 1.25 * b.fs) < 0.05 &&
      Math.abs(b.ih - 1.25 * b.fs) < 0.05;
    // Hovers entry i, optionally shoots its hide button hovered, then clicks it.
    const hideVia = async (i, shot) => {
      const b = await hoverHide(i);
      if (shot) {
        await moveTo(center(await rect(hideBtn(i))));
        await ctx.sleep(60);
        await ctx.shot(shot);
      }
      await click(center(await rect(hideBtn(i))));
      await ctx.sleep(100);
      return b;
    };
    const folds = () =>
      json(
        `[...document.querySelectorAll("${PANE} .ccup-hist-fold")].map(function(g){` +
          `return{a:+g.getAttribute("data-a"),b:+g.getAttribute("data-b"),` +
          `n:g.querySelector(".ccup-hist-fold-n").textContent,` +
          `r:g.querySelector(".ccup-hist-fold-r").textContent,cur:g.hasAttribute("data-cur")}})`,
      );
    const stored = () =>
      json(
        `(function(){try{return JSON.parse(localStorage.getItem("ccup-prompt-history-hidden")||"{}")}catch(e){return null}})()`,
      );
    const has = (i) =>
      ctx.evaluate(`!!${q(`${PANE} .ccup-hist-item[data-i="${i}"]`)}`);

    await clickSel(BTN);
    await ctx.sleep(200);
    const stH = await scrollTop();
    const hv = await hideVia(3, "hide-hover");
    check(
      "hide: a one-line square button with a 1.25em icon shows on hover, on the second line",
      hv.vis === "visible" &&
        Math.abs(hv.w - hv.lh) < 0.5 &&
        Math.abs(hv.h - hv.lh) < 0.5 &&
        iconOk(hv) &&
        Math.abs(hv.line2 - hv.lh) < 0.6,
      JSON.stringify(hv),
    );
    check(
      "hide: under the number, 2px from the row's left edge and the text as from its bottom, the number 8px from the text, clear of the scrollbar edge",
      airOk(hv),
      JSON.stringify(hv),
    );
    let fs = await folds();
    check(
      "hide: entry 4 folds into one row",
      fs.length === 1 &&
        fs[0].a === 3 &&
        fs[0].b === 3 &&
        fs[0].n === "1 hidden" &&
        fs[0].r === "4" &&
        !(await has(3)),
      JSON.stringify(fs),
    );
    check(
      "hide: the click neither jumps nor closes",
      Math.abs((await scrollTop()) - stH) < 1 && (await isOpen()),
    );
    await hideVia(4);
    fs = await folds();
    check(
      "hide: a neighbor joins the same fold",
      fs.length === 1 &&
        fs[0].a === 3 &&
        fs[0].b === 4 &&
        fs[0].n === "2 hidden" &&
        fs[0].r === "4–5",
      JSON.stringify(fs),
    );
    // A fold is a row like an entry: a divider above it and one below.
    const fd = await json(
      `(function(){var g=${q(`${PANE} .ccup-hist-fold`)},n=g.nextElementSibling,` +
        `a=getComputedStyle(g,"::before"),b=n?getComputedStyle(n,"::before"):null;` +
        `return{above:a.content+" "+a.height,below:b?b.content+" "+b.height:"none"}})()`,
    );
    check(
      "hide: the fold has a divider above and below, like an entry",
      fd.above === '"" 1px' && fd.below === '"" 1px',
      JSON.stringify(fd),
    );
    // The fold keeps the entries' columns: its chevron, .9em of the text, ends
    // where the next entry's number does, and its label starts where that
    // entry's text does.
    const fa = await json(
      `(function(){var g=${q(`${PANE} .ccup-hist-fold`)},e=g.nextElementSibling,r=document.createRange();` +
        `r.selectNodeContents(e.querySelector(".ccup-hist-num"));` +
        `var c=g.querySelector(".ccup-hist-num svg").getBoundingClientRect(),n=r.getBoundingClientRect(),` +
        `l=g.querySelector(".ccup-hist-fold-n").getBoundingClientRect(),t=e.querySelector(".ccup-hist-txt").getBoundingClientRect();` +
        `return{chevron:+(c.right-n.right).toFixed(2),label:+(l.left-t.left).toFixed(2),` +
        `size:+(c.width/parseFloat(getComputedStyle(g).fontSize)).toFixed(3)}})()`,
    );
    check(
      "hide: the fold's .9em chevron ends with the numbers, its label starts with the text",
      Math.abs(fa.chevron) < 0.6 &&
        Math.abs(fa.label) < 0.6 &&
        Math.abs(fa.size - 0.9) < 0.005,
      JSON.stringify(fa),
    );
    const nums = await json(
      `[...document.querySelectorAll("${PANE} .ccup-hist-item .ccup-hist-num")]` +
        `.map(function(e){return e.textContent}).join(",")`,
    );
    check(
      "hide: the other entries keep their numbers",
      nums === "1,2,3,6,7,8,9,10,11,12,13,14",
      nums,
    );
    const sid = await ctx.evaluate(
      `new URLSearchParams(location.search).get("session")||""`,
    );
    let sto = await stored();
    check(
      "hide: stored under the conversation's id",
      sid === R && !!sto && !!sto[R] && sto[R].k.length === 2,
      `session=${sid} ${JSON.stringify(sto)}`,
    );
    await ctx.shot("hidden");

    // The fold survives a reload, and a click on it brings the run back.
    check("hide: remounts", !!(await boot()));
    await ctx.sleep(300);
    await clickSel(BTN);
    await ctx.sleep(250);
    fs = await folds();
    check(
      "hide: the fold survives a reload",
      fs.length === 1 && fs[0].a === 3 && fs[0].b === 4,
      JSON.stringify(fs),
    );
    await ctx.evaluate(
      `(function(){var p=${q(PANE)},g=p.querySelector(".ccup-hist-fold");` +
        `p.scrollTop=g.offsetTop-(p.clientHeight-g.offsetHeight)/2})()`,
    );
    await ctx.shot("fold");
    const stF = await scrollTop();
    await clickSel(`${PANE} .ccup-hist-fold`);
    await ctx.sleep(100);
    check(
      "hide: clicking the fold brings both back, with no jump",
      (await folds()).length === 0 &&
        (await has(3)) &&
        (await has(4)) &&
        Math.abs((await scrollTop()) - stF) < 1,
    );
    sto = await stored();
    check(
      "hide: and clears the conversation's marks",
      !!sto && !sto[R],
      JSON.stringify(sto),
    );

    // Keyboard: Delete hides the focused entry and leaves focus on its fold,
    // Enter there restores it. The current entry's fold takes the highlight.
    await ctx.evaluate(`${q(PANE)}.focus()`);
    await key("Home", "Home", 36);
    await key("Delete", "Delete", 46);
    await ctx.sleep(80);
    const kf = await json(
      `(function(){var a=document.activeElement;` +
        `return{fold:!!a&&a.classList.contains("ccup-hist-fold"),a:a&&a.getAttribute("data-a")}})()`,
    );
    check(
      "hide: Delete hides the focused entry, focus on its fold",
      kf.fold && kf.a === "0",
      JSON.stringify(kf),
    );
    await key("Enter", "Enter", 13);
    await ctx.sleep(80);
    const ke = await ctx.evaluate(
      `document.activeElement&&document.activeElement.getAttribute("data-i")`,
    );
    check(
      "hide: Enter on the fold restores it, focus on the entry",
      ke === "0" && (await folds()).length === 0,
      ke,
    );
    await key("End", "End", 35);
    await key("Delete", "Delete", 46);
    await ctx.sleep(80);
    fs = await folds();
    check(
      "hide: a hidden current entry hands the highlight to its fold",
      fs.length === 1 && fs[0].a === PROMPTS.length - 1 && fs[0].cur,
      JSON.stringify(fs),
    );
    await key("Enter", "Enter", 13);
    await ctx.sleep(80);
    check(
      "hide: and comes back current",
      (await curEntry()) === PROMPTS.length - 1,
    );
    // At a larger chat font (15.25px) the square grows with the line and its
    // icon with the text, and the air stays the same.
    await ctx.evaluate(
      `document.documentElement.style.setProperty("--vscode-chat-font-size","15.25px")`,
    );
    await ctx.sleep(60);
    const hl = await hoverHide(5);
    await ctx.evaluate(
      `document.documentElement.style.removeProperty("--vscode-chat-font-size")`,
    );
    check(
      "hide: at a 15.25px chat font the square grows to the 30.5px line, its icon to 1.25em, same air",
      hl.vis === "visible" &&
        Math.abs(hl.lh - 30.5) < 0.1 &&
        Math.abs(hl.w - hl.lh) < 0.5 &&
        Math.abs(hl.h - hl.lh) < 0.5 &&
        iconOk(hl) &&
        airOk(hl),
      JSON.stringify(hl),
    );
    await ctx.evaluate(`localStorage.removeItem("ccup-prompt-history-hidden")`);
    await key("Escape", "Escape", 27);
    await ctx.sleep(100);

    // Popup: a permission request replaces the composer under an open list.
    await clickSel(BTN);
    await ctx.sleep(200);
    check("popup: list open on the composer", await isOpen());
    await ctx.evaluate(
      `deliver({type:"request",channelId:window.__chan,requestId:"perm1",` +
        `request:{type:"tool_permission_request",toolName:"Bash",` +
        `inputs:{command:"ls -la",description:"List files"},suggestions:[],toolUseId:"toolu_1"}})`,
    );
    const hostBtn = await until(
      `!!document.querySelector(".ccup-btn-host ${BTN}[data-show]")`,
    );
    check("popup: the button rides the popup's wrapper", !!hostBtn);
    check("popup: the composer's list closed with its host", !(await isOpen()));
    await clickSel(`.ccup-btn-host ${BTN}`);
    await ctx.sleep(250);
    const pp = await json(
      `(function(){var p=${q(PANE)},h=document.querySelector(".ccup-btn-host");if(!p||!h)return null;` +
        `var pr=p.getBoundingClientRect(),hr=h.getBoundingClientRect();` +
        `return{inHost:h.contains(p),pr:pr.right,hr:hr.right,gap:hr.top-pr.bottom,n:p.children.length,top:pr.top,hb:hr.bottom,vh:innerHeight}})()`,
    );
    check(
      "popup: the list opens on the popup's wrapper, right-aligned, above the row",
      !!pp &&
        pp.inHost &&
        Math.abs(pp.pr - pp.hr) < 0.6 &&
        Math.abs(pp.gap - 40) < 0.6,
      pp && `right ${pp.pr} vs ${pp.hr}, gap ${pp.gap}`,
    );
    check(
      "popup: with every entry",
      !!pp && pp.n === PROMPTS.length,
      pp && pp.n,
    );
    await ctx.shot("popup");
    await key("Escape", "Escape", 27);
    await ctx.sleep(100);
    check("popup: Escape closes it", !(await isOpen()));

    // Short prompts: the width floor, right-aligned.
    check("short: the short session mounts", !!(await boot("?s=short")));
    await ctx.sleep(300);
    await clickSel(BTN);
    await ctx.sleep(250);
    const s = await json(
      `(function(){var p=${q(PANE)}.getBoundingClientRect(),f=${q(WRAP)}.querySelector("fieldset").getBoundingClientRect();` +
        `return{pw:p.width,pr:p.right,fw:f.width,fr:f.right,n:document.querySelectorAll("${PANE} .ccup-hist-item").length}})()`,
    );
    check("short: five entries", s.n === SHORT.length, s.n);
    check(
      "short: the list keeps its 260px floor, right-aligned",
      Math.abs(s.pw - 260) < 0.6 && Math.abs(s.pr - s.fr) < 0.6,
      `${s.pw} wide, right ${s.pr} vs ${s.fr}`,
    );
    await ctx.shot("short");

    // Narrow panel: an input box under 260px caps the floor.
    await ctx.cdp("Emulation.setDeviceMetricsOverride", {
      width: 250,
      height: 620,
      deviceScaleFactor: 2,
      mobile: false,
    });
    check("narrow: remounts at 250px", !!(await boot()));
    await ctx.sleep(300);
    await clickSel(BTN);
    await ctx.sleep(250);
    const n = await json(
      `(function(){var p=${q(PANE)}.getBoundingClientRect(),f=${q(WRAP)}.querySelector("fieldset").getBoundingClientRect();` +
        `return{pw:p.width,pr:p.right,pl:p.left,fw:f.width,fr:f.right,fl:f.left}})()`,
    );
    check(
      "narrow: the list never outgrows the input box",
      n.fw < 260 && Math.abs(n.pw - n.fw) < 0.6 && Math.abs(n.pl - n.fl) < 0.6,
      `${n.pw} vs ${n.fw}`,
    );
    await ctx.shot("narrow");
    await ctx.cdp("Emulation.setDeviceMetricsOverride", {
      ...ctx.viewport,
      deviceScaleFactor: 2,
      mobile: false,
    });

    // Alone: with the jump and scroll lines out, the corner slot.
    serve = variants.alone;
    check("alone: mounts", !!(await boot()));
    await ctx.sleep(300);
    const a = await json(
      `(function(){var b=${q(BTN)}.getBoundingClientRect(),w=${q(WRAP)}.getBoundingClientRect();` +
        `return{gap:w.right-b.right,others:document.querySelectorAll(".ccup-nav-btn,.ccup-scroll-btn").length}})()`,
    );
    check(
      "alone: 5px in from the right edge, no other buttons",
      Math.abs(a.gap - 5) < 0.6 && a.others === 0,
      `${a.gap}px, ${a.others} others`,
    );
    // Empty: nothing to list, so the button dims and a click opens nothing.
    serve = variants.full;
    await ctx.navigate(base + "?s=empty");
    const dimmed = await until(`!!${q(`${BTN}[data-show][data-off]`)}`);
    check("empty: the button dims", !!dimmed);
    if (dimmed) {
      await clickSel(BTN);
      await ctx.sleep(200);
      check("empty: a click opens nothing", !(await isOpen()));
    }
    const err = await ctx.evaluate(
      `document.getElementById("claude-error").textContent`,
    );
    check("the app reported no error", !err, err.slice(0, 200));
  } finally {
    server.close();
  }
  return ok;
}
