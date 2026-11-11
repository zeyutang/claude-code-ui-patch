// Scenario for scripts/cdp-driver.mjs: the always-on sticky copy button, on
// the REAL webview bundle booted against a stub host into a transcript whose
// code blocks are taller than the view: in a plain response under a prompt
// that wraps, in a response with math, in one whose math is wider than the
// chat, in a list item, and in an open thinking block, plus a one-line and an
// empty block. Both bundles, native and patched, are measured with the same
// scrolls, and the checks assert:
//   layout     every block, wrapper and <pre> alike, lays out as natively,
//              and every button sits at the block's top right while the
//              block's top is in view
//   native     a block scrolled 300px under the top of the chat takes its
//              button with it (the canary: once it stops reproducing, Claude
//              Code has changed the button)
//   pinned     there the patched button sits 4px under the stuck prompt,
//              whatever its height, 4px in from the block's right edge, on
//              top for a click, and it stops 4px above the block's end
//   math       a math root holding a code block is clipped and scrolls
//              nothing sideways, while one whose math is wider than the chat
//              keeps its sideways scroll and its button's native place
//   inner      a block inside a scroll container of its own pins to that
//              container's top, under no header
//   reveal     hovering the block reveals the pinned button, the code under
//              the rail is still the code's, and a click on the button copies
//              the whole block
//   preview    a question's option preview shows no copy button, as natively
//
//   node scripts/cdp-driver.mjs scripts/repro/copy-pin.mjs 600 700
//
// The patched bundle served is the compiled patcher's own output for the live
// install (copyPinWebview, out/, so compile first), so the scenario runs
// exactly what an apply writes and doubles as the drift canary for both
// halves. The native bundle is the live one with this point's fragments
// stripped. The live bundle is found under ~/.vscode/extensions (newest
// Claude Code install) or via $CCUP_BUNDLE (the webview directory).
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

// This point's fragments in an installed bundle.
const FRAG_RE = /\/\*ccup:copyPin:[-\w]+\*\/[\s\S]*?\/\*ccup:copyPinEnd\*\//g;

const R = "44444444-4444-4444-8444-444444444444";
const lines = (n, f) =>
  Array.from({ length: n }, (_, i) => f(i + 1)).join("\n");
// A block whose every line starts with its tag, which is how a block is found.
const code = (tag, n, lang = "txt") =>
  "```" +
  lang +
  "\n" +
  lines(n, (i) => `${tag} line ${i} of the block`) +
  "\n```";
const filler = (n) =>
  lines(n, (i) => `Filler paragraph ${i}.`).replace(/\n/g, "\n\n");
// An inline formula no line of a 600px chat can hold (KaTeX breaks only at
// operators), in a form native math takes (it refuses a span past 60
// characters, and sizing and spacing commands such as \Huge and \rule), and
// no wider than the line as source, so its root is marked before it typesets
// and unmarked after.
const WIDE = "$\\mathbf{" + "W".repeat(45) + "}$";
const LONG_PROMPT =
  "Show me the whole script, and keep this prompt long enough that its sticky " +
  "header wraps onto more lines than the other prompts do, so the pinned " +
  "button has to clear a taller header than theirs, which is what a measured " +
  "offset is for, rather than a constant one.";

const REPLIES = [
  {
    prompt: LONG_PROMPT,
    content:
      "Intro.\n\n" + code("plain", 60, "js") + "\n\nOutro.\n\n" + filler(6),
  },
  {
    content:
      "Inline math $x^2 + y^2$ here.\n\n" +
      code("math", 60, "py") +
      "\n\nEnd.\n\n" +
      filler(6),
  },
  {
    content:
      "Wide math " +
      WIDE +
      " here.\n\n" +
      code("wide", 60, "sh") +
      "\n\nEnd.\n\n" +
      filler(6),
  },
  {
    content:
      "- a list item\n\n  " +
      code("list", 50).replace(/\n/g, "\n  ") +
      "\n- next\n\n" +
      filler(6),
  },
  {
    content: [
      {
        type: "thinking",
        thinking: "Thinking with code:\n\n" + code("think", 50),
        signature: "x",
      },
      { type: "text", text: "After thinking.\n\n" + filler(3) },
    ],
  },
  {
    content:
      "Short:\n\n```\nshort one\n```\n\nEmpty:\n\n```\n```\n\n" + filler(10),
  },
  { content: filler(30) },
];
const PREVIEW = [
  {
    question: "Which layout?",
    header: "Layout",
    multiSelect: false,
    options: [
      {
        label: "Grid",
        description: "Two columns",
        preview: "grid:\n  columns: 2\n  gap: 12px\n",
      },
      {
        label: "Stack",
        description: "One column",
        preview: "stack:\n  gap: 8px\n",
      },
    ],
  },
];

// The stub host: just enough of the init state for the chat to mount (see the
// real-webview-mock notes), one session with the transcript above, and no
// plugins. Responses go out synchronously, or the first render races ahead
// of get_claude_state. A question card arrives as a tool_permission_request
// push on the session's channel.
const page = (mode) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css?mode=${mode}">
<style>
:root{--vscode-editor-font-family:"SF Mono",monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-chat-font-family:system-ui;
--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#cccccc;
--vscode-descriptionForeground:#9d9d9d;--vscode-sideBar-background:#181818;
--vscode-editor-background:#1f1f1f;--vscode-input-background:#262626;--vscode-input-border:#3c3c3c;
--vscode-input-foreground:#cccccc;--vscode-focusBorder:#0078d4;--vscode-widget-border:#313131;
--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${R}"></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
const R = "${R}", NOW = Date.now();
const REPLIES = ${JSON.stringify(REPLIES)};
const at = (i) => new Date(NOW - (REPLIES.length - i) * 60e3).toISOString();
const MESSAGES = REPLIES.flatMap((r, i) => [
  { type: "user", uuid: crypto.randomUUID(), session_id: R, parent_tool_use_id: null, timestamp: at(i),
    message: { role: "user", content: [{ type: "text", text: r.prompt || "Prompt " + (i + 1) }] } },
  { type: "assistant", uuid: crypto.randomUUID(), session_id: R, parent_tool_use_id: null, timestamp: at(i),
    message: { id: "msg_" + i, type: "message", role: "assistant", model: "claude-fable-5",
      content: typeof r.content === "string" ? [{ type: "text", text: r.content }] : r.content,
      stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } },
]);
const SESSION = { id: R, summary: "Code", customTitle: "Code", lastModified: NOW,
  lastActivity: NOW, archived: false, fileSize: 4096, gitBranch: "develop",
  isCurrentWorkspace: true };
const deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
window.deliver = deliver;
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
<script type="module" src="/wv/index.js?mode=${mode}"></script>
</body></html>`;

const TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

// Page helpers, installed once per boot: the chat scroller, the stuck
// header's bottom, a block by its tag, and one block's geometry relative to
// the scroller's top.
const HELPERS = (cls) => `(function(){
var SC=${JSON.stringify(`.${cls.chat}`)},ST=${JSON.stringify(`.${cls.sticky}`)},
W=${JSON.stringify(`.${cls.wrap}`)},RT=${JSON.stringify(`.${cls.root}`)};
window.__sc=function(){return document.querySelector(SC)};
window.__hb=function(){var t=__sc(),s=t.getBoundingClientRect(),hs=t.querySelectorAll(ST),b=null;
for(var i=0;i<hs.length;i++){var r=hs[i].getBoundingClientRect();if(r.top<=s.top+1&&r.top>=s.top-3)b=r}
return b?{bottom:b.bottom-s.top,height:b.height}:{bottom:0,height:0}};
window.__block=function(tag){var ws=document.querySelectorAll(W);
for(var i=0;i<ws.length;i++){var p=ws[i].querySelector("pre");if(p&&p.textContent.split(" ")[0]===tag)return ws[i]}
for(i=0;i<ws.length;i++){p=ws[i].querySelector("pre");if(p&&tag===""&&p.textContent==="")return ws[i]}return null};
window.__geom=function(w){var s=__sc().getBoundingClientRect(),wr=w.getBoundingClientRect(),
b=w.querySelector("button"),br=b.getBoundingClientRect(),pr=w.querySelector("pre").getBoundingClientRect(),
hit=document.elementFromPoint(br.left+br.width/2,br.top+br.height/2),o=w.closest(RT),
r=function(v){return Math.round(v*10)/10};
return{top:r(wr.top-s.top),bottom:r(wr.bottom-s.top),w:r(wr.width),h:r(wr.height),
preTop:r(pr.top-wr.top),preH:r(pr.height),preW:r(pr.width),
btnTop:r(br.top-s.top),btnBottom:r(br.bottom-s.top),inTop:r(br.top-wr.top),inRight:r(wr.right-br.right),
onTop:!!hit&&b.contains(hit),opacity:getComputedStyle(b).opacity,
clip:!!o&&o.hasAttribute("data-ccup-copy-clip"),ovx:o?getComputedStyle(o).overflowX:null,
wide:!!o&&o.scrollWidth-o.clientWidth>1,math:!!o&&!!o.querySelector(".katex")}};
window.__to=function(w,at){var t=__sc();t.scrollTop+=w.getBoundingClientRect().top-t.getBoundingClientRect().top-at};
})()`;

export async function run(ctx) {
  const dir = liveBundleDir();
  const P = loadPatcher();
  const native = {
    js: readFileSync(join(dir, "index.js"), "utf8").replace(FRAG_RE, ""),
    css: readFileSync(join(dir, "index.css"), "utf8").replace(FRAG_RE, ""),
  };
  const patched = P.copyPinWebview(native.js, native.css);
  const hash = (key) =>
    native.js.match(new RegExp(`[,{]${key}:"(${key}_[-\\w]+)"`))?.[1];
  const cls = {
    chat: hash("messagesContainer"),
    sticky: hash("stickyHeader"),
    wrap: hash("codeBlockWrapper"),
    root: `root_${hash("codeBlockWrapper")?.slice("codeBlockWrapper_".length)}`,
    preview: hash("previewBody"),
  };
  console.log(`live bundle: ${dir}`);

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };
  if (!check("the patcher builds both halves", !!patched)) return false;

  const server = createServer((req, res) => {
    const [rel, qs] = req.url.split("?");
    const mode = new URLSearchParams(qs ?? "").get("mode") ?? "native";
    const B = mode === "patched" ? patched : native;
    const head = (type) => ({
      "content-type": type,
      "cache-control": "no-store",
    });
    if (rel === "/wv/index.js")
      res.writeHead(200, head(TYPES[".js"])).end(B.js);
    else if (rel === "/wv/index.css")
      res.writeHead(200, head(TYPES[".css"])).end(B.css);
    else if (rel.startsWith("/wv/")) {
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
    } else res.writeHead(200, head("text/html")).end(page(mode));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  await ctx.cdp("Browser.grantPermissions", {
    origin: base.replace(/\/$/, ""),
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });

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
  const TAGS = ["plain", "math", "wide", "list", "think", "short", ""];
  // A block's geometry with its top `at` px below the scroller's top
  // (negative: scrolled under it), after the watch's frame and the reveal's
  // fade have run.
  const geomAt = async (tag, at, ms = 250) => {
    await ctx.evaluate(`void __to(__block(${JSON.stringify(tag)}),${at})`);
    await ctx.sleep(ms);
    return json(`__geom(__block(${JSON.stringify(tag)}))`);
  };
  const hb = () => json(`__hb()`);
  const mouse = (type, p) =>
    ctx.cdp("Input.dispatchMouseEvent", {
      type,
      x: p.x,
      y: p.y,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;

  const boot = async (mode) => {
    await ctx.navigate(`${base}?mode=${mode}`);
    const up = await until(
      `document.querySelectorAll(".${cls.wrap}").length>=${TAGS.length}`,
      10000,
    );
    if (!up) return false;
    await ctx.evaluate(HELPERS(cls));
    // the thinking block opens like a click on its summary would
    await ctx.evaluate(
      `document.querySelectorAll("details").forEach(function(d){d.open=true})`,
    );
    await ctx.sleep(400);
    return true;
  };

  const seen = {};
  try {
    for (const mode of ["native", "patched"]) {
      const up = await boot(mode);
      const err = await ctx.evaluate(
        `document.getElementById("claude-error").textContent`,
      );
      if (
        !check(
          `${mode}: the transcript renders its code blocks`,
          up,
          err || undefined,
        )
      )
        return false;
      // Math typesets lazily, near the view: bring each math paragraph in
      // first, so the roots read as they will.
      for (const tag of ["math", "wide"]) {
        await geomAt(tag, 400, 100);
        await until(
          `!!__block(${JSON.stringify(tag)}).closest(".${cls.root}").querySelector(".katex")`,
          3000,
        );
      }
      const rest = {};
      for (const tag of TAGS) rest[tag] = await geomAt(tag, 120);
      const under = {};
      for (const tag of ["plain", "math", "wide", "list", "think"])
        under[tag] = { g: await geomAt(tag, -300), h: await hb() };
      seen[mode] = { rest, under };
    }

    // Layout: the patched blocks lay out exactly as the native ones.
    for (const tag of TAGS) {
      const n = seen.native.rest[tag];
      const p = seen.patched.rest[tag];
      const name = tag || "empty";
      check(
        `layout: the ${name} block lays out as natively`,
        ["h", "w", "preTop", "preH", "preW"].every((k) =>
          near(n[k], p[k], 0.11),
        ),
        `native ${n.w}x${n.h} pre ${n.preTop}/${n.preH}, patched ${p.w}x${p.h} pre ${p.preTop}/${p.preH}`,
      );
      for (const [mode, g] of [
        ["native", n],
        ["patched", p],
      ])
        check(
          `layout: ${mode} ${name} button at the block's top right`,
          near(g.inTop, 4) && near(g.inRight, 4),
          `${g.inTop}, ${g.inRight}`,
        );
    }

    // Under the top of the chat: native scrolls the button away, patched pins.
    for (const tag of ["plain", "math", "list", "think"]) {
      const n = seen.native.under[tag];
      const p = seen.patched.under[tag];
      check(
        `native: the ${tag} block's button scrolls away with it`,
        n.g.btnBottom < n.h.bottom,
        `button bottom ${n.g.btnBottom}, header bottom ${n.h.bottom}`,
      );
      check(
        `pinned: the ${tag} block's button sits 4px under the stuck prompt`,
        p.h.height > 0 &&
          near(p.g.btnTop, p.h.bottom + 4) &&
          near(p.g.inRight, 4),
        `button top ${p.g.btnTop}, header bottom ${p.h.bottom}, right inset ${p.g.inRight}`,
      );
      check(
        `pinned: the ${tag} block's button is on top for a click`,
        p.g.onTop,
      );
    }
    const tall = seen.patched.under.plain.h.height;
    const usual = seen.patched.under.list.h.height;
    check(
      "pinned: a taller prompt pushes the button down with it",
      tall > usual + 10,
      `${tall} against ${usual}`,
    );

    // Math roots, on a build that renders math itself (2.1.301 and later).
    const m = seen.patched.under.math.g;
    const w = seen.patched.under.wide.g;
    const wn = seen.native.under.wide.g;
    if (!seen.native.under.math.g.math)
      console.log("SKIP  math: this build renders no math of its own");
    else {
      check(
        "math: a math root holding a code block is clipped, not a scroller",
        m.math && m.clip && m.ovx === "clip" && !m.wide,
        JSON.stringify({ math: m.math, clip: m.clip, ovx: m.ovx }),
      );
      check(
        "math: a root whose math is wider than the chat still scrolls sideways",
        w.math && !w.clip && w.ovx === wn.ovx && w.wide,
        JSON.stringify({
          math: w.math,
          clip: w.clip,
          ovx: w.ovx,
          native: wn.ovx,
        }),
      );
      check(
        "math: and its block's button keeps its native place",
        near(w.inTop, 4) && near(w.inTop, wn.inTop),
        `${w.inTop} against native ${wn.inTop}`,
      );
    }

    // The rest runs on the patched bundle, booted fresh.
    await boot("patched");

    // The end of a block: once the end comes within the button's height of
    // the header, the button leaves with it, up under the header.
    const plainH = (await geomAt("plain", -300)).h;
    const H = (await hb()).bottom;
    const end = await geomAt("plain", H + 20 - plainH);
    check(
      "pinned: the button stops 4px above the block's end",
      near(end.btnBottom, end.bottom - 4) && end.btnTop < H + 4,
      `button ${end.btnTop}-${end.btnBottom}, block bottom ${end.bottom}, header bottom ${H}`,
    );

    // Reveal, the code under the rail, and the copy.
    await geomAt("plain", -300);
    const box = await json(
      `(function(){var w=__block("plain"),r=w.getBoundingClientRect(),b=w.querySelector("button").getBoundingClientRect();` +
        `return{x:r.left+r.width/2,y:b.top+b.height/2,bx:b.left+b.width/2,by:b.top+b.height/2}})()`,
    );
    await mouse("mouseMoved", { x: box.x, y: box.y });
    await ctx.sleep(350);
    const lit = await json(`__geom(__block("plain"))`);
    check(
      "reveal: hovering the block shows the pinned button",
      lit.opacity === "1",
      lit.opacity,
    );
    const under = await json(
      `(function(){var e=document.elementFromPoint(${box.x},${box.y});return !!e&&!!e.closest("pre")})()`,
    );
    check(
      "reveal: the code beside the pinned button is still the code's",
      under,
    );
    const text = await ctx.evaluate(
      `__block("plain").querySelector("pre").textContent`,
    );
    await ctx.cdp("Runtime.evaluate", {
      expression: `navigator.clipboard.writeText("<untouched>")`,
      awaitPromise: true,
      userGesture: true,
    });
    await mouse("mouseMoved", { x: box.bx, y: box.by });
    await mouse("mousePressed", { x: box.bx, y: box.by });
    await mouse("mouseReleased", { x: box.bx, y: box.by });
    await ctx.sleep(300);
    const clip = (
      await ctx.cdp("Runtime.evaluate", {
        expression: `navigator.clipboard.readText()`,
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
      })
    ).result.value;
    check(
      "reveal: a click on the pinned button copies the whole block",
      clip === text && text.includes("plain line 60"),
      `${JSON.stringify(clip.slice(0, 30))}... ${clip.length} chars of ${text.length}`,
    );
    await mouse("mouseMoved", { x: 2, y: 2 });

    // Inner: a block moved into a scroll container of its own, in the chat.
    // The copy is not React's, so it renders nothing the app tracks; the
    // watch sees it come in as it sees any new block.
    await ctx.evaluate(`void (function(){var w=__block("short").cloneNode(true),box=document.createElement("div");
      box.id="ccup-inner";box.style.cssText="overflow:auto;height:240px;margin:0 20px";
      var p=w.querySelector("pre");p.textContent=${JSON.stringify(lines(40, (i) => `inner line ${i}`))};
      box.appendChild(w);__sc().appendChild(box)})()`);
    await ctx.sleep(300);
    await ctx.evaluate(`void (function(){var t=__sc(),b=document.getElementById("ccup-inner");
      t.scrollTop+=b.getBoundingClientRect().top-t.getBoundingClientRect().top-200;b.scrollTop=300})()`);
    await ctx.sleep(300);
    const inner = await json(
      `(function(){var b=document.getElementById("ccup-inner"),w=b.firstChild,r=w.querySelector(".ccup-copy-rail"),` +
        `x=b.getBoundingClientRect(),k=w.querySelector("button").getBoundingClientRect();` +
        `return{mark:!!r&&r.hasAttribute("data-ccup-copy-inner"),top:Math.round((k.top-x.top)*10)/10,` +
        `hb:__hb().height}})()`,
    );
    check(
      "inner: a block in a scroll container of its own is marked",
      inner.mark,
    );
    check(
      "inner: its button pins 4px under that container's top, under no header",
      near(inner.top, 4) && inner.hb > 0,
      `${inner.top} under the container's top, chat header ${inner.hb}`,
    );

    // Preview: an option preview hides the copy button, in both bundles.
    for (const mode of ["native", "patched"]) {
      await boot(mode);
      await until(`!!window.__chan`);
      await ctx.evaluate(
        `deliver({type:"request",channelId:window.__chan,requestId:"card1",` +
          `request:{type:"tool_permission_request",toolName:"AskUserQuestion",` +
          `inputs:${JSON.stringify({ questions: PREVIEW })},suggestions:[],toolUseId:"toolu_1"}})`,
      );
      const shown = await until(
        `!!document.querySelector(".${cls.preview} .${cls.wrap}")`,
        5000,
      );
      const btn = shown
        ? await json(
            `(function(){var b=document.querySelector(".${cls.preview} .${cls.wrap} button");return !!b&&b.getClientRects().length===0})()`,
          )
        : false;
      check(
        `preview: ${mode} option preview shows no copy button`,
        !!shown && btn,
      );
    }
    await ctx.shot("copy-pin");
  } finally {
    server.close();
  }
  return ok;
}
