// Scenario for scripts/cdp-driver.mjs: the session cards, on the REAL webview
// bundle booted as the sidebar against a stub host that lists six local
// sessions (plus a Web one) and runs a turn for every prompt sent until the
// scenario ends it. Real clicks and keys drive it, and the checks assert:
//   mount     the strip is the session body's last child, across the view's
//             whole width on its bottom edge, the input box 8px above it,
//             its cards one status bar (22px) tall over a 4px foot
//   order     cards run from the session of your last message: the booted
//             one by its newest prompt (not by the later activity the list
//             reports for it), the others by the list's activity time, no
//             Web session, and a prompt you send moves its session first
//   active    the session on screen is marked, and never shows pending
//   pending   the host's feed: awaiting input in a tab, and Claude Code's
//             unread mark, each mark the card, its reason in the hover tip
//   circle    each card leads with a circle: a hollow ring in the card's
//             grey, solid in its text color for the session on screen, solid
//             clay for a session waiting on you
//   seamless  the card on screen is the chat's own background, joined to
//             the chat above with no edge, its bottom corners rounded and the
//             strip curving into it at the top, on the screen's pixels
//   click     a session open in an editor tab asks the host to focus that
//             tab, any other opens here, the strip staying the same element
//             and the input box staying put
//   held      a turn that ends in a session this view holds while another
//             is on screen gives it a dot until you open it, and so does a
//             permission request arriving there
//   keys      the strip is one tab stop, arrows move between cards, and
//             Enter opens one
//   press     a press keeps focus where it was
//   relist    a session the feed reports that the list has not read asks
//             for one re-read, and its card then shows
//   reload    the time of a sent prompt survives a reload
//   fill      as many cards show as fit at their whole title or 96px,
//             whichever is narrower, and each is as wide as its title allows:
//             short titles whole, the longer ones splitting the rest evenly,
//             none past the strip's edge, at 420px, 760px and 250px
//   settle    an idle strip mutates nothing
//   look      the card on screen follows VS Code's layout density: no line
//             at the default density, the blue line along its bottom edge
//             when compact (both built here, as the patcher would from
//             window.density.layout)
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
// list reports activity ten minutes ago. G is a session no list read has seen yet, W a
// Web session.
const S = {
  A: id("1"),
  B: id("2"),
  C: id("3"),
  D: id("4"),
  E: id("5"),
  F: id("6"),
  G: id("7"),
  W: id("9"),
};
const TITLES = {
  A: "Cards below the composer",
  B: "Fix the regex toggle",
  C: "Bookmark notes",
  D: "KaTeX bump",
  E: "Anchor audit",
  F: "Release notes",
  G: "Started in a tab",
  W: "A Web session",
};
// Minutes ago: the list's activity time, and each transcript's last prompt.
const ACTIVITY = { A: 10, B: 60, C: 120, D: 180, E: 240, F: 360, G: 1 };
const PROMPT = { A: 150, B: 70, C: 130, D: 190, E: 250, F: 370, G: 2 };

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
  lastModified: ago(ACTIVITY[k]), lastActivity: ago(ACTIVITY[k]), archived: false,
  fileSize: 4096, gitBranch: "develop", isCurrentWorkspace: true });
window.__listed = ["A", "B", "C", "D", "E", "F"];
const msgs = (sid) => { const k = KEY[sid]; if (!k) return []; return [
  { type: "user", uuid: "a" + sid.slice(1), session_id: sid, parent_tool_use_id: null,
    timestamp: new Date(ago(PROMPT[k])).toISOString(), origin: { kind: "human" },
    message: { role: "user", content: [{ type: "text", text: "A prompt in " + TITLES[k] }] } },
  { type: "assistant", uuid: "b" + sid.slice(1), session_id: sid, parent_tool_use_id: null,
    timestamp: new Date(ago(ACTIVITY[k])).toISOString(),
    message: { id: "msg_" + k, type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text: "A reply in " + TITLES[k] + "." }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } } } ]; };
const deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
window.__push = (request) =>
  deliver({ type: "request", channelId: "", requestId: "p" + Math.random(), request });
const io = (channelId, message) => deliver({ type: "io_message", channelId, message, done: false });
// What the page posted, each session's channel, and each running turn.
window.__sent = []; window.__chan = {}; window.__lives = {};
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
      content: [{ type: "text", text: LIVE }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } });
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
    if (msg && msg.type !== "request") window.__sent.push({ type: msg.type, channelId: msg.channelId });
    if (msg && msg.type === "io_message" && msg.message && msg.message.type === "user") live(msg);
    if (!msg || msg.type !== "request") return;
    const r = msg.request;
    window.__sent.push({ type: "request:" + r.type, sessionId: r.sessionId, entryPoint: r.entryPoint });
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
const CARD = ".ccup-card";
const INPUT = '[aria-label="Message input"]';

export async function run(ctx) {
  const dir = liveBundleDir();
  const P = loadPatcher();
  const native = readFileSync(join(dir, "index.js"), "utf8");
  // Both looks, as the patcher builds them for each layout density; the
  // stub server hands out the one /__look/<name> last picked.
  const serve = {
    line: P.sessionCardsWebview(native, "line"),
    seamless: P.sessionCardsWebview(native, "seamless"),
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
      "the patcher builds the strip into this bundle in both looks",
      !!serve.line && !!serve.seamless,
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
  const clickCard = async (k) => click(center(await box(cardEl(k))));
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
          `return[b.dataset.id,b.hasAttribute("data-active"),b.hasAttribute("data-pending")&&getComputedStyle(b.firstChild).backgroundColor==="rgb(217, 119, 87)"]})`,
      )
    )
      .map(([i, a, p]) => `${LETTER[i] ?? "?"}${a ? "*" : ""}${p ? "!" : ""}`)
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
  // The strip as laid out: its content width, each card's width, its whole
  // width (as the strip measures it: its width, less what its label shows,
  // plus the label's whole text) and whether its title is cut, the next
  // candidate's whole width (a clone measured in place), and whether any card
  // runs past the strip's edge.
  const MIN_W = 96;
  const layout = () =>
    json(
      `(function(){var b=${q(BAR)},cs=[].slice.call(b.querySelectorAll(${JSON.stringify(CARD)})),` +
        `ps=getComputedStyle(b),pl=parseFloat(ps.paddingLeft),pr=parseFloat(ps.paddingRight),W=b.clientWidth-pl-pr,rb=b.getBoundingClientRect();` +
        `function whole(c){var l=c.lastChild;return c.getBoundingClientRect().width-l.clientWidth+l.scrollWidth}` +
        `var shown=cs.map(function(c){var l=c.lastChild;` +
        `return{w:c.getBoundingClientRect().width,whole:whole(c),cut:l.scrollWidth>l.clientWidth+1}});` +
        `var rows=window.__ccupSessionCards.rows,nx=rows[cs.length],nw=null;` +
        `if(nx){var t=cs[0].cloneNode(true);t.lastChild.textContent=nx.title;` +
        `t.toggleAttribute("data-pending",nx.pending);t.removeAttribute("data-active");` +
        `b.appendChild(t);nw=whole(t);t.remove()}` +
        `return{W:W,shown:shown,next:nw,` +
        `over:cs.some(function(c){return c.getBoundingClientRect().right>rb.right-pr+0.5})}})()`,
    );
  // The rule: the shown cards fit at their whole title or the minimum,
  // whichever is narrower, and one more would not; each gets at least that;
  // with a title cut the cards fill the strip, the cut ones equally wide and
  // no whole one wider, and with none cut each card is its whole width.
  const fillOk = (L) => {
    const need = (w) => Math.min(w, MIN_W);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const needs = sum(L.shown.map((s) => need(s.whole)));
    const fits =
      needs <= L.W + 0.5 &&
      (L.next === null || needs + need(L.next) > L.W - 0.5);
    const floor = L.shown.every((s) => s.w >= need(s.whole) - 0.5);
    const cut = L.shown.filter((s) => s.cut).map((s) => s.w);
    const shares =
      cut.length === 0
        ? L.shown.every((s) => Math.abs(s.w - s.whole) < 1)
        : Math.abs(sum(L.shown.map((s) => s.w)) - L.W) < 1 &&
          Math.max(...cut) - Math.min(...cut) < 1 &&
          L.shown.every((s) => s.cut || s.w <= Math.min(...cut) + 1);
    return { fits, floor, shares };
  };

  try {
    // Mount and geometry.
    check("boot: the sidebar shows the strip", !!(await boot()));
    await ctx.sleep(300);
    const g = await json(
      `(function(){var b=${q(BAR)},f=${q(BOX)} && ${q(BOX)}.querySelector("fieldset"),c=b.querySelectorAll(${JSON.stringify(CARD)});` +
        `var rb=b.getBoundingClientRect(),rf=f.getBoundingClientRect(),c0=c[0].getBoundingClientRect();` +
        `return{last:b.parentNode.matches(${JSON.stringify(BODY)})&&!b.nextSibling,h:rb.height,ch:c0.height,top:c0.top-rb.top,gap:rb.top-rf.bottom,` +
        `edge:innerHeight-rb.bottom,left:rb.left,right:innerWidth-rb.right,marked:b.parentNode.hasAttribute("data-ccup-cards"),n:c.length}})()`,
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
      "mount: cards one status bar tall at the strip's top, over a 4px foot",
      g.ch === 22 && Math.abs(g.top) < 0.6 && g.h === 26,
    );
    const L0 = await layout();
    const fill0 = fillOk(L0);
    check(
      "fill: at 420px, as many as fit at their whole title or the minimum",
      fill0.fits && fill0.floor,
      JSON.stringify(L0),
    );
    check(
      "fill: at 420px, short titles whole and the longer ones share the rest",
      fill0.shares && L0.shown.some((s) => !s.cut),
      JSON.stringify(L0.shown),
    );

    // Order: A by its prompt 150 minutes ago, the rest by activity; no Web.
    const s0 = await strip();
    check(
      "order: by your last message, the booted session by its prompt",
      s0 === "B C A* D",
      s0,
    );
    check("active: the session on screen is marked", s0.includes("A*"));
    const wide = await json(
      `(function(){var s=window.__ccupSessionCards.rows.map(function(r){return r.id});return s})()`,
    );
    check(
      "order: the full model places A by its prompt, no Web",
      wide.map((i) => LETTER[i]).join(" ") === "B C A D E F",
      wide.map((i) => LETTER[i]).join(" "),
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
      s1 === "B! C A* D!",
      s1,
    );
    // Circles: C is idle, A on screen, B waiting.
    const ring = (k) =>
      json(
        `(function(){var b=${cardEl(k)},d=b.firstChild,s=getComputedStyle(d),c=getComputedStyle(b);` +
          `return{w:s.width,bg:s.backgroundColor,edge:s.borderTopColor,ink:c.color,first:d.className}})()`,
      );
    const [rc, ra, rb] = [await ring("C"), await ring("A"), await ring("B")];
    check(
      "circle: a hollow ring in the card's grey when idle",
      rc.first === "ccup-card-dot" &&
        rc.w === "8px" &&
        rc.bg === "rgba(0, 0, 0, 0)" &&
        rc.edge === rc.ink &&
        rc.ink === "rgb(157, 157, 157)",
      JSON.stringify(rc),
    );
    check(
      "circle: solid in the text color for the session on screen, solid clay when waiting",
      ra.bg === ra.ink &&
        ra.ink === "rgb(255, 255, 255)" &&
        rb.bg === "rgb(217, 119, 87)" &&
        rb.edge === "rgb(217, 119, 87)",
      JSON.stringify({ ra, rb }),
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
    const [above, joined, shoulder, beside, cornerOut, cornerIn, foot] =
      await colorsAt([
        [a.x + a.w / 2, a.y - 3],
        [a.x + a.w / 2, a.y + 0.5],
        [a.x - 1, a.y + 0.5],
        [a.x - 1, a.y + 6],
        [a.x + 0.5, a.b - 0.5],
        [a.x + 7, a.b - 1.5],
        [cIdle.x + cIdle.w / 2, cIdle.b + 2],
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
    // The tip names the reason, above the card.
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
    check(
      "pending: the hover tip says why, above the card",
      tip === `${TITLES.B} — awaiting input (open in a tab)` &&
        !!tipBox &&
        tipBox.b <= bBox.y,
      tip,
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

    // A press keeps focus: the input box keeps it through a click on the
    // card of the session on screen, which does nothing else.
    await ctx.evaluate(`${q(INPUT)}.focus()`);
    await clickCard("A");
    await ctx.sleep(150);
    check(
      "press: focus stays in the input box",
      await ctx.evaluate(`document.activeElement===${q(INPUT)}`),
    );

    // Click: C is open in a tab, so the host focuses that tab.
    let mark = (await sent()).length;
    await clickCard("C");
    await ctx.sleep(300);
    const toTab = (await sent())
      .slice(mark)
      .find((m) => m.type === "request:open_in_editor");
    check(
      "click: a session open in a tab asks the host to focus it",
      toTab?.sessionId === S.C && (await shownTitle()) === TITLES.A,
      JSON.stringify(toTab),
    );

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
    // E sits past the strip's width here, so make room by widening.
    await ctx.cdp("Emulation.setDeviceMetricsOverride", {
      width: 760,
      height: 700,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await until(`!!${cardEl("E")}`, 2000);
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
    check(
      "held: a turn ending in the background gives its session a dot",
      !s4.includes("A!") && s5.includes("A!"),
      `${s4} -> ${s5}`,
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
    const why = await ctx.evaluate(`${cardEl("A")}.dataset.tip`);
    check(
      "held: a permission request in the background gives its session a dot",
      s7.includes("A!") && why.endsWith("awaiting input"),
      `${s7} / ${why}`,
    );

    // Keys: one tab stop; arrows move; Enter opens.
    const stops = await ctx.evaluate(
      `[].filter.call(document.querySelectorAll(${JSON.stringify(CARD)}),function(b){return b.tabIndex===0}).length`,
    );
    await ctx.evaluate(
      `[].find.call(document.querySelectorAll(${JSON.stringify(CARD)}),function(b){return b.tabIndex===0}).focus()`,
    );
    const f0 = await ctx.evaluate(`document.activeElement.dataset.id`);
    await key("ArrowLeft", "ArrowLeft", 37);
    const f1 = await ctx.evaluate(`document.activeElement.dataset.id`);
    await key("End", "End", 35);
    const f2 = await ctx.evaluate(`document.activeElement.dataset.id`);
    await key("Home", "Home", 36);
    const f3 = await ctx.evaluate(`document.activeElement.dataset.id`);
    const order = await json(
      `[].map.call(document.querySelectorAll(${JSON.stringify(CARD)}),function(b){return b.dataset.id})`,
    );
    check(
      "keys: one tab stop, on the session on screen, and arrows move",
      stops === 1 &&
        f0 === S.E &&
        f1 === order[Math.max(0, order.indexOf(S.E) - 1)] &&
        f2 === order[order.length - 1] &&
        f3 === order[0],
      JSON.stringify({ stops, f: [f0, f1, f2, f3].map((i) => LETTER[i]) }),
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

    // Fill at other widths: a wide sidebar (seven candidates by now), then a
    // narrow one.
    for (const width of [760, 250]) {
      await ctx.cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height: 700,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await ctx.sleep(400);
      const L = await layout();
      const f = fillOk(L);
      check(
        `fill: at ${width}px, as many as fit, each as wide as its title allows, none past the edge`,
        f.fits && f.floor && f.shares && !L.over,
        JSON.stringify(L),
      );
    }
    await ctx.cdp("Emulation.setDeviceMetricsOverride", {
      width: 420,
      height: 700,
      deviceScaleFactor: 2,
      mobile: false,
    });

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
    await fetch(base + "__look/seamless");
    await boot();
    await ctx.sleep(400);
    const plain = await paint("A");
    const rest = await paint("B");
    const [plainMid] = await (async () => {
      const b = await box(cardEl("A"));
      return colorsAt([[b.x + b.w / 2, b.b - 0.5]]);
    })();
    check(
      "look: default keeps the card on screen seamless, with no line",
      plain.bg === "rgb(24, 24, 24)" &&
        plain.img === "none" &&
        plainMid === "rgb(24, 24, 24)" &&
        rest.bg === "rgba(0, 0, 0, 0)",
      JSON.stringify({ plain, plainMid, rest }),
    );
    await ctx.shot("session-cards-seamless");
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
