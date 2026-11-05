// Scenario for scripts/cdp-driver.mjs: the always-on card text fix, on the
// REAL webview bundle booted against a stub host that raises permission and
// question cards in place of the input box. Real mouse presses, drags, and
// keys drive both bundles, native and patched, and the checks assert:
//   native     a drag across the question text selects nothing, and a drag
//              across an option's label picks the option (the canaries: once
//              they stop reproducing, Claude Code has changed the card)
//   select     a drag across the question text, an option preview, the Bash
//              card's header, or a WebFetch card's URL selects exactly that
//              text, and Copy puts it on the clipboard
//   options    a drag across an option's label, or from its label into its
//              description, selects the text and picks nothing, so the card
//              stays on its question; a click on that row's radio, a plain
//              click on a label, and a double click on a word still pick it,
//              as natively
//   clicks     a plain click on the card's text leaves focus where the card's
//              own handoff sends it: to the first option or the Yes button
//              (the latter as natively), and back to the permission feedback
//              box (as natively) or the question's "Other" box with the caret
//              where it was, so typing goes on there
//   keys       after a drag, the card still takes Escape
//
//   node scripts/cdp-driver.mjs scripts/repro/card-text.mjs 520 700
//
// The patched bundle served is the compiled patcher's own output for the live
// install (cardTextWebview, out/, so compile first), so the scenario runs
// exactly what an apply writes and doubles as the drift canary. The native
// bundle is the live one with this point's lines stripped. The live bundle is
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

// This point's lines in an installed bundle.
const LINE_RE = /\n\/\*ccup:cardText(?:Css)?\*\/[^\n]*/g;

const R = "44444444-4444-4444-8444-444444444444";
const CMD = "security add-generic-password -s corroborate-stanford -a $USER -w";
const QTEXT =
  "Which macOS keychain item holds the gateway key? If no item exists yet, " +
  "create one with `" +
  CMD +
  "` and answer `corroborate-stanford`.";
// Two single-select questions, so a pick on the first moves on to the second.
const TWO = [
  {
    question: QTEXT,
    header: "Keychain item",
    multiSelect: false,
    options: [
      {
        label: "corroborate-stanford",
        description: "The item the command above creates",
      },
      {
        label: "stanford-gateway",
        description: "An item from an earlier setup",
      },
    ],
  },
  {
    question: "Second question?",
    header: "Second",
    multiSelect: false,
    options: [
      { label: "Yes", description: "Go on" },
      { label: "No", description: "Stop here" },
    ],
  },
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
const URL_TEXT = "https://example.com/docs/keychain";

// The stub host: just enough of the init state for the chat to mount (see the
// real-webview-mock notes), one session with a short transcript, and no
// plugins. Responses go out synchronously, or the first render races ahead of
// get_claude_state. Cards arrive as tool_permission_request pushes on the
// session's channel.
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
const MESSAGES = [
  { type: "user", uuid: "7a1c0e52-0000-4000-8000-000000000001", session_id: R,
    parent_tool_use_id: null, timestamp: new Date(NOW - 60e3).toISOString(),
    message: { role: "user", content: [{ type: "text", text: "Set up the gateway key." }] } },
  { type: "assistant", uuid: "7a1c0e52-0000-4000-8000-000000000002", session_id: R,
    parent_tool_use_id: null, timestamp: new Date(NOW - 50e3).toISOString(),
    message: { id: "msg_1", type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text: "I need one detail first." }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } } },
];
const SESSION = { id: R, summary: "Gateway key", customTitle: "Gateway key",
  lastModified: NOW, lastActivity: NOW, archived: false, fileSize: 4096,
  gitBranch: "develop", isCurrentWorkspace: true };
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

export async function run(ctx) {
  const dir = liveBundleDir();
  const P = loadPatcher();
  const native = {
    js: readFileSync(join(dir, "index.js"), "utf8").replace(LINE_RE, ""),
    css: readFileSync(join(dir, "index.css"), "utf8").replace(LINE_RE, ""),
  };
  const patched = P.cardTextWebview(native.js, native.css);
  const cls = (key) =>
    native.js.match(new RegExp(`[,{]${key}:"(${key}_[-\\w]+)"`))?.[1];
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
    const B =
      new URLSearchParams(qs ?? "").get("mode") === "patched"
        ? patched
        : native;
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
    } else
      res
        .writeHead(200, head("text/html"))
        .end(page(new URLSearchParams(qs ?? "").get("mode") ?? "native"));
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
  const mouse = (type, p, extra = {}) =>
    ctx.cdp("Input.dispatchMouseEvent", {
      type,
      x: p.x,
      y: p.y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
      ...extra,
    });
  const drag = async (a, b) => {
    await mouse("mouseMoved", a, { button: "none", buttons: 0 });
    await mouse("mousePressed", a);
    for (let i = 1; i <= 8; i++) {
      await mouse("mouseMoved", {
        x: a.x + ((b.x - a.x) * i) / 8,
        y: a.y + ((b.y - a.y) * i) / 8,
      });
    }
    await mouse("mouseReleased", b);
    await ctx.sleep(120);
  };
  const click = async (p, count = 1) => {
    await mouse("mouseMoved", p, { button: "none", buttons: 0 });
    for (let c = 1; c <= count; c++) {
      await mouse("mousePressed", p, { clickCount: c });
      await mouse("mouseReleased", p, { clickCount: c });
    }
    await ctx.sleep(120);
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
    await ctx.sleep(80);
  };
  const type = async (text) => {
    await ctx.cdp("Input.insertText", { text });
    await ctx.sleep(120);
  };
  // Points just inside the first and the last character of `needle`, in the
  // first text node under any `sel` element that holds it.
  const span = (sel, needle) =>
    json(
      `(function(){var es=document.querySelectorAll(${JSON.stringify(sel)}),k,n,w,i,r,a,b;` +
        `for(k=0;k<es.length;k++){w=document.createTreeWalker(es[k],NodeFilter.SHOW_TEXT);` +
        `while((n=w.nextNode())){i=n.data.indexOf(${JSON.stringify(needle)});if(i<0)continue;` +
        `r=document.createRange();r.setStart(n,i);r.setEnd(n,i+1);a=r.getClientRects()[0];` +
        `r.setStart(n,i+${needle.length}-1);r.setEnd(n,i+${needle.length});b=r.getClientRects()[0];` +
        `return{a:{x:a.left+1,y:a.top+a.height/2},b:{x:b.right-1,y:b.top+b.height/2}}}}return null})()`,
    );
  const mid = (s) => ({ x: (s.a.x + s.b.x) / 2, y: s.a.y });
  const center = (sel, i = 0) =>
    json(
      `(function(){var e=document.querySelectorAll(${JSON.stringify(sel)})[${i}];if(!e)return null;` +
        `var r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );

  const CARD = `.${cls("permissionRequestContainer")}`;
  const QT = `.${cls("questionTextLarge")}`;
  const LABEL = `.${cls("optionLabel")}`;
  const DESC = `.${cls("optionDescription")}`;
  const RADIO = `.${cls("radio")}`;
  const OTHER = `.${cls("otherInput")}`;
  const PREV = `.${cls("previewBody")}`;
  const HEADER = `.${cls("permissionRequestHeader")}`;
  const INPUT = `.${cls("permissionRequestInput")}`;
  const FEEDBACK = `.${cls("rejectMessageInput")}`;
  // The selection's text, what has focus, which options are picked, and the
  // question on screen.
  const state = () =>
    json(
      `(function(){var a=document.activeElement,q=document.querySelector(${JSON.stringify(QT)});` +
        `return{sel:getSelection().toString(),` +
        `focus:!a?"none":a.matches(${JSON.stringify(CARD)})?"card":a.getAttribute("role")==="radio"?` +
        `"option"+Array.prototype.indexOf.call(document.querySelectorAll('[role="radio"]'),a):` +
        `a.matches(${JSON.stringify(FEEDBACK)})||a.closest(${JSON.stringify(FEEDBACK)})?"feedback":` +
        `a.closest(${JSON.stringify(OTHER)})?"other":a.tagName==="BUTTON"?"button:"+a.textContent.trim():a.tagName,` +
        `picked:Array.prototype.map.call(document.querySelectorAll('[role="radio"]'),function(e){return e.getAttribute("aria-checked")==="true"?1:0}).join(""),` +
        `q:q?q.textContent.slice(0,16):null}})()`,
    );
  // Copy as VS Code does it (execCommand on the frame), read back from the
  // clipboard.
  const copied = async () => {
    await ctx.cdp("Runtime.evaluate", {
      expression: `navigator.clipboard.writeText("<untouched>")`,
      awaitPromise: true,
      userGesture: true,
    });
    await ctx.cdp("Runtime.evaluate", {
      expression: `document.execCommand("copy")`,
      userGesture: true,
    });
    const r = await ctx.cdp("Runtime.evaluate", {
      expression: `navigator.clipboard.readText()`,
      awaitPromise: true,
      userGesture: true,
      returnByValue: true,
    });
    return r.result.value;
  };

  const boot = async (mode) => {
    await ctx.navigate(`${base}?mode=${mode}`);
    if (
      !(await until(`!!document.querySelector('[aria-label="Message input"]')`))
    )
      return false;
    return !!(await until(`!!window.__chan`));
  };
  let rid = 0;
  const raise = async (toolName, inputs, sel) => {
    rid++;
    await ctx.evaluate(
      `deliver({type:"request",channelId:window.__chan,requestId:"card${rid}",` +
        `request:{type:"tool_permission_request",toolName:${JSON.stringify(toolName)},` +
        `inputs:${JSON.stringify(inputs)},suggestions:[],toolUseId:"toolu_${rid}"}})`,
    );
    const up = await until(`!!document.querySelector(${JSON.stringify(sel)})`);
    await ctx.sleep(900); // past the card's 500ms arming
    return !!up;
  };
  // A fresh view with one card up.
  const fresh = async (mode, toolName, inputs, sel) =>
    (await boot(mode)) && (await raise(toolName, inputs, sel));
  const ask = (mode, questions = TWO) =>
    fresh(mode, "AskUserQuestion", { questions }, QT);
  const bash = (mode) =>
    fresh(
      mode,
      "Bash",
      { command: "ls -la /tmp", description: "List the temp directory" },
      HEADER,
    );

  await ctx.cdp("Browser.grantPermissions", {
    origin: base.replace(/\/$/, ""),
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });

  try {
    // Native: the canaries.
    if (!check("native: the question card comes up", await ask("native")))
      return false;
    let s = await span(QT, CMD);
    await drag(s.a, s.b);
    let st = await state();
    check(
      "native: a drag across the question text selects nothing",
      st.sel === "",
      st.sel,
    );
    check("native: and Copy takes nothing", (await copied()) === "<untouched>");
    await ask("native");
    await drag(...Object.values(await span(LABEL, "corroborate-stanford")));
    st = await state();
    check(
      "native: a drag across an option's label picks it",
      st.picked === "100",
      JSON.stringify(st),
    );

    // Patched: select and copy.
    if (!check("patched: the question card comes up", await ask("patched")))
      return false;
    s = await span(QT, CMD);
    await drag(s.a, s.b);
    st = await state();
    check(
      "select: a drag across the command in the question selects exactly it",
      st.sel === CMD,
      st.sel,
    );
    check("select: focus stays on the card", st.focus === "card", st.focus);
    const clip = await copied();
    check("select: Copy puts the command on the clipboard", clip === CMD, clip);
    await key("Escape", "Escape", 27);
    await ctx.sleep(300);
    check(
      "keys: after a drag the card still takes Escape",
      !(await ctx.evaluate(`!!document.querySelector(${JSON.stringify(QT)})`)),
    );

    // Options.
    await ask("patched");
    s = await span(LABEL, "corroborate-stanford");
    await drag(s.a, s.b);
    st = await state();
    check(
      "options: a drag across a label selects it and picks nothing",
      st.sel === "corroborate-stanford" && st.picked === "000",
      JSON.stringify(st),
    );
    await ctx.sleep(500);
    st = await state();
    check(
      "options: the card stays on its question",
      st.q === QTEXT.slice(0, 16) && st.picked === "000",
      JSON.stringify(st),
    );
    await click(await center(RADIO, 0));
    st = await state();
    check(
      "options: a click on that row's radio, the selection still there, picks it",
      st.picked === "100",
      JSON.stringify(st),
    );
    await ctx.sleep(500);
    st = await state();
    check(
      "options: and moves on to the next question",
      st.q === "Second question?",
      st.q,
    );

    await ask("patched");
    s = await span(LABEL, "stanford-gateway");
    const d = await span(DESC, "An item");
    await drag(s.a, d.b);
    st = await state();
    check(
      "options: a drag from a label into its description selects and picks nothing",
      st.sel.includes("stanford-gateway") &&
        st.sel.includes("An item") &&
        st.picked === "000",
      JSON.stringify(st),
    );

    for (const mode of ["native", "patched"]) {
      await ask(mode);
      await click(mid(await span(LABEL, "stanford-gateway")));
      st = await state();
      const picked = st.picked === "010";
      await ctx.sleep(500);
      st = await state();
      check(
        `options (${mode}): a plain click on a label picks it and moves on`,
        picked && st.q === "Second question?",
        JSON.stringify(st),
      );
      await ask(mode);
      await click(mid(await span(DESC, "earlier")), 2);
      st = await state();
      check(
        `options (${mode}): a double click on a word picks its option`,
        st.picked === "010" && st.sel === (mode === "patched" ? "earlier" : ""),
        JSON.stringify(st),
      );
    }

    // Previews.
    await ask("patched", PREVIEW);
    s = await span(PREV, "columns: 2");
    if (check("select: the option preview shows", !!s)) {
      await drag(s.a, s.b);
      st = await state();
      check(
        "select: a drag in a preview selects its text",
        st.sel === "columns: 2",
        st.sel,
      );
      const c = await copied();
      check("select: and Copy takes it", c === "columns: 2", c);
    }

    // Plain clicks: the card's own handoff decides where focus goes.
    await ask("patched");
    await click((await span(QT, "keychain")).a);
    st = await state();
    check(
      "clicks: a plain click on the question hands focus to the first option",
      st.focus === "option0" && st.sel === "",
      JSON.stringify(st),
    );
    // Patched only: natively focus leaves the box, and Input.insertText still
    // writes into the editable that holds the caret, so a native pass would
    // read the same text without telling anything.
    await ask("patched");
    await click((await span(LABEL, "Other")).a);
    await ctx.sleep(150);
    await type("my-item");
    await click((await span(QT, "keychain")).a);
    st = await state();
    await type("X");
    const other = await ctx.evaluate(
      `document.querySelector(${JSON.stringify(`${OTHER} [contenteditable]`)}).textContent`,
    );
    check(
      `clicks: after a click on the question, focus is back in "Other" and typing goes on at its caret`,
      st.focus === "other" && other === "my-itemX",
      `${st.focus} ${JSON.stringify(other)}`,
    );
    for (const mode of ["native", "patched"]) {
      await bash(mode);
      await click((await span(HEADER, "Allow this")).a);
      st = await state();
      check(
        `clicks (${mode}): a plain click on the Bash header leaves focus on Yes`,
        st.focus === "button:1 Yes",
        st.focus,
      );
      await click(await center(FEEDBACK));
      await type("abc");
      await click((await span(HEADER, "Allow this")).a);
      st = await state();
      await type("d");
      const fb = await ctx.evaluate(
        `document.querySelector(${JSON.stringify(FEEDBACK)}).textContent`,
      );
      check(
        `clicks (${mode}): typing in the feedback box goes on at its caret after a click on the header`,
        st.focus === "feedback" && fb === "abcd",
        `${st.focus} ${JSON.stringify(fb)}`,
      );
    }

    // Permission cards.
    await bash("patched");
    s = await span(HEADER, "Allow this");
    await drag(s.a, (await span(HEADER, "command?")).b);
    st = await state();
    check(
      "select: a drag across the Bash header selects it, focus on the card",
      st.sel === "Allow this bash command?" && st.focus === "card",
      JSON.stringify(st),
    );
    await fresh(
      "patched",
      "WebFetch",
      { url: URL_TEXT, prompt: "Read it" },
      INPUT,
    );
    s = await span(INPUT, URL_TEXT);
    await drag(s.a, s.b);
    st = await state();
    check(
      "select: a drag across a WebFetch URL selects it",
      st.sel === URL_TEXT,
      st.sel,
    );
    const u = await copied();
    check("select: and Copy takes it", u === URL_TEXT, u);
    await ctx.shot("card-text");

    const err = await ctx.evaluate(
      `document.getElementById("claude-error").textContent`,
    );
    check("the app reported no error", !err, err.slice(0, 200));
  } finally {
    server.close();
  }
  return ok;
}
