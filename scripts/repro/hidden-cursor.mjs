// Scenario for scripts/cdp-driver.mjs: a cursor hidden by typing is really
// hidden, on the REAL webview bundle booted against a stub host with dictation
// on, so the input box carries its mic button. macOS hides the cursor on a
// keydown in a text field and shows it on the next move; Chromium never tells
// the page, and whenever layout carries an element under the resting cursor it
// moves :hover there and sends the boundary events (no move). With the pointer
// parked above the composer, typing new lines grows the box until a control
// sits under it, and each check asserts:
//   hidden    nothing reacts: no tooltip, no hover tint, no trusted boundary
//             event reaching the page, the hovered elements marked
//   revealed  a 1px move unmarks them and everything reacts as from any hover
//   visible   with no keydown since the last move (the box grown by inserted
//             text, the find bar opened with Cmd+F), behavior is native
// plus the hand-off (starting to type closes an open tooltip), a motionless
// click while hidden landing where it rests, and a native pass (both halves
// stripped) proving the harness reproduces the unasked popups.
//
//   node scripts/cdp-driver.mjs scripts/repro/hidden-cursor.mjs 760 620
//
// The bundle served is the compiled patcher's own output for the live install
// (hiddenCursorWebview, out/, so compile first), so the scenario runs exactly
// what an apply writes and doubles as the canary for both halves. The live
// bundle is found under ~/.vscode/extensions (newest Claude Code install) or
// via $CCUP_BUNDLE (the webview directory).
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The compiled patcher. The find bar's config build reads its key chord
// settings, so the vscode stand-in answers every setting with its default.
function loadPatcher() {
  const require = createRequire(import.meta.url);
  const Module = require("node:module");
  const load = Module._load;
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
  };
  Module._load = (request, ...rest) =>
    request === "vscode" ? vscode : load(request, ...rest);
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

// A marked line out of a bundle file, the way an apply's restore takes it out.
function stripLine(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return text;
  const start = i > 0 && text[i - 1] === "\n" ? i - 1 : i;
  const end = text.indexOf("\n", i);
  return text.slice(0, start) + (end < 0 ? "" : text.slice(end));
}

// The stub host: just enough of the init state for the chat to mount (see the
// real-webview-mock notes), with speechToTextEnabled so the mic renders.
// Responses go out synchronously, or the first render races ahead of
// get_claude_state.
const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:"SF Mono",monospace;--vscode-editor-font-size:12px;
--vscode-editor-font-weight:normal;--vscode-chat-font-size:13px;--vscode-chat-font-family:system-ui;
--vscode-font-family:system-ui;--vscode-font-size:13px;--vscode-foreground:#cccccc;
--vscode-descriptionForeground:#9d9d9d;--vscode-sideBar-background:#181818;
--vscode-editor-background:#1f1f1f;--vscode-input-background:#262626;--vscode-input-border:#3c3c3c;
--vscode-input-foreground:#cccccc;--vscode-focusBorder:#0078d4;
--vscode-list-activeSelectionBackground:#04395e;--vscode-list-hoverBackground:#2a2d2e;
--vscode-widget-border:#313131;--vscode-menu-background:#1f1f1f;
--vscode-toolbar-hoverBackground:#5a5d5e50;--vscode-icon-foreground:#cccccc;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}'></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
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
          experimentGates: {}, useCtrlEnterToSend: false, speechToTextEnabled: true,
          speechToTextMicDenied: false } };
        break;
      case "get_claude_state":
        resp = { type: "get_claude_state_response",
          config: { experimentGates: {}, models: [MODEL], unavailable_models: [] } };
        break;
      case "list_sessions_request":
        resp = { type: "list_sessions_response", sessions: [], folderKey: "k" };
        break;
      case "get_session_groups":
        resp = { type: "get_session_groups_response", groups: [] };
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

const WRAP = "[class*=micButtonWrapper_]";
const MIC = "[class*=micButton_]";
const TIP = `${WRAP} [class*=micTooltip_]`;
const INPUT = '[aria-label="Message input"]';
const SCROLL = ".ccup-scroll-btn";
const NEXT = '.ccup-find-bar button[aria-label="Next Match"]';
const CLOSE = '.ccup-find-bar button[aria-label="Close"]';
const NOHOVER = "/*ccup:nohover*/:where(:not([data-ccup-nohover]))";

export async function run(ctx) {
  const dir = liveBundleDir();
  const built = loadPatcher().hiddenCursorWebview(
    readFileSync(join(dir, "index.js"), "utf8"),
    readFileSync(join(dir, "index.css"), "utf8"),
  );
  console.log(`live bundle: ${dir}`);

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };
  if (!check("the patcher builds both halves and the tip toggles", !!built))
    return false;
  const gated = built.css.split(NOHOVER).length - 1;
  check("the stylesheet's hover rules carry the gate", gated > 100, gated);
  // The native variant: both halves stripped, the rest as patched.
  const variants = {
    patched: built,
    native: {
      js: stripLine(built.js, "/*ccup:hiddenCursor*/"),
      css: built.css.split(NOHOVER).join(""),
    },
  };
  let serve = variants.patched;

  const server = createServer((req, res) => {
    const rel = req.url.split("?")[0];
    if (rel === "/wv/index.js" || rel === "/wv/index.css") {
      res
        .writeHead(200, { "content-type": TYPES[extname(rel)] })
        .end(rel.endsWith(".js") ? serve.js : serve.css);
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
  const url = `http://127.0.0.1:${server.address().port}/`;

  const until = async (expr, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      const v = await ctx.evaluate(expr);
      if (v) return v;
      await ctx.sleep(100);
    }
    return null;
  };
  const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
  const moveTo = (p) =>
    ctx.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
  const key = async (k, code, vk, modifiers, text) => {
    for (const type of ["keyDown", "keyUp"]) {
      await ctx.cdp("Input.dispatchKeyEvent", {
        type,
        key: k,
        code,
        windowsVirtualKeyCode: vk,
        modifiers,
        ...(type === "keyDown" && text ? { text } : {}),
      });
    }
  };
  const box = async (sel) =>
    JSON.parse(
      await ctx.evaluate(
        `JSON.stringify((function(){var e=${q(sel)};if(!e)return null;` +
          `var r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})())`,
      ),
    );
  const inside = (b, p) =>
    !!b && p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h;
  const center = (b) => ({
    x: Math.round(b.x + b.w / 2),
    y: Math.round(b.y + b.h / 2),
  });
  const hovered = (sel) => ctx.evaluate(`!!${q(sel)}?.matches(":hover")`);
  const marks = () =>
    ctx.evaluate(`document.querySelectorAll("[data-ccup-nohover]").length`);
  const micTip = () =>
    ctx.evaluate(
      `(function(){var s=getComputedStyle(${q(TIP)});return s.opacity+" "+s.visibility})()`,
    );
  const bg = (sel) =>
    ctx.evaluate(`getComputedStyle(${q(sel)}).backgroundColor`);
  const shownTip = (cls) =>
    ctx.evaluate(
      `[...document.querySelectorAll(".${cls}")]` +
        `.filter(function(t){return getComputedStyle(t).display!=="none"})` +
        `.map(function(t){return t.textContent}).join("|")`,
    );
  const focusInput = () => ctx.evaluate(`${q(INPUT)}.focus()`);
  // Counts what reaches el's own listeners, trusted or not.
  const probe = (sel) =>
    ctx.evaluate(
      `(function(){var e=${q(sel)},p={over:0,overTrusted:0,leave:0,click:0};` +
        `e.addEventListener("mouseover",function(v){p.over++;if(v.isTrusted)p.overTrusted++});` +
        `e.addEventListener("mouseleave",function(){p.leave++});` +
        `e.addEventListener("click",function(v){if(v.isTrusted)p.click++});` +
        `window.__probe=p})()`,
    );
  const probed = () => ctx.evaluate(`JSON.stringify(window.__probe)`);

  const boot = async () => {
    await ctx.navigate(url);
    return until(
      `!!document.querySelector("${WRAP}")&&!!document.querySelector("${SCROLL}[data-show]")&&!!${q(INPUT)}`,
    );
  };
  // A park point straight above sel and clear of the CCUP button strip, so
  // the only real move lands on transcript background.
  const parkAbove = async (sel) => {
    const b = await box(sel);
    const strip = await box(SCROLL);
    return { x: Math.round(b.x + b.w / 2), y: Math.round(strip.y - 24) };
  };
  // From a real move to p, add lines until the box carries sel under p, the
  // pointer never moving again. typed: each line is a keydown (an x, then
  // Shift+Enter, the native newline path), which is what hides the cursor;
  // otherwise the lines go in as inserted text, with no keydown at all.
  const growUnder = async (sel, p, typed) => {
    await moveTo(p);
    await ctx.sleep(150);
    await focusInput();
    for (let i = 0; i < 12; i++) {
      if (inside(await box(sel), p)) return true;
      if (typed) {
        await key("x", "KeyX", 88, 0, "x");
        await key("Enter", "Enter", 13, 8, "\r");
      } else await ctx.cdp("Input.insertText", { text: "x\n" });
      await ctx.sleep(120);
    }
    return inside(await box(sel), p);
  };

  try {
    // Native pass: the popups the patch exists to stop.
    serve = variants.native;
    check("native: the chat and composer mount", !!(await boot()));
    let p = await parkAbove(WRAP);
    check(
      "native: typing carries the mic under the resting pointer",
      await growUnder(WRAP, p, true),
    );
    await ctx.sleep(800);
    let s = await micTip();
    check("native: the mic tooltip opens unasked", s === "1 visible", s);
    check(
      "native: and the button tints",
      (await bg(MIC)) !== "rgba(0, 0, 0, 0)",
    );
    check("native: boot again", !!(await boot()));
    p = await parkAbove(SCROLL);
    check(
      "native: typing carries the scroll button under it",
      await growUnder(SCROLL, p, true),
    );
    await ctx.sleep(500);
    let t = await shownTip("ccup-hover-tip");
    check(
      "native: its tip opens unasked",
      t === "Scroll to Bottom",
      t || "none",
    );

    // Patched, hidden then revealed: the mic.
    serve = variants.patched;
    check("patched: the chat and composer mount", !!(await boot()));
    await probe(WRAP);
    p = await parkAbove(WRAP);
    check(
      "mic: typing carries it under the resting pointer",
      await growUnder(WRAP, p, true),
    );
    await ctx.sleep(800);
    check("mic: Chromium hovers it", await hovered(WRAP));
    check(
      "mic: the hovered chain is marked",
      (await marks()) > 3,
      await marks(),
    );
    s = await micTip();
    check("mic: its tooltip stays closed", s === "0 hidden", s);
    let c = await bg(MIC);
    check(
      "mic: and the button keeps its resting look",
      c === "rgba(0, 0, 0, 0)",
      c,
    );
    let pr = JSON.parse(await probed());
    check(
      "mic: no trusted boundary event reached it",
      pr.overTrusted === 0 && pr.over === 0,
      JSON.stringify(pr),
    );
    await moveTo({ x: p.x + 1, y: p.y });
    await ctx.sleep(800);
    check("mic: a 1px move clears every mark", (await marks()) === 0);
    s = await micTip();
    check("mic: the tooltip then opens", s === "1 visible", s);
    c = await bg(MIC);
    check("mic: and the button tints", c !== "rgba(0, 0, 0, 0)", c);
    pr = JSON.parse(await probed());
    check(
      "mic: on the enter the reveal sends",
      pr.over === 1,
      JSON.stringify(pr),
    );

    // The hand-off: hovered by a real move, then typing starts.
    await focusInput();
    await key("x", "KeyX", 88, 0, "x");
    await ctx.sleep(300);
    s = await micTip();
    check("hand-off: a keystroke closes the open tooltip", s === "0 hidden", s);
    pr = JSON.parse(await probed());
    check(
      "hand-off: with a leave sent to it",
      pr.leave >= 1,
      JSON.stringify(pr),
    );

    // Patched, hidden then revealed: the scroll button, plus a click at rest.
    check("patched: boot again for the scroll button", !!(await boot()));
    await probe(SCROLL);
    p = await parkAbove(SCROLL);
    check(
      "scroll button: typing carries it under the resting pointer",
      await growUnder(SCROLL, p, true),
    );
    await ctx.sleep(500);
    check("scroll button: Chromium hovers it", await hovered(SCROLL));
    t = await shownTip("ccup-hover-tip");
    check("scroll button: its tip stays closed", t === "", t || "none");
    for (const type of ["mousePressed", "mouseReleased"]) {
      await ctx.cdp("Input.dispatchMouseEvent", {
        type,
        x: p.x,
        y: p.y,
        button: "left",
        clickCount: 1,
      });
    }
    await ctx.sleep(100);
    pr = JSON.parse(await probed());
    check(
      "scroll button: a click at rest still lands on it",
      pr.click === 1,
      JSON.stringify(pr),
    );
    check(
      "scroll button: and leaves the cursor hidden",
      (await marks()) > 0,
      await marks(),
    );
    await moveTo({ x: p.x + 1, y: p.y });
    await ctx.sleep(500);
    t = await shownTip("ccup-hover-tip");
    check(
      "scroll button: a 1px move opens the tip",
      t === "Scroll to Bottom",
      t || "none",
    );

    // Visible cursor: the box grown with no keydown behaves natively.
    check("visible: boot again", !!(await boot()));
    p = await parkAbove(SCROLL);
    check(
      "visible: inserted text carries the scroll button under the pointer",
      await growUnder(SCROLL, p, false),
    );
    await ctx.sleep(500);
    check("visible: nothing is marked", (await marks()) === 0);
    t = await shownTip("ccup-hover-tip");
    check(
      "visible: the tip opens, as natively",
      t === "Scroll to Bottom",
      t || "none",
    );

    // Find bar: opened by Cmd+F under the pointer, visible and then hidden.
    const chord = await ctx.evaluate(
      `JSON.stringify((window.__ccupFindCfg||{}).open||null)`,
    );
    check("find bar: its config line is in", chord !== "null", chord);
    // A chord is {k: lowercased key, m/c/a/s: meta, ctrl, alt, shift}.
    const open = async () => {
      const ch = JSON.parse(chord)[0];
      const mods =
        (ch.a ? 1 : 0) | (ch.c ? 2 : 0) | (ch.m ? 4 : 0) | (ch.s ? 8 : 0);
      await key(
        ch.k,
        `Key${ch.k.toUpperCase()}`,
        ch.k.toUpperCase().charCodeAt(0),
        mods,
      );
    };
    const isOpen = `!!document.querySelector(".ccup-find-bar[data-open]")`;
    check("find bar: boot again", !!(await boot()));
    await focusInput();
    await open();
    check("find bar: the chord opens the bar", !!(await until(isOpen, 2000)));
    const nb = center(await box(NEXT));
    const cb = center(await box(CLOSE));
    await key("Escape", "Escape", 27, 0);
    check("find bar: Escape closes it", !!(await until(`!${isOpen}`, 2000)));
    await moveTo(nb);
    await ctx.sleep(200);
    await focusInput();
    await open();
    await ctx.sleep(500);
    check(
      "find bar: Next Match opened under the visible pointer",
      await hovered(NEXT),
    );
    t = await shownTip("ccup-find-tip");
    check(
      "find bar: Cmd+F hides no cursor, so its tip opens",
      t === "Next Match",
      t || "none",
    );
    await key("Escape", "Escape", 27, 0);
    await until(`!${isOpen}`, 2000);
    await moveTo(cb);
    await ctx.sleep(200);
    await focusInput();
    await key("x", "KeyX", 88, 0, "x");
    await open();
    await ctx.sleep(500);
    check(
      "find bar: Close opened under the hidden pointer",
      await hovered(CLOSE),
    );
    t = await shownTip("ccup-find-tip");
    check("find bar: then its tip stays closed", t === "", t || "none");
    c = await bg(CLOSE);
    check(
      "find bar: and Close keeps its resting look",
      c === "rgba(0, 0, 0, 0)",
      c,
    );
    await moveTo({ x: cb.x + 1, y: cb.y });
    await ctx.sleep(500);
    t = await shownTip("ccup-find-tip");
    check("find bar: a 1px move opens it", t === "Close", t || "none");
    c = await bg(CLOSE);
    check("find bar: and tints Close", c !== "rgba(0, 0, 0, 0)", c);
  } finally {
    server.close();
  }
  return ok;
}
