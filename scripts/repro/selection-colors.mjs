// Scenario for scripts/cdp-driver.mjs: the editor selection colors, on the REAL
// webview bundle booted against a stub host into a short transcript and framed
// the way VS Code frames a webview, as an iframe under a page that can take the
// focus away. What a selection paints is read off screenshots, since no DOM
// property tells. The checks assert:
//   focused   a selection over agent text paints in the editor's selection
//             color exactly (the native bundle paints the browser's own)
//   runs      selected plain text, a selected link, and selected inline code
//             each keep their own text color
//   image     a selected image (the attachment thumbnail in a user message)
//             takes the color at half strength, not the near-opaque veil a
//             plain rule leaves
//   blur      focus moving to the page above swaps the selection to the
//             editor's inactive color, a selection moved by script while
//             unfocused (the native find) is re-marked where it lands, focus
//             coming back restores the active color, and the mark sits on the
//             selection's subtree, never inside the composer's editable
//   composer  the input box draws its own text transparent over a mirror, so
//             the line paints its selected glyphs itself: they stay legible
//             over the editor color, focused and unfocused alike (natively
//             the translucent highlight let the mirror show through)
//   contrast  under the high-contrast body class the selected text takes the
//             theme's selection foreground
//   native    the unpatched bundle installs nothing and paints its own color
//
//   node scripts/cdp-driver.mjs scripts/repro/selection-colors.mjs 460 640
//
// The bundle served is the compiled patcher's own output for the live install
// (selectionColorsWebview, out/, so compile first), so the scenario runs
// exactly what an apply writes. The live bundle is found under
// ~/.vscode/extensions (newest Claude Code install) or via $CCUP_BUNDLE (the
// webview directory); its own copy of the two lines, if applied, is stripped
// first, so the native pass is native for this point.
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

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

const R = "44444444-4444-4444-8444-444444444444";
// A run of no-break spaces is a glyph-free stretch of selected text: a pixel
// at its middle is the selection color and nothing else. Two of them, one per
// paragraph, so a selection can land on either.
const GAP = "\u00a0".repeat(10);
// A PNG of one color, 48 by 48, attached to the user message: the chat shows
// it as a thumbnail, the one <img> a transcript selection crosses (the
// markdown layer drops data: images from agent text).
const IMG_COLOR = "#ff8800";
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function solidPng(w, h, rgb) {
  const crc32 = (buf) => {
    let c = -1;
    for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array(w).fill(rgb).flat()),
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array(h).fill(row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const TILE_PNG = solidPng(48, 48, [0xff, 0x88, 0x00]).toString("base64");
const REPLY = [
  "Here is the **plan**, with `inline code` and a [link](https://example.com), then a gap:" +
    GAP +
    ":end.",
  "A second paragraph that wraps across a couple of lines in a narrow chat " +
    "panel so the selection spans lines." +
    GAP +
    ":end.",
].join("\n\n");

// The editor colors a theme hands the webview: Dark Modern's, and a
// high-contrast set with the selection foreground HC themes define.
const THEMES = {
  dark: {
    cls: "vscode-dark",
    vars:
      "--vscode-editor-selectionBackground:#264f78;--vscode-editor-inactiveSelectionBackground:#3a3d41;" +
      "--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-foreground:#cccccc",
    sel: "#264f78",
    inactive: "#3a3d41",
  },
  hc: {
    cls: "vscode-high-contrast",
    vars:
      "--vscode-editor-selectionBackground:#ffffff;--vscode-editor-selectionForeground:#000000;" +
      "--vscode-editor-inactiveSelectionBackground:#ffffffb3;" +
      "--vscode-editor-background:#000000;--vscode-sideBar-background:#000000;--vscode-foreground:#ffffff",
    sel: "#ffffff",
    fg: "#000000",
  },
};

// The page above the webview, with an input that can take the focus away.
const frame = (
  mode,
  theme,
  w,
  frameH,
  h,
) => `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#000}
#f{position:absolute;left:0;top:0;width:${w}px;height:${frameH}px;border:0}
#pi{position:absolute;left:10px;top:${h - 45}px;width:120px}
</style></head><body><iframe id="f" src="/app?mode=${mode}&theme=${theme}"></iframe><input id="pi" aria-label="page input"></body></html>`;

// The stub host: just enough of the init state for the chat to mount (see the
// real-webview-mock notes), one session on disk and its transcript in SDK
// message form. The root names the session, so the view opens it at boot, and
// the host reports no plugins, without which every row stays hidden as
// "Waiting for your plugins". Responses go out synchronously, or the first
// render races ahead of get_claude_state.
const app = (mode, theme) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css?mode=${mode}">
<style>
:root{--vscode-editor-font-family:"SF Mono",monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-chat-font-family:system-ui;
--vscode-font-family:system-ui;--vscode-font-size:13px;
--vscode-descriptionForeground:#9d9d9d;--vscode-input-background:#262626;--vscode-input-border:#3c3c3c;
--vscode-input-foreground:#cccccc;--vscode-focusBorder:#0078d4;--vscode-textLink-foreground:#4daafc;
--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;
--vscode-list-hoverBackground:#2a2d2e;--vscode-widget-border:#313131;--vscode-menu-background:#1f1f1f;
--vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-icon-foreground:#cccccc;color-scheme:dark;
${theme.vars}}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="${theme.cls}">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${R}"></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
const R = "${R}", NOW = Date.now();
const at = (i) => new Date(NOW - (4 - i) * 60e3).toISOString();
const MESSAGES = [
  { type: "user", uuid: "u0-0000-4000-8000-000000000000", session_id: R,
    parent_tool_use_id: null, timestamp: at(0),
    message: { role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: ${JSON.stringify(TILE_PNG)} } },
      { type: "text", text: "Show me the plan." }] } },
  { type: "assistant", uuid: "a0-0000-4000-8000-000000000000", session_id: R,
    parent_tool_use_id: null, timestamp: at(1),
    message: { id: "msg_0", type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text: ${JSON.stringify(REPLY)} }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } } },
];
const SESSION = { id: R, summary: "Selection colors", customTitle: "Selection colors",
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

// Reads a screenshot's pixels in the frame page: a [x, y] probe gives the hex
// at that CSS point, a {x, y, w, h, want} probe counts the device pixels of
// that color inside the box (glyphs of a text run keep their color only if
// some pixel of theirs is exactly it).
const SCAN = `async function(data,probes){
var img=new Image();img.src="data:image/png;base64,"+data;await img.decode();
var cv=document.createElement("canvas");cv.width=img.width;cv.height=img.height;
var g=cv.getContext("2d");g.drawImage(img,0,0);var S=devicePixelRatio;
var hex=function(d,o){return"#"+[d[o],d[o+1],d[o+2]].map(function(v){return v.toString(16).padStart(2,"0")}).join("")};
var out={};
for(var k in probes){var p=probes[k];if(!p)continue;
if(Array.isArray(p)){out[k]=hex(g.getImageData(Math.round(p[0]*S),Math.round(p[1]*S),1,1).data,0)}
else{var x=Math.floor(p.x*S),y=Math.floor(p.y*S),w=Math.max(1,Math.ceil(p.w*S)),h=Math.max(1,Math.ceil(p.h*S));
var d=g.getImageData(x,y,w,h).data,n=0,seen={};for(var i=0;i<d.length;i+=4){var c=hex(d,i);if(p.distinct)seen[c]=1;else if(c===p.want)n++}
out[k]=p.distinct?Object.keys(seen).length:n}}
return out}`;

const MARK = "[data-ccup-sel-inactive]";
const INPUT = '[aria-label="Message input"]';

export async function run(ctx) {
  // The headless page counts as focused, so the frame's document.hasFocus()
  // follows where the focus really sits.
  await ctx.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  const dir = liveBundleDir();
  const P = loadPatcher();
  const strip = (s, marker) =>
    s
      .split("\n")
      .filter((l) => !l.startsWith(marker))
      .join("\n");
  const nativeJs = strip(
    readFileSync(join(dir, "index.js"), "utf8"),
    "/*ccup:selectionColors*/",
  );
  const nativeCss = strip(
    readFileSync(join(dir, "index.css"), "utf8"),
    "/*ccup:selectionColorsCss*/",
  );
  const patched = P.selectionColorsWebview(nativeJs, nativeCss);
  const cls = (key) =>
    nativeJs.match(new RegExp(`${key}:"(${key}_[-\\w]+)"`))?.[1];
  const SC = `.${cls("messagesContainer")}`;
  console.log(`live bundle: ${dir}`);

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };
  check(
    "the patcher writes both marked lines",
    patched.js.includes("\n/*ccup:selectionColors*/") &&
      patched.css.includes("\n/*ccup:selectionColorsCss*/"),
  );
  const again = P.selectionColorsWebview(patched.js, patched.css);
  check(
    "a second apply changes nothing",
    again.js === patched.js && again.css === patched.css,
  );

  const { width: W, height: H } = ctx.viewport;
  const FRAME_H = H - 60;
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const mode = u.searchParams.get("mode") === "native" ? "native" : "patched";
    const theme = THEMES[u.searchParams.get("theme")] ?? THEMES.dark;
    const html = { "content-type": "text/html", "cache-control": "no-store" };
    if (u.pathname === "/") {
      res
        .writeHead(200, html)
        .end(frame(mode, u.searchParams.get("theme") ?? "dark", W, FRAME_H, H));
    } else if (u.pathname === "/app") {
      res.writeHead(200, html).end(app(mode, theme));
    } else if (
      u.pathname === "/wv/index.js" ||
      u.pathname === "/wv/index.css"
    ) {
      const js = u.pathname.endsWith(".js");
      const body =
        mode === "native"
          ? js
            ? nativeJs
            : nativeCss
          : patched[js ? "js" : "css"];
      res
        .writeHead(200, {
          "content-type": TYPES[js ? ".js" : ".css"],
          "cache-control": "no-store",
        })
        .end(body);
    } else if (u.pathname.startsWith("/wv/")) {
      let body;
      try {
        body = readFileSync(join(dir, u.pathname.slice(4)));
      } catch {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, {
          "content-type":
            TYPES[extname(u.pathname)] ?? "application/octet-stream",
        })
        .end(body);
    } else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Helpers evaluated inside the frame: w and d are its window and document.
  const PRELUDE =
    `var GAP=${JSON.stringify(GAP)},SC=d.querySelector(${JSON.stringify(SC)});` +
    // Only text the transcript shows: a hidden copy of the source (the raw
    // markdown view keeps one) carries the same run but no box.
    `function shown(n){var r=d.createRange();r.selectNodeContents(n);return r.getBoundingClientRect().width>0}` +
    `function gapNodes(){var it=d.createNodeIterator(SC||d.body,4),n,a=[];while((n=it.nextNode()))if(n.data.indexOf(GAP)>=0&&shown(n))a.push(n);return a}` +
    `function gaps(){return gapNodes().map(function(n){var i=n.data.indexOf(GAP),r=d.createRange();r.setStart(n,i+1);r.setEnd(n,i+GAP.length-1);var b=r.getBoundingClientRect();return{x:b.x,y:b.y,w:b.width,h:b.height}})}` +
    `function box(e){var b=e.getBoundingClientRect();return{x:b.x,y:b.y,w:b.width,h:b.height}}` +
    `function mid(b){return[b.x+b.w/2,b.y+b.h/2]}` +
    `function textRects(n){var r=d.createRange();r.selectNodeContents(n);return Array.prototype.map.call(r.getClientRects(),function(b){return{x:b.x,y:b.y,w:b.width,h:b.height}})}` +
    `function hex(c){var m;if((m=c.match(/^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/)))return"#"+[m[1],m[2],m[3]].map(function(v){return(+v).toString(16).padStart(2,"0")}).join("");` +
    `if((m=c.match(/^color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)/)))return"#"+[m[1],m[2],m[3]].map(function(v){return Math.round(+v*255).toString(16).padStart(2,"0")}).join("");return c}` +
    `function marks(){return Array.prototype.map.call(d.querySelectorAll(${JSON.stringify(MARK)}),function(e){return e===SC?"SC":e.tagName})}` +
    `function editable(){var e=d.querySelector(${JSON.stringify(INPUT)});return e&&(e.matches("[contenteditable]")?e:e.querySelector("[contenteditable]")||e.closest("[contenteditable]"))}`;
  const inner = (body) =>
    ctx.evaluate(
      `(function(){var w=document.getElementById("f").contentWindow,d=w.document;${PRELUDE}${body}})()`,
    );
  const until = async (expr, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      const v = await ctx.evaluate(expr);
      if (v) return v;
      await ctx.sleep(100);
    }
    return null;
  };
  const boot = async (mode, theme) => {
    await ctx.navigate(`${base}/?mode=${mode}&theme=${theme}`);
    const up = await until(
      `(function(){var f=document.getElementById("f"),w=f&&f.contentWindow;if(!w)return false;var d=w.document;${PRELUDE}return !!SC&&gaps().length===2})()`,
    );
    if (!up) {
      // What did render: the app's error sink, the container, and every text
      // node carrying the gap with the chain it sits in.
      const why = await ctx.evaluate(
        `(function(){var f=document.getElementById("f"),w=f&&f.contentWindow;if(!w)return"no frame";var d=w.document;${PRELUDE}` +
          `var e=d.getElementById("claude-error"),it=d.createNodeIterator(d.body,4),n,a=[];` +
          `while((n=it.nextNode()))if(n.data.indexOf(GAP)>=0){var c=[],p=n.parentElement;while(p&&p!==d.body){c.push(p.tagName+"."+String(p.className).slice(0,24));p=p.parentElement}a.push((shown(n)?"shown ":"hidden ")+c.join(" < "))}` +
          `return JSON.stringify({error:e?e.textContent.slice(0,300):null,container:!!SC,gaps:a})})()`,
      );
      await ctx.shot("boot-failed");
      throw new Error(`the transcript never rendered: ${why}`);
    }
    await ctx.sleep(300);
  };
  const click = async (x, y) => {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await ctx.cdp("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
  };
  // A click on the frame's header gives the frame the focus without touching
  // the transcript; one on the page's input takes it away.
  const focusFrame = () => click(W / 2, 12);
  const blurFrame = () => click(30, H - 35);
  const sample = async (probes) => {
    const shot = await ctx.cdp("Page.captureScreenshot", { format: "png" });
    const r = await ctx.cdp("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(${SCAN})(${JSON.stringify(shot.data)},${JSON.stringify(probes)})`,
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  const selectAll = async () => {
    await inner(`w.getSelection().selectAllChildren(SC)`);
    await ctx.sleep(150);
  };

  // --- patched, dark theme ---
  const DARK = THEMES.dark;
  await boot("patched", "dark");
  await focusFrame();
  await selectAll();
  const g = await inner(
    `var a=gaps();return{g0:mid(a[0]),g1:mid(a[1]),hasFocus:d.hasFocus(),flag:w.__ccupSelectionColors===1,marks:marks()}`,
  );
  check("patched: the watch is installed", g.flag && g.hasFocus);
  const runs = await inner(
    `var link=d.querySelector('a[href="https://example.com"]'),code=Array.prototype.find.call(d.querySelectorAll("code"),function(c){return!c.closest("pre")}),n=gapNodes()[1],img=d.querySelector('img[src^="data:"]');` +
      `return{link:link?{box:box(link),color:hex(getComputedStyle(link).color)}:null,code:code?{box:box(code),color:hex(getComputedStyle(code).color)}:null,` +
      `para:{rect:textRects(n)[0],color:hex(getComputedStyle(n.parentElement).color)},img:img?mid(box(img)):null}`,
  );
  const px = await sample({
    g0: g.g0,
    g1: g.g1,
    para: { ...runs.para.rect, want: runs.para.color },
    link: runs.link && { ...runs.link.box, want: runs.link.color },
    code: runs.code && { ...runs.code.box, want: runs.code.color },
    img: runs.img,
  });
  check(
    "focused: a selection paints in the editor's selection color",
    px.g0 === DARK.sel && px.g1 === DARK.sel && g.marks.length === 0,
    `${px.g0} ${px.g1}`,
  );
  check(
    "runs: selected plain text keeps its color",
    px.para > 0,
    `${px.para} px of ${runs.para.color}`,
  );
  check(
    "runs: a selected link keeps its color",
    !!runs.link && px.link > 0,
    runs.link ? `${px.link} px of ${runs.link.color}` : "no link rendered",
  );
  check(
    "runs: selected inline code keeps its color",
    !!runs.code && px.code > 0,
    runs.code
      ? `${px.code} px of ${runs.code.color}`
      : "no inline code rendered",
  );
  if (runs.img) {
    // Half strength: the tile's red channel stays above half, where a plain
    // rule's veil would pull it under a quarter (0x33 of 0xff measured).
    check(
      "image: a selected image takes the color at half strength",
      px.img !== IMG_COLOR && parseInt(px.img.slice(1, 3), 16) >= 0x80,
      px.img,
    );
  } else console.log("SKIP  image: the attachment rendered no thumbnail");

  // Focus leaves the frame: the inactive color, the mark on the selection's
  // common ancestor (the container itself for a select-all).
  await blurFrame();
  await ctx.sleep(150);
  const b = await inner(`return{hasFocus:d.hasFocus(),marks:marks()}`);
  const pb = await sample({ g0: g.g0, g1: g.g1 });
  check(
    "blur: the selection swaps to the editor's inactive color",
    !b.hasFocus &&
      pb.g0 === DARK.inactive &&
      pb.g1 === DARK.inactive &&
      b.marks.join() === "SC",
    `${pb.g0} ${pb.g1} marks=${b.marks.join()}`,
  );
  // The native find moves the selection by script while the frame stays
  // unfocused: the mark follows to the new ancestor.
  await inner(
    `var n=gapNodes()[1],r=d.createRange();r.selectNodeContents(n);var s=w.getSelection();s.removeAllRanges();s.addRange(r)`,
  );
  await ctx.sleep(150);
  const m2 = await inner(
    `var m=d.querySelector(${JSON.stringify(MARK)});return{count:marks().length,onPara:!!m&&m===gapNodes()[1].parentElement}`,
  );
  const pm = await sample({ g0: g.g0, g1: g.g1 });
  check(
    "blur: a selection moved while unfocused is re-marked where it lands",
    m2.count === 1 && m2.onPara && pm.g1 === DARK.inactive,
    `${pm.g0} ${pm.g1} count=${m2.count}`,
  );
  // Focus comes back the way VS Code hands it back, through window.focus().
  // The chat then focuses its composer, which takes the document selection
  // with it, so the active color is read off a selection made again.
  await inner(`w.focus()`);
  await ctx.sleep(150);
  const f2 = await inner(
    `var a=d.activeElement,s=w.getSelection();return{hasFocus:d.hasFocus(),marks:marks(),active:a?a.tagName+"["+(a.getAttribute("aria-label")||"")+"]":null,kept:!s.isCollapsed&&!!s.anchorNode&&SC.contains(s.anchorNode)}`,
  );
  await inner(
    `var n=gapNodes()[1],r=d.createRange();r.selectNodeContents(n);var s=w.getSelection();s.removeAllRanges();s.addRange(r)`,
  );
  await ctx.sleep(150);
  const pf = await sample({ g1: g.g1 });
  check(
    "focus back: the mark is gone and a selection paints the active color",
    f2.hasFocus && f2.marks.length === 0 && pf.g1 === DARK.sel,
    `${pf.g1} marks=${f2.marks.join()} focus=${f2.active} kept=${f2.kept}`,
  );
  // A selection inside the composer. Its editable draws its own text
  // transparent over a mirror sibling, the construction the line's composer
  // rule is for: the selected glyphs have to stay legible over the editor
  // color, focused and unfocused alike, and the mark goes on the editable's
  // parent, never into the editor's own DOM.
  const COMPOSER_SEL =
    `var e=editable(),t=e.firstChild,r=d.createRange();r.setStart(t,0);r.setEnd(t,15);` +
    `var s=w.getSelection();s.removeAllRanges();s.addRange(r);var b=r.getBoundingClientRect();` +
    `return{rect:{x:b.x,y:b.y,w:b.width,h:b.height},transparent:getComputedStyle(e).color==="rgba(0, 0, 0, 0)",` +
    `mirror:!!d.querySelector("[class*=mentionMirror_]"),fg:hex(getComputedStyle(d.querySelector("[class*=mentionMirror_]")||e.parentElement).color)}`;
  const ib = await inner(`var e=editable();return e?box(e):null`);
  if (check("the composer's editable is up", !!ib)) {
    await click(ib.x + ib.w / 2, ib.y + ib.h / 2);
    await ctx.insertText("hello selection colors");
    const cs = await inner(COMPOSER_SEL);
    await ctx.sleep(150);
    check(
      "composer: the editable draws its text transparent over a mirror",
      cs.transparent && cs.mirror,
      `transparent=${cs.transparent} mirror=${cs.mirror}`,
    );
    const pc = await sample({
      fg: { ...cs.rect, want: cs.fg },
      bg: { ...cs.rect, want: DARK.sel },
    });
    check(
      "composer: selected text stays legible over the editor color",
      pc.fg > 0 && pc.bg > 0,
      `${pc.fg} px of ${cs.fg}, ${pc.bg} px of ${DARK.sel}`,
    );
    await blurFrame();
    await ctx.sleep(150);
    const c = await inner(
      `var e=editable(),m=d.querySelector(${JSON.stringify(MARK)});return{count:marks().length,inside:!!e.querySelector(${JSON.stringify(MARK)}),self:e.hasAttribute("data-ccup-sel-inactive"),onParent:!!m&&m===e.parentElement,collapsed:w.getSelection().isCollapsed}`,
    );
    check(
      "blur: a selection in the composer marks its wrapper, not the editable",
      c.count === 1 && !c.inside && !c.self && c.onParent,
      `count=${c.count} inside=${c.inside} self=${c.self} onParent=${c.onParent} collapsed=${c.collapsed}`,
    );
    const pcb = await sample({
      fg: { ...cs.rect, want: cs.fg },
      bg: { ...cs.rect, want: DARK.inactive },
    });
    check(
      "composer: unfocused, the inactive color keeps the text legible",
      pcb.fg > 0 && pcb.bg > 0,
      `${pcb.fg} px of ${cs.fg}, ${pcb.bg} px of ${DARK.inactive}`,
    );
  }

  // --- patched, high contrast ---
  const HC = THEMES.hc;
  await boot("patched", "hc");
  await focusFrame();
  await selectAll();
  const hc = await inner(
    `var a=gaps(),n=gapNodes()[1];return{g1:mid(a[1]),rect:textRects(n)[0],hcClass:d.body.classList.contains("vscode-high-contrast")}`,
  );
  const ph = await sample({ g1: hc.g1, fg: { ...hc.rect, want: HC.fg } });
  check(
    "contrast: selected text takes the theme's selection foreground",
    hc.hcClass && ph.g1 === HC.sel && ph.fg > 0,
    `${ph.g1} ${ph.fg} px of ${HC.fg}`,
  );
  // The composer's own rule gives way to the selection foreground here, so
  // its selected text reads in that color, not in the mirror's input white.
  const hib = await inner(`var e=editable();return e?box(e):null`);
  if (hib) {
    await click(hib.x + hib.w / 2, hib.y + hib.h / 2);
    await ctx.insertText("hello selection colors");
    const hcs = await inner(COMPOSER_SEL);
    await ctx.sleep(150);
    const hp = await sample({
      fg: { ...hcs.rect, want: HC.fg },
      bg: { ...hcs.rect, want: HC.sel },
    });
    check(
      "contrast: the composer's selected text takes the selection foreground",
      hp.fg > 0 && hp.bg > 0,
      `${hp.fg} px of ${HC.fg}, ${hp.bg} px of ${HC.sel}`,
    );
  }

  // --- native, dark theme ---
  await boot("native", "dark");
  await focusFrame();
  await selectAll();
  const nv = await inner(
    `var a=gaps();return{g0:mid(a[0]),flag:w.__ccupSelectionColors===void 0}`,
  );
  const pn = await sample({ g0: nv.g0 });
  await blurFrame();
  await ctx.sleep(150);
  const nb = await inner(`return marks().length`);
  check(
    "native: the unpatched bundle installs nothing and paints its own color",
    nv.flag && pn.g0 !== DARK.sel && nb === 0,
    `${pn.g0} marks=${nb}`,
  );
  // Natively the composer's highlight is translucent, so the mirror's text
  // shows through it and the selection is no single flat color: what the
  // editor's opaque color took away, and the composer rule gives back.
  const nib = await inner(`var e=editable();return e?box(e):null`);
  if (nib) {
    await click(nib.x + nib.w / 2, nib.y + nib.h / 2);
    await ctx.insertText("hello selection colors");
    const ncs = await inner(COMPOSER_SEL);
    await ctx.sleep(150);
    const np = await sample({ colors: { ...ncs.rect, distinct: true } });
    check(
      "native: the composer's translucent highlight lets the mirror through",
      np.colors > 1,
      `${np.colors} colors in the selection`,
    );
  }

  server.close();
  return ok;
}
