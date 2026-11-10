// Scenario for scripts/cdp-driver.mjs: where the find bar's queries land, and
// what a session switch leaves of a search, on the REAL webview bundle booted
// against a stub host with two seeded sessions (prose, code, tool calls whose
// output folds, and one turn long enough to scroll inside with its header
// pinned). The checks:
//   origin  a word typed letter by letter lands where the same word pasted
//           whole does, and so does a typo corrected on the way. Every
//           letter lands by the one reading position, the first line that
//           shows whole under the pinned header, which a linear walk of the
//           transcript finds here on its own (the engine halves its way to
//           it). A landing in view scrolls nothing, no letter scrolls up,
//           and the pinned header's own match is not the landing. Near the
//           end, a word whose first letter matches over 20000 times lands
//           the same
//   moves   a step moves the origin to its match, so a longer query goes on
//           from there and the shorter one comes back to it. A landing's own
//           scroll leaves the origin alone, while a wheel turn, a press, and
//           a key in the chat each hand it back to the reading position
//   hidden  a prompt's text matches once: its second copy, a heading for
//           screen readers clipped to a pixel, is no match, and neither is
//           a "Show more" that shows nowhere
//   wrap    with no match from the origin on, the first match overall
//   flip    an option flipped on and off again ends on the same match
//   swap    a new session, which has no transcript at all, takes the
//           matches, the active match and the ruler with it, and the counter
//           reads "No results". Back in a session the counter reads "? of n"
//           with no match active, the first step lands by the reading
//           position there, and a step back lands before it, as a block
//           step back enters the block before it at its first match. A
//           session slow to load never reads "No results" on the way, and a
//           match that appears while none is active stays unmarked
//
//   node scripts/cdp-driver.mjs scripts/repro/find-origin.mjs 760 900
//
// The bundle served is the compiled patcher's own output for the live install
// (findBarWebview, out/, so compile first), as in find-typing.mjs. The live
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

const A = "66666666-6666-4666-8666-666666666666";
const B = "55555555-5555-4555-8555-555555555555";
const TITLE = { [A]: "Alpha long", [B]: "Beta short" };
// The long turn of session A, whose prompt and forty extra paragraphs carry
// MARK, and a token no transcript holds.
const LONG = 10;
const MARK = "zebraquux";
const NONE = "qqzzxv";

// A seeded transcript: per turn a prompt, a Bash call and its output (which
// folds), a Read call and its listing, and a closing response with a list
// and a fence. The words hold a family on "ver", so a query grown or cut
// by a letter changes what it matches.
function transcript(id, turns, seed, long) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const W = (
    "the a of to and in is that for it as with on be by this are from or at an " +
    "selection find bar transcript match highlight range scroll render patch " +
    "bundle webview native engine layout paint style token offset node element " +
    "query search cache index value state update rescan reveal block ruler " +
    "message turn response prompt session model cursor input composer scroller " +
    "theory measure kernel bound proof lemma estimate variance sample effect " +
    "graph vertex edge path cycle tree order relation partial total chain " +
    "version versatile verify vertical very vector velocity"
  ).split(" ");
  const word = () => W[Math.floor(rnd() * W.length)];
  const sentence = () => {
    const ws = [];
    for (let i = 8 + Math.floor(rnd() * 14); i > 0; i--) {
      const r = rnd();
      const w = word();
      ws.push(r < 0.06 ? "`" + w + "()`" : r < 0.09 ? "**" + w + "**" : w);
    }
    const t = ws.join(" ");
    return t[0].toUpperCase() + t.slice(1) + ".";
  };
  const para = () =>
    Array.from({ length: 2 + Math.floor(rnd() * 4) }, sentence).join(" ");
  const code = (n) =>
    Array.from(
      { length: n },
      (_, i) =>
        `  const ${word()}${i} = ${word()}(${word()}, ${Math.floor(rnd() * 100)});`,
    ).join("\n");
  const msgs = [];
  let n = 0;
  const now = Date.now();
  const base = (type) => ({
    type,
    uuid: `${id.slice(0, 8)}-0000-4000-8000-${(n++).toString(16).padStart(12, "0")}`,
    session_id: id,
    parent_tool_use_id: null,
    timestamp: new Date(now - (turns * 10 - n) * 1000).toISOString(),
  });
  const asst = (content) =>
    msgs.push({
      ...base("assistant"),
      message: {
        id: `msg_${id.slice(0, 4)}${n}`,
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content,
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
  const user = (content) =>
    msgs.push({ ...base("user"), message: { role: "user", content } });
  for (let t = 0; t < turns; t++) {
    const mark = t === long ? MARK + " " : "";
    const tool = `${id.slice(0, 4)}${t}`;
    user([{ type: "text", text: `Turn ${t + 1}: ${mark}${para()}` }]);
    asst([
      { type: "text", text: para() + "\n\n" + para() },
      {
        type: "tool_use",
        id: `toolu_b${tool}`,
        name: "Bash",
        input: {
          command: `grep -n "${word()}" src/x.ts`,
          description: sentence(),
        },
      },
    ]);
    user([
      {
        type: "tool_result",
        tool_use_id: `toolu_b${tool}`,
        content: Array.from(
          { length: 8 + Math.floor(rnd() * 20) },
          (_, i) => `${100 + i}:  ${sentence()}`,
        ).join("\n"),
      },
    ]);
    asst([
      {
        type: "tool_use",
        id: `toolu_r${tool}`,
        name: "Read",
        input: { file_path: `/repo/src/${word()}.ts` },
      },
    ]);
    user([
      { type: "tool_result", tool_use_id: `toolu_r${tool}`, content: code(40) },
    ]);
    const extra =
      t === long
        ? Array.from(
            { length: 40 },
            (_, i) => `\n\nLong ${i} ${MARK} ${para()}`,
          )
        : [];
    asst([
      {
        type: "text",
        text:
          para() +
          `\n\n- ${sentence()}\n- ${sentence()}\n- ${sentence()}` +
          "\n\n```ts\n" +
          code(6) +
          "\n```\n\n" +
          para() +
          "\n\n" +
          para() +
          extra.join(""),
      },
    ]);
  }
  return msgs;
}

// The stub host, as in find-typing.mjs, with two sessions on disk and their
// transcripts loaded ahead of the bundle from a classic script. A session's
// transcript is answered after window.__delay ms when that is set, which is
// how long the session then shows its loading state.
const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-font-family:system-ui;--vscode-font-size:13px;
--vscode-foreground:#cccccc;--vscode-sideBar-background:#181818;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${A}"></div>
<script src="/messages.js"></script>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
window.__delay = 0;
const NOW = Date.now();
const SESSIONS = ${JSON.stringify([
  [A, TITLE[A], 1],
  [B, TITLE[B], 60],
])}.map(([id, t, age]) => ({ id, summary: t, customTitle: t,
  lastModified: NOW - age * 60e3, lastActivity: NOW - age * 60e3, archived: false,
  fileSize: 4096, gitBranch: "develop", isCurrentWorkspace: true }));
const deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
const respond = (requestId, response) => deliver({ type: "response", requestId, response });
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
        resp = { type: "list_sessions_response",
          sessions: SESSIONS.map((s) => ({ ...s })), folderKey: "k" };
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
          messages: window.MESSAGES[r.sessionId] || [], sessionDiffs: [] };
        if (window.__delay) return void setTimeout(respond, window.__delay, msg.requestId, resp);
        break;
    }
    respond(msg.requestId, resp);
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

// Page-side probes. The second half is an oracle for the engine's reading
// position, by its definition and none of its method: a linear walk over the
// visible text nodes and their characters, where the engine searches by
// halves over its cached haystack. edge() mirrors the engine's own numbers
// (TOP minus GAP, 42px, under the bar, or the pinned header's bottom), and
// the 3px that tell a line from the next one mirror seatView's. Keep them
// in step.
const PROBES = `(() => {
  const sc = () => document.querySelector('[class*="messagesContainer_"]');
  const STICKY = '[class*="stickyHeader_"]';
  // Text set out for screen readers alone, clipped to a pixel.
  const SR = '[class*="visuallyHidden_"],[class*="srOnly_"]';
  const pr = document.createRange();
  window.__fg = {
    sc,
    input: () => document.querySelector(".ccup-find-bar input"),
    count: () => document.querySelector(".ccup-find-bar .ccup-find-count span")?.textContent ?? null,
    st: () => { const s = sc(); return s ? s.scrollTop : null; },
    title: () => document.querySelector('[class*="titleText_"]')?.getAttribute("title") ?? null,
    // The active match's start, as a node and an offset, or null.
    act() {
      const h = CSS.highlights.get("ccup-find-active");
      const a = h && [...h][0];
      return a ? [a.startContainer, a.startOffset] : null;
    },
    painted: () => CSS.highlights.get("ccup-find")?.size ?? 0,
    ruler() {
      const r = document.querySelector(".ccup-find-ruler");
      return !!r && getComputedStyle(r).display !== "none";
    },
    off: () => document.querySelector('.ccup-find-bar button[aria-label="Next Match"]')?.hasAttribute("data-off") ?? null,
    loading: () => !!document.querySelector('[class*="loadingState_"]'),
    // The pinned header: stuck at the scroller's top with its turn above.
    pinned() {
      const s = sc(), rt = s.getBoundingClientRect().top;
      return [...s.querySelectorAll(STICKY)].find((h) => {
        const r = h.getBoundingClientRect();
        return r.top <= rt + 4 && r.bottom > rt + 4 && h.parentElement.getBoundingClientRect().top < rt - 40;
      }) || null;
    },
    edge() {
      const s = sc(), rt = s.getBoundingClientRect().top;
      let e = Math.max(42, rt);
      for (const h of s.querySelectorAll(STICKY)) {
        const r = h.getBoundingClientRect();
        if (r.top <= rt + 4 && r.bottom > e) e = r.bottom;
      }
      return e;
    },
    // The transcript's visible text nodes, in document order: none of the
    // text for screen readers alone, unless all is asked for.
    nodes(all) {
      const out = [], vis = new Map();
      const w = document.createTreeWalker(sc(), 4);
      while (w.nextNode()) {
        const n = w.currentNode, p = n.parentElement;
        if (!p || !n.nodeValue) continue;
        let v = vis.get(p);
        if (v === undefined) {
          v = !["SCRIPT", "STYLE", "NOSCRIPT"].includes(p.tagName) && p.checkVisibility() &&
            (!!all || !p.closest(SR));
          vis.set(p, v);
        }
        if (v) out.push(n);
      }
      return out;
    },
    // How often q occurs in the text that shows, and in the text for screen
    // readers alone, with the registered ranges that start in the latter.
    copies(q) {
      const Q = q.toLowerCase();
      const count = (ns) => {
        let c = 0;
        for (const n of ns) {
          const t = n.nodeValue.toLowerCase();
          for (let k = t.indexOf(Q); k >= 0; k = t.indexOf(Q, k + Q.length)) c++;
        }
        return c;
      };
      const shown = count(__fg.nodes()), every = count(__fg.nodes(true));
      let ranges = 0;
      for (const name of ["ccup-find", "ccup-find-active"]) {
        for (const r of CSS.highlights.get(name) || []) {
          const e = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
          if (e && e.closest(SR)) ranges++;
        }
      }
      return { shown, hidden: every - shown, ranges };
    },
    // b cut to the boxes that clip node n: a pinned header, a folded row.
    clipped(n, b) {
      const s = sc();
      for (let e = n.parentElement; e && e !== s; e = e.parentElement) {
        if (e.matches(STICKY) || getComputedStyle(e).overflowY !== "visible")
          b = Math.min(b, e.getBoundingClientRect().bottom);
      }
      return b;
    },
    // The first character from (i0, o0) on whose line reaches below y.
    scan(ns, y, i0, o0) {
      for (let i = i0; i < ns.length; i++) {
        const n = ns[i];
        pr.selectNodeContents(n);
        const r = pr.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        if (__fg.clipped(n, r.bottom) <= y) continue;
        for (let o = i === i0 ? o0 : 0; o < n.nodeValue.length; o++) {
          pr.setStart(n, o);
          pr.setEnd(n, o + 1);
          const c = pr.getBoundingClientRect();
          if ((c.width || c.height) && c.bottom > y) return { i, o, top: c.top, bottom: c.bottom };
        }
      }
      return null;
    },
    // Seat the oracle's origin at the reading position of the view as it
    // stands, for the land() calls that follow.
    seat() {
      const ns = __fg.nodes(), edge = __fg.edge();
      let p = __fg.scan(ns, edge, 0, 0);
      if (p && p.top < edge - 0.5) p = __fg.scan(ns, p.bottom + 3, p.i, p.o) || p;
      window.__seat = p ? [ns[p.i], p.o] : null;
      return { edge, top: p ? p.top : null, text: p ? ns[p.i].nodeValue.slice(p.o, p.o + 24) : null };
    },
    // Or at the active match, where a step leaves the engine's.
    seatAtActive() { window.__seat = __fg.act(); },
    // The landing for q from the seat: the first occurrence that ends after
    // it, else the first of all. Kept in window.__land with the occurrence
    // before it (else the last of all), for same() and back().
    land(q) {
      const ns = __fg.nodes(), at = window.__seat, Q = q.toLowerCase();
      const i0 = at ? ns.indexOf(at[0]) : -1;
      let first = null, last = null, hit = null, prev = null, total = 0, rank = 0, prevRank = 0;
      for (let i = 0; i < ns.length; i++) {
        const t = ns[i].nodeValue.toLowerCase();
        for (let k = t.indexOf(Q); k >= 0; k = t.indexOf(Q, k + Q.length)) {
          total++;
          last = [ns[i], k];
          if (!first) first = last;
          const after = i0 >= 0 && (i > i0 || (i === i0 && k + Q.length > at[1]));
          if (after && !hit) { hit = last; rank = total; }
          if (!after) { prev = last; prevRank = total; }
        }
      }
      window.__land = { pt: hit || first, prev: prev || last };
      let box = null;
      if (hit) {
        pr.setStart(hit[0], hit[1]);
        pr.setEnd(hit[0], hit[1] + Q.length);
        const b = pr.getBoundingClientRect();
        box = { top: b.top, bottom: b.bottom };
      }
      return { total, wrapped: !hit, rank: hit ? rank : total ? 1 : 0,
        prevRank: prev ? prevRank : total, box };
    },
    text: (pt) => (pt && pt[0].nodeType === 3 ? pt[0].nodeValue.slice(Math.max(0, pt[1] - 12), pt[1] + 16) : null),
    is: (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1],
    // The active match is the oracle's landing, or the occurrence before it.
    same() {
      const a = __fg.act(), w = window.__land.pt;
      return { same: __fg.is(a, w), got: __fg.text(a), want: __fg.text(w) };
    },
    back() {
      const a = __fg.act(), w = window.__land.prev;
      return { same: __fg.is(a, w), got: __fg.text(a), want: __fg.text(w) };
    },
    keep(name) { (window.__kept ||= {})[name] = __fg.act(); },
    kept: (name) => __fg.is(__fg.act(), (window.__kept || {})[name]),
    // The block a point lies in, as the engine's block skip takes it: the
    // nearest ancestor of a baked block class, else the transcript row.
    block(pt) {
      const s = sc(), B = window.__ccupFindCfg.blocks;
      let row = null;
      for (let e = pt[0].parentElement; e && e !== s; e = e.parentElement) {
        if (B.some((b) => e.classList.contains(b))) return e;
        row = e;
      }
      return row;
    },
    // The active match's place among q's occurrences, and whether it heads
    // its block: the occurrence before it lies in another one.
    heads(q) {
      const a = __fg.act(), Q = q.toLowerCase(), all = [];
      for (const n of __fg.nodes()) {
        const t = n.nodeValue.toLowerCase();
        for (let k = t.indexOf(Q); k >= 0; k = t.indexOf(Q, k + Q.length)) all.push([n, k]);
      }
      const i = all.findIndex((p) => __fg.is(p, a));
      return { i, head: i === 0 || (i > 0 && __fg.block(all[i - 1]) !== __fg.block(a)) };
    },
    // Occurrences of q showing in the viewport, and those no registered
    // range starts at, as in find-typing.mjs.
    cover(q) {
      const have = new Set();
      const key = (n, o) => (n.__fk ||= Math.random()) + ":" + o;
      for (const name of ["ccup-find", "ccup-find-active"]) {
        const h = CSS.highlights.get(name);
        if (h) for (const r of h) have.add(key(r.startContainer, r.startOffset));
      }
      const Q = q.toLowerCase();
      let want = 0, miss = 0;
      for (const n of __fg.nodes()) {
        const t = n.nodeValue.toLowerCase();
        for (let i = t.indexOf(Q); i >= 0; i = t.indexOf(Q, i + Q.length)) {
          pr.setStart(n, i);
          pr.setEnd(n, i + Q.length);
          const b = pr.getBoundingClientRect();
          if (b.width > 0 && b.bottom > 0 && b.top < innerHeight) {
            want++;
            if (!have.has(key(n, i))) miss++;
          }
        }
      }
      return { want, miss };
    },
    // A sampler of the counter and the ruler through a session switch.
    watch() {
      window.__seen = [];
      window.__watch = setInterval(() => window.__seen.push({
        count: __fg.count(), ruler: __fg.ruler(), sc: !!sc(), loading: __fg.loading(),
        painted: __fg.painted(), act: !!__fg.act() }), 20);
    },
    seen() { clearInterval(window.__watch); return window.__seen; },
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
  const msgs = `window.MESSAGES = ${JSON.stringify({
    [A]: transcript(A, 40, 12345, LONG),
    [B]: transcript(B, 6, 777, -1),
  })};`;

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
      res.writeHead(200, { "content-type": "text/html" }).end(page);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const ev = (s) => ctx.evaluate(s);
  const J = (o) => JSON.stringify(o);
  const frames = (n) =>
    ctx.cdp("Runtime.evaluate", {
      expression: `new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r(1)); requestAnimationFrame(f); })`,
      awaitPromise: true,
    });
  const settle = async (ms) => {
    await ctx.sleep(ms);
    await frames(3);
  };
  const until = async (expr, ms = 8000) => {
    for (let t = 0; t < ms; t += 50) {
      if (await ev(expr)) return true;
      await ctx.sleep(50);
    }
    return !!(await ev(expr));
  };
  const focusInput = () =>
    ev(`(() => { const i = __fg.input(); i.focus(); i.select(); })()`);
  const mod = process.platform === "darwin" ? "metaKey" : "ctrlKey";
  const openChord = () =>
    ev(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ${mod}: true, bubbles: true, cancelable: true }))`,
    );
  // A real key, to whatever holds the focus, under CDP modifier bits.
  const SHIFT = 8;
  const MOD = process.platform === "darwin" ? 4 : 2;
  const key = async (k, code, modifiers = 0) => {
    for (const type of ["keyDown", "keyUp"]) {
      await ctx.cdp("Input.dispatchKeyEvent", {
        type,
        key: k,
        code: k,
        windowsVirtualKeyCode: code,
        modifiers,
      });
    }
  };
  // Empty the query and close the bar, so the next opening starts clean.
  const close = async () => {
    if (!(await ev(`!!document.querySelector(".ccup-find-bar[data-open]")`)))
      return;
    await ev(
      `(() => { const i = __fg.input(); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
    await ctx.sleep(150);
    await ev(
      `__fg.input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`,
    );
    await settle(60);
  };
  // The bar opened afresh over the view at scroll position pos, and the
  // oracle seated at that view.
  const openAt = async (pos) => {
    await close();
    await ev(`void (__fg.sc().scrollTop = ${pos})`);
    await settle(250);
    await openChord();
    await settle(150);
    return ev("__fg.seat()");
  };
  // Replace the query at once, then wait out the debounce and the reveal.
  const paste = async (q) => {
    await focusInput();
    await ctx.cdp("Input.insertText", { text: q });
    await settle(300);
  };
  // Type more letters at the caret, one at a time, each past the debounce,
  // comparing every landing with the oracle's for the query so far.
  const type = async (sofar, letters) => {
    const steps = [];
    let q = sofar;
    let st = await ev("__fg.st()");
    for (const ch of letters) {
      q += ch;
      const want = await ev(`__fg.land(${J(q)})`);
      await ctx.cdp("Input.insertText", { text: ch });
      await settle(170);
      const got = await ev("__fg.same()");
      const now = await ev("__fg.st()");
      steps.push({ q, ...got, wrapped: want.wrapped, up: now < st - 0.5 });
      st = now;
    }
    return steps;
  };
  const backspace = async (n) => {
    for (let i = 0; i < n; i++) await key("Backspace", 8);
    await settle(300);
  };
  const wheel = (dy) =>
    ctx.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 380,
      y: 450,
      deltaX: 0,
      deltaY: dy,
    });
  const history = async (title) => {
    await ev(
      `document.querySelector('[aria-label="Session history"]').click()`,
    );
    const DLG = `[role=dialog][aria-label="Past conversations"]`;
    await until(`!!document.querySelector('${DLG}')`);
    return ev(`(() => {
      const row = [...document.querySelectorAll('${DLG} button[id]')]
        .find((b) => b.textContent.includes(${J(title)}));
      if (row) row.click();
      return !!row;
    })()`);
  };
  // A session's transcript is up once its row count holds.
  const rendered = async () => {
    let last = -1;
    let stable = 0;
    for (let t = 0; t < 60000 && stable < 8; t += 100) {
      const n = await ev(
        `document.querySelectorAll('[data-testid="assistant-message"]').length`,
      );
      stable = n > 0 && n === last ? stable + 1 : 0;
      last = n;
      await ctx.sleep(100);
    }
    return last;
  };

  try {
    await ctx.navigate(base);
    const rows = await rendered();
    if (
      !check(
        "the transcript rendered",
        rows > 100,
        `${rows} responses; ${await ev(`document.getElementById("claude-error").textContent`)}`,
      )
    )
      return false;
    await ev(PROBES);
    const H = await ev("__fg.sc().scrollHeight - __fg.sc().clientHeight");
    // Deep inside the long turn, its header pinned over its own paragraphs.
    const deep = await ev(`(() => {
      const s = __fg.sc();
      const u = [...s.querySelectorAll('[class*="stickyHeader_"]')].find((h) => h.textContent.includes("${MARK}"));
      return s.scrollTop + u.parentElement.getBoundingClientRect().top - s.getBoundingClientRect().top + 4200;
    })()`);
    await openChord();
    await settle(200);
    if (
      !check(
        "the chord opens the bar",
        await ev(`!!document.querySelector(".ccup-find-bar[data-open]")`),
      )
    )
      return false;

    // origin: typed against pasted, every letter against the oracle.
    const places = [0.21, 0.46, 0.72, 0.9].map((f) => Math.round(f * H));
    places.push(Math.round(deep));
    const words = ["version", "graph", "relation"];
    const letters = [];
    const ends = [];
    const calm = [];
    for (const pos of places) {
      for (const w of words) {
        await openAt(pos);
        const from = await ev("__fg.st()");
        await focusInput();
        letters.push(...(await type("", w)).map((s) => ({ pos, ...s })));
        await ev(`__fg.keep("typed")`);
        const typed = await ev("__fg.count()");
        await openAt(pos);
        const want = await ev(`__fg.land(${J(w)})`);
        await paste(w);
        const got = await ev("__fg.same()");
        const pasted = await ev("__fg.count()");
        ends.push({
          pos,
          w,
          typed,
          pasted,
          one: (await ev(`__fg.kept("typed")`)) && got.same,
          rank: `${want.rank} of ${want.total}`,
        });
        // A landing showing whole and clear of the composer scrolls nothing.
        if (
          want.box &&
          want.box.bottom < ctx.viewport.height - 300 &&
          !want.wrapped
        ) {
          calm.push({ pos, w, moved: (await ev("__fg.st()")) - from });
        }
      }
    }
    const off = letters.filter((s) => !s.same);
    check(
      "typing: every letter lands by the one reading position, as a linear walk finds it",
      letters.length > 80 && off.length === 0,
      `${letters.length - off.length} of ${letters.length}${off.length ? `, first miss ${J(off[0])}` : ""}`,
    );
    const split = ends.filter(
      (e) => !e.one || e.typed !== e.pasted || e.typed !== e.rank,
    );
    check(
      "typing: a word typed letter by letter lands where the word pasted whole does",
      split.length === 0,
      split.length ? J(split) : ends.map((e) => `${e.w} ${e.typed}`).join(", "),
    );
    const ups = letters.filter((s) => s.up && !s.wrapped);
    check(
      "typing: no letter scrolls the chat up, short of a wrap",
      ups.length === 0,
      ups.length ? J(ups[0]) : `${letters.length} letters`,
    );
    const stirred = calm.filter((c) => Math.abs(c.moved) > 0.5);
    check(
      "typing: a landing that shows scrolls nothing",
      calm.length >= 5 && stirred.length === 0,
      `${calm.length - stirred.length} of ${calm.length} held${stirred.length ? `, ${J(stirred[0])}` : ""}`,
    );

    // A common first letter near the end: its matches run past 20000 before
    // the view, where a shorter match list would end and the letter wrap to
    // the first match of all.
    await openAt(Math.round(0.96 * H));
    const many = await ev(`__fg.land("e")`);
    const late = await ev("__fg.st()");
    await focusInput();
    const common = await type("", "element");
    check(
      "typing: a word whose first letter matches over 20000 times lands by the reading position near the end, and scrolls nothing up",
      many.total > 20000 &&
        many.rank > 20000 &&
        common.every((s) => s.same && !s.up) &&
        (await ev("__fg.st()")) >= late - 0.5,
      `"e" ${many.rank} of ${many.total}, ${J(common.filter((s) => !s.same || s.up)[0] ?? null)}, ${await ev("__fg.count()")}`,
    );

    // A typo, corrected: "vert" lands on another word, then back to "ver",
    // then on to "version".
    await openAt(places[1]);
    await ev(`__fg.land("version")`);
    await paste("version");
    await ev(`__fg.keep("whole")`);
    const whole = await ev("__fg.count()");
    await openAt(places[1]);
    await focusInput();
    const typo = await type("", "vert");
    await backspace(1);
    const cut = {
      ...(await ev(`(__fg.land("ver"), __fg.same())`)),
      count: await ev("__fg.count()"),
    };
    const rest = await type("ver", "sion");
    check(
      "typing: a typo and its correction each land by the reading position",
      [...typo, cut, ...rest].every((s) => s.same),
      J([...typo, cut, ...rest].filter((s) => !s.same)),
    );
    check(
      "typing: and the corrected word ends where the word pasted whole does",
      (await ev(`__fg.kept("whole")`)) && (await ev("__fg.count()")) === whole,
      `${await ev("__fg.count()")} against ${whole}`,
    );

    // The pinned header holds MARK, the first of all its matches.
    const seat = await openAt(Math.round(deep));
    const pin = await ev(`(() => {
      const u = __fg.pinned();
      return u ? { has: u.textContent.includes("${MARK}"), bottom: u.getBoundingClientRect().bottom } : null;
    })()`);
    if (
      !check(
        "precondition: the long turn's header is pinned, and holds the token",
        !!pin && pin.has,
        J({ pin, seat }),
      )
    )
      return false;
    const deepAt = await ev("__fg.st()");
    const markWant = await ev(`__fg.land("${MARK}")`);
    await paste(MARK);
    const mark = await ev(`(() => {
      const a = __fg.act(), u = __fg.pinned();
      let held = 0;
      for (const r of CSS.highlights.get("ccup-find") || []) if (u && u.contains(r.startContainer)) held++;
      return { ...__fg.same(), count: __fg.count(), st: __fg.st(), inHeader: !!a && !!u && u.contains(a[0]), held };
    })()`);
    check(
      "pinned: the landing is the first match under the header, not the header's own, and the view holds",
      mark.same &&
        !mark.inHeader &&
        !markWant.wrapped &&
        markWant.rank > 1 &&
        Math.abs(mark.st - deepAt) < 0.5,
      J({
        ...mark,
        want: `${markWant.rank} of ${markWant.total}`,
        from: deepAt,
      }),
    );
    check(
      "pinned: the header's own match is painted as a match",
      mark.held >= 1,
      J(mark),
    );

    // moves: three steps on from a landing, then a longer and a shorter
    // query.
    await openAt(places[0]);
    const verWant = await ev(`__fg.land("ver")`);
    await paste("ver");
    for (let i = 0; i < 3; i++) await key("Enter", 13);
    await settle(300);
    const stepped = await ev("__fg.count()");
    const three = `${((verWant.rank - 1 + 3) % verWant.total) + 1} of ${verWant.total}`;
    if (
      !check(
        "precondition: three steps on from the landing",
        stepped === three,
        `${stepped}, landing ${verWant.rank} of ${verWant.total}`,
      )
    )
      return false;
    await ev(`(__fg.keep("step"), __fg.seatAtActive())`);
    // Past the step's own match unless it reads "vers" too.
    const more = await type("ver", "s");
    check(
      "moves: after a step, a longer query lands on the first match from the step on",
      more[0].same,
      J(more[0]),
    );
    await backspace(1);
    check(
      "moves: and the shorter one comes back to the step's match",
      (await ev(`__fg.kept("step")`)) && (await ev("__fg.count()")) === stepped,
      `${await ev("__fg.count()")} against ${stepped}`,
    );

    // A landing far below scrolls there, and the next query still lands by
    // the reading position the first was typed at, well above the long turn.
    await openAt(Math.max(0, Math.round(deep) - 9200));
    const far = await ev(`__fg.land("${MARK}")`);
    const farFrom = await ev("__fg.st()");
    await paste(MARK);
    const farTo = await ev("__fg.st()");
    const next = await ev(`__fg.land("relation")`);
    await paste("relation");
    const kept = await ev("__fg.same()");
    check(
      "moves: a landing's own scroll leaves the origin where typing began",
      !far.wrapped &&
        farTo - farFrom > ctx.viewport.height &&
        kept.same &&
        !next.wrapped,
      J({ scrolled: farTo - farFrom, ...kept, back: await ev("__fg.st()") }),
    );
    // The same, after a wheel turn in the chat, lands by the new view.
    await paste(MARK);
    await wheel(700);
    await settle(250);
    await ev("__fg.seat()");
    const wheeled = await ev(`__fg.land("relation")`);
    await paste("relation");
    const byWheel = await ev("__fg.same()");
    check(
      "moves: a wheel turn in the chat hands the origin back to the reading position",
      byWheel.same && wheeled.rank !== next.rank,
      J({ ...byWheel, now: wheeled.rank, before: next.rank }),
    );
    // A press on a response's text, away from the first landing.
    await paste(MARK);
    await ev(`void (__fg.sc().scrollTop = ${places[2]})`);
    await settle(250);
    const spot = await ev(`(() => {
      for (const p of __fg.sc().querySelectorAll('[data-testid="assistant-message"] p')) {
        const b = p.getBoundingClientRect();
        if (b.top > 200 && b.bottom < innerHeight - 320) return { x: b.left + 8, y: b.top + 6 };
      }
      return null;
    })()`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await ctx.cdp("Input.dispatchMouseEvent", {
        type,
        x: spot.x,
        y: spot.y,
        button: "left",
        clickCount: 1,
      });
    }
    await settle(450);
    await ev("__fg.seat()");
    const pressed = await ev(`__fg.land("graph")`);
    await paste("graph");
    const byPress = await ev("__fg.same()");
    check(
      "moves: so does a press in the chat",
      byPress.same && !pressed.wrapped,
      J({ ...byPress, rank: pressed.rank }),
    );
    // A key in the chat: Page Down with the transcript focused.
    await paste(MARK);
    await ev(`void (__fg.sc().scrollTop = ${places[1]})`);
    await settle(250);
    await ev("__fg.sc().focus()");
    await key("PageDown", 34);
    await settle(400);
    await ev("__fg.seat()");
    const keyed = await ev(`__fg.land("vertex")`);
    await paste("vertex");
    const byKey = await ev("__fg.same()");
    check(
      "moves: and so does a key in the chat",
      byKey.same && !keyed.wrapped,
      J({ ...byKey, rank: keyed.rank }),
    );

    // hidden: each turn carries its prompt a second time, as a heading for
    // screen readers, and a "Show more" for the keyboard, both clipped to a
    // pixel. Neither is a match.
    await openAt(places[0]);
    const prompt = "Turn 12:";
    await paste(prompt);
    const once = {
      count: await ev("__fg.count()"),
      ...(await ev(`__fg.copies(${J(prompt)})`)),
    };
    check(
      "hidden: a prompt's text matches once, its copy for screen readers left out",
      once.shown === 1 &&
        once.hidden >= 1 &&
        once.ranges === 0 &&
        once.count === "1 of 1",
      J(once),
    );
    await paste("Show more");
    const button = {
      count: await ev("__fg.count()"),
      ...(await ev(`__fg.copies("Show more")`)),
    };
    check(
      'hidden: so is a "Show more" that shows nowhere',
      button.hidden >= 5 &&
        button.ranges === 0 &&
        (button.shown
          ? button.count.endsWith(` of ${button.shown}`)
          : button.count === "No results"),
      J(button),
    );

    // wrap: at the end, the token's matches all lie above.
    await openAt(H);
    const wrap = await ev(`__fg.land("${MARK}")`);
    await paste(MARK);
    check(
      "wrap: with no match from the origin on, the first match overall",
      wrap.wrapped &&
        (await ev("__fg.same()")).same &&
        (await ev("__fg.count()")) === `1 of ${wrap.total}`,
      `${await ev("__fg.count()")}`,
    );

    // flip: Match Case on, then off again.
    await openAt(places[2]);
    await ev(`__fg.land("version")`);
    await paste("version");
    await ev(`__fg.keep("flip")`);
    const plain = await ev("__fg.count()");
    const caseB = `document.querySelector('.ccup-find-bar .ccup-find-opt[data-opt="c"]')`;
    await ev(`${caseB}.click()`);
    await settle(300);
    const cased = await ev("__fg.count()");
    await ev(`${caseB}.click()`);
    await settle(300);
    check(
      "flip: an option flipped on and off again ends on the same match",
      cased !== plain &&
        (await ev(`__fg.kept("flip")`)) &&
        (await ev("__fg.count()")) === plain &&
        (await ev(`${caseB}.getAttribute("aria-checked")`)) === "false",
      `${plain} -> ${cased} -> ${await ev("__fg.count()")}`,
    );

    // swap: a new session, with the ruler up in the old one.
    await openAt(places[1]);
    await ev(`__fg.land("version")`);
    await paste("version");
    const before = {
      count: await ev("__fg.count()"),
      ruler: await ev("__fg.ruler()"),
      painted: await ev("__fg.painted()"),
    };
    const totalA = Number(before.count.split(" of ")[1]);
    if (
      !check(
        "precondition: a match is active and the ruler marks its block",
        before.ruler && before.painted > 0 && totalA > 100,
        J(before),
      )
    )
      return false;
    await ev("__fg.watch()");
    await ev(`document.querySelector('[aria-label="New session"]').click()`);
    await until(`__fg.title() === "Untitled"`);
    await settle(500);
    let seen = await ev("__fg.seen()");
    // From the frame after the transcript went.
    let gone = seen.slice(seen.findIndex((s) => !s.sc) + 1);
    const stale = gone.filter(
      (s) => s.ruler || s.act || s.painted || /\d of/.test(s.count),
    );
    check(
      "swap: a new session takes the ruler, the active match and the matches with it",
      gone.length > 5 && stale.length === 0,
      `${gone.length} samples${stale.length ? `, ${J(stale[0])}` : ""}`,
    );
    check(
      'swap: its counter reads "No results", and the step buttons are off',
      (await ev("__fg.count()")) === "No results" &&
        (await ev("__fg.off()")) === true &&
        (await ev("__fg.input().value")) === "version",
      J({ count: await ev("__fg.count()"), off: await ev("__fg.off()") }),
    );
    await ctx.shot("find-origin-untitled");

    // Back in A: counted, painted, and nothing active.
    await history(TITLE[A]);
    await until(`__fg.title() === ${J(TITLE[A])}`);
    await rendered();
    await settle(600);
    const backIn = {
      count: await ev("__fg.count()"),
      ruler: await ev("__fg.ruler()"),
      act: await ev("!!__fg.act()"),
      cover: await ev(`__fg.cover("version")`),
    };
    check(
      'swap: back in a session, the counter reads "? of n" with no match active and no ruler',
      backIn.count === `? of ${totalA}` && !backIn.ruler && !backIn.act,
      J(backIn),
    );
    // Somewhere with matches in view, by the wheel as a user would get there.
    await ev(`void (__fg.sc().scrollTop = ${places[2]})`);
    await wheel(1);
    await settle(400);
    const shown = await ev(`__fg.cover("version")`);
    check(
      "swap: its matches in view are painted",
      shown.want > 0 && shown.miss === 0 && !(await ev("!!__fg.act()")),
      J(shown),
    );
    await ev("__fg.input().focus()");
    await ev("__fg.seat()");
    const step1 = await ev(`__fg.land("version")`);
    await key("Enter", 13);
    await settle(350);
    const stepIn = {
      ...(await ev("__fg.same()")),
      count: await ev("__fg.count()"),
      ruler: await ev("__fg.ruler()"),
    };
    check(
      "swap: the first step lands by the reading position there, and the ruler marks it",
      stepIn.same &&
        !step1.wrapped &&
        stepIn.count === `${step1.rank} of ${totalA}` &&
        stepIn.ruler,
      J(stepIn),
    );

    // A session that takes a while to load.
    await ev("window.__delay = 700");
    await ev("__fg.watch()");
    await history(TITLE[B]);
    await until(`__fg.title() === ${J(TITLE[B])}`);
    await rendered();
    await settle(600);
    seen = await ev("__fg.seen()");
    await ev("window.__delay = 0");
    const waited = seen.filter((s) => s.loading);
    gone = seen.slice(seen.findIndex((s) => s.loading));
    const told = gone.filter(
      (s) => s.count === "No results" || s.ruler || s.act,
    );
    const end = await ev("__fg.count()");
    check(
      'swap: a session slow to load never reads "No results", and ends on "? of n"',
      waited.length > 10 &&
        told.length === 0 &&
        waited.every((s) => s.count === "") &&
        /^\? of \d+$/.test(end),
      `${waited.length} samples loading, ${told.length} told, then ${end}${told.length ? ` ${J(told[0])}` : ""}`,
    );
    const totalB = Number(end.split(" of ")[1]);
    // A step back, from mid-session.
    await ev(
      `void (__fg.sc().scrollTop = Math.round((__fg.sc().scrollHeight - __fg.sc().clientHeight) * 0.6))`,
    );
    await wheel(1);
    await settle(400);
    await ev("__fg.input().focus()");
    await ev("__fg.seat()");
    const stepB = await ev(`__fg.land("version")`);
    await key("Enter", 13, SHIFT);
    await settle(350);
    const stepBack = {
      ...(await ev("__fg.back()")),
      count: await ev("__fg.count()"),
    };
    check(
      "swap: a step back from there lands on the match before the reading position",
      stepBack.same &&
        stepB.prevRank > 0 &&
        stepBack.count === `${stepB.prevRank} of ${totalB}`,
      J({ ...stepBack, want: stepB.prevRank }),
    );

    // A third switch, and block steps back from there.
    await history(TITLE[A]);
    await until(`__fg.title() === ${J(TITLE[A])}`);
    await rendered();
    await ev(`void (__fg.sc().scrollTop = ${places[1]})`);
    await wheel(1);
    await settle(600);
    await ev("__fg.input().focus()");
    await ev("__fg.seat()");
    await ev(`__fg.land("version")`);
    const unset = await ev("__fg.count()");
    await key("Enter", 13, MOD | SHIFT);
    await settle(350);
    const blockBack = await ev(`(() => {
      const a = __fg.act(), w = window.__land.prev;
      return { ...__fg.heads("version"), block: !!a && __fg.block(a) === __fg.block(w), count: __fg.count() };
    })()`);
    await ev(`__fg.keep("block")`);
    await key("Enter", 13, MOD | SHIFT);
    await settle(350);
    const blockOn = await ev(`(() => {
      const a = __fg.act();
      return { ...__fg.heads("version"), other: !!a && __fg.block(a) !== __fg.block(window.__kept.block), count: __fg.count() };
    })()`);
    check(
      "swap: a block step back from there enters the block before the reading position at its first match, and the next one the block before that",
      unset === `? of ${totalA}` &&
        blockBack.block &&
        blockBack.head &&
        blockOn.other &&
        blockOn.head &&
        blockOn.i >= 0 &&
        blockOn.i < blockBack.i,
      J({ unset, blockBack, blockOn }),
    );

    // A match that appears while none is active.
    await paste(NONE);
    const none = await ev("__fg.count()");
    await ev(`(() => {
      const ps = [...__fg.sc().querySelectorAll('[data-testid="assistant-message"] p')];
      const p = ps.find((p) => {
        const b = p.getBoundingClientRect();
        return b.top > 200 && b.bottom < innerHeight - 320;
      }) || ps[ps.length >> 1];
      p.append(" ${NONE} ");
    })()`);
    await settle(450);
    const born = {
      count: await ev("__fg.count()"),
      ruler: await ev("__fg.ruler()"),
      act: await ev("!!__fg.act()"),
      painted: await ev("__fg.painted()"),
    };
    await key("Enter", 13);
    await settle(300);
    check(
      "swap: a match that appears while none is active is counted and painted, not marked, until a step takes it",
      none === "No results" &&
        born.count === "? of 1" &&
        !born.ruler &&
        !born.act &&
        born.painted === 1 &&
        (await ev("__fg.count()")) === "1 of 1" &&
        (await ev("__fg.ruler()")),
      J({ none, ...born, then: await ev("__fg.count()") }),
    );
    await ctx.shot("find-origin");
  } finally {
    server.close();
  }
  return ok;
}
