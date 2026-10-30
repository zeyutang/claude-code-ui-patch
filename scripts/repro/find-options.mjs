// Scenario for scripts/cdp-driver.mjs: the find bar's place over the chat
// header and its search options, on the REAL webview bundle booted against a
// stub host into a one-reply session whose paragraphs hold the test tokens.
// Real mouse events drive the toggles, and the checks assert:
//   place    in the sidebar the bar covers the header's New session button
//            whole, centered on it and overhanging its right edge as much as
//            above and below, and in the editor tab (no header) it keeps the
//            top-right corner
//   toggles  Match Case, Match Whole Word and Use Regular Expression sit
//            inside the input box as unchecked checkboxes whose codicon
//            glyphs paint under the webview's content security policy (which
//            refuses the bundle's codicon font), each hover tip is its bare
//            label, and a click flips it without taking the focus from the
//            input and searches again from the active match
//   search   the counts for each option and their combinations, a case fold
//            that keeps every later match on its own text (U+0130 lowercases
//            to two code units), a pattern spanning lines only when it names
//            a line break, empty matches skipped, and an invalid pattern's
//            error border and message
//   seed     a selection seeds the query escaped while regex is on
//   persist  the options survive a reload
//
//   node scripts/cdp-driver.mjs scripts/repro/find-options.mjs 600 520
//
// The bundle served is the compiled patcher's own output for the live install
// (findBarWebview, out/, so compile first), as in find-math.mjs. The live
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

const R = "77777777-7777-4777-8777-777777777777";
// U+0130, built here rather than escaped in the source.
const DOTTED_I = String.fromCharCode(0x130);
// The reply's paragraphs. The prompt carries none of the tokens, so every
// count below comes from the reply alone.
const REPLY = [
  "Alpha zeta Zeta ZETA zetas azeta zeta-ray zeta_q (zeta) zeta.",
  "Omega line.",
  `${DOTTED_I}stanbul then target.`,
  "Literal a.b(c) here.",
].join("\n\n");

function transcript() {
  const now = Date.now();
  const base = (type, n) => ({
    type,
    uuid: `00000000-0000-4000-8000-00000000000${n}`,
    session_id: R,
    parent_tool_use_id: null,
    timestamp: new Date(now - (10 - n) * 1000).toISOString(),
  });
  return [
    {
      ...base("user", 1),
      message: {
        role: "user",
        content: [{ type: "text", text: "Turn 1: options probe" }],
      },
    },
    {
      ...base("assistant", 2),
      message: {
        id: "msg_2",
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content: [{ type: "text", text: REPLY }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
}

// The stub host, as in find-typing.mjs, under the content security policy
// Claude Code gives its webview, the stub's origin standing in for the
// webview's source: no font loads from a data: URI, and no fetch at all.
// ?editor=1 boots the editor tab's layout, whose header renders empty and
// hidden.
const NONCE = "ccupfindoptions";
const CSP =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
  `img-src 'self' data:; script-src 'nonce-${NONCE}'; worker-src 'self';`;
const page = (editor) => `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-font-family:system-ui;--vscode-font-size:13px;
--vscode-foreground:#cccccc;--vscode-sideBar-background:#181818;color-scheme:dark;
--vscode-inputOption-activeBorder:#2488db;--vscode-inputOption-activeBackground:rgba(36,137,219,.51);
--vscode-inputOption-activeForeground:#ffffff;--vscode-inputOption-hoverBackground:rgba(90,93,94,.5);
--vscode-inputValidation-errorBorder:#be1100;--vscode-inputValidation-errorBackground:#5a1d1d}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${R}"></div>
<script nonce="${NONCE}" src="/messages.js"></script>
<script nonce="${NONCE}">
window.IS_SIDEBAR = ${!editor}; window.IS_FULL_EDITOR = ${editor}; window.IS_SESSION_LIST_ONLY = false;
const R = "${R}", NOW = Date.now();
const SESSION = { id: R, summary: "Options", customTitle: "Options", lastModified: NOW,
  lastActivity: NOW, archived: false, fileSize: 4096, gitBranch: "develop",
  isCurrentWorkspace: true };
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
          messages: r.sessionId === R ? window.MESSAGES : [], sessionDiffs: [] };
        break;
    }
    deliver({ type: "response", requestId: msg.requestId, response: resp });
  },
});
</script>
<script nonce="${NONCE}" type="module" src="/wv/index.js"></script>
</body></html>`;

const TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

// Page-side probes: client boxes, the counter, a toggle and its state, the
// active match's text, and the tip on show.
const PROBES = `(() => {
  const box = (e) => {
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
  };
  window.__fo = {
    box,
    bar: () => document.querySelector(".ccup-find-bar"),
    field: () => document.querySelector(".ccup-find-bar .ccup-find-field"),
    input: () => document.querySelector(".ccup-find-bar input"),
    count: () => document.querySelector(".ccup-find-bar .ccup-find-count span")?.textContent ?? null,
    opt: (k) => document.querySelector('.ccup-find-bar .ccup-find-opt[data-opt="' + k + '"]'),
    checked: (k) => __fo.opt(k)?.getAttribute("aria-checked") ?? null,
    act() {
      const h = CSS.highlights.get("ccup-find-active");
      if (h) for (const r of h) return String(r);
      return null;
    },
    tip() {
      const t = document.querySelector(".ccup-find-tip");
      return t && getComputedStyle(t).display !== "none" ? t.textContent : "";
    },
    // The paragraph holding text t, for a selection.
    para: (t) => [...document.querySelectorAll('[class*="messagesContainer_"] p')]
      .find((p) => p.textContent.includes(t)),
  };
})()`;

export async function run(ctx) {
  const dir = liveBundleDir();
  const built = loadPatcher().findBarWebview(
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
  if (!check("the patcher builds the find bar", !!built)) return false;
  const msgs = `window.MESSAGES = ${JSON.stringify(transcript())};`;

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/wv/index.js" || url.pathname === "/wv/index.css") {
      const js = url.pathname.endsWith(".js");
      res
        .writeHead(200, {
          "content-type": TYPES[js ? ".js" : ".css"],
          "cache-control": "no-store",
        })
        .end(js ? built.js : built.css);
    } else if (url.pathname === "/messages.js") {
      res.writeHead(200, { "content-type": TYPES[".js"] }).end(msgs);
    } else if (url.pathname.startsWith("/wv/")) {
      // Read before writing the head: a bundle dir without its fonts must
      // answer 404, not throw on headers already sent.
      const file = join(dir, url.pathname.slice(4));
      let body;
      try {
        body = readFileSync(file);
      } catch {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, {
          "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        })
        .end(body);
    } else {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(page(url.searchParams.get("editor") === "1"));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const ev = (s) => ctx.evaluate(s);
  // ctx.evaluate does not await promises.
  const evAsync = async (s) =>
    (
      await ctx.cdp("Runtime.evaluate", {
        expression: s,
        awaitPromise: true,
        returnByValue: true,
      })
    ).result.value;
  const J = (o) => JSON.stringify(o);
  // The device pixels of box b (CSS px) within a few levels of color css (an
  // rgb() string), counted on a capture decoded in the page, with the bitmap
  // that tells one glyph from another.
  const inkOf = async (b, css) => {
    const png = (
      await ctx.cdp("Page.captureScreenshot", {
        format: "png",
        clip: { x: b.l, y: b.t, width: b.w, height: b.h, scale: 1 },
      })
    ).data;
    const rgb = css.match(/\d+/g).slice(0, 3).map(Number);
    return evAsync(`(async () => {
      const img = new Image();
      img.src = "data:image/png;base64,${png}";
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data, want = ${J(rgb)};
      let n = 0, bits = "";
      for (let i = 0; i < d.length; i += 4) {
        const on = [0, 1, 2].every((j) => Math.abs(d[i + j] - want[j]) < 48);
        if (on) n++;
        bits += on ? 1 : 0;
      }
      return { n, bits };
    })()`);
  };
  const until = async (expr, ms) => {
    for (let t = 0; t < ms; t += 50) {
      if (await ev(expr)) return true;
      await ctx.sleep(50);
    }
    return !!(await ev(expr));
  };
  const mouse = (type, p) =>
    ctx.cdp("Input.dispatchMouseEvent", {
      type,
      x: p.x,
      y: p.y,
      button: type === "mouseMoved" ? "none" : "left",
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  const center = (b) => ({ x: b.l + b.w / 2, y: b.t + b.h / 2 });
  const click = async (p) => {
    await mouse("mouseMoved", p);
    await mouse("mousePressed", p);
    await mouse("mouseReleased", p);
  };
  const mod = process.platform === "darwin" ? "metaKey" : "ctrlKey";
  const openChord = () =>
    ev(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ${mod}: true, bubbles: true, cancelable: true }))`,
    );
  // Replace the query at once, then wait out the 90ms input debounce.
  const query = async (q) => {
    await ev(`(() => { const i = __fo.input(); i.focus(); i.select(); })()`);
    await ctx.cdp("Input.insertText", { text: q });
    await ctx.sleep(250);
  };
  // The counter reads want.
  const countIs = async (name, want) => {
    const c = await ev("__fo.count()");
    return check(name, c === want, c);
  };
  // Click toggle k with real mouse events and park the pointer off the bar.
  const flip = async (k) => {
    await click(center(await ev(`__fo.box(__fo.opt("${k}"))`)));
    await mouse("mouseMoved", { x: 300, y: 300 });
    await ctx.sleep(150);
  };
  // Every option set to the wanted state, by clicks.
  const setOpts = async (want) => {
    for (const k of ["c", "w", "r"]) {
      const on = (await ev(`__fo.checked("${k}")`)) === "true";
      if (on !== !!want[k]) await flip(k);
    }
  };
  const boot = async (url) => {
    await ctx.navigate(url);
    const up = await until(
      `document.querySelectorAll('[data-testid="assistant-message"]').length === 1 && document.body.innerText.includes("Literal a.b")`,
      15000,
    );
    if (up) await ev(PROBES);
    await ctx.sleep(300);
    return up;
  };

  try {
    // place: the sidebar.
    if (
      !check(
        "the transcript rendered",
        await boot(base),
        await ev(`document.getElementById("claude-error").textContent`),
      )
    )
      return false;
    await ev(`localStorage.removeItem("ccup-find-options")`);
    await openChord();
    check(
      "the chord opens the bar",
      await until(
        `!!document.querySelector(".ccup-find-bar[data-open]")`,
        2000,
      ),
    );
    await ctx.sleep(200);
    const p = await ev(`(() => {
      const ns = document.querySelector('[aria-label="New session"]');
      const n = __fo.box(ns), b = __fo.box(__fo.bar());
      if (!n || !b) return { n, b };
      const hit = document.elementFromPoint(n.l + n.w / 2, n.t + n.h / 2);
      return { n, b, covered: !!hit && __fo.bar().contains(hit) };
    })()`);
    check(
      "sidebar: the bar covers the New session button whole",
      !!p.n &&
        p.b.l <= p.n.l &&
        p.b.r >= p.n.r &&
        p.b.t <= p.n.t &&
        p.b.b >= p.n.b &&
        p.covered,
      J(p),
    );
    const above = p.n && p.n.t - p.b.t;
    const below = p.n && p.b.b - p.n.b;
    const beyond = p.n && p.b.r - p.n.r;
    check(
      "sidebar: centered on the button, overhanging its right edge as much as above and below",
      !!p.n &&
        Math.abs(above - below) < 0.6 &&
        Math.abs(beyond - above) < 0.6 &&
        above >= 0,
      `above ${above}, below ${below}, beyond ${beyond}`,
    );
    await ctx.shot("find-options-sidebar");

    // toggles: inside the input box, unchecked, each glyph a mask image.
    const t = await ev(`(() => {
      const f = __fo.box(__fo.field()), i = __fo.box(__fo.input());
      return ["c", "w", "r"].map((k) => {
        const o = __fo.opt(k), b = __fo.box(o), cs = getComputedStyle(o, "::before");
        return { k, label: o.getAttribute("aria-label"), role: o.getAttribute("role"),
          checked: o.getAttribute("aria-checked"), box: b, color: getComputedStyle(o).color,
          inside: b.l >= f.l && b.r <= f.r && b.t >= f.t && b.b <= f.b && b.l >= i.r - 0.5,
          content: cs.content, mask: cs.webkitMaskImage || cs.maskImage || "" };
      });
    })()`);
    check(
      "toggles: Match Case, Match Whole Word, Use Regular Expression, in order",
      J(t.map((x) => x.label)) ===
        J(["Match Case", "Match Whole Word", "Use Regular Expression"]),
      J(t.map((x) => x.label)),
    );
    check(
      "toggles: unchecked checkboxes inside the input box, right of the text",
      t.every(
        (x) => x.role === "checkbox" && x.checked === "false" && x.inside,
      ),
      J(t),
    );
    // The editor's 20px squares 2px apart read cramped here.
    const gaps = t.slice(1).map((x, i) => x.box.l - t[i].box.r);
    check(
      "toggles: 22px wide and 4px apart, roomier than the editor's 20px and 2px",
      t.every((x) => Math.abs(x.box.w - 22) < 0.5) &&
        gaps.every((g) => Math.abs(g - 4) < 0.5),
      `widths ${J(t.map((x) => x.box.w))}, gaps ${J(gaps)}`,
    );
    // The webview's policy refuses the bundle's codicon font face, a data:
    // URI, so a glyph drawn in that font shows as a missing-glyph box.
    const face = await evAsync(`(async () => {
      try {
        await document.fonts.load("16px codicon", String.fromCharCode(0xeab1));
      } catch {}
      return [...document.fonts].filter((f) => f.family === "codicon").map((f) => f.status);
    })()`);
    check(
      "precondition: the policy keeps the codicon font face from loading",
      J(face) === J(["error"]),
      J(face),
    );
    check(
      "toggles: each glyph is a mask image of an SVG path, with no text to fall back to a missing glyph",
      t.every(
        (x) =>
          x.content === '""' &&
          x.mask.startsWith('url("data:image/svg+xml') &&
          decodeURIComponent(x.mask).includes('<path d="M'),
      ) && new Set(t.map((x) => x.mask)).size === 3,
      J(t.map((x) => [x.content, x.mask.slice(0, 40)])),
    );
    // What each toggle paints: device pixels in the toggle's own color.
    const inks = [];
    for (const x of t) inks.push(await inkOf(x.box, x.color));
    check(
      "toggles: each glyph paints in the toggle's color, and the three differ",
      inks.every((k) => k.n >= 20) &&
        new Set(inks.map((k) => k.bits)).size === 3,
      J(inks.map((k) => k.n)),
    );
    const tips = [];
    for (const k of ["c", "w", "r"]) {
      await mouse("mouseMoved", center(await ev(`__fo.box(__fo.opt("${k}"))`)));
      await ctx.sleep(450);
      tips.push(await ev("__fo.tip()"));
    }
    await mouse("mouseMoved", { x: 300, y: 300 });
    check(
      "toggles: each hover tip is its bare label, no shortcut",
      J(tips) ===
        J(["Match Case", "Match Whole Word", "Use Regular Expression"]),
      J(tips),
    );

    // search: the counts.
    await query("zeta");
    await countIs("search: plain text ignores case", "1 of 9");
    // The matches paint while the bar is open (their highlight rules apply
    // only under body.ccup-find-open, so a closed bar costs no style work):
    // the active one in the find color and another in the match color, each
    // blended over the chat's background (#181818, the stub sets no find
    // tokens, so the rules' fallbacks paint).
    const hl = await ev(`(() => {
      const b = (r) => { const q = document.createRange(); q.setStart(r.startContainer, r.startOffset); q.setEnd(r.endContainer, r.endOffset); const x = q.getBoundingClientRect(); return { l: x.left, t: x.top, w: x.width, h: x.height }; };
      const seen = (x) => x.w > 0 && x.t >= 0 && x.t + x.h <= innerHeight;
      const act = [...(CSS.highlights.get("ccup-find-active") || [])].map(b).find(seen) || null;
      const other = [...(CSS.highlights.get("ccup-find") || [])].map(b)
        .find((x) => seen(x) && (!act || Math.abs(x.t - act.t) > 1 || Math.abs(x.l - act.l) > 1)) || null;
      return { act, other };
    })()`);
    const actInk = hl.act ? await inkOf(hl.act, "rgb(194, 123, 29)") : { n: 0 };
    const otherInk = hl.other
      ? await inkOf(hl.other, "rgb(93, 46, 16)")
      : { n: 0 };
    // Without the class the same match paints nothing: the rules are scoped.
    await ev('document.body.classList.remove("ccup-find-open")');
    const offInk = hl.act
      ? await inkOf(hl.act, "rgb(194, 123, 29)")
      : { n: -1 };
    await ev('document.body.classList.add("ccup-find-open")');
    check(
      "search: the active match paints in the find color and another in the match color, only while the bar is open",
      actInk.n >= 20 && otherInk.n >= 20 && offInk.n === 0,
      J({ act: actInk.n, other: otherInk.n, closed: offInk.n }),
    );
    // Three steps on, to zetas, so the flip below shows it keeps the place.
    for (let i = 0; i < 3; i++) {
      await ev(
        `document.querySelector('.ccup-find-bar button[aria-label="Next Match"]').click()`,
      );
    }
    await countIs("precondition: three steps on, at zetas", "4 of 9");
    await flip("c");
    check(
      "toggles: a click checks Match Case and leaves the focus in the input",
      (await ev(`__fo.checked("c")`)) === "true" &&
        (await ev(`document.activeElement === __fo.input()`)),
      await ev(
        `document.activeElement && document.activeElement.outerHTML.slice(0, 60)`,
      ),
    );
    await countIs(
      "search: Match Case counts the lowercase ones and keeps the place, zetas second of them",
      "2 of 7",
    );
    await query("Zeta");
    await countIs("search: Match Case finds Zeta once", "1 of 1");
    await setOpts({ w: 1 });
    await query("zeta");
    await countIs(
      "search: Whole Word drops zetas, azeta and zeta_q, keeps zeta-ray, (zeta) and zeta.",
      "1 of 6",
    );
    await setOpts({ c: 1, w: 1 });
    await countIs("search: Whole Word with Match Case", "1 of 4");
    await setOpts({ r: 1 });
    await query("zeta\\w*");
    await countIs("search: a regular expression", "1 of 9");
    await setOpts({ w: 1, r: 1 });
    await countIs(
      "search: a regular expression with Whole Word rejects the match inside azeta",
      "1 of 8",
    );
    await setOpts({ r: 1 });
    await query("^alpha");
    await countIs("search: ^ meets a line's start", "1 of 1");
    await query("zeta\\.$");
    await countIs("search: $ meets a line's end", "1 of 1");
    await query("zeta\\.\\s+omega");
    await countIs("search: \\s stays on one line", "No results");
    await query("zeta\\.\\W+omega");
    await countIs("search: \\W spans lines, as in the editor", "1 of 1");
    await query("^");
    check(
      "search: empty matches are skipped, with no error",
      (await ev("__fo.count()")) === "No results" &&
        !(await ev(`__fo.bar().hasAttribute("data-err")`)),
      await ev("__fo.count()"),
    );
    await query("(zeta");
    const e = await ev(`(() => {
      const m = document.querySelector(".ccup-find-msg"), f = __fo.field();
      return { err: __fo.bar().hasAttribute("data-err"), inv: __fo.input().getAttribute("aria-invalid"),
        shown: getComputedStyle(m).display, text: m.textContent,
        under: m.getBoundingClientRect().top >= __fo.bar().getBoundingClientRect().bottom,
        left: Math.abs(m.getBoundingClientRect().left - f.getBoundingClientRect().left) < 0.6,
        width: Math.abs(m.getBoundingClientRect().width - f.getBoundingClientRect().width) < 0.6,
        border: getComputedStyle(f).borderTopColor, count: __fo.count() };
    })()`);
    check(
      "search: an invalid pattern shows its error under the input box, at its width",
      e.err &&
        e.inv === "true" &&
        e.shown === "block" &&
        /Unterminated group/.test(e.text) &&
        e.under &&
        e.left &&
        e.width &&
        e.count === "No results",
      J(e),
    );
    check(
      "search: and the input box takes the error border",
      e.border === "rgb(190, 17, 0)",
      e.border,
    );
    await ctx.shot("find-options-invalid");
    await query("(zeta)");
    check(
      "search: the error clears once the pattern is valid",
      !(await ev(`__fo.bar().hasAttribute("data-err")`)) &&
        (await ev(
          `getComputedStyle(document.querySelector(".ccup-find-msg")).display`,
        )) === "none" &&
        (await ev("__fo.count()")) === "1 of 9",
      await ev("__fo.count()"),
    );

    // The fold: U+0130 lowercases to two code units, which would shift every
    // later match by one without it.
    await setOpts({});
    await query("istanbul");
    await countIs("search: a case fold finds the dotted capital I", "1 of 1");
    await query("target");
    check(
      "search: a later match keeps its own text",
      (await ev("__fo.act()")) === "target",
      J(await ev("__fo.act()")),
    );

    // seed: a selection, escaped while regex is on.
    const select = (txt) =>
      ev(`(() => {
        const p = __fo.para(${J(txt)}), w = document.createTreeWalker(p, 4);
        let n;
        while ((n = w.nextNode()) && !n.nodeValue.includes(${J(txt)}));
        const i = n.nodeValue.indexOf(${J(txt)}), r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + ${txt.length});
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(r);
        return String(s);
      })()`);
    await setOpts({ r: 1 });
    await select("a.b(c)");
    await openChord();
    await ctx.sleep(250);
    check(
      "seed: with regex on, the selection is escaped and matches itself",
      (await ev("__fo.input().value")) === "a\\.b\\(c\\)" &&
        (await ev("__fo.count()")) === "1 of 1",
      `${J(await ev("__fo.input().value"))}, ${await ev("__fo.count()")}`,
    );
    await setOpts({});
    await select("a.b(c)");
    await openChord();
    await ctx.sleep(250);
    check(
      "seed: with regex off, as selected",
      (await ev("__fo.input().value")) === "a.b(c)" &&
        (await ev("__fo.count()")) === "1 of 1",
      `${J(await ev("__fo.input().value"))}, ${await ev("__fo.count()")}`,
    );

    // persist: two options on, then a reload.
    await setOpts({ c: 1, r: 1 });
    const stored = await ev(`localStorage.getItem("ccup-find-options")`);
    check(
      "persist: the options are stored",
      J(JSON.parse(stored || "null")) === J({ c: 1, w: 0, r: 1 }),
      stored,
    );
    check("persist: remounts", await boot(base));
    await openChord();
    await ctx.sleep(250);
    check(
      "persist: the toggles come back as left",
      J(await ev(`["c", "w", "r"].map(__fo.checked)`)) ===
        J(["true", "false", "true"]),
      J(await ev(`["c", "w", "r"].map(__fo.checked)`)),
    );
    await ev(`localStorage.removeItem("ccup-find-options")`);

    // place: the editor tab, whose header is empty and hidden.
    check("editor: remounts", await boot(base + "?editor=1"));
    await openChord();
    await ctx.sleep(250);
    const q = await ev(`(() => {
      const h = document.querySelector('[class*="header_"]');
      return { head: h ? getComputedStyle(h).display : null, b: __fo.box(__fo.bar()),
        vw: document.documentElement.clientWidth };
    })()`);
    check(
      "editor: with the header hidden, the bar keeps the top-right corner",
      q.head === "none" &&
        q.b &&
        q.b.t === 8 &&
        Math.abs(q.vw - q.b.r - 16) < 0.6,
      J(q),
    );
    await ctx.shot("find-options-editor");
  } finally {
    server.close();
  }
  return ok;
}
