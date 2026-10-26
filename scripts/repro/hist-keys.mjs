// Scenario for scripts/cdp-driver.mjs: the recall keys of
// chatInputCtrlUpDownToHistory and the caret chords they bring on macOS, on
// the REAL webview bundle booted against a stub host into a session with three
// sent prompts, so the recall pair has a history to cycle. Real key events
// drive the input box, and the checks assert:
//   caret     with a draft taller than the box, Cmd+Ctrl+A puts the caret
//             before the draft's first character and scrolls the box to its
//             top, and Cmd+Ctrl+E puts it after the last character and scrolls
//             to the bottom, from the end, the start, and the middle, the
//             text unchanged and the focus kept
//   mirror    the painted text layer follows each scroll
//   exact     Shift or Option added to the chord, or Ctrl+A alone, moves
//             nothing
//   recall    plain Up/Down only move the caret (at the draft's very start
//             too), Cmd+Up from the middle recalls the last prompt, and
//             Cmd+Down brings the draft back
//   gate      with the slash command menu up, the chord moves nothing
//   native    with the setting off, Cmd+Ctrl+A moves nothing
//
//   node scripts/cdp-driver.mjs scripts/repro/hist-keys.mjs 760 620
//
// The bundle served is the compiled patcher's own output for the live install
// (histKeysWebview, out/, so compile first), so the scenario runs exactly what
// an apply writes and doubles as the drift canary. The caret branch is baked
// on macOS only, and so is this run. The live bundle is found under
// ~/.vscode/extensions (newest Claude Code install) or via $CCUP_BUNDLE (the
// webview directory).
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

const R = "44444444-4444-4444-8444-444444444444";
const PROMPTS = [
  "Summarize the README in one paragraph.",
  "Add tests for the parser.",
  "Ship it.",
];
// Forty lines overflow the box at any line cap (the cap is clamped to 70% of
// the window height), and the last line ends in a letter, so the end of the
// text is the end of a line box.
const LINES = Array.from(
  { length: 40 },
  (_, i) => `line ${i + 1} of the draft`,
);
const DRAFT = LINES.join("\n");

// The stub host: just enough of the init state for the chat to mount (see the
// real-webview-mock notes), one session on disk and its transcript in SDK
// message form. The root names the session, so the view opens it at boot, and
// the host reports no plugins, without which every row stays hidden as
// "Waiting for your plugins". Responses go out synchronously, or the first
// render races ahead of get_claude_state.
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
const PROMPTS = ${JSON.stringify(PROMPTS)};
const at = (i) => new Date(NOW - (PROMPTS.length - i) * 60e3).toISOString();
const MESSAGES = PROMPTS.flatMap((p, i) => [
  { type: "user", uuid: "u" + i + "-0000-4000-8000-000000000000", session_id: R,
    parent_tool_use_id: null, timestamp: at(i),
    message: { role: "user", content: [{ type: "text", text: p }] } },
  { type: "assistant", uuid: "a" + i + "-0000-4000-8000-000000000000", session_id: R,
    parent_tool_use_id: null, timestamp: at(i),
    message: { id: "msg_" + i, type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text: "Reply " + (i + 1) + "." }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } } },
]);
const SESSION = { id: R, summary: "Recall keys", customTitle: "Recall keys",
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
<script type="module" src="/wv/index.js"></script>
</body></html>`;

const TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

const INPUT = '[aria-label="Message input"]';
const MIRROR = "[class*=mentionMirror_]";
// CDP modifier bits.
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

export async function run(ctx) {
  if (process.platform !== "darwin") {
    console.log("SKIP  the caret chords are baked on macOS only");
    return true;
  }
  const dir = liveBundleDir();
  const P = loadPatcher();
  const live = readFileSync(join(dir, "index.js"), "utf8");
  const variants = {
    patched: P.histKeysWebview(live, true),
    native: P.histKeysWebview(live, false),
  };
  const HDR = `.${live.match(/stickyHeader:"(stickyHeader_[-\w]+)"/)?.[1]}`;
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
      "the patcher builds the bundle with the setting on and off",
      !!variants.patched && !!variants.native,
    ) ||
    !check(
      "the on form carries the caret branch",
      variants.patched.includes("/*ccup:histKeysCaret*/"),
    )
  )
    return false;
  let serve = variants.patched;

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
  const key = async (k, code, vk, modifiers = 0, text) => {
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
  // A letter chord, then a beat for the scroll event to reach the mirror.
  const chord = async (letter, modifiers) => {
    const up = letter.toUpperCase();
    await key(letter, `Key${up}`, up.charCodeAt(0), modifiers);
    await ctx.sleep(150);
  };
  const arrow = async (dir, times = 1, modifiers = 0) => {
    for (let i = 0; i < times; i++) {
      await key(
        `Arrow${dir}`,
        `Arrow${dir}`,
        dir === "Up" ? 38 : 40,
        modifiers,
      );
    }
    await ctx.sleep(150);
  };
  // The caret as a text offset into the input box, the box's scroll against
  // its range, the mirror's scroll, and whether the first and last characters
  // sit inside the box.
  const state = () =>
    json(
      `(function(){var el=${q(INPUT)},mi=${q(MIRROR)},s=getSelection(),t=el.textContent,c=-1;` +
        `if(s.rangeCount&&el.contains(s.focusNode)){var r=document.createRange();` +
        `r.selectNodeContents(el);r.setEnd(s.focusNode,s.focusOffset);c=r.toString().length}` +
        `var box=el.getBoundingClientRect();` +
        `function charIn(i){var w=document.createTreeWalker(el,4),n,k=i;while((n=w.nextNode())){` +
        `if(k<n.length){var g=document.createRange();g.setStart(n,k);g.setEnd(n,k+1);` +
        `var b=g.getBoundingClientRect();return b.top>=box.top-0.5&&b.bottom<=box.bottom+0.5}` +
        `k-=n.length}return!1}` +
        `return{text:t,len:t.length,caret:c,collapsed:s.isCollapsed,top:el.scrollTop,` +
        `max:el.scrollHeight-el.clientHeight,mirror:mi?mi.scrollTop:null,` +
        `firstIn:charIn(0),lastIn:charIn(t.length-1),focus:document.activeElement===el}})()`,
    );
  const boot = async () => {
    await ctx.navigate(base);
    return until(
      `!!${q(INPUT)}&&document.querySelectorAll(${JSON.stringify(HDR)}).length===${PROMPTS.length}&&` +
        `getComputedStyle(${q(HDR)}).visibility==="visible"`,
    );
  };
  // The draft typed as a user types it: each line inserted, Shift+Enter
  // between them.
  const typeDraft = async () => {
    await ctx.evaluate(`${q(INPUT)}.focus()`);
    for (let i = 0; i < LINES.length; i++) {
      if (i) await key("Enter", "Enter", 13, SHIFT, "\r");
      await ctx.insertText(LINES[i]);
    }
    await ctx.sleep(200);
  };
  const atStart = (s) =>
    s.caret === 0 && s.collapsed && s.top === 0 && s.firstIn;
  const atEnd = (s) =>
    s.caret === s.len &&
    s.collapsed &&
    Math.abs(s.top - s.max) <= 1 &&
    s.lastIn;
  // Typing's own reveal fits the caret's rect, not its line box, so it can
  // stop a couple of px short of the bottom: compare against where it was.
  const unmoved = (a, b) =>
    a.text === b.text && a.caret === b.caret && a.top === b.top;
  const where = (s) =>
    `caret ${s.caret}/${s.len}, scroll ${s.top}/${s.max}, mirror ${s.mirror}`;

  try {
    check("the transcript and the input box mount", !!(await boot()));
    await typeDraft();
    let s = await state();
    check("the draft reads back as typed", s.text === DRAFT, s.len);
    check("the draft overflows the box", s.max > 0, `range ${s.max}`);
    check(
      "typing leaves the caret at the end, in view",
      s.caret === s.len && s.lastIn,
      where(s),
    );

    // From the end to the start and back.
    await chord("a", META | CTRL);
    s = await state();
    check(
      "Cmd+Ctrl+A from the end: caret and box at the start",
      atStart(s),
      where(s),
    );
    check("  the mirror follows to the top", s.mirror === s.top, where(s));
    check("  the text and the focus stay", s.text === DRAFT && s.focus);
    await ctx.shot("start");
    await arrow("Up");
    s = await state();
    check(
      "plain Up at the very start keeps the draft",
      s.text === DRAFT,
      where(s),
    );
    await chord("e", META | CTRL);
    s = await state();
    check(
      "Cmd+Ctrl+E from the start: caret and box at the end",
      atEnd(s),
      where(s),
    );
    check(
      "  the mirror follows to the bottom",
      Math.abs(s.mirror - s.top) <= 1,
      where(s),
    );
    check("  the text and the focus stay", s.text === DRAFT && s.focus);
    await ctx.shot("end");
    await arrow("Down");
    s = await state();
    check(
      "plain Down at the very end keeps the draft",
      s.text === DRAFT,
      where(s),
    );

    // From the middle, each way.
    await arrow("Up", 15);
    s = await state();
    check(
      "plain Up moves the caret into the middle, no recall",
      s.text === DRAFT && s.caret > 0 && s.caret < s.len,
      where(s),
    );
    await chord("a", META | CTRL);
    s = await state();
    check("Cmd+Ctrl+A from the middle: at the start", atStart(s), where(s));
    await arrow("Down", 15);
    s = await state();
    check(
      "plain Down moves the caret into the middle, no recall",
      s.text === DRAFT && s.caret > 0 && s.caret < s.len,
      where(s),
    );
    await chord("e", META | CTRL);
    s = await state();
    check("Cmd+Ctrl+E from the middle: at the end", atEnd(s), where(s));

    // Only the exact chord.
    for (const [name, mods] of [
      ["Shift+Cmd+Ctrl+A", SHIFT | META | CTRL],
      ["Option+Cmd+Ctrl+A", ALT | META | CTRL],
      ["Ctrl+A", CTRL],
    ]) {
      const was = await state();
      await chord("a", mods);
      s = await state();
      check(`${name} moves nothing`, unmoved(s, was), where(s));
    }

    // The recall pair still recalls from anywhere.
    await arrow("Up", 5);
    await arrow("Up", 1, META);
    await ctx.sleep(150);
    s = await state();
    check(
      "Cmd+Up from the middle recalls the last prompt",
      s.text === PROMPTS[PROMPTS.length - 1],
      JSON.stringify(s.text.slice(0, 40)),
    );
    await arrow("Down", 1, META);
    await ctx.sleep(150);
    s = await state();
    check("Cmd+Down brings the draft back", s.text === DRAFT, s.len);

    // An open slash command menu keeps the chord out, as it does the recall.
    await ctx.evaluate(`document.execCommand("selectAll")`);
    await key("Backspace", "Backspace", 8);
    await ctx.insertText("/");
    const menu = await until(
      `${q(INPUT)}.getAttribute("aria-autocomplete")==="list"`,
      3000,
    );
    check("typing / opens the slash command menu", !!menu);
    await chord("a", META | CTRL);
    s = await state();
    check(
      "Cmd+Ctrl+A with the menu up moves nothing",
      s.text === "/" && s.caret === 1,
      where(s),
    );
    await key("Escape", "Escape", 27);

    // With the setting off the chord is the browser's, which has nothing for it.
    serve = variants.native;
    check("native: the transcript and the input box mount", !!(await boot()));
    await typeDraft();
    const was = await state();
    await chord("a", META | CTRL);
    s = await state();
    check(
      "native: Cmd+Ctrl+A moves nothing",
      s.text === DRAFT && unmoved(s, was),
      where(s),
    );
  } finally {
    server.close();
  }
  console.log(ok ? "\nOK" : "\nFAIL");
  return ok;
}
