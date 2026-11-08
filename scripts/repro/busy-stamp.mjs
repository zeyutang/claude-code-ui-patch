// Scenario for scripts/cdp-driver.mjs: the always-on reload-during-a-turn fix,
// on the REAL webview bundle booted against a stub host. A view opens session
// R from the history and sends it a prompt the stub never answers, so R runs
// on. The page clock then jumps 17 minutes, as if the turn had run that long,
// and the view reboots with the webview state it last saved, as a window
// reload or an extension host restart does. Natively the saved stamp still
// holds the moment the prompt went out, so the boot finds it older than 10
// minutes and opens a new session; patched, the stamp moves on every minute
// while R runs, so the boot reopens R and asks to resume its interrupted turn.
// Each mode runs:
//   busy        R running when the clock jumps (the case the point fixes)
//   idle        R open but idle, which must still boot a new session (the
//               native rule the point keeps)
// and the patched busy pass also switches to another session and checks that
// the stamping stops with it. The native busy pass has to reproduce the new
// session: once it stops, Claude Code itself has fixed it, and the point can be
// retired.
//
//   node scripts/cdp-driver.mjs scripts/repro/busy-stamp.mjs 760 620
//
// The minute-long stamp period is shortened to 1.5s in the page (the one
// interval whose callback writes sessionUpdatedAt), so a pass takes seconds;
// CCUP_REAL_TIME=1 keeps the real period, and each busy pass then waits a
// minute. The patched bundle served is the compiled patcher's own output for
// the live install (busyStampWebview, out/, so compile first), so the scenario
// runs exactly what an apply writes and doubles as the drift canary. The live
// bundle is found under ~/.vscode/extensions (newest Claude Code install) or
// via $CCUP_BUNDLE (the webview directory).
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

const R = "11111111-1111-4111-8111-111111111111";
const R_SHORT = R.slice(0, 4);
const OTHER = "22222222-2222-4222-8222-222222222222";
const FRAG_RE = /\/\*ccup:busyStamp\*\/[\s\S]*?\/\*ccup:busyStampEnd\*\//g;
const REAL_TIME = process.env.CCUP_REAL_TIME === "1";
const JUMP = 17 * 60e3;

// The stub host: just enough of the init state for the chat to mount (see the
// real-webview-mock notes) and two sessions on disk. R's transcript ends on a
// prompt with no reply, the shape Claude Code resumes after a reload. The page
// takes the webview state to boot with (?state=) and a clock offset (?skew=,
// read by Date.now, which the bundle's stamps and its freshness test both
// use), keeps every state the bundle saves in window.__states, and logs each
// request as type[id prefix]:state and each launch with its resume fields.
const page = (q) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-font-family:system-ui;--vscode-font-size:13px;
--vscode-foreground:#cccccc;--vscode-sideBar-background:#181818;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}'></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
window.__reqs = []; window.__launches = []; window.__states = [];
const realNow = Date.now.bind(Date);
window.__skew = Number(${JSON.stringify(q.get("skew") || 0)});
Date.now = () => realNow() + window.__skew;
if (${!REAL_TIME}) {
  const every = window.setInterval;
  window.setInterval = (fn, ms, ...rest) => every(fn,
    ms === 60000 && String(fn).includes("sessionUpdatedAt") ? 1500 : ms, ...rest);
}
let saved = ${q.get("state") || "undefined"};
const MIN = 60e3, NOW = Date.now();
const SESSIONS = [
  ["${R}", "Running task", 5 * MIN],
  ["${OTHER}", "Older idle task", 90 * MIN],
].map(([id, t, age]) => ({ id, summary: t, customTitle: t, lastModified: NOW - age,
  lastActivity: NOW - age, archived: false, fileSize: 2048, gitBranch: "develop",
  isCurrentWorkspace: true }));
const user = (uuid, text, at) => ({ type: "user", uuid, session_id: "${R}",
  parent_tool_use_id: null, timestamp: new Date(at).toISOString(),
  message: { role: "user", content: [{ type: "text", text }] } });
const TRANSCRIPT = [
  user("a1", "start the long task", NOW - 20 * MIN),
  { type: "assistant", uuid: "a2", session_id: "${R}", parent_tool_use_id: null,
    timestamp: new Date(NOW - 19 * MIN).toISOString(),
    message: { id: "m1", type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text: "Working on it." }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } } },
  user("a3", "keep working", NOW - 18 * MIN),
];
const deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
const respond = (requestId, response) => deliver({ type: "response", requestId, response });
const MODEL = { value: "default", label: "Default", resolvedModel: "claude-fable-5",
  supportsAutoMode: true, supportsFastMode: false, supportedEffortLevels: [] };
window.acquireVsCodeApi = () => ({
  getState() { return saved; },
  setState(s) { saved = s; window.__states.push(JSON.parse(JSON.stringify(s))); },
  postMessage(msg) {
    if (!msg) return;
    if (msg.type !== "request") {
      if (msg.type === "launch_claude") window.__launches.push({ resume: msg.resume ?? null,
        waitForHolderToLetGo: !!msg.waitForHolderToLetGo,
        resumeInterruptedTurn: !!msg.resumeInterruptedTurn });
      window.__reqs.push("send:" + (msg.message?.type ?? msg.type));
      return;
    }
    const r = msg.request;
    window.__reqs.push(r.type + (r.sessionId ? "[" + r.sessionId.slice(0, 4) + "]" : "") +
      (r.state ? ":" + r.state : ""));
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
      case "get_session_request":
        resp = { type: "get_session_response", sessionDiffs: [],
          messages: r.sessionId === "${R}" ? TRANSCRIPT : [] };
        break;
    }
    respond(msg.requestId, resp);
  },
});
</script>
<script type="module" src="/wv/index.js?mode=${q.get("mode")}"></script>
</body></html>`;

const TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

export async function run(ctx) {
  const dir = liveBundleDir();
  const web = readFileSync(join(dir, "index.js"), "utf8");
  const bundles = {
    native: web.replace(FRAG_RE, ""),
    patched: loadPatcher().busyStampWebview(web),
  };
  console.log(
    `live bundle: ${dir}${REAL_TIME ? "  (real-time stamp period)" : ""}`,
  );

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };
  if (!check("the patcher locates the save", bundles.patched !== null))
    return false;

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/wv/index.js") {
      res
        .writeHead(200, {
          "content-type": TYPES[".js"],
          "cache-control": "no-store",
        })
        .end(bundles[url.searchParams.get("mode")]);
    } else if (url.pathname.startsWith("/wv/")) {
      try {
        const file = join(dir, url.pathname.slice(4));
        res
          .writeHead(200, {
            "content-type": TYPES[extname(file)] ?? "application/octet-stream",
          })
          .end(readFileSync(file));
      } catch {
        res.writeHead(404).end();
      }
    } else {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(page(url.searchParams));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const until = async (expr, ms = 6000) => {
    for (let t = 0; t < ms; t += 50) {
      const v = await ctx.evaluate(expr);
      if (v) return v;
      await ctx.sleep(50);
    }
    return null;
  };
  const DLG = `[role=dialog][aria-label="Past conversations"]`;
  const TITLE = `document.querySelector('[class*="titleText_"]')?.getAttribute("title")`;
  const titleIs = (t) => until(`${TITLE} === ${JSON.stringify(t)}`);
  const mount = async (tag) => {
    const mounted = await until(
      `!!document.querySelector('[aria-label="Session history"]')`,
    );
    const err = await ctx.evaluate(
      `document.getElementById("claude-error").textContent`,
    );
    return check(`${tag}: chat mounted`, !!mounted, err || undefined);
  };
  const open = async (title) => {
    await ctx.evaluate(
      `document.querySelector('[aria-label="Session history"]').click()`,
    );
    await until(`!!document.querySelector('${DLG}')`);
    await ctx.evaluate(`(() => {
      const row = [...document.querySelectorAll('${DLG} button[id]')]
        .find((b) => b.textContent.includes(${JSON.stringify(title)}));
      if (row) row.click();
    })()`);
    return titleIs(title);
  };
  // Send a prompt in the open session; the stub never answers, so it runs on.
  const sendPrompt = async () => {
    await ctx.evaluate(
      `document.querySelector('[aria-label="Message input"]').focus()`,
    );
    await ctx.insertText("keep working");
    for (const type of ["keyDown", "keyUp"]) {
      await ctx.cdp("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        ...(type === "keyDown" ? { text: "\r" } : {}),
      });
    }
  };
  const lastState = () => ctx.evaluate("window.__states.at(-1) ?? null");
  // How many states the page saved, and how many of them moved the stamp.
  const stamps = () =>
    ctx.evaluate(`window.__states.filter((s, i, a) =>
      i > 0 && s.sessionUpdatedAt !== a[i - 1].sessionUpdatedAt).length`);
  const wait = REAL_TIME ? 62000 : 4000;

  try {
    for (const mode of ["native", "patched"]) {
      for (const variant of ["busy", "idle"]) {
        const tag = `${mode} ${variant}`;
        await ctx.navigate(`${base}?mode=${mode}`);
        if (!(await mount(tag))) return false;
        await titleIs("Untitled");
        if (!check(`${tag}: R open`, !!(await open("Running task")))) continue;
        if (variant === "busy") {
          await sendPrompt();
          check(
            `${tag}: R runs`,
            !!(await until(
              `window.__reqs.includes("update_session_state[${R_SHORT}]:running")`,
            )),
          );
        }
        await ctx.sleep(300);
        const before = await lastState();
        const movesBefore = await stamps();
        // The turn has now run for 17 minutes, as far as the page can tell.
        await ctx.evaluate(`window.__skew = ${JUMP}`);
        await ctx.sleep(wait);
        const after = await lastState();
        const moved = (await stamps()) - movesBefore;
        const age = await ctx.evaluate(
          `Date.now() - ${after?.sessionUpdatedAt ?? 0}`,
        );
        const fresh = after?.sessionID === R && age < 10 * 60e3;
        if (mode === "patched" && variant === "busy") {
          check(
            `${tag}: the stamp keeps moving while R runs`,
            fresh && moved >= (REAL_TIME ? 1 : 2),
            JSON.stringify({ moved, ageMs: age }),
          );
        } else {
          check(
            `${tag}: the stamp stays where ${variant === "busy" ? "the prompt left it" : "the open left it"}`,
            after?.sessionID === R &&
              after.sessionUpdatedAt === before?.sessionUpdatedAt &&
              moved === 0,
            JSON.stringify({ moved, ageMin: Math.round(age / 60e3) }),
          );
        }

        // Reboot with the saved state at the jumped clock, as a reload would.
        await ctx.navigate(
          `${base}?mode=${mode}&skew=${JUMP}&state=${encodeURIComponent(JSON.stringify(after))}`,
        );
        if (!(await mount(`${tag} reboot`))) return false;
        await until(`window.__launches.length > 0`, 4000);
        await ctx.sleep(800);
        const launches = await ctx.evaluate("window.__launches");
        const title = await ctx.evaluate(TITLE);
        const reopened = launches.some((l) => l.resume === R);
        if (mode === "patched" && variant === "busy") {
          check(
            `${tag}: the reboot reopens R and asks to resume its turn`,
            reopened &&
              launches.some(
                (l) =>
                  l.resume === R &&
                  l.waitForHolderToLetGo &&
                  l.resumeInterruptedTurn,
              ),
            JSON.stringify({ title, launches }),
          );
          if (ok) await ctx.shot("reopened");
        } else {
          check(
            `${tag}: the reboot opens a new session${mode === "native" && variant === "busy" ? " (the bug the point fixes)" : ""}`,
            !reopened && title === "Untitled",
            JSON.stringify({ title, launches }),
          );
        }
      }
    }

    // Switching away from a running session stops its stamping: the effect's
    // cleanup clears the timer when the active session changes.
    await ctx.navigate(`${base}?mode=patched`);
    if (!(await mount("patched switch"))) return false;
    await titleIs("Untitled");
    await open("Running task");
    await sendPrompt();
    await until(
      `window.__reqs.includes("update_session_state[${R_SHORT}]:running")`,
    );
    await open("Older idle task");
    await ctx.sleep(1000);
    // Other saves may follow (the open-tracking effect clears its record about
    // 3s after a load), but none of them may move the stamp.
    const settled = await lastState();
    const from = await ctx.evaluate("window.__states.length");
    await ctx.sleep(wait);
    const later = await ctx.evaluate(
      `window.__states.slice(${from}).filter((s) =>
        s.sessionUpdatedAt !== ${settled?.sessionUpdatedAt})`,
    );
    check(
      "patched switch: no stamping once another session is open",
      settled?.sessionID === OTHER && later.length === 0,
      JSON.stringify({ settled, later }),
    );
  } finally {
    server.close();
  }
  return ok;
}
