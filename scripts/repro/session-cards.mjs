// Scenario for scripts/cdp-driver.mjs: the session cards, on the REAL webview
// bundle booted as the sidebar against a stub host that lists six local
// sessions (plus an archived and a Web one) and runs a turn for every prompt
// sent until the scenario ends it. Real clicks and keys drive it, and the
// checks assert:
//   mount     the strip is the session body's last child, across the view's
//             whole width on its bottom edge, the input box 8px above it,
//             its cards an editor tab (24px) tall in its 13px text over a 1px
//             groove, the New session button square at its left end and the
//             hide button at its right, the cards scrolling between them
//   order     cards run from the session of your last message: the booted
//             one by its newest prompt (not by the later activity the list
//             reports for it), the others by the list's activity time, no
//             Web session, and a prompt you send moves its session first
//   active    the session on screen is marked, never shows pending, and its
//             text takes the input box's color
//   buttons   both sit on the chat's own background, the card on screen's,
//             groove included, a gap of the strip's color between each and
//             the cards, the ghost hover under the pointer, each with its own
//             tip; New session presses the header's own button (by click or
//             key, once each) and wears its icon, or with no header creates
//             the session itself; the hide button asks the host to hide the
//             secondary side bar, a host without that request gets the reload
//             notice, and its arrow points to the bar's edge of the window,
//             either side
//   pending   the host's feed: awaiting input in a tab, and Claude Code's
//             unread mark, each mark the card, its reason in the label read
//             out to assistive tech
//   tip       the hover tip is the full title alone, where the card cuts it
//   circle    each card leads with a circle in the card's color, clay for a
//             session waiting on you, filled while its prompt cache is warm
//             and a ring once cold
//   warm      the session on screen reads its own record, as the footer
//             clock does, a held one its live record, the rest their newest
//             message at that record's TTL, and a card empties on its own at
//             the expiry
//   seamless  the card on screen is the chat's own background, joined to
//             the chat above with no edge, its bottom corners rounded and the
//             strip curving into it at the top, on the screen's pixels, a
//             button it meets drawing the curve the scroller cuts off
//   click     a session open in an editor tab asks the host to focus that
//             tab, any other opens here, the strip staying the same element
//             and the input box staying put
//   held      a turn that ends in a session this view holds while another
//             is on screen gives it a dot until you open it, and so does a
//             permission request arriving there
//   keys      the strip is one tab stop, arrows move between its buttons
//             and cards (Home and End reaching the buttons), and Enter opens
//             a card
//   press     a press keeps focus where it was
//   relist    a session the feed reports that the list has not read asks
//             for one re-read, and its card then shows
//   reload    the time of a sent prompt survives a reload
//   shares    at rest only whole cards show, one more for every 300px of the
//             space between the buttons, each an equal share of it, the next
//             card starting at the edge, at every width from 900px to 250px
//   titles    each label carries its whole title, the browser cutting a long
//             one with an ellipsis
//   scroll    the strip holds every non-archived session, scrolls sideways
//             under the wheel, and brings the card on screen into view when
//             it changes
//   settle    an idle strip mutates nothing
//   look      the strip follows VS Code's layout density: at the default
//             density no groove, the cards on the view's bottom edge, no
//             line, and the strip's ends 8px in so its corners stay square
//             under the rounded clip VS Code puts on the webview there
//             (emulated), and when compact the 1px groove and the blue line
//             along the bottom of the card on screen (both built here, as
//             the patcher would from window.density.layout); a compact tab
//             height makes the cards and buttons 20px tall; the first card
//             keeps its rounded corner beside the New session button
//   editor    an editor tab (IS_SIDEBAR false) gets no strip
//   empty     with no session to show the strip stays hidden and the input
//             box keeps its native 16px
//
//   node scripts/cdp-driver.mjs scripts/repro/session-cards.mjs 420 700
//
// The bundle served is the compiled patcher's own output for the live install
// (sessionCardsWebview, out/, so compile first), so the scenario runs exactly
// what an apply writes and doubles as the drift canary. The live bundle is
// found under ~/.vscode/extensions (newest Claude Code install) or via
// $CCUP_BUNDLE (the webview directory).
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
// A boots the view; its last prompt is two and a half hours old though the
// list reports activity ten minutes ago. B and E have titles past the
// 40-character cap. G is a session no list read has seen yet, Z an archived
// one, W a Web session.
const S = {
  A: id("1"),
  B: id("2"),
  C: id("3"),
  D: id("4"),
  E: id("5"),
  F: id("6"),
  G: id("7"),
  Z: id("8"),
  W: id("9"),
};
const TITLES = {
  A: "Cards below the composer",
  B: "Fix the regex toggle in the find bar and its whole word rule",
  C: "Bookmark notes",
  D: "KaTeX bump",
  E: "Anchor audit for the 2.1.312 release with a bisect table",
  F: "Release notes",
  G: "Started in a tab",
  Z: "An archived session",
  W: "A Web session",
};
// Minutes ago: the list's activity time, and each transcript's last prompt.
const ACTIVITY = { A: 10, B: 30, C: 120, D: 180, E: 240, F: 360, G: 1, Z: 5 };
const PROMPT = { A: 150, B: 70, C: 130, D: 190, E: 250, F: 370, G: 2, Z: 6 };

const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:"SF Mono",monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-chat-font-family:system-ui;
--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#cccccc;
--vscode-descriptionForeground:#9d9d9d;--vscode-sideBar-background:#181818;
--vscode-editor-background:#1f1f1f;--vscode-input-background:#313131;--vscode-input-border:#3c3c3c;
--vscode-input-foreground:#cccccc;--vscode-focusBorder:#0078d4;
--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;
--vscode-list-hoverBackground:#2a2d2e;--vscode-widget-border:#313131;--vscode-menu-background:#1f1f1f;
--vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-icon-foreground:#cccccc;
--vscode-tab-activeBackground:#1f1f1f;--vscode-tab-inactiveBackground:#181818;
--vscode-tab-activeForeground:#ffffff;--vscode-tab-inactiveForeground:#9d9d9d;
--vscode-tab-border:#2b2b2b;--vscode-tab-activeBorderTop:#0078d4;--vscode-tab-hoverBackground:#1f1f1f;
--vscode-modernEditorTab-activeBackground:#37373d;--vscode-modernEditorTab-activeForeground:#cccccc;
--vscode-modernEditorTab-hoverBackground:#2a2d2e;--vscode-editorGroupHeader-connectedTabsBackground:#2b2b2b;
color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}'></div>
<script>
const Q = new URLSearchParams(location.search);
window.IS_SIDEBAR = Q.get("editor") !== "1"; window.IS_FULL_EDITOR = Q.get("editor") === "1";
window.IS_SESSION_LIST_ONLY = false;
const S = ${JSON.stringify(S)}, TITLES = ${JSON.stringify(TITLES)};
const ACTIVITY = ${JSON.stringify(ACTIVITY)}, PROMPT = ${JSON.stringify(PROMPT)};
const EMPTY = Q.get("s") === "none", NOW = Date.now(), ago = (m) => NOW - m * 60e3;
if (!EMPTY) document.getElementById("root").dataset.initialSession = S.A;
const KEY = Object.fromEntries(Object.entries(S).map(([k, v]) => [v, k]));
const entry = (k) => ({ id: S[k], summary: TITLES[k], customTitle: TITLES[k],
  lastModified: ago(ACTIVITY[k]), lastActivity: ago(ACTIVITY[k]), archived: k === "Z",
  fileSize: 4096, gitBranch: "develop", isCurrentWorkspace: true });
window.__listed = ["A", "B", "C", "D", "E", "F", "Z"];
// A reply's usage: it read the conversation's cache and wrote to it, at
// the one-hour TTL.
const CACHED = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 100,
  cache_creation_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 0 } };
const msgs = (sid) => { const k = KEY[sid]; if (!k) return []; return [
  { type: "user", uuid: "a" + sid.slice(1), session_id: sid, parent_tool_use_id: null,
    timestamp: new Date(ago(PROMPT[k])).toISOString(), origin: { kind: "human" },
    message: { role: "user", content: [{ type: "text", text: "A prompt in " + TITLES[k] }] } },
  { type: "assistant", uuid: "b" + sid.slice(1), session_id: sid, parent_tool_use_id: null,
    timestamp: new Date(ago(ACTIVITY[k])).toISOString(),
    message: { id: "msg_" + k, type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text: "A reply in " + TITLES[k] + "." }], stop_reason: "end_turn",
      usage: CACHED } } ]; };
const deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
window.__push = (request) =>
  deliver({ type: "request", channelId: "", requestId: "p" + Math.random(), request });
const io = (channelId, message) => deliver({ type: "io_message", channelId, message, done: false });
// What the page posted, each session's channel, each running turn, and the
// requests the host answers as unknown.
window.__sent = []; window.__chan = {}; window.__lives = {}; window.__unknown = [];
const LIVE = "Working on it.";
const live = (msg) => {
  const ch = msg.channelId, m = msg.message, sid = Object.keys(window.__chan).find((s) => window.__chan[s] === ch);
  window.__lives[ch] = { sid, uuid: m.uuid };
  setTimeout(() => {
    io(ch, { type: "system", subtype: "init", session_id: sid, model: "claude-fable-5",
      permissionMode: "default", tools: [], mcp_servers: [], slash_commands: [], uuid: "i" + m.uuid.slice(1) });
    io(ch, { ...m, session_id: sid, isReplay: true });
    io(ch, { type: "stream_event", session_id: sid, parent_tool_use_id: null, uuid: "e" + m.uuid.slice(1),
      event: { type: "message_start", message: { id: "msg_live", type: "message", role: "assistant",
        model: "claude-fable-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } } });
  }, 30);
};
// The turn a prompt started ends, as the CLI ends one.
window.__finish = (sid) => {
  const ch = window.__chan[sid], L = window.__lives[ch];
  if (!L) return false;
  delete window.__lives[ch];
  io(ch, { type: "assistant", uuid: "c" + L.uuid.slice(1), session_id: sid, parent_tool_use_id: null,
    message: { id: "msg_live", type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text: LIVE }], stop_reason: "end_turn", usage: CACHED } });
  io(ch, { type: "result", subtype: "success", is_error: false, duration_ms: 10, duration_api_ms: 10,
    num_turns: 1, result: LIVE, session_id: sid, total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 }, uuid: "d" + L.uuid.slice(1) });
  return true;
};
window.__permit = (sid) => deliver({ type: "request", channelId: window.__chan[sid], requestId: "q" + Math.random(),
  request: { type: "tool_permission_request", toolName: "Bash", inputs: { command: "ls", description: "List" },
    suggestions: [], toolUseId: "toolu_" + Math.random().toString(36).slice(2) } });
const MODEL = { value: "default", label: "Default", resolvedModel: "claude-fable-5",
  supportsAutoMode: true, supportsFastMode: false, supportedEffortLevels: [] };
window.acquireVsCodeApi = () => ({
  getState() { return undefined; },
  setState() {},
  postMessage(msg) {
    if (msg && msg.type === "launch_claude" && msg.resume) window.__chan[msg.resume] = msg.channelId;
    if (msg && msg.type !== "request") window.__sent.push({ type: msg.type, channelId: msg.channelId, resume: msg.resume });
    if (msg && msg.type === "io_message" && msg.message && msg.message.type === "user") live(msg);
    if (!msg || msg.type !== "request") return;
    const r = msg.request;
    window.__sent.push({ type: "request:" + r.type, sessionId: r.sessionId, entryPoint: r.entryPoint,
      message: r.message });
    let resp = {};
    // A request a host still running its pre-patch code would not know.
    if (window.__unknown.includes(r.type)) resp = { type: "error", error: "Unknown request type." };
    else switch (r.type) {
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
        resp = { type: "list_sessions_response",
          sessions: EMPTY ? [] : window.__listed.map(entry), folderKey: "k" };
        break;
      case "list_remote_sessions":
        resp = { type: "list_remote_sessions_response", sessions: [{ id: S.W, summary: TITLES.W,
          lastModified: NOW, status: "idle" }] };
        break;
      case "get_session_groups":
        resp = { type: "get_session_groups_response", groups: [] };
        break;
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

const BAR = ".ccup-cards";
const LIST = ".ccup-cards-scroll";
const CARD = ".ccup-card";
const NEW = ".ccup-cards-new";
const HIDE = ".ccup-cards-hide";
// The header's own New session button.
const HEAD_NEW = 'button[aria-label="New session"]:not(.ccup-cards-btn)';
const INPUT = '[aria-label="Message input"]';
const HIDE_TIP = "Hide Secondary Side Bar";
const RELOAD = "Reload the window to start using the side bar hide button.";

export async function run(ctx) {
  const dir = liveBundleDir();
  const P = loadPatcher();
  const native = readFileSync(join(dir, "index.js"), "utf8");
  // Both looks, as the patcher builds them for each layout density, and the
  // hide button for a secondary side bar on the left; the stub server hands
  // out the one /__look/<name> last picked.
  const serve = {
    line: P.sessionCardsWebview(native, "line"),
    seamless: P.sessionCardsWebview(native, "seamless"),
    line20: P.sessionCardsWebview(native, "line", 20),
    lineLeft: P.sessionCardsWebview(native, "line", 24, "left"),
  };
  let look = "line";
  const cls = (key) =>
    native.match(new RegExp(`${key}:"(${key}_[-\\w]+)"`))?.[1];
  const BODY = `.${cls("sessionBody")}`;
  const chat = cls("messagesContainer")?.slice("messagesContainer_".length);
  const BOX = `.inputContainer_${chat}`;
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
      "the patcher builds the strip into this bundle for every look and side",
      Object.values(serve).every(Boolean),
    )
  )
    return false;

  const server = createServer((req, res) => {
    const rel = req.url.split("?")[0];
    if (rel.startsWith("/__look/")) {
      look = rel.slice("/__look/".length);
      res.writeHead(204).end();
    } else if (rel === "/wv/index.js") {
      res
        .writeHead(200, {
          "content-type": TYPES[".js"],
          "cache-control": "no-store",
        })
        .end(serve[look]);
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

  const until = async (expr, ms = 8000) => {
    for (let t = 0; t < ms; t += 50) {
      const v = await ctx.evaluate(expr);
      if (v) return v;
      await ctx.sleep(50);
    }
    return null;
  };
  const json = async (expr) =>
    JSON.parse(await ctx.evaluate(`JSON.stringify(${expr})`));
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const box = (expr) =>
    json(
      `(function(){var e=${expr};if(!e)return null;var r=e.getBoundingClientRect();` +
        `return{x:r.x,y:r.y,w:r.width,h:r.height,r:r.right,b:r.bottom}})()`,
    );
  const cardEl = (k) => `${q(`${CARD}[data-id="${S[k]}"]`)}`;
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
  // A card into the strip's view, as you would scroll to it, then a click.
  const showCard = (k) =>
    ctx.evaluate(
      `(function(){var b=${q(LIST)},e=${cardEl(k)};if(!b||!e)return;var a=e.offsetLeft-8,z=e.offsetLeft+e.offsetWidth+8;` +
        `if(a<b.scrollLeft)b.scrollLeft=Math.max(0,a);else if(z>b.scrollLeft+b.clientWidth)b.scrollLeft=z-b.clientWidth})()`,
    );
  const clickCard = async (k) => {
    await showCard(k);
    await ctx.sleep(50);
    await click(center(await box(cardEl(k))));
  };
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
  // The cards as shown: session letter, then * for the one on screen and !
  // for one whose circle shows it waiting.
  const LETTER = Object.fromEntries(Object.entries(S).map(([k, v]) => [v, k]));
  const strip = async () =>
    (
      await json(
        `[].map.call(document.querySelectorAll(${JSON.stringify(CARD)}),function(b){` +
          `return[b.dataset.id,b.hasAttribute("data-active"),b.hasAttribute("data-pending")&&getComputedStyle(b.firstChild).borderTopColor==="rgb(217, 119, 87)"]})`,
      )
    )
      .map(([i, a, p]) => `${LETTER[i] ?? "?"}${a ? "*" : ""}${p ? "!" : ""}`)
      .join(" ");
  // Each card's letter, + while its circle is filled (a warm prompt cache),
  // - while it is a ring.
  const warmth = async () =>
    (
      await json(
        `[].map.call(document.querySelectorAll(${JSON.stringify(CARD)}),function(b){` +
          `return[b.dataset.id,getComputedStyle(b.firstChild).backgroundColor!=="rgba(0, 0, 0, 0)"]})`,
      )
    )
      .map(([i, w]) => `${LETTER[i] ?? "?"}${w ? "+" : "-"}`)
      .join(" ");
  const shownTitle = () => ctx.evaluate(`${q(TITLE)}?.textContent ?? null`);
  const sent = () => json("window.__sent");
  const send = async (text) => {
    await ctx.evaluate(`${q(INPUT)}.focus()`);
    await ctx.insertText(text);
    await key("Enter", "Enter", 13);
  };
  const boot = async (query = "") => {
    await ctx.navigate(base + query);
    return until(
      `!!${q(INPUT)}&&!!window.__ccupSessionCards&&document.querySelectorAll(${JSON.stringify(CARD)}).length>=4`,
    );
  };
  // The cards' scroller as laid out: its width, whether it scrolls, the label
  // font and the card chrome around a label (padding, circle, gap), and each
  // card's width, whole title and label text.
  const layout = () =>
    json(
      `(function(){var b=${q(LIST)},cs=[].slice.call(b.querySelectorAll(${JSON.stringify(CARD)})),` +
        `W=b.getBoundingClientRect().width;` +
        `var byId={};window.__ccupSessionCards.rows.forEach(function(r){byId[r.id]=r.title});` +
        `var l0=cs[0].lastChild,s=getComputedStyle(l0);` +
        `var br=b.getBoundingClientRect();` +
        `return{W:W,vis:W,sl:b.scrollLeft,scroll:b.scrollWidth>b.clientWidth+1,size:s.fontSize,` +
        `font:s.fontStyle+" "+s.fontWeight+" "+s.fontSize+" "+s.fontFamily,` +
        `chrome:cs[0].getBoundingClientRect().width-l0.getBoundingClientRect().width,` +
        `cards:cs.map(function(c){var r=c.getBoundingClientRect(),p=parseFloat(getComputedStyle(c.lastChild).paddingRight);return{w:r.width-p,pad:p,` +
        `l:r.left-br.left+b.scrollLeft,r:r.right-br.left+b.scrollLeft,title:byId[c.dataset.id],text:c.lastChild.textContent,` +
        `cut:c.lastChild.scrollWidth>c.lastChild.clientWidth+0.5,te:getComputedStyle(c.lastChild).textOverflow}})}})()`,
    );
  // The share rule: K whole cards in view, one more for every 300px of the
  // space between the buttons, each an equal share of it; at any scroll the
  // cards rest on a card boundary and the card after the last whole one
  // starts at the edge. Every label carries its whole title, the browser
  // cutting it.
  const CARD_MAX = 300;
  const sharesOk = (L) => {
    const K = Math.max(1, Math.ceil(L.vis / CARD_MAX));
    const per = L.vis / K;
    const first = Math.round(L.sl / per);
    const next = L.cards[first + K];
    const ok =
      L.cards.every((c) => Math.abs(c.r - c.l - per) < 0.6) &&
      Math.abs(L.sl - first * per) < 0.6 &&
      (!next || Math.abs(next.l - (L.sl + L.vis)) < 0.6) &&
      L.cards.every((c) => c.text === c.title);
    return { ok, K, per: +per.toFixed(2), first, n: L.cards.length };
  };

  try {
    // Mount and geometry.
    check("boot: the sidebar shows the strip", !!(await boot()));
    await ctx.sleep(300);
    const g = await json(
      `(function(){var b=${q(BAR)},f=${q(BOX)} && ${q(BOX)}.querySelector("fieldset"),c=b.querySelectorAll(${JSON.stringify(CARD)});` +
        `var rb=b.getBoundingClientRect(),rf=f.getBoundingClientRect(),c0=c[0].getBoundingClientRect();` +
        `var L=${q(LIST)},rl=L.getBoundingClientRect(),n=${q(NEW)}.getBoundingClientRect(),h=${q(HIDE)}.getBoundingClientRect();` +
        `return{last:b.parentNode.matches(${JSON.stringify(BODY)})&&!b.nextSibling,h:rb.height,ch:c0.height,top:c0.top-rb.top,gap:rb.top-rf.bottom,` +
        `edge:innerHeight-rb.bottom,left:rb.left,right:innerWidth-rb.right,first:c0.left-rl.left+L.scrollLeft,` +
        `nl:n.left-rb.left,nw:n.width,nh:n.height,ntop:n.top-rb.top,hr:rb.right-h.right,hw:h.width,hh:h.height,` +
        `between:Math.abs(rl.left-n.right-4)<0.6&&Math.abs(h.left-rl.right-4)<0.6&&L.parentNode===b,` +
        `size:getComputedStyle(c[0].lastChild).fontSize,marked:b.parentNode.hasAttribute("data-ccup-cards"),n:c.length}})()`,
    );
    check(
      "mount: last child of the session body, marked on it",
      g.last && g.marked,
      JSON.stringify(g),
    );
    check(
      "mount: across the whole width on the bottom edge, the input box 8px above",
      Math.abs(g.left) < 0.6 &&
        Math.abs(g.right) < 0.6 &&
        Math.abs(g.edge) < 0.6 &&
        Math.abs(g.gap - 8) < 0.6,
    );
    check(
      "mount: cards an editor tab tall in its text size, over a 1px groove",
      g.ch === 24 && Math.abs(g.top) < 0.6 && g.h === 25 && g.size === "13px",
    );
    check(
      "mount: New session square at the strip's left end, the hide button at its right, the cards scrolling between from the first, 4px in from each",
      Math.abs(g.nl) < 0.6 &&
        Math.abs(g.hr) < 0.6 &&
        g.nw === 24 &&
        g.nh === 24 &&
        g.hw === 24 &&
        g.hh === 24 &&
        Math.abs(g.ntop) < 0.6 &&
        g.between &&
        Math.abs(g.first) < 0.6,
      JSON.stringify(g),
    );
    const L0 = await layout();
    const sh0 = sharesOk(L0);
    check(
      "shares: at 420px two whole cards in view, each half the strip, the next starting at its edge",
      sh0.ok && sh0.K === 2,
      JSON.stringify(sh0),
    );
    check(
      "titles: each label carries its whole title, the browser cutting a long one with an ellipsis",
      L0.cards.every((x) => x.text === x.title && x.te === "ellipsis") &&
        L0.cards.some((x) => x.cut) &&
        L0.cards.some((x) => !x.cut),
      JSON.stringify(L0.cards.map((x) => [x.text, x.cut])),
    );

    // Order: A by its prompt 150 minutes ago, the rest by activity; no Web.
    const s0 = await strip();
    check(
      "order: by your last message, the booted session by its prompt",
      s0 === "B C A* D E F",
      s0,
    );
    check("active: the session on screen is marked", s0.includes("A*"));
    const wide = await json(
      `(function(){var s=window.__ccupSessionCards.rows.map(function(r){return r.id});return s})()`,
    );
    check(
      "order: the full model places A by its prompt, no archived or Web session",
      wide.map((i) => LETTER[i]).join(" ") === "B C A D E F",
      wide.map((i) => LETTER[i]).join(" "),
    );

    // Warmth at boot: A, on screen, reads its own record as the footer clock
    // does (its cache last used by the prompt 150 minutes ago, so cold),
    // and the rest count from their newest message at that record's TTL
    // (one hour): B, half an hour ago, warm.
    const w0 = await warmth();
    const rw = await json(
      `(function(){var b=${cardEl("B")},d=b.firstChild,s=getComputedStyle(d),c=getComputedStyle(b);` +
        `return{bg:s.backgroundColor,edge:s.borderTopColor,ink:c.color}})()`,
    );
    check(
      "warm: the session on screen by its own record, the rest by their newest message",
      w0 === "B+ C- A- D- E- F-",
      w0,
    );
    check(
      "circle: filled in the card's own grey while its prompt cache is warm",
      rw.bg === rw.ink && rw.edge === rw.ink && rw.ink === "rgb(157, 157, 157)",
      JSON.stringify(rw),
    );

    // Pending from the host's feed: B awaits input in a tab, D and A unread.
    await ctx.evaluate(
      `window.__push({type:"session_states_update",sessions:[{sessionId:"${S.A}",state:"idle",title:"x"},` +
        `{sessionId:"${S.B}",state:"waiting_input",title:"${TITLES.B}"}],activeSessionId:"${S.A}",` +
        `openSessionIds:["${S.B}","${S.C}"],unreadSessionKeys:["${S.D}","${S.A}"]})`,
    );
    await ctx.sleep(200);
    const s1 = await strip();
    check(
      "pending: awaiting input and unread each mark the card, never the session on screen",
      s1 === "B! C A* D! E F",
      s1,
    );
    // Circles: C idle and cold, A on screen and cold, B waiting and warm, D
    // waiting and cold.
    const ring = (k) =>
      json(
        `(function(){var b=${cardEl(k)},d=b.firstChild,s=getComputedStyle(d),c=getComputedStyle(b);` +
          `return{w:s.width,bg:s.backgroundColor,edge:s.borderTopColor,ink:c.color,first:d.className}})()`,
      );
    const [rc, ra, rb, rd] = [
      await ring("C"),
      await ring("A"),
      await ring("B"),
      await ring("D"),
    ];
    check(
      "circle: a hollow ring in the card's grey once its prompt cache is cold",
      rc.first === "ccup-card-dot" &&
        rc.w === "8px" &&
        rc.bg === "rgba(0, 0, 0, 0)" &&
        rc.edge === rc.ink &&
        rc.ink === "rgb(157, 157, 157)",
      JSON.stringify(rc),
    );
    // The input box's text color, which the stub sets apart from both the
    // other cards' grey and the editor tab's white.
    const composer = await ctx.evaluate(
      `(function(){var d=document.createElement("span");d.style.color="var(--app-input-foreground)";` +
        `document.body.appendChild(d);var c=getComputedStyle(d).color;d.remove();return c})()`,
    );
    check(
      "active: the session on screen in the input box's text color, a ring in it while cold",
      ra.bg === "rgba(0, 0, 0, 0)" &&
        ra.edge === ra.ink &&
        ra.ink === composer &&
        ra.ink === "rgb(204, 204, 204)" &&
        ra.ink !== rc.ink,
      JSON.stringify({ ra, composer }),
    );
    check(
      "circle: clay while waiting on you, filled while warm and a ring once cold",
      rb.bg === "rgb(217, 119, 87)" &&
        rb.edge === "rgb(217, 119, 87)" &&
        rd.bg === "rgba(0, 0, 0, 0)" &&
        rd.edge === "rgb(217, 119, 87)",
      JSON.stringify({ rb, rd }),
    );
    // Seamless, on the screen's pixels: around the card on screen (A) and in
    // the strip beside it.
    const colorsAt = async (pts) => {
      const shot = await ctx.cdp("Page.captureScreenshot", { format: "png" });
      const r = await ctx.cdp("Runtime.evaluate", {
        awaitPromise: true,
        returnByValue: true,
        expression:
          `new Promise(function(res){var im=new Image();im.onload=function(){var c=document.createElement("canvas");` +
          `c.width=im.width;c.height=im.height;var g=c.getContext("2d");g.drawImage(im,0,0);var k=im.width/innerWidth;` +
          `res(${JSON.stringify(pts)}.map(function(p){var d=g.getImageData(Math.floor(p[0]*k),Math.floor(p[1]*k),1,1).data;` +
          `return "rgb("+d[0]+", "+d[1]+", "+d[2]+")"}))};im.src="data:image/png;base64,${shot.data}"})`,
      });
      return r.result.value;
    };
    await ctx.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 5,
      y: 5,
    });
    await ctx.sleep(150);
    const a = await box(cardEl("A"));
    const cIdle = await box(cardEl("C"));
    // A, brought into view at boot, ends at the scroller's right edge, so the
    // hide button draws the right shoulder the scroller cuts off, in the gap
    // between them.
    const hb = await box(q(HIDE));
    const [
      above,
      joined,
      shoulder,
      beside,
      cornerOut,
      cornerIn,
      foot,
      borrowed,
      borrowedIn,
    ] = await colorsAt([
      [a.x + a.w / 2, a.y - 3],
      [a.x + a.w / 2, a.y + 0.5],
      [a.x - 1, a.y + 0.5],
      [a.x - 1, a.y + 3.5],
      [a.x + 0.5, a.b - 0.5],
      [a.x + 4, a.b - 1.5],
      [cIdle.x + cIdle.w / 2, cIdle.b + 0.5],
      [a.r + 0.5, a.y + 0.5],
      [a.r + 1, a.y + 3.5],
    ]);
    const CHAT = "rgb(24, 24, 24)";
    const STRIP = "rgb(43, 43, 43)";
    check(
      "seamless: the card on screen is the chat's background, joined to the chat above",
      above === CHAT && joined === CHAT,
      JSON.stringify({ above, joined }),
    );
    check(
      "seamless: the strip curves into it at the top, its bottom corners are rounded",
      shoulder === CHAT &&
        beside === STRIP &&
        cornerOut === STRIP &&
        cornerIn === CHAT &&
        foot === STRIP,
      JSON.stringify({ shoulder, beside, cornerOut, cornerIn, foot }),
    );
    check(
      "seamless: at the scroller's edge the hide button draws the shoulder the scroller cuts off, in the gap",
      Math.abs(a.r + 4 - hb.x) < 0.6 &&
        borrowed === CHAT &&
        borrowedIn === STRIP,
      JSON.stringify({ ar: a.r, hx: hb.x, borrowed, borrowedIn }),
    );
    // The tip is the full title, above the card, though the card's own label
    // cuts it; the label read out to assistive tech names the reason too.
    await showCard("B");
    await ctx.sleep(50);
    await ctx.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      ...center(await box(cardEl("B"))),
    });
    const tip = await until(
      `(function(){var t=[].find.call(document.querySelectorAll(".ccup-hover-tip"),function(e){return e.style.display==="block"});` +
        `return t&&t.textContent})()`,
      1500,
    );
    const tipBox = await box(
      `[].find.call(document.querySelectorAll(".ccup-hover-tip"),function(e){return e.style.display==="block"})`,
    );
    const bBox = await box(cardEl("B"));
    const bLabel = await json(
      `(function(){var b=${cardEl("B")},l=b.lastChild;return{text:l.textContent,cut:l.scrollWidth>l.clientWidth+0.5,aria:b.getAttribute("aria-label")}})()`,
    );
    check(
      "tip: the full title alone, above the card, where the card's label cuts it",
      tip === TITLES.B &&
        bLabel.text === TITLES.B &&
        bLabel.cut &&
        !!tipBox &&
        tipBox.b <= bBox.y,
      JSON.stringify({ tip, label: bLabel.text, cut: bLabel.cut }),
    );
    check(
      "pending: the label read out to assistive tech still names the reason",
      bLabel.aria === `${TITLES.B} — awaiting input (open in a tab)`,
      bLabel.aria,
    );
    await ctx.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 5,
      y: 5,
    });
    await ctx.sleep(100);
    const tipGone = await ctx.evaluate(
      `![].some.call(document.querySelectorAll(".ccup-hover-tip"),function(e){return e.style.display==="block"})`,
    );
    check("pending: the tip goes when the pointer leaves", tipGone);
    // The host clears the unread mark of the session a visible view shows,
    // as it would here for A.
    await ctx.evaluate(
      `window.__push({type:"session_states_update",sessions:[{sessionId:"${S.A}",state:"idle",title:"x"},` +
        `{sessionId:"${S.B}",state:"waiting_input",title:"${TITLES.B}"}],activeSessionId:"${S.A}",` +
        `openSessionIds:["${S.B}","${S.C}"],unreadSessionKeys:["${S.D}"]})`,
    );
    await ctx.sleep(100);

    // Buttons: the chat's own background, groove included, until hovered,
    // each with its tip, and a gap of the strip's color before the cards.
    const away = async () => {
      await ctx.cdp("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: 5,
        y: 5,
      });
      await ctx.sleep(150);
    };
    const shownTip = () =>
      until(
        `(function(){var t=[].find.call(document.querySelectorAll(".ccup-hover-tip"),function(e){return e.style.display==="block"});` +
          `return t&&t.textContent})()`,
        1500,
      );
    const nb = await box(q(NEW));
    const hb1 = await box(q(HIDE));
    const [newRest, hideRest, newFoot, hideFoot, gapL, gapR] = await colorsAt([
      [nb.x + 1.5, nb.y + nb.h / 2],
      [hb1.r - 1.5, hb1.y + hb1.h / 2],
      [nb.x + nb.w / 2, nb.b + 0.5],
      [hb1.x + hb1.w / 2, hb1.b + 0.5],
      [nb.r + 2, nb.y + nb.h / 2],
      [hb1.x - 2, hb1.y + hb1.h / 2],
    ]);
    const hover = async (b) => {
      await ctx.cdp("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        ...center(b),
      });
      const t = await shownTip();
      const [px] = await colorsAt([[b.x + 1.5, b.y + b.h / 2]]);
      await away();
      return { t, px };
    };
    const newHover = await hover(nb);
    const hideHover = await hover(hb1);
    check(
      "buttons: the chat's background, groove included, until hovered, each with its own tip",
      newRest === CHAT &&
        hideRest === CHAT &&
        newFoot === CHAT &&
        hideFoot === CHAT &&
        newHover.px !== CHAT &&
        hideHover.px !== CHAT &&
        newHover.t === "New session" &&
        hideHover.t === HIDE_TIP,
      JSON.stringify({
        newRest,
        hideRest,
        newFoot,
        hideFoot,
        newHover,
        hideHover,
      }),
    );
    check(
      "buttons: a gap of the strip's color between each and the cards",
      gapL === STRIP && gapR === STRIP,
      JSON.stringify({ gapL, gapR }),
    );
    // The hide button's arrow points right, to the edge a secondary side bar
    // on the right sits on (VS Code's default): above the arrowhead only its
    // bar shows, near the button's right side, against the button's own
    // background.
    const arrowAt = async () => {
      const b = await box(q(HIDE));
      const [ground, l, r] = await colorsAt([
        [b.x + 1.5, b.y + b.h / 2],
        [b.x + 6.5, b.y + 8],
        [b.x + 17.5, b.y + 8],
      ]);
      return { l: l !== ground, r: r !== ground };
    };
    const arrowR = await arrowAt();
    check(
      "hide: the arrow points to the right edge, its bar there",
      arrowR.r && !arrowR.l,
      JSON.stringify(arrowR),
    );

    // New session with no header button to press (renamed away here): the
    // strip creates the session itself, as the header's fallback does.
    const onScreen = () =>
      json(
        `({title:${q(TITLE)}&&${q(TITLE)}.textContent,card:window.__ccupSessionCards.rows.some(function(r){return r.active})})`,
      );
    await ctx.evaluate(
      `window.__heads=0;document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest(${JSON.stringify(HEAD_NEW)});if(b)window.__heads++},true)`,
    );
    const icon = await json(
      `(function(){var a=${q(NEW)}.querySelector("path"),b=${q(HEAD_NEW)};b=b&&b.querySelector("path");` +
        `return{head:!!b,own:!!a&&!!b&&a.getAttribute("d")===b.getAttribute("d")}})()`,
    );
    check(
      "new: the button wears the header's own New session icon",
      icon.head && icon.own,
      JSON.stringify(icon),
    );
    await ctx.evaluate(
      `window.__head=${q(HEAD_NEW)};window.__head.setAttribute("aria-label","Renamed")`,
    );
    await click(center(await box(q(NEW))));
    await ctx.sleep(400);
    const lone = await onScreen();
    await ctx.evaluate(
      `window.__head.setAttribute("aria-label","New session")`,
    );
    check(
      "new: with no header button the strip creates the session itself",
      lone.title !== TITLES.A &&
        !lone.card &&
        (await ctx.evaluate("window.__heads")) === 0,
      JSON.stringify(lone),
    );
    const backToA = async () => {
      await clickCard("A");
      await until(
        `${q(TITLE)}&&${q(TITLE)}.textContent===${JSON.stringify(TITLES.A)}`,
      );
      await ctx.sleep(200);
    };
    await backToA();
    // With the header's button, a click presses it, and so does Enter on the
    // focused button, once each.
    await click(center(await box(q(NEW))));
    await ctx.sleep(400);
    const viaHead = await onScreen();
    const heads1 = await ctx.evaluate("window.__heads");
    await backToA();
    await ctx.evaluate(`${q(NEW)}.focus()`);
    await key("Enter", "Enter", 13);
    await ctx.sleep(400);
    const heads2 = await ctx.evaluate("window.__heads");
    check(
      "new: a click and Enter each press the header's own New session once",
      heads1 === 1 &&
        heads2 === 2 &&
        viaHead.title !== TITLES.A &&
        !viaHead.card,
      JSON.stringify({ heads1, heads2, viaHead }),
    );
    await backToA();

    // Hide: the host is asked to hide the secondary side bar, and a host
    // that answers the request as unknown gets the reload notice (here from
    // the keyboard).
    const hides = async (go) => {
      const m0 = (await sent()).length;
      await go();
      await ctx.sleep(300);
      const after = (await sent()).slice(m0);
      return {
        asked: after.filter((m) => m.type === "request:ccup_close_sidebar")
          .length,
        notes: after
          .filter((m) => m.type === "request:show_notification")
          .map((m) => m.message),
      };
    };
    const hide1 = await hides(async () => click(center(await box(q(HIDE)))));
    await ctx.evaluate(`window.__unknown.push("ccup_close_sidebar")`);
    const hide2 = await hides(async () => {
      await ctx.evaluate(`${q(HIDE)}.focus()`);
      await key("Enter", "Enter", 13);
    });
    await ctx.evaluate(`window.__unknown.length=0`);
    check(
      "hide: a click asks the host to hide the secondary side bar",
      hide1.asked === 1 && hide1.notes.length === 0,
      JSON.stringify(hide1),
    );
    check(
      "hide: a host without the request gets the reload notice, Enter pressing the button once",
      hide2.asked === 1 &&
        hide2.notes.length === 1 &&
        hide2.notes[0] === RELOAD,
      JSON.stringify(hide2),
    );

    // A press keeps focus: the input box keeps it through a click on the
    // card of the session on screen, which does nothing else.
    await ctx.evaluate(`${q(INPUT)}.focus()`);
    await clickCard("A");
    await ctx.sleep(150);
    check(
      "press: focus stays in the input box",
      await ctx.evaluate(`document.activeElement===${q(INPUT)}`),
    );

    // Click: C is open in a tab, so the host focuses that tab, which is the
    // native guard keeping a session in one place: the sidebar asks for
    // nothing of C, starts nothing for it, and keeps A on screen. From the
    // keyboard too.
    const tabbed = async (go) => {
      const mark = (await sent()).length;
      await go();
      await ctx.sleep(300);
      const after = (await sent()).slice(mark);
      return {
        focus: after.filter((m) => m.type === "request:open_in_editor"),
        here: after.filter(
          (m) =>
            (m.type === "request:get_session_request" && m.sessionId === S.C) ||
            (m.type === "launch_claude" && m.resume === S.C),
        ),
        stays:
          (await shownTitle()) === TITLES.A &&
          (await strip()).includes("A*") &&
          !(await strip()).includes("C*"),
      };
    };
    const byClick = await tabbed(() => clickCard("C"));
    check(
      "click: a session open in a tab gets that tab focused, never a second copy here",
      byClick.focus.length === 1 &&
        byClick.focus[0].sessionId === S.C &&
        byClick.here.length === 0 &&
        byClick.stays,
      JSON.stringify(byClick),
    );
    const byKey = await tabbed(async () => {
      await showCard("C");
      await ctx.evaluate(`${cardEl("C")}.focus()`);
      await key("Enter", "Enter", 13);
    });
    check(
      "keys: Enter on a session open in a tab focuses that tab too",
      byKey.focus.length === 1 &&
        byKey.focus[0].sessionId === S.C &&
        byKey.here.length === 0 &&
        byKey.stays,
      JSON.stringify(byKey),
    );
    await ctx.evaluate(`${q(INPUT)}.focus()`);
    let mark = 0;

    // Send a prompt in A: its turn starts and A moves first.
    await send("Keep going.");
    const going = await until(`Object.keys(window.__lives).length===1`);
    await ctx.sleep(200);
    const s2 = await strip();
    check(
      "order: a prompt you send moves its session first",
      !!going && s2.startsWith("A*"),
      s2,
    );
    const stored = await json(
      `(function(){try{return JSON.parse(localStorage.getItem("ccup-session-cards")).sent}catch(e){return null}})()`,
    );
    await ctx.sleep(1100);
    const stored2 = await json(
      `(function(){try{return JSON.parse(localStorage.getItem("ccup-session-cards")).sent}catch(e){return null}})()`,
    );
    check(
      "order: the time is stored",
      !!stored2 && stored2[S.A] > Date.now() - 60e3,
      JSON.stringify({ stored, stored2 }),
    );

    // Click E: it opens here, the strip stays the same element, the input
    // box stays put. A keeps running in the background.
    const bar0 = await ctx.evaluate(`window.__bar0=${q(BAR)},true`);
    const top0 = (await box(`${q(BOX)}.querySelector("fieldset")`)).y;
    // E sits past the cards' right edge here: the wheel over the strip, a
    // vertical one as a mouse sends, scrolls it sideways into view.
    const pastEdge = () =>
      json(
        `(function(){var b=${q(LIST)}.getBoundingClientRect(),e=${cardEl("E")}.getBoundingClientRect();return e.right>b.right+0.5})()`,
      );
    const sc0 = await ctx.evaluate(`${q(LIST)}.scrollLeft`);
    const hidden0 = await pastEdge();
    const bb = await box(q(LIST));
    for (let i = 0; i < 20 && (await pastEdge()); i++) {
      await ctx.cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: bb.x + bb.w / 2,
        y: bb.y + bb.h / 2,
        deltaX: 0,
        deltaY: 40,
      });
      await ctx.sleep(60);
    }
    // Once the wheel stops, the strip glides on to the next card boundary.
    await ctx.sleep(700);
    const sc1 = await ctx.evaluate(`${q(LIST)}.scrollLeft`);
    const per1 = await ctx.evaluate(
      `parseFloat(${q(LIST)}.style.getPropertyValue("--ccup-card-w"))`,
    );
    const aligned = Math.abs(sc1 - Math.round(sc1 / per1) * per1) < 1;
    const chatTop = await ctx.evaluate(
      `document.querySelector(".${cls("messagesContainer")}").scrollTop`,
    );
    check(
      "scroll: the wheel over the strip scrolls it sideways to a card past its edge, coming to rest on a card boundary",
      hidden0 && sc1 > sc0 && aligned && !(await pastEdge()) && chatTop === 0,
      JSON.stringify({ hidden0, sc0, sc1, per1, aligned, chatTop }),
    );
    const top1 = (await box(`${q(BOX)}.querySelector("fieldset")`)).y;
    mark = (await sent()).length;
    await clickCard("E");
    const switched = await until(
      `${q(TITLE)}&&${q(TITLE)}.textContent===${JSON.stringify(TITLES.E)}`,
    );
    await ctx.sleep(300);
    const top2 = (await box(`${q(BOX)}.querySelector("fieldset")`)).y;
    const asked = (await sent())
      .slice(mark)
      .some(
        (m) => m.type === "request:get_session_request" && m.sessionId === S.E,
      );
    const s3 = await strip();
    check(
      "click: any other session opens here",
      !!switched && asked && s3.includes("E*"),
      s3,
    );
    check(
      "click: the strip stays the same element and the input box stays put",
      bar0 &&
        (await ctx.evaluate(
          `window.__bar0===${q(BAR)}&&window.__bar0.isConnected`,
        )) &&
        Math.abs(top2 - top1) < 0.6,
      JSON.stringify({ top0, top1, top2 }),
    );

    // Held: A's turn ends while E is on screen.
    const s4 = await strip();
    await ctx.evaluate(`window.__finish(${JSON.stringify(S.A)})`);
    await ctx.sleep(300);
    const s5 = await strip();
    const w5 = await warmth();
    check(
      "held: a turn ending in the background gives its session a dot",
      !s4.includes("A!") && s5.includes("A!"),
      `${s4} -> ${s5}`,
    );
    check(
      "warm: a turn that used the cache fills a held session's circle, by its live record",
      w5.includes("A+"),
      w5,
    );
    await clickCard("A");
    await until(
      `${q(TITLE)}&&${q(TITLE)}.textContent===${JSON.stringify(TITLES.A)}`,
    );
    await ctx.sleep(300);
    const s6 = await strip();
    check(
      "held: opening it clears the dot",
      s6.includes("A*") && !s6.includes("A!"),
      s6,
    );

    // Held: a permission request arrives in A while E is on screen.
    await clickCard("E");
    await until(
      `${q(TITLE)}&&${q(TITLE)}.textContent===${JSON.stringify(TITLES.E)}`,
    );
    await ctx.sleep(200);
    await ctx.evaluate(`window.__permit(${JSON.stringify(S.A)})`);
    await ctx.sleep(300);
    const s7 = await strip();
    const why = await ctx.evaluate(`${cardEl("A")}.getAttribute("aria-label")`);
    check(
      "held: a permission request in the background gives its session a dot",
      s7.includes("A!") && why.endsWith("awaiting input"),
      `${s7} / ${why}`,
    );

    // Keys: one tab stop; arrows move, Home and End reaching the buttons;
    // Enter opens.
    const ITEMS = JSON.stringify(`${CARD},${NEW},${HIDE}`);
    const stops = await ctx.evaluate(
      `[].filter.call(document.querySelectorAll(${ITEMS}),function(b){return b.tabIndex===0}).length`,
    );
    await ctx.evaluate(
      `[].find.call(document.querySelectorAll(${ITEMS}),function(b){return b.tabIndex===0}).focus()`,
    );
    const focused = () =>
      ctx.evaluate(
        `(function(){var e=document.activeElement;return e.dataset.id||(e.matches(${JSON.stringify(NEW)})?"new":e.matches(${JSON.stringify(HIDE)})?"hide":"?")})()`,
      );
    const f0 = await focused();
    await key("ArrowLeft", "ArrowLeft", 37);
    const f1 = await focused();
    await key("End", "End", 35);
    const f2 = await focused();
    await key("ArrowLeft", "ArrowLeft", 37);
    const f3 = await focused();
    await key("Home", "Home", 36);
    const f4 = await focused();
    await key("ArrowRight", "ArrowRight", 39);
    const f5 = await focused();
    const order = await json(
      `[].map.call(document.querySelectorAll(${JSON.stringify(CARD)}),function(b){return b.dataset.id})`,
    );
    check(
      "keys: one tab stop, on the session on screen, arrows move, Home and End reach the buttons",
      stops === 1 &&
        f0 === S.E &&
        f1 === order[Math.max(0, order.indexOf(S.E) - 1)] &&
        f2 === "hide" &&
        f3 === order[order.length - 1] &&
        f4 === "new" &&
        f5 === order[0],
      JSON.stringify({
        stops,
        f: [f0, f1, f2, f3, f4, f5].map((i) => LETTER[i] ?? i),
      }),
    );
    await key("Enter", "Enter", 13);
    const keyed = await until(
      `${q(TITLE)}&&${q(TITLE)}.textContent===${JSON.stringify(TITLES[LETTER[order[0]]])}`,
      3000,
    );
    check("keys: Enter opens the focused card's session", !!keyed);

    // Relist: G shows up in the feed before any list read has it.
    mark = (await sent()).length;
    await ctx.evaluate(
      `window.__listed.push("G");window.__push({type:"session_states_update",sessions:[{sessionId:"${S.G}",state:"running",title:"${TITLES.G}"}],` +
        `activeSessionId:"${S.G}",openSessionIds:["${S.G}"],unreadSessionKeys:[]})`,
    );
    const g1 = await until(`!!${cardEl("G")}`, 3000);
    await ctx.evaluate(
      `window.__push({type:"session_states_update",sessions:[{sessionId:"${S.G}",state:"idle",title:"${TITLES.G}"},{sessionId:"${S.W}",state:"idle",title:"w"}],` +
        `activeSessionId:"${S.G}",openSessionIds:["${S.G}"],unreadSessionKeys:[]})`,
    );
    await ctx.sleep(6000);
    await ctx.evaluate(
      `window.__push({type:"session_states_update",sessions:[{sessionId:"${S.W}",state:"running",title:"w"}],` +
        `activeSessionId:"${S.W}",openSessionIds:["${S.G}"],unreadSessionKeys:[]})`,
    );
    await ctx.sleep(6000);
    const relists = (await sent())
      .slice(mark)
      .filter((m) => m.type === "request:list_sessions_request")
      .map((m) => m.entryPoint);
    check(
      "relist: one re-read for each id the list has not seen, then G's card",
      !!g1 && relists.join() === "state_sync,state_sync",
      JSON.stringify(relists),
    );
    check(
      "relist: a Web session the feed reports gets no card",
      !(await ctx.evaluate(`!!${cardEl("W")}`)),
    );

    // Settle: nothing changes, so nothing is written.
    const quiet = await json(
      `new Promise(function(){})&&(function(){window.__muts=0;new MutationObserver(function(r){window.__muts+=r.length})` +
        `.observe(${q(BAR)},{subtree:true,childList:true,attributes:true,characterData:true});return true})()`,
    );
    await ctx.sleep(1500);
    check(
      "settle: an idle strip mutates nothing",
      quiet && (await ctx.evaluate("window.__muts")) === 0,
      await ctx.evaluate("window.__muts"),
    );

    // Widths from a wide sidebar down to a narrow one (seven sessions by now):
    // the title rule holds at each, and so does the edge rule, both its peek
    // and its sliver turning up along the way. It ends at 250px, where the
    // scroll checks below run.
    const steps = {};
    const bad = [];
    for (let width = 900; width >= 250; width -= 10) {
      await ctx.cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height: 700,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await ctx.sleep(120);
      await ctx.evaluate(`${q(LIST)}.scrollLeft=0`);
      await ctx.sleep(60);
      const sh = sharesOk(await layout());
      steps[sh.K] = (steps[sh.K] || 0) + 1;
      if (!sh.ok) bad.push({ width, ...sh });
    }
    check(
      "shares: at every width from 900px to 250px whole cards only, one more for every 300px, the next at the edge",
      !bad.length && Object.keys(steps).length >= 3,
      JSON.stringify({ steps, bad: bad.slice(0, 4) }),
    );
    // Every non-archived session is a card, the archived one never, and the
    // card on screen comes into view when it changes.
    const all = await strip();
    check(
      "scroll: the strip holds every non-archived local session",
      all.split(" ").length === 7 &&
        !all.includes("Z") &&
        !all.includes("W") &&
        (await ctx.evaluate(`${q(LIST)}.scrollWidth>${q(LIST)}.clientWidth`)),
      all,
    );
    const lastId = await ctx.evaluate(
      `[].slice.call(document.querySelectorAll(${JSON.stringify(CARD)})).pop().dataset.id`,
    );
    await ctx.evaluate(`${q(LIST)}.scrollLeft=0`);
    await ctx.evaluate(
      `(function(){var t=[].slice.call(document.querySelectorAll(${ITEMS})).find(function(b){return b.tabIndex===0});t.focus()})()`,
    );
    // End reaches the hide button, the last card just before it.
    await key("End", "End", 35);
    await key("ArrowLeft", "ArrowLeft", 37);
    await key("Enter", "Enter", 13);
    await until(
      `!!${q(LIST)}.querySelector('[data-id="${lastId}"][data-active]')`,
      3000,
    );
    await ctx.evaluate(`${q(LIST)}.scrollLeft=0`);
    await ctx.sleep(100);
    const inView = async () =>
      json(
        `(function(){var b=${q(LIST)}.getBoundingClientRect(),e=${q(LIST)}.querySelector('[data-active]').getBoundingClientRect();return e.left>=b.left-0.5&&e.right<=b.right+0.5})()`,
      );
    const before = await inView();
    // A new render (the next feed report) brings it back only if it moved or
    // changed, so a scroll of your own stays.
    await ctx.evaluate(
      `window.__push({type:"session_states_update",sessions:[],activeSessionId:"",openSessionIds:[],unreadSessionKeys:[]})`,
    );
    await ctx.sleep(200);
    const stays = !(await inView());
    // Opening another card from the far end brings the new one into view.
    await ctx.evaluate(`${q(LIST)}.scrollLeft=${q(LIST)}.scrollWidth`);
    await ctx.sleep(100);
    const firstId = await ctx.evaluate(
      `document.querySelector(${JSON.stringify(CARD)}).dataset.id`,
    );
    await ctx.evaluate(
      `(function(){var t=[].slice.call(document.querySelectorAll(${ITEMS})).find(function(b){return b.tabIndex===0});t.focus()})()`,
    );
    // Home reaches the New session button, the first card just after it.
    await key("Home", "Home", 36);
    await key("ArrowRight", "ArrowRight", 39);
    await key("Enter", "Enter", 13);
    await until(
      `!!${q(LIST)}.querySelector('[data-id="${firstId}"][data-active]')`,
      3000,
    );
    await ctx.sleep(200);
    check(
      "scroll: the card on screen comes into view when it changes, a scroll of your own stays otherwise",
      before === false && stays && (await inView()),
      JSON.stringify({ before, stays }),
    );
    await ctx.cdp("Emulation.setDeviceMetricsOverride", {
      width: 420,
      height: 700,
      deviceScaleFactor: 2,
      mobile: false,
    });

    // Expiry: D (never opened here, so it carries no record) has its newest
    // message moved to four seconds inside the TTL, so its card fills, then
    // empties on its own when the cache would expire.
    const filled = `getComputedStyle(${cardEl("D")}.firstChild).backgroundColor!=="rgba(0, 0, 0, 0)"`;
    await ctx.evaluate(
      `ACTIVITY.D=60-4/60-(Date.now()-NOW)/60e3;window.__push({type:"session_store_changed"})`,
    );
    const warmD = await until(filled, 3000);
    const rowD = await json(
      `(function(){var r=window.__ccupSessionCards.rows.find(function(x){return x.id===${JSON.stringify(S.D)}});` +
        `return r&&{mod:Date.now()-r.mod,rec:!!r.s.promptCacheRecord.value,cache:r.cache&&{warm:r.cache.warm,left:r.cache.until-Date.now()}}})()`,
    );
    await ctx.sleep(5500);
    const coldD = await ctx.evaluate(`!(${filled})`);
    check(
      "warm: a card empties on its own when its cache expires",
      !!warmD && coldD,
      JSON.stringify({ warmD, coldD, rowD }),
    );

    // Reload: A's sent time keeps it ahead of its transcript's old prompt.
    await boot();
    await ctx.sleep(400);
    const s8 = await strip();
    check(
      "reload: the stored time of a sent prompt keeps its place",
      s8.startsWith("A*"),
      s8,
    );

    // Look: the line form (compact density, or no modern UI) draws the tab's
    // blue accent along the bottom edge of the card on screen, inset by its
    // corners, and the seamless form (default density) draws none. Both keep
    // the card in the chat's background.
    const paint = (k) =>
      json(
        `(function(){var s=getComputedStyle(${cardEl(k)});` +
          `return{bg:s.backgroundColor,img:s.backgroundImage,size:s.backgroundSize,pos:s.backgroundPosition}})()`,
      );
    const line = await paint("A");
    const [lineMid, lineCorner] = await (async () => {
      const b = await box(cardEl("A"));
      return colorsAt([
        [b.x + b.w / 2, b.b - 0.5],
        [b.x + 2, b.b - 0.5],
      ]);
    })();
    check(
      "look: compact puts the blue line along the bottom of the card on screen",
      line.bg === "rgb(24, 24, 24)" &&
        line.img.includes("rgb(0, 120, 212)") &&
        lineMid === "rgb(0, 120, 212)" &&
        lineCorner !== "rgb(0, 120, 212)",
      JSON.stringify({ line, lineMid, lineCorner }),
    );
    // A, first since the send, sits one gap after the New session button: its
    // bottom-left corner stays rounded, the button draws the left shoulder
    // the scroller cuts off in that gap, and the gap keeps the two apart.
    const lead = await json(
      `(function(){var b=${cardEl("A")},n=${q(NEW)};return{first:b===b.parentNode.firstElementChild,` +
        `corner:getComputedStyle(b).borderBottomLeftRadius,lent:n.hasAttribute("data-shoulder"),` +
        `gap:b.getBoundingClientRect().left-n.getBoundingClientRect().right}})()`,
    );
    const [leadShoulder, leadIn, leadApart, leadCorner, leadButton] =
      await (async () => {
        const n = await box(q(NEW));
        const b = await box(cardEl("A"));
        return colorsAt([
          [b.x - 0.5, b.y + 0.5],
          [b.x - 1, b.y + 3.5],
          [n.r + 0.5, n.y + n.h / 2],
          [b.x + 0.5, b.b - 0.5],
          [n.r - 1, n.y + 0.5],
        ]);
      })();
    check(
      "look: the first card keeps its rounded corner a gap from New session, the button drawing its shoulder there",
      lead.first &&
        Math.abs(lead.gap - 4) < 0.6 &&
        lead.corner === "4px" &&
        lead.lent &&
        leadShoulder === CHAT &&
        leadIn === STRIP &&
        leadApart === STRIP &&
        leadCorner === STRIP &&
        leadButton === CHAT,
      JSON.stringify({
        lead,
        leadShoulder,
        leadIn,
        leadApart,
        leadCorner,
        leadButton,
      }),
    );
    await ctx.shot("session-cards-line");
    await fetch(base + "__look/seamless");
    await boot();
    await ctx.sleep(400);
    const plain = await paint("A");
    const rest = await paint("B");
    const [plainMid] = await (async () => {
      const b = await box(cardEl("A"));
      return colorsAt([[b.x + b.w / 2, b.b - 0.5]]);
    })();
    const seat = await json(
      `(function(){var b=${q(BAR)}.getBoundingClientRect(),c=${cardEl("A")}.getBoundingClientRect();return{h:b.height,ch:c.height,edge:innerHeight-c.bottom}})()`,
    );
    check(
      "look: default keeps the card on screen seamless, with no line",
      plain.bg === "rgb(24, 24, 24)" &&
        plain.img === "none" &&
        plainMid === "rgb(24, 24, 24)" &&
        rest.bg === "rgba(0, 0, 0, 0)",
      JSON.stringify({ plain, plainMid, rest }),
    );
    check(
      "look: default has no groove, the cards on the view's bottom edge",
      seat.h === 24 && seat.ch === 24 && Math.abs(seat.edge) < 0.6,
      JSON.stringify(seat),
    );
    // There VS Code clips the webview to its 8px radius, so the strip's ends
    // keep 8px in, over the chat's background, and its corners stay square:
    // the buttons' chat background at its ends, and the band of cards square
    // at the gaps beside them. The clip is emulated by a box over the whole
    // view with those corners, its shadow painting what falls outside them in
    // a color nothing else uses, and the view's own corner shows that it
    // took.
    const ends = await json(
      `(function(){var e=${q(BAR)},b=e.getBoundingClientRect(),s=getComputedStyle(e),` +
        `n=${q(NEW)}.getBoundingClientRect(),h=${q(HIDE)}.getBoundingClientRect();` +
        `return{left:b.left,right:innerWidth-b.right,x:b.x,r:b.right,b:b.bottom,w:innerWidth,h:innerHeight,` +
        `nr:n.right,hx:h.left,radius:s.borderBottomLeftRadius+" "+s.borderBottomRightRadius}})()`,
    );
    const CLIPPED = "rgb(255, 0, 255)";
    await ctx.evaluate(
      `(function(){var d=document.createElement("div");d.id="ccup-clip";` +
        `d.style.cssText="position:fixed;inset:0;border-radius:8px;box-shadow:0 0 0 64px #f0f;pointer-events:none;z-index:2147483647";` +
        `document.body.appendChild(d)})()`,
    );
    const [viewCorner, endLeft, endRight, pastEnd, bandLeft, bandRight] =
      await colorsAt([
        [ends.w - 0.5, ends.h - 0.5],
        [ends.x + 0.5, ends.b - 0.5],
        [ends.r - 0.5, ends.b - 0.5],
        [ends.r + 4, ends.b - 4],
        [ends.nr + 0.5, ends.b - 0.5],
        [ends.hx - 0.5, ends.b - 0.5],
      ]);
    await ctx.shot("session-cards-seamless-clip");
    await ctx.evaluate(`document.getElementById("ccup-clip").remove()`);
    check(
      "look: default keeps the strip's ends 8px in, its corners square under VS Code's rounded clip",
      Math.abs(ends.left - 8) < 0.6 &&
        Math.abs(ends.right - 8) < 0.6 &&
        ends.radius === "0px 0px" &&
        viewCorner === CLIPPED &&
        endLeft === CHAT &&
        endRight === CHAT &&
        pastEnd === CHAT &&
        bandLeft === STRIP &&
        bandRight === STRIP,
      JSON.stringify({
        ends,
        viewCorner,
        endLeft,
        endRight,
        pastEnd,
        bandLeft,
        bandRight,
      }),
    );
    await ctx.shot("session-cards-seamless");
    await fetch(base + "__look/line20");
    await boot();
    await ctx.sleep(400);
    const short = await json(
      `(function(){var b=${q(BAR)}.getBoundingClientRect(),c=${cardEl("A")}.getBoundingClientRect(),` +
        `n=${q(NEW)}.getBoundingClientRect(),h=${q(HIDE)}.getBoundingClientRect();` +
        `return{h:b.height,ch:c.height,n:[n.width,n.height],x:[h.width,h.height]}})()`,
    );
    check(
      "look: a compact editor tab height makes the cards and buttons 20px tall",
      short.ch === 20 &&
        short.h === 21 &&
        short.n.join() === "20,20" &&
        short.x.join() === "20,20",
      JSON.stringify(short),
    );
    // A secondary side bar on the left (the primary moved right): the arrow
    // points left, its bar near the button's left side, with the same tip.
    await fetch(base + "__look/lineLeft");
    await boot();
    await ctx.sleep(400);
    await away();
    const arrowL = await arrowAt();
    const tipL = await ctx.evaluate(`${q(HIDE)}.dataset.tip`);
    check(
      "hide: on the left the arrow points to the left edge, with the same tip",
      arrowL.l && !arrowL.r && tipL === HIDE_TIP,
      JSON.stringify({ arrowL, tipL }),
    );
    await fetch(base + "__look/line");

    // Editor tab: no strip at all.
    await ctx.navigate(base + "?editor=1");
    const tab = await until(`!!${q(INPUT)}`);
    await ctx.sleep(600);
    check(
      "editor: an editor tab gets no strip",
      !!tab && (await ctx.evaluate(`!window.__ccupSessionCards&&!${q(BAR)}`)),
    );

    // Empty: nothing to show, so no strip and the native gap.
    await ctx.navigate(base + "?s=none");
    await until(`!!${q(INPUT)}`);
    await ctx.sleep(800);
    const empty = await json(
      `(function(){var b=${q(BAR)},f=${q(BOX)};return{hidden:!b||b.hidden,marked:!!document.querySelector("[data-ccup-cards]"),bottom:f&&getComputedStyle(f).bottom}})()`,
    );
    check(
      "empty: the strip stays hidden and the input box keeps its 16px",
      empty.hidden && !empty.marked && empty.bottom === "16px",
      JSON.stringify(empty),
    );

    const err = await ctx.evaluate(
      `document.getElementById("claude-error").textContent`,
    );
    check("no error surfaced", !err, err.slice(0, 200));
  } finally {
    await ctx.shot("session-cards");
    server.close();
  }
  return ok;
}
