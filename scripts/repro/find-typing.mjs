// Scenario for scripts/cdp-driver.mjs: the find bar on a long transcript, on
// the REAL webview bundle booted against a stub host into a seeded synthetic
// session (a few hundred turns of prose, code, tool calls and diff cards, one
// turn made long enough to scroll inside it with its header pinned). Typing
// used to cost a full transcript walk per keystroke, and every match was a
// live Range in the highlight registry, which Blink rebuilds on each frame
// with a DOM or style change. The checks:
//   cache   typing a word walks the transcript once, not once per keystroke
//   window  only the matches near the view are registered, capped for a
//           one-letter query, yet every match in view is painted: at the
//           bottom, after a jump to the top, at each step of a wheel scroll,
//           and after a jump into the middle
//   pinned  deep inside the long turn, a query landing in its pinned header
//           picks that match first, as the linear scan did, and the
//           header's matches stay painted though their document position
//           lies far above the view
//   rescan  an appended match is counted and painted without a keystroke,
//           and text hidden by an attribute drops out on the next one
//   close   Escape inside the input debounce leaves nothing painted, and a
//           reopen repaints the kept query
//
//   node scripts/cdp-driver.mjs scripts/repro/find-typing.mjs 760 900
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

const R = "66666666-6666-4666-8666-666666666666";
const TURNS = 120;
// The long turn: early enough that a one-letter query's matches there fall
// under the bar's 20000 match cap, which bounds both engines alike.
const LONG = 10;
const MARK = "zebraquux";
// The painted window's cap (WINMAX in the engine), plus the pinned header's
// allowance on top of it.
const WINMAX = 1000;

// The seeded transcript: per turn a prompt, a Bash call and its output, a
// Read call and its listing, an Edit diff every third turn, and a closing
// response with a list and a fence. The long turn's prompt and forty extra
// paragraphs of its response carry MARK.
function transcript() {
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const W = (
    "the a of to and in is that for it as with on be by this are from or at an " +
    "selection find bar transcript match highlight range scroll render patch " +
    "bundle webview native engine layout paint style token offset node element " +
    "query search cache index value state update rescan reveal block ruler " +
    "message turn response prompt session model cursor input composer scroller " +
    "theory measure kernel bound proof lemma estimate variance sample effect " +
    "graph vertex edge path cycle tree order relation partial total chain"
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
  let id = 0;
  const now = Date.now();
  const base = (type) => ({
    type,
    uuid: `00000000-0000-4000-8000-${(id++).toString(16).padStart(12, "0")}`,
    session_id: R,
    parent_tool_use_id: null,
    timestamp: new Date(now - (TURNS * 10 - id) * 1000).toISOString(),
  });
  const asst = (content) =>
    msgs.push({
      ...base("assistant"),
      message: {
        id: "msg_" + id,
        type: "message",
        role: "assistant",
        model: "claude-fable-5",
        content,
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
  const user = (content, extra) =>
    msgs.push({
      ...base("user"),
      message: { role: "user", content },
      ...extra,
    });
  for (let t = 0; t < TURNS; t++) {
    const mark = t === LONG ? MARK + " " : "";
    user([{ type: "text", text: `Turn ${t + 1}: ${mark}${para()}` }]);
    asst([
      { type: "text", text: para() + "\n\n" + para() },
      {
        type: "tool_use",
        id: `toolu_b${t}`,
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
        tool_use_id: `toolu_b${t}`,
        content: Array.from(
          { length: 8 + Math.floor(rnd() * 20) },
          (_, i) => `${100 + i}:  ${sentence()}`,
        ).join("\n"),
      },
    ]);
    asst([
      {
        type: "tool_use",
        id: `toolu_r${t}`,
        name: "Read",
        input: { file_path: `/repo/src/${word()}.ts` },
      },
    ]);
    user([
      {
        type: "tool_result",
        tool_use_id: `toolu_r${t}`,
        content: code(40),
      },
    ]);
    if (t % 3 === 0) {
      const old = code(4);
      asst([
        {
          type: "tool_use",
          id: `toolu_e${t}`,
          name: "Edit",
          input: {
            file_path: "/repo/src/x.ts",
            old_string: old,
            new_string: code(5),
          },
        },
      ]);
      user(
        [
          {
            type: "tool_result",
            tool_use_id: `toolu_e${t}`,
            content: "The file has been updated successfully.",
          },
        ],
        {
          tool_use_result: {
            originalFile: code(10) + "\n" + old + "\n" + code(10),
            oldString: old,
            replaceAll: false,
          },
        },
      );
    }
    const long =
      t === LONG
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
          long.join(""),
      },
    ]);
  }
  return msgs;
}

// The stub host, as in find-math.mjs, with the transcript loaded ahead of the
// bundle from a classic script. A createTreeWalker wrapper counts the walks
// rooted at the chat scroller, which is what a haystack collect starts with.
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
<script src="/messages.js"></script>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
window.__walks = 0;
const ctw = Document.prototype.createTreeWalker;
Document.prototype.createTreeWalker = function (root, ...rest) {
  if (root && root.classList && [...root.classList].some((c) => c.startsWith("messagesContainer_")))
    window.__walks++;
  return ctw.call(this, root, ...rest);
};
const R = "${R}", NOW = Date.now();
const SESSION = { id: R, summary: "Long", customTitle: "Long", lastModified: NOW,
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
<script type="module" src="/wv/index.js"></script>
</body></html>`;

const TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

// Page-side probes. cover(q) finds every occurrence of q inside one visible
// text node of the transcript that lies in the viewport, and counts those no
// registered range starts at (painted or active): the misses.
const PROBES = `(() => {
  const sc = () => document.querySelector('[class*="messagesContainer_"]');
  const key = (n, o) => {
    if (!n.__fk) n.__fk = Math.random();
    return n.__fk + ":" + o;
  };
  window.__ft = {
    sc,
    count: () => document.querySelector(".ccup-find-bar .ccup-find-count span")?.textContent ?? null,
    total: () => Number(String(__ft.count()).split(" of ")[1]),
    painted: () => CSS.highlights.get("ccup-find")?.size ?? 0,
    cover(q) {
      const have = new Set();
      for (const name of ["ccup-find", "ccup-find-active"]) {
        const h = CSS.highlights.get(name);
        if (h) for (const r of h) have.add(key(r.startContainer, r.startOffset));
      }
      const vh = innerHeight, Q = q.toLowerCase(), pr = document.createRange();
      const w = document.createTreeWalker(sc(), 4);
      let want = 0, miss = 0;
      while (w.nextNode()) {
        const n = w.currentNode;
        if (!n.parentElement || !n.parentElement.checkVisibility()) continue;
        const t = n.nodeValue.toLowerCase();
        for (let i = t.indexOf(Q); i >= 0; i = t.indexOf(Q, i + Q.length)) {
          pr.setStart(n, i);
          pr.setEnd(n, i + Q.length);
          const b = pr.getBoundingClientRect();
          if (b.width > 0 && b.bottom > 0 && b.top < vh) {
            want++;
            if (!have.has(key(n, i))) miss++;
          }
        }
      }
      return { want, miss, painted: __ft.painted() };
    },
    // The long turn's header and its scroller-relative state.
    head() {
      const s = sc(), sr = s.getBoundingClientRect();
      const u = [...s.querySelectorAll('[class*="stickyHeader_"]')].find((h) => h.textContent.includes("${MARK}"));
      if (!u) return null;
      const ur = u.getBoundingClientRect();
      let painted = 0;
      for (const r of CSS.highlights.get("ccup-find") || []) if (u.contains(r.startContainer)) painted++;
      let active = 0;
      for (const r of CSS.highlights.get("ccup-find-active") || []) if (u.contains(r.startContainer)) active++;
      return { pinned: Math.abs(ur.top - sr.top) < 5, painted, active, turnH: u.parentElement.getBoundingClientRect().height };
    },
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
      res.writeHead(200, { "content-type": "text/html" }).end(page);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const ev = (s) => ctx.evaluate(s);
  const J = (o) => JSON.stringify(o);
  // A few frames, so the bar's frame callback has painted the window.
  const frames = (n) =>
    ctx.cdp("Runtime.evaluate", {
      expression: `new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r(1)); requestAnimationFrame(f); })`,
      awaitPromise: true,
    });
  const settle = async (ms) => {
    await ctx.sleep(ms);
    await frames(3);
  };
  const focusInput = () =>
    ev(
      `(() => { const i = document.querySelector(".ccup-find-bar input"); i.focus(); i.select(); })()`,
    );
  // Replace the query at once, then wait out the 90ms input debounce.
  const query = async (q) => {
    await focusInput();
    await ctx.cdp("Input.insertText", { text: q });
    await settle(300);
  };
  const scrollBy = (expr) =>
    ev(`(() => { const s = __ft.sc(); s.scrollTop = ${expr}; })()`);
  const mod = process.platform === "darwin" ? "metaKey" : "ctrlKey";
  const openChord = () =>
    ev(
      `window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ${mod}: true, bubbles: true, cancelable: true }))`,
    );

  try {
    await ctx.navigate(base);
    // Booted once every turn's prompt rendered and the row count holds.
    let last = -1;
    let stable = 0;
    for (let t = 0; t < 60000 && stable < 10; t += 100) {
      const n = await ev(
        `document.querySelectorAll('[data-testid="assistant-message"]').length`,
      );
      stable = n > 0 && n === last ? stable + 1 : 0;
      last = n;
      await ctx.sleep(100);
    }
    const users = await ev(
      `document.querySelectorAll('[class*="userMessage_"]').length`,
    );
    if (
      !check(
        "the transcript rendered",
        users === TURNS,
        `${users} prompts, ${last} responses; ${await ev(`document.getElementById("claude-error").textContent`)}`,
      )
    )
      return false;
    await ev(PROBES);
    await scrollBy("s.scrollHeight");
    await settle(800);
    await openChord();
    await settle(300);
    check(
      "the chord opens the bar",
      await ev(`!!document.querySelector(".ccup-find-bar[data-open]")`),
    );

    // cache: one walk for a whole typed word.
    const word = "selection";
    await focusInput();
    const walks0 = await ev("__walks");
    for (const ch of word) {
      await ctx.cdp("Input.insertText", { text: ch });
      await ctx.sleep(130); // past the debounce: one scan per keystroke
    }
    await settle(300);
    const walks = (await ev("__walks")) - walks0;
    check(
      `typing "${word}" walks the transcript at most twice, not per keystroke`,
      walks >= 1 && walks <= 2,
      `${walks} walks over ${word.length} keystrokes, ${await ev("__ft.count()")}`,
    );

    // window: a frequent word at the bottom.
    await query("graph");
    let c = await ev(`__ft.cover("graph")`);
    const total = await ev("__ft.total()");
    check(
      "only the matches near the view are registered",
      total > 300 && c.painted > 0 && c.painted < total / 4,
      `${c.painted} painted of ${total}`,
    );
    check(
      "at the bottom, every match in view is painted",
      c.want > 0 && c.miss === 0,
      J(c),
    );
    await scrollBy("0");
    await settle(150);
    c = await ev(`__ft.cover("graph")`);
    check(
      "after a jump to the top, every match in view is painted",
      c.want > 0 && c.miss === 0,
      J(c),
    );
    check(
      "and the count holds",
      (await ev("__ft.total()")) === total,
      `${total} -> ${await ev("__ft.total()")}`,
    );
    let worst = 0;
    for (let k = 0; k < 25; k++) {
      await ctx.cdp("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 380,
        y: 450,
        deltaX: 0,
        deltaY: 400,
      });
      await ctx.sleep(30);
      await frames(2);
      worst = Math.max(worst, (await ev(`__ft.cover("graph")`)).miss);
    }
    check(
      "wheel scrolling: every match in view is painted at each step",
      worst === 0,
      `worst miss ${worst} over 25 steps`,
    );
    await scrollBy("s.scrollHeight / 2");
    await settle(150);
    await query("graph ");
    c = await ev(`__ft.cover("graph ")`);
    check(
      "a new query after a jump into the middle paints the view",
      c.miss === 0,
      `${J(c)} ${await ev("__ft.count()")}`,
    );

    // pinned: deep inside the long turn, its header stuck to the top.
    await query(MARK);
    const landed = await ev("__ft.count()");
    await ev(`(() => {
      const s = __ft.sc();
      const u = [...s.querySelectorAll('[class*="stickyHeader_"]')].find((h) => h.textContent.includes("${MARK}"));
      s.scrollTop += u.parentElement.getBoundingClientRect().top - s.getBoundingClientRect().top + 4200;
    })()`);
    await settle(150);
    // A changed value, so the input event fires; the search ignores case.
    await query(MARK.toUpperCase());
    let h = await ev("__ft.head()");
    if (
      !check(
        "precondition: the long turn's header is pinned deep inside it",
        !!h && h.pinned && h.turnH > 5200,
        J(h),
      )
    )
      return false;
    check(
      "the query lands on the pinned header's match first, as the linear scan did",
      (await ev("__ft.count()")).startsWith("1 of ") && h.active === 1,
      `${landed} at the middle, ${await ev("__ft.count()")} inside ${J(h)}`,
    );
    c = await ev(`__ft.cover("${MARK}")`);
    check(
      "the pinned header's matches and the view's are painted",
      h.painted + h.active >= 2 && c.miss === 0,
      `${J(h)} ${J(c)}`,
    );
    await query("e");
    h = await ev("__ft.head()");
    c = await ev(`__ft.cover("e")`);
    check(
      "a one-letter query registers a capped window",
      c.painted > 300 && c.painted <= WINMAX + 200,
      `${c.painted} painted, ${await ev("__ft.count()")}`,
    );
    check("yet paints every match in view", c.want > 100 && c.miss === 0, J(c));
    check("and the pinned header's matches", h.pinned && h.painted >= 20, J(h));

    // rescan: a mutation adds a match; an attribute hides one.
    await query("graph");
    const before = await ev("__ft.total()");
    await ev(`(() => {
      const p = [...__ft.sc().querySelectorAll("p")].find((p) => {
        const b = p.getBoundingClientRect();
        return b.top > 100 && b.bottom < innerHeight - 100;
      });
      p.append(" graph appended ");
    })()`);
    await settle(400);
    check(
      "an appended match is counted without a keystroke",
      (await ev("__ft.total()")) === before + 1,
      `${before} -> ${await ev("__ft.total()")}`,
    );
    c = await ev(`__ft.cover("graph")`);
    check("and painted", c.miss === 0, J(c));
    const lost = await ev(`(() => {
      const p = [...__ft.sc().querySelectorAll("p")].find((p) => p.textContent.includes("graph appended"));
      p.hidden = true;
      return (p.textContent.toLowerCase().match(/graph/g) || []).length;
    })()`);
    await settle(400);
    const held = await ev("__ft.total()");
    await query("graph");
    check(
      "text hidden by an attribute drops out on the next keystroke",
      held === before + 1 && (await ev("__ft.total()")) === before + 1 - lost,
      `${before + 1} -> ${held} (no rescan) -> ${await ev("__ft.total()")}, ${lost} hidden`,
    );

    // close: Escape inside the debounce, then a reopen.
    await focusInput();
    await ctx.cdp("Input.insertText", { text: "graph" });
    await ev(
      `document.querySelector(".ccup-find-bar input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`,
    );
    await settle(400);
    const left = await ev(
      `({ open: !!document.querySelector(".ccup-find-bar[data-open]"), all: CSS.highlights.get("ccup-find")?.size ?? 0, act: CSS.highlights.get("ccup-find-active")?.size ?? 0 })`,
    );
    check(
      "Escape inside the input debounce leaves nothing painted",
      !left.open && left.all === 0 && left.act === 0,
      J(left),
    );
    await openChord();
    await settle(300);
    c = await ev(`__ft.cover("graph")`);
    check(
      "a reopen repaints the kept query",
      c.want > 0 && c.miss === 0,
      `${J(c)} ${await ev("__ft.count()")}`,
    );
    const n1 = await ev("__ft.count()");
    const now = await ev("__ft.total()");
    await ev(
      `document.querySelector('.ccup-find-bar button[aria-label="Next Match"]').click()`,
    );
    await settle(200);
    const n2 = await ev("__ft.count()");
    const act = await ev(`(() => {
      const a = [...CSS.highlights.get("ccup-find-active")][0];
      const b = a && a.getBoundingClientRect();
      return b ? { top: b.top, bottom: b.bottom } : null;
    })()`);
    check(
      "next advances by one and reveals the match",
      Number(n2.split(" ")[0]) === (Number(n1.split(" ")[0]) % now) + 1 &&
        !!act &&
        act.top >= 0 &&
        act.bottom <= ctx.viewport.height,
      `${n1} -> ${n2} ${J(act)}`,
    );
    await ctx.shot("find-typing");
  } finally {
    server.close();
  }
  return ok;
}
