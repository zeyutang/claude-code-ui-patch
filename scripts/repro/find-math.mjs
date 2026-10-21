// Scenario for scripts/cdp-driver.mjs: the find bar searching rendered math by
// its TeX, on the REAL webview bundle booted against a stub host into a
// transcript whose first response holds formulas and sits several scroller
// heights above the last, which holds a few more. Native math (2.1.301+)
// typesets a response only within a scroller height of the view and reverts it
// to raw source beyond that, so the first response boots as source and the last
// as KaTeX, and the checks assert across both states:
//   count   a TeX query counts every occurrence once, typeset or not, and the
//           count holds through each reveal, typeset, and revert (sampled
//           throughout, so a passing "No results" fails it)
//   paint   the active match selects its whole formula element, never
//           collapsing, over the rendered formula once it typesets, and the
//           ruler marks the response's own markdown root, display formulas
//           included
//   scope   glyphs (π) match prose only, no match crosses a formula's edge,
//           prose around formulas still matches, and the raw markdown view
//           counts the same TeX
//   units   a .ccup-math wrapper (the patch's own chatMath on older builds) and
//           a bare .katex read as formulas too
//
//   node scripts/cdp-driver.mjs scripts/repro/find-math.mjs 760 700
//
// The bundle served is the compiled patcher's own output for the live install
// (findBarWebview, out/, so compile first), so the scenario runs exactly what
// an apply writes and doubles as the drift canary. The live bundle is found
// under ~/.vscode/extensions (newest Claude Code install) or via $CCUP_BUNDLE
// (the webview directory).
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

const R = "55555555-5555-4555-8555-555555555555";
const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";
const FILLERS = 6;
const PARAS = 6;
// The first response: three inline formulas and a display block, the last
// followed by prose. The last response: two inline formulas, then prose
// carrying the glyph π as plain text.
const FIRST =
  "Euler: $e^{i\\pi} + 1 = 0$ and the circle $A = \\pi r^2$, plus $\\frac{a}{b}$.\n\n" +
  "$$\n\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n$$\n\nTail line.";
const LAST =
  "Near: $\\alpha + \\pi$ and $\\frac{c}{d}$ here, while the letter π in prose stays text.";
const REPLIES = [
  FIRST,
  ...Array.from({ length: FILLERS }, () =>
    Array.from({ length: PARAS }, () => LOREM).join("\n\n"),
  ),
  LAST,
];
const LAST_ROW = REPLIES.length - 1;

// The stub host: just enough of the init state for the chat to mount (see the
// real-webview-mock notes), one session on disk and its transcript in SDK
// message form. The root names the session, so the view opens it at boot, and
// the host reports no plugins, without which every row stays hidden as
// "Waiting for your plugins". Responses go out synchronously, or the first
// render races ahead of get_claude_state.
const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-font-family:system-ui;--vscode-font-size:13px;
--vscode-foreground:#cccccc;--vscode-sideBar-background:#181818;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${R}"></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
const R = "${R}", NOW = Date.now();
const REPLIES = ${JSON.stringify(REPLIES)};
const at = (i) => new Date(NOW - (REPLIES.length - i) * 60e3).toISOString();
const MESSAGES = REPLIES.flatMap((text, i) => [
  { type: "user", uuid: "u" + i + "-0000-4000-8000-000000000000", session_id: R,
    parent_tool_use_id: null, timestamp: at(i),
    message: { role: "user", content: [{ type: "text", text: "Prompt " + (i + 1) }] } },
  { type: "assistant", uuid: "a" + i + "-0000-4000-8000-000000000000", session_id: R,
    parent_tool_use_id: null, timestamp: at(i),
    message: { id: "msg_" + i, type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } } },
]);
const SESSION = { id: R, summary: "Math", customTitle: "Math", lastModified: NOW,
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

// Page-side probes. A formula is a native wrapper ([data-redrawn]); the active
// match is read off the highlight registry, as the unit it starts before (row
// and wrapper index) or as a text match.
const PROBES = `(() => {
  const ROW = '[data-testid="assistant-message"]', W = "[data-redrawn]";
  const rows = () => [...document.querySelectorAll(ROW)];
  const box = (e) => { const r = e.getBoundingClientRect(); return { t: r.top, b: r.bottom, l: r.left, r: r.right, w: r.width }; };
  const meets = (a, b) => a.t < b.b && a.b > b.t && a.l < b.r && a.r > b.l;
  window.__fm = {
    rows,
    wrappers: (i) => [...rows()[i].querySelectorAll(W)],
    typeset: (i) => rows()[i].querySelectorAll(".katex").length,
    count: () => document.querySelector(".ccup-find-bar .ccup-find-count span")?.textContent ?? null,
    act() {
      const h = CSS.highlights.get("ccup-find-active");
      const r = h && [...h][0];
      if (!r) return null;
      const sc = r.startContainer;
      const unit = sc.nodeType === 1 ? sc.childNodes[r.startOffset] : null;
      const out = { collapsed: r.collapsed, text: sc.nodeType === 3, row: -1, w: -1,
        whole: false, onKatex: false, inMath: false };
      const at = unit && unit.nodeType === 1 ? unit : sc.parentElement;
      const row = at && at.closest(ROW);
      out.row = rows().indexOf(row);
      if (out.text) {
        out.inMath = !!sc.parentElement.closest(W + ",.katex,.ccup-math");
        return out;
      }
      if (unit && unit.nodeType === 1) {
        out.w = row ? [...row.querySelectorAll(W)].indexOf(unit) : -1;
        out.whole = r.endContainer === sc && r.endOffset === r.startOffset + 1;
        const kh = unit.querySelector(".katex-html");
        if (kh) out.onKatex = box(kh).w > 0 && meets(box(r), box(kh));
      }
      return out;
    },
    // The ruler against row i's markdown root and its turn: shown, inside the
    // root's own box (it spans the visible slice), and the turn's top above.
    ruler(i) {
      const el = document.querySelector(".ccup-find-ruler");
      const root = rows()[i].querySelector('span[class^="root_"]');
      if (!el || !root) return { shown: false };
      const rb = box(root), turn = rows()[i].parentElement.closest('[class^="turn_"]');
      const top = parseFloat(el.style.top), bot = top + parseFloat(el.style.height);
      return { shown: el.style.display === "block", top, bot, rootT: rb.t, rootB: rb.b,
        turnT: turn ? box(turn).t : NaN,
        inRoot: top >= rb.t - 1 && bot <= rb.b + 1 };
    },
    scroller: () => document.querySelector('[class*="messagesContainer_"]'),
  };
})()`;

export async function run(ctx) {
  const dir = liveBundleDir();
  const web = readFileSync(join(dir, "index.js"), "utf8");
  const built = loadPatcher().findBarWebview(
    web,
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
  const cfg = /window\.__ccupFindCfg=(\{[^\n]*\});/.exec(built.js);
  check(
    "the cfg bakes native math's wrapper attribute",
    !!cfg && JSON.parse(cfg[1]).math === "data-redrawn",
    cfg ? JSON.parse(cfg[1]).math : "no cfg line",
  );

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
      res.writeHead(200, { "content-type": "text/html" }).end(page);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const ev = (s) => ctx.evaluate(s);
  const until = async (expr, ms) => {
    for (let t = 0; t < ms; t += 50) {
      if (await ev(expr)) return true;
      await ctx.sleep(50);
    }
    return !!(await ev(expr));
  };
  // Every distinct counter value and whether the active range ever collapsed,
  // sampled while the transcript settles.
  const watch = async (ms) => {
    const seen = new Set();
    let collapsed = false;
    for (let t = 0; t < ms; t += 25) {
      seen.add(await ev("__fm.count()"));
      const a = await ev("__fm.act()");
      if (!a || a.collapsed) collapsed = true;
      await ctx.sleep(25);
    }
    return { seen: [...seen], collapsed };
  };
  const query = async (q) => {
    await ev(
      `(() => { const i = document.querySelector(".ccup-find-bar input"); i.focus(); i.select(); })()`,
    );
    await ctx.cdp("Input.insertText", { text: q });
    await until(
      `(__fm.count() || "").length > 0 && !document.querySelector(".ccup-find-bar input").matches(":placeholder-shown")`,
      2000,
    );
    await ctx.sleep(250); // the 90ms input debounce, then a frame
  };
  const next = () =>
    ev(
      `document.querySelector('.ccup-find-bar button[aria-label="Next Match"]').click()`,
    );
  const scrollTo = (where) =>
    ev(
      `(() => { const s = __fm.scroller(); s.scrollTop = ${where === "top" ? 0 : "s.scrollHeight"}; })()`,
    );
  const J = (o) => JSON.stringify(o);

  try {
    await ctx.navigate(base);
    const booted = await until(
      `document.querySelectorAll('[data-testid="assistant-message"]').length === ${REPLIES.length} && document.querySelectorAll(".katex").length > 0`,
      15000,
    );
    if (
      !check(
        "the transcript rendered and math loaded",
        booted,
        booted
          ? undefined
          : await ev(`document.getElementById("claude-error").textContent`),
      )
    )
      return false;
    await ev(PROBES);
    await ctx.sleep(400);
    const raw0 = await ev("__fm.wrappers(0).length");
    if (
      !check(
        "precondition: the first response boots as raw source, the last typeset",
        raw0 === 4 &&
          (await ev("__fm.typeset(0)")) === 0 &&
          (await ev(`__fm.typeset(${LAST_ROW})`)) === 2,
        `first: ${raw0} wrappers, ${await ev("__fm.typeset(0)")} typeset; last: ${await ev(`__fm.typeset(${LAST_ROW})`)} typeset`,
      )
    )
      return false;

    const mod = process.platform === "darwin" ? "metaKey" : "ctrlKey";
    await ev(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ${mod}: true, bubbles: true, cancelable: true }))`,
    );
    check(
      "the chord opens the bar",
      await until(
        `!!document.querySelector(".ccup-find-bar[data-open]")`,
        2000,
      ),
    );

    // count + paint, the last response typeset: the first match in view.
    await query("\\pi");
    let a = await ev("__fm.act()");
    check(
      "\\pi counts both responses' formulas, typeset or not",
      (await ev("__fm.count()")) === "3 of 3",
      await ev("__fm.count()"),
    );
    check(
      "the active match selects the last response's first formula whole, over its rendering",
      !!a &&
        !a.collapsed &&
        a.row === LAST_ROW &&
        a.w === 0 &&
        a.whole &&
        a.onKatex,
      J(a),
    );
    let ru = await ev(`__fm.ruler(${LAST_ROW})`);
    check(
      "the ruler marks the last response's markdown root",
      ru.shown && ru.inRoot,
      J(ru),
    );

    // Next wraps to the first response, still raw source: the reveal scrolls
    // there, the response typesets, the last reverts, and nothing moves.
    await next();
    const w1 = await watch(1200);
    check(
      "jumping to a raw formula: the count holds through its typeset and the rescan",
      w1.seen.length === 1 && w1.seen[0] === "1 of 3",
      J(w1.seen),
    );
    check("the active highlight never collapses meanwhile", !w1.collapsed);
    check(
      "precondition: the first response typeset, the last reverted",
      (await ev("__fm.typeset(0)")) === 4 &&
        (await ev(`__fm.typeset(${LAST_ROW})`)) === 0,
      `${await ev("__fm.typeset(0)")} / ${await ev(`__fm.typeset(${LAST_ROW})`)}`,
    );
    a = await ev("__fm.act()");
    check(
      "the active match covers the first formula as rendered",
      !!a && !a.collapsed && a.row === 0 && a.w === 0 && a.whole && a.onKatex,
      J(a),
    );
    ru = await ev("__fm.ruler(0)");
    check(
      "the ruler marks the first response's markdown root",
      ru.shown && ru.inRoot,
      J(ru),
    );
    await ctx.shot("find-math-jump");

    await next();
    await ctx.sleep(300);
    a = await ev("__fm.act()");
    check(
      "next steps to the second formula",
      (await ev("__fm.count()")) === "2 of 3" &&
        !!a &&
        a.row === 0 &&
        a.w === 1 &&
        a.whole,
      `${await ev("__fm.count()")} ${J(a)}`,
    );

    // Scrolling away reverts the first response under the active match.
    await scrollTo("bottom");
    const w2 = await watch(1200);
    check(
      "scrolling away: the count and the active match hold through the revert",
      w2.seen.length === 1 && w2.seen[0] === "2 of 3" && !w2.collapsed,
      J(w2),
    );
    a = await ev("__fm.act()");
    check(
      "precondition: the first response reverted, the active match still its second formula",
      (await ev("__fm.typeset(0)")) === 0 &&
        !!a &&
        a.row === 0 &&
        a.w === 1 &&
        a.whole,
      J(a),
    );

    // A display formula: the ruler still marks the response's own root, not
    // the whole turn (its unit starts in the root itself).
    await query("n(n+1)");
    await watch(1000);
    a = await ev("__fm.act()");
    check(
      "a display formula matches by its TeX and typesets under the match",
      (await ev("__fm.count()")) === "1 of 1" &&
        !!a &&
        a.row === 0 &&
        a.w === 3 &&
        a.whole &&
        a.onKatex,
      `${await ev("__fm.count()")} ${J(a)}`,
    );
    ru = await ev("__fm.ruler(0)");
    check(
      "the ruler marks the root of a display formula's response, not its turn",
      ru.shown && ru.inRoot && ru.turnT < ru.rootT - 10,
      J(ru),
    );

    // scope: glyphs, edges, and prose around the formulas.
    await query("\\frac");
    check(
      "\\frac counts every fraction",
      (await ev("__fm.count()")).endsWith(" of 3"),
      await ev("__fm.count()"),
    );
    await query("\u03c0");
    a = await ev("__fm.act()");
    check(
      "the glyph \u03c0 matches the prose only, never a rendered formula",
      (await ev("__fm.count()")) === "1 of 1" &&
        !!a &&
        a.text &&
        !a.inMath &&
        a.row === LAST_ROW,
      `${await ev("__fm.count()")} ${J(a)}`,
    );
    await query("0 and");
    check(
      "no match crosses a formula's edge",
      (await ev("__fm.count()")) === "No results",
      await ev("__fm.count()"),
    );
    await query("+ 1 = 0");
    check(
      "a run inside one formula's TeX matches",
      (await ev("__fm.count()")) === "1 of 1",
      await ev("__fm.count()"),
    );
    for (const [q, n] of [
      ["Tail line", 1],
      ["here, while", 1],
      ["ipsum", FILLERS * PARAS],
    ]) {
      await query(q);
      check(
        `prose around and after formulas still matches: "${q}"`,
        (await ev("__fm.count()")).endsWith(` of ${n}`),
        await ev("__fm.count()"),
      );
    }

    // The raw markdown view counts the same TeX.
    if (await ev(`!!__fm.rows()[0].querySelector(".ccup-rawmd-btn")`)) {
      await scrollTo("top");
      await ctx.sleep(500);
      await query("\\pi");
      const before = await ev("__fm.count()");
      await ev(`__fm.rows()[0].querySelector(".ccup-rawmd-btn").click()`);
      await until(`!!__fm.rows()[0].querySelector("pre.ccup-rawmd")`, 2000);
      await ctx.sleep(500);
      check(
        "the raw markdown view counts the same TeX as the rendered one",
        (await ev("__fm.count()")).endsWith(" of 3") &&
          before.endsWith(" of 3"),
        `${before} -> ${await ev("__fm.count()")}`,
      );
      await ev(`__fm.rows()[0].querySelector(".ccup-rawmd-btn").click()`);
      await until(`!__fm.rows()[0].querySelector("pre.ccup-rawmd")`, 2000);
    } else {
      console.log(
        "SKIP  raw markdown view (chatRawMarkdownButton is off in the live bundle)",
      );
    }

    // units: the patch's own chatMath wrapper and a bare .katex, cloned from a
    // typeset native formula into filler prose (native never re-renders it).
    await scrollTo("bottom");
    await until(`__fm.typeset(${LAST_ROW}) === 2`, 3000);
    await ev(`(() => {
      const k = __fm.wrappers(${LAST_ROW})[1].querySelector(".katex");
      const ps = __fm.rows()[1].querySelectorAll("p"), q = __fm.rows()[2].querySelectorAll("p");
      const span = document.createElement("span");
      span.className = "ccup-math";
      span.appendChild(k.cloneNode(true));
      ps[0].append(" with ", span, " inline.");
      q[0].append(" bare ", k.cloneNode(true), " too.");
    })()`);
    await query("\\frac{c}{d}");
    await ctx.sleep(300);
    check(
      "a .ccup-math wrapper and a bare .katex count as formulas",
      (await ev("__fm.count()")).endsWith(" of 3"),
      await ev("__fm.count()"),
    );
    await query("inline.");
    check(
      "prose after an injected unit still matches",
      (await ev("__fm.count()")).endsWith(" of 1"),
      await ev("__fm.count()"),
    );
    await ctx.shot("find-math");
  } finally {
    server.close();
  }
  return ok;
}
