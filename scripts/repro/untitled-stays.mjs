// Scenario for scripts/cdp-driver.mjs: the always-on untitled session fix, on
// the REAL webview bundle booted against a stub host. A view opens on a blank
// "Untitled" session; the user picks another session R from the history
// dropdown, picks Untitled again, then opens the dropdown once more. Natively
// that last opening re-reads the session list, whose restore takes the view
// back to R, which the URL still names; patched, Untitled stays. Each pass
// runs four variants:
//   boot         R idle
//   boot-busy    R running (a prompt the stub never answers)
//   explicit     Untitled made by the New session button, which natively
//                stays too (the control)
//   url-restore  a boot with ?session=R, which must still restore R (the
//                restore the fix keeps)
// The native pass has to reproduce the jump: once it stops, Claude Code
// itself has fixed it, and the point can be retired.
//
//   node scripts/cdp-driver.mjs scripts/repro/untitled-stays.mjs 760 620
//
// The patched bundle served is the compiled patcher's own output for the live
// install (untitledStaysWebview, out/, so compile first), so the scenario runs
// exactly what an apply writes and doubles as the drift canary. The live
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
const FRAG_RE =
  /\/\*ccup:untitledStays\*\/[\s\S]*?\/\*ccup:untitledStaysEnd\*\//g;

// The stub host: just enough of the init state for the chat to mount (see the
// real-webview-mock notes), two sessions on disk, and empty transcripts. It
// logs every request as type(entryPoint)[id prefix]:state. Responses go out
// synchronously, or the first render races ahead of get_claude_state, except
// the list when the page URL carries ?delay=N: the URL restore only shows
// once the boot session exists, which real host latency guarantees.
const page = (mode) => `<!doctype html><html><head><meta charset="utf-8">
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
window.__reqs = [];
const NOW = Date.now(), MIN = 60e3;
const SESSIONS = [
  ["${R}", "Running task", 5 * MIN],
  ["${OTHER}", "Older idle task", 90 * MIN],
].map(([id, t, age]) => ({ id, summary: t, customTitle: t, lastModified: NOW - age,
  lastActivity: NOW - age, archived: false, fileSize: 2048, gitBranch: "develop",
  isCurrentWorkspace: true }));
const DELAY = Number(new URLSearchParams(location.search).get("delay") || 0);
const deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
const respond = (requestId, response) => deliver({ type: "response", requestId, response });
const MODEL = { value: "default", label: "Default", resolvedModel: "claude-fable-5",
  supportsAutoMode: true, supportsFastMode: false, supportedEffortLevels: [] };
window.acquireVsCodeApi = () => ({
  getState() { return undefined; },
  setState() {},
  postMessage(msg) {
    if (!msg) return;
    if (msg.type !== "request") {
      window.__reqs.push("send:" + (msg.message?.type ?? msg.type));
      return;
    }
    const r = msg.request;
    window.__reqs.push(r.type + (r.entryPoint ? "(" + r.entryPoint + ")" : "") +
      (r.sessionId ? "[" + r.sessionId.slice(0, 4) + "]" : "") + (r.state ? ":" + r.state : ""));
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
        if (DELAY) return void setTimeout(() => respond(msg.requestId, resp), DELAY);
        break;
      case "get_session_groups":
        resp = { type: "get_session_groups_response", groups: [] };
        break;
      case "get_session_request":
        resp = { type: "get_session_response", messages: [], sessionDiffs: [] };
        break;
    }
    respond(msg.requestId, resp);
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
  const web = readFileSync(join(dir, "index.js"), "utf8");
  const bundles = {
    native: web.replace(FRAG_RE, ""),
    patched: loadPatcher().untitledStaysWebview(web),
  };
  console.log(`live bundle: ${dir}`);

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };
  if (!check("the patcher locates the guard", bundles.patched !== null))
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
        .end(page(url.searchParams.get("mode")));
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
  // What the view shows: its header title, and the session its URL names.
  const state = () =>
    ctx.evaluate(`({ title: ${TITLE} ?? null,
      url: (new URLSearchParams(location.search).get("session") || "").slice(0, 4) || null })`);
  const titleIs = (t) => until(`${TITLE} === ${JSON.stringify(t)}`);
  const openHistory = async () => {
    await ctx.evaluate(
      `document.querySelector('[aria-label="Session history"]').click()`,
    );
    return until(`!!document.querySelector('${DLG}')`);
  };
  const pick = (title) =>
    ctx.evaluate(`(() => {
      const row = [...document.querySelectorAll('${DLG} button[id]')]
        .find((b) => b.textContent.includes(${JSON.stringify(title)}));
      if (row) row.click();
      return !!row;
    })()`);
  const reqs = () => ctx.evaluate("window.__reqs");
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

  try {
    for (const mode of ["native", "patched"]) {
      for (const variant of ["boot", "boot-busy", "explicit"]) {
        const tag = `${mode} ${variant}`;
        await ctx.navigate(`${base}?mode=${mode}`);
        const mounted = await until(
          `!!document.querySelector('[aria-label="Session history"]')`,
        );
        const err = await ctx.evaluate(
          `document.getElementById("claude-error").textContent`,
        );
        if (!check(`${tag}: chat mounted`, !!mounted, err || undefined))
          return false;
        await titleIs("Untitled");
        if (variant === "explicit") {
          // Visit R, then make the Untitled row with the New session button.
          await openHistory();
          await pick("Running task");
          await titleIs("Running task");
          await ctx.evaluate(
            `document.querySelector('[aria-label="New session"]').click()`,
          );
          await titleIs("Untitled");
        }
        await openHistory();
        await pick("Running task");
        await titleIs("Running task");
        if (variant === "boot-busy") {
          await sendPrompt();
          const busy = await until(
            `window.__reqs.includes("update_session_state[${R_SHORT}]:running")`,
          );
          check(`${tag}: R runs`, !!busy);
        }
        await openHistory();
        const picked = await pick("Untitled");
        await titleIs("Untitled");
        const before = await state();
        check(
          `${tag}: back on Untitled, the URL still naming R`,
          picked && before.title === "Untitled" && before.url === R_SHORT,
          JSON.stringify(before),
        );
        await ctx.evaluate("window.__reqs.length = 0");
        await openHistory();
        await until(
          `window.__reqs.includes("list_sessions_request(sessions_dialog)")`,
        );
        await ctx.sleep(500);
        const after = await state();
        const sent = await reqs();
        const jumped = after.title === "Running task";
        if (mode === "native" && variant !== "explicit") {
          check(
            `${tag}: opening the history jumps to R (the bug the point fixes)`,
            jumped,
            JSON.stringify({ ...after, sent }),
          );
        } else {
          check(
            `${tag}: opening the history stays on Untitled`,
            after.title === "Untitled" &&
              !sent.includes(`get_session_request[${R_SHORT}]`) &&
              !sent.includes("send:close_channel"),
            JSON.stringify({ ...after, sent }),
          );
        }
        if (mode === "patched" && variant === "boot") await ctx.shot("stays");
      }

      // A reload that keeps the page's own ?session=: the boot session waits
      // for R and takes its id, so R's transcript loads and R reports in. The
      // adopted session keeps no title, so the requests are the evidence.
      await ctx.navigate(`${base}?mode=${mode}&delay=40&session=${R}`);
      await until(
        `window.__reqs.includes("get_session_request[${R_SHORT}]")`,
        4000,
      );
      await ctx.sleep(300);
      const sent = await reqs();
      check(
        `${mode} url-restore: a boot with ?session=R restores R`,
        sent.includes(`get_session_request[${R_SHORT}]`) &&
          sent.some((r) => r.startsWith(`update_session_state[${R_SHORT}]`)),
        JSON.stringify(sent),
      );
    }
  } finally {
    server.close();
  }
  return ok;
}
