// Scenario for scripts/cdp-driver.mjs: the always-on session delete button,
// on the REAL webview bundle booted against a stub host. It checks that every
// persisted session row (live or archived) gets the button and the fresh
// active row none, that on hover it sits on its siblings' line at their size,
// right of the archive or unarchive button, that a real click sends one
// delete_session with the row's id and title without opening the session,
// that the row leaves the list once the host announces session_store_changed
// (what the host half sends after a delete), and that a host without the
// handler gets the reload notice instead.
//
//   node scripts/cdp-driver.mjs scripts/repro/session-delete.mjs 760 620
//
// The bundle served is the compiled patcher's own output for the live install
// (sessionDeleteWebview, out/, so compile first), so the scenario runs exactly
// what an apply writes and doubles as the drift canary for both halves. The
// live bundle is found under ~/.vscode/extensions (newest Claude Code install)
// or via $CCUP_BUNDLE (the webview directory, with extension.js beside it).
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

const IDS = {
  live1: "11111111-1111-4111-8111-111111111111",
  live2: "22222222-2222-4222-8222-222222222222",
  live3: "33333333-3333-4333-8333-333333333333",
  arch1: "44444444-4444-4444-8444-444444444444",
  arch2: "55555555-5555-4555-8555-555555555555",
};
const NOTICE = "Reload the window to start using session delete.";

// The stub host: just enough of the init state for the chat to mount (see the
// real-webview-mock notes), the session list below, and a delete_session
// handler that drops the row and announces the store change, or answers like
// a host without the handler. Responses go out synchronously, or the first
// render races ahead of get_claude_state.
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
window.__reqs = []; window.__notes = []; window.__deleteMode = "ok";
const NOW = Date.now(), MIN = 60e3, DAY = 86400e3;
window.__sessions = [
  ["${IDS.live1}", "Katex 0.19.0 upgrade", 40 * MIN, false],
  ["${IDS.live2}", "Current branch merge into develop", 2 * DAY, false],
  ["${IDS.live3}", "Claude-code extension settings", 11 * DAY, false],
  ["${IDS.arch1}", "Prompt navigator git issue", 26 * DAY, true],
  ["${IDS.arch2}", "Markdown button placement conflict", 28 * DAY, true],
].map(([id, t, age, archived]) => ({ id, summary: t, customTitle: t,
  lastModified: NOW - age, lastActivity: NOW - age, archived, fileSize: 2048,
  gitBranch: "develop", isCurrentWorkspace: true }));
const deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
const respond = (requestId, response) =>
  deliver({ type: "response", requestId, response });
const MODEL = { value: "default", label: "Default", resolvedModel: "claude-fable-5",
  supportsAutoMode: true, supportsFastMode: false, supportedEffortLevels: [] };
window.acquireVsCodeApi = () => ({
  getState() { return undefined; },
  setState() {},
  postMessage(msg) {
    if (!msg || msg.type !== "request") return;
    const r = msg.request;
    window.__reqs.push(r.type === "delete_session" ? r : r.type);
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
          sessions: window.__sessions.map((s) => ({ ...s })), folderKey: "k" };
        break;
      case "get_session_groups":
        resp = { type: "get_session_groups_response", groups: [] };
        break;
      case "show_notification":
        window.__notes.push([r.message, r.severity]);
        resp = { type: "show_notification_response" };
        break;
      case "delete_session":
        if (window.__deleteMode === "unknown")
          return respond(msg.requestId, { type: "error", error: "Unknown request type." });
        window.__sessions = window.__sessions.filter((s) => s.id !== r.sessionId);
        respond(msg.requestId, { type: "delete_session_response", deleted: true });
        return deliver({ type: "request", channelId: "", requestId: "store-" + Date.now(),
          request: { type: "session_store_changed" } });
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

export async function run(ctx) {
  const dir = liveBundleDir();
  const js = loadPatcher().sessionDeleteWebview(
    readFileSync(join(dir, "index.js"), "utf8"),
    readFileSync(join(dir, "..", "extension.js"), "utf8"),
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
  if (!check("the patcher locates both halves' sites", js !== null))
    return false;

  const server = createServer((req, res) => {
    const rel = req.url.split("?")[0];
    if (rel === "/wv/index.js") {
      res.writeHead(200, { "content-type": TYPES[".js"] }).end(js);
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

  const until = async (expr, ms = 8000) => {
    for (let t = 0; t < ms; t += 100) {
      const v = await ctx.evaluate(expr);
      if (v) return v;
      await ctx.sleep(100);
    }
    return null;
  };
  const mouse = (type, x, y) =>
    ctx.cdp("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  // A row of the open dropdown by its title, with its delete button and the
  // archive or unarchive button beside it, as client boxes in CSS px.
  const rowInfo = (title) =>
    ctx.evaluate(`(() => {
      const dlg = document.querySelector('[role=dialog][aria-label="Past conversations"]');
      const row = dlg && [...dlg.querySelectorAll("button[id]")]
        .find((b) => b.textContent.includes(${JSON.stringify(title)}));
      if (!row) return null;
      const box = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      };
      const del = row.querySelector('[title="Delete session"]');
      const sib = row.querySelector('[title="Archive session"],[title="Unarchive session"]');
      return { row: box(row), del: box(del), sib: box(sib),
        delSvg: box(del && del.querySelector("svg")), sibSvg: box(sib && sib.querySelector("svg")) };
    })()`);
  // Hover the row, then press its delete button with real mouse events.
  const hover = async (title) => {
    const g = await rowInfo(title);
    await mouse("mouseMoved", g.row.x + g.row.w / 2, g.row.y + g.row.h / 2);
    await ctx.sleep(150);
    return rowInfo(title);
  };
  const pressDelete = async (title) => {
    const g = await hover(title);
    const x = g.del.x + g.del.w / 2;
    const y = g.del.y + g.del.h / 2;
    await mouse("mouseMoved", x, y);
    await mouse("mousePressed", x, y);
    await mouse("mouseReleased", x, y);
  };
  const listed = (title) =>
    ctx.evaluate(
      `!!document.querySelector('[role=dialog]')?.textContent.includes(${JSON.stringify(title)})`,
    );

  try {
    await ctx.navigate(`http://127.0.0.1:${server.address().port}/`);
    const mounted = await until(
      `!!document.querySelector('[aria-label="Session history"]')`,
    );
    const err = await ctx.evaluate(
      `document.getElementById("claude-error").textContent`,
    );
    if (!check("chat mounted", !!mounted, err || undefined)) return false;
    await ctx.evaluate(
      `document.querySelector('[aria-label="Session history"]').click()`,
    );
    const open = await until(`(() => {
      const d = document.querySelector('[role=dialog][aria-label="Past conversations"]');
      return d && d.textContent.includes("Archived sessions");
    })()`);
    if (!check("history dropdown open", !!open)) return false;
    await ctx.evaluate(`[...document.querySelectorAll("[role=dialog] button")]
      .find((b) => b.textContent.includes("Archived sessions")).click()`);
    await until(
      `document.querySelector("[role=dialog]").textContent.includes("Markdown button placement conflict")`,
    );

    const rows =
      await ctx.evaluate(`[...document.querySelectorAll("[role=dialog] button[id]")]
      .map((r) => [r.textContent, !!r.querySelector('[title="Delete session"]')])`);
    check(
      "every persisted row has a delete button",
      rows.filter(([, d]) => d).length === 5,
      `${rows.filter(([, d]) => d).length} of ${rows.length} rows`,
    );
    check(
      "the fresh active row has none",
      rows.some(([t, d]) => t.startsWith("Untitled") && !d),
    );

    for (const [title, sib] of [
      ["Katex 0.19.0 upgrade", "archive"],
      ["Prompt navigator git issue", "unarchive"],
    ]) {
      const g = await hover(title);
      await ctx.shot(`hover-${sib}`);
      const near = (a, b) => Math.abs(a - b) < 0.5;
      check(
        `${title}: on hover, beside ${sib} at its size`,
        g.del.w > 0 &&
          near(g.del.y, g.sib.y) &&
          near(g.del.h, g.sib.h) &&
          near(g.del.w, g.sib.w) &&
          g.del.x > g.sib.x &&
          near(g.delSvg.w, g.sibSvg.w) &&
          near(g.delSvg.h, g.sibSvg.h) &&
          g.del.x + g.del.w <= g.row.x + g.row.w + 0.5,
        `delete ${JSON.stringify(g.del)}, ${sib} ${JSON.stringify(g.sib)}`,
      );
    }

    await pressDelete("Markdown button placement conflict");
    const gone = await until(
      `!document.querySelector("[role=dialog]")?.textContent.includes("Markdown button placement conflict")`,
    );
    const sent = await ctx.evaluate(
      `window.__reqs.filter((r) => typeof r === "object")`,
    );
    check(
      "a click sends delete_session with the row's id and title",
      sent.length === 1 &&
        sent[0].sessionId === IDS.arch2 &&
        sent[0].title === "Markdown button placement conflict",
      JSON.stringify(sent),
    );
    check("the row leaves the list on session_store_changed", !!gone);
    check(
      "the dropdown stays open (the row's own click never fired)",
      await ctx.evaluate(
        `!!document.querySelector('[role=dialog][aria-label="Past conversations"]')`,
      ),
    );
    await ctx.shot("after-delete");

    await ctx.evaluate(`window.__deleteMode = "unknown"`);
    await pressDelete("Claude-code extension settings");
    const note = await until(`window.__notes[0] ?? null`);
    check(
      "a host without the handler: the reload notice, and the row stays",
      note?.[0] === NOTICE &&
        note?.[1] === "warning" &&
        (await listed("Claude-code extension settings")),
      JSON.stringify(note),
    );
  } finally {
    server.close();
  }
  return ok;
}
