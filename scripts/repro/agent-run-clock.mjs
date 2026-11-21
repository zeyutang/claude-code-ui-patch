// Scenario for scripts/cdp-driver.mjs: the always-on agent run clock, on the
// REAL webview bundle booted against a stub host. An agent woken again by
// SendMessage should show the time of the run it is on in the Agent map, as an
// agent on its first run does. Each mode runs:
//   live      the scenario plays the CLI on the open session's channel: an
//             Agent call starts a background agent, which finishes; the page
//             clock moves on 3 hours and a SendMessage wakes it, the map read
//             while it runs; the wake finishes; an hour later a second wake
//             fails 2.5 seconds in
//   reopened  a session whose transcript holds two agents, each woken 5 hours
//             after its spawn: one whose wake failed 7 minutes in, one whose
//             wake finished in 4 minutes
// The native mode has to reproduce the bug: a running wake counts from the
// first spawn (3 hours and more), and so does a failed wake, live (4 hours)
// and reopened (307 minutes). Once it stops reproducing, Claude Code itself
// times a woken agent by its run, and the point can be retired. A finished
// wake shows the notification's duration in both modes.
//
//   node scripts/cdp-driver.mjs scripts/repro/agent-run-clock.mjs 760 620
//
// The patched bundle served is the compiled patcher's own output for the live
// install (agentRunClockWebview, out/, so compile first), so the scenario runs
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

const LIVE = "11111111-1111-4111-8111-111111111111";
const REOPENED = "22222222-2222-4222-8222-222222222222";
const TITLE = { [LIVE]: "Live agents", [REOPENED]: "Reopened agents" };
const FRAG_RE =
  /\/\*ccup:agentRunClock:[-\w]+\*\/[\s\S]*?\/\*ccup:agentRunClockEnd\*\//g;
const HOUR = 3600e3;
const MIN = 60e3;
// The agents, by the description the map titles their rows with.
const AGENT = {
  live: { id: "aliveagent01", desc: "Cold read" },
  failed: { id: "areplayagent01", desc: "Replay read" },
  done: { id: "areplayagent02", desc: "Replay done" },
};

// The stub host: the init state the chat needs to mount (see the
// real-webview-mock notes) and the two sessions on disk, booting into the one
// named by ?session=. The reopened session's transcript is in SDK stream form,
// its timestamps counted back from the page's load, each task notification a
// user message from the task-notification origin as the host replays one.
// The page clock runs ahead by window.__skew (read by Date.now, which both the
// agent map's stamps and its rows read). It records each launch's channel
// under the session it resumes, and page errors land in window.__errors.
const page = (q) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-font-family:system-ui;--vscode-font-size:13px;
--vscode-foreground:#cccccc;--vscode-sideBar-background:#181818;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${q.get("session")}"></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
window.__chans = {}; window.__errors = [];
window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason)));
const realNow = Date.now.bind(Date);
window.__skew = 0;
Date.now = () => realNow() + window.__skew;
const NOW = Date.now(), HOUR = ${HOUR}, MIN = ${MIN};
const AGENT = ${JSON.stringify(AGENT)};
const SESSIONS = ${JSON.stringify([
  [LIVE, TITLE[LIVE], 2],
  [REOPENED, TITLE[REOPENED], 30],
])}.map(([id, t, age]) => ({ id, summary: t, customTitle: t,
  lastModified: NOW - age * MIN, lastActivity: NOW - age * MIN, archived: false,
  fileSize: 2048, gitBranch: "develop", isCurrentWorkspace: true }));
let seq = 0;
const uuid = () => "00000000-0000-4000-8000-" + String(++seq).padStart(12, "0");
const at = (t) => (t === undefined ? {} : { timestamp: new Date(t).toISOString() });
// SDK stream messages, as the CLI sends them and the host replays them.
window.__msg = {
  assistant: (sid, content, t) => ({ type: "assistant", uuid: uuid(), session_id: sid,
    parent_tool_use_id: null, ...at(t),
    message: { id: "msg_" + uuid().slice(-8), type: "message", role: "assistant",
      model: "claude-fable-5", content, stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 } } }),
  user: (sid, content, t, extra) => ({ type: "user", uuid: uuid(), session_id: sid,
    parent_tool_use_id: null, ...at(t), ...extra, message: { role: "user", content } }),
  spawn: (id, desc) => ({ type: "tool_use", id, name: "Agent", input: { description: desc,
    prompt: "Read the note.", subagent_type: "general-purpose", run_in_background: true } }),
  launched: (toolUseId, agentId) => ({ type: "tool_result", tool_use_id: toolUseId,
    content: [{ type: "text", text: "Async agent launched successfully. (This tool " +
      "result is internal metadata.)\\nagentId: " + agentId + " (internal)" }] }),
  wake: (id, agentId) => ({ type: "tool_use", id, name: "SendMessage",
    input: { to: agentId, message: "Check the new round." } }),
  resumed: (toolUseId, agentId) => ({ type: "tool_result", tool_use_id: toolUseId,
    content: [{ type: "text", text: JSON.stringify({ success: true,
      message: "Resuming agent " + agentId.slice(0, 7) }) }] }),
  // A task notification as its transcript line replays: the CLI's own form.
  notice: (sid, agent, toolUseId, status, durationMs, t) => window.__msg.user(sid,
    [{ type: "text", text: "<task-notification>\\n<task-id>" + agent.id + "</task-id>\\n" +
      "<tool-use-id>" + toolUseId + "</tool-use-id>\\n<output-file>/tmp/" + agent.id +
      ".output</output-file>\\n<status>" + status + "</status>\\n<summary>Agent \\"" +
      agent.desc + "\\" " + (status === "completed" ? "finished" : "failed: no reply") +
      "</summary>" + (durationMs === undefined ? "" : "\\n<usage><subagent_tokens>2000" +
      "</subagent_tokens><tool_uses>4</tool_uses><duration_ms>" + durationMs +
      "</duration_ms></usage>") + "\\n</task-notification>" }],
    t, { origin: { kind: "task-notification" } }),
};
const M = window.__msg, T0 = NOW - 6 * HOUR, R = "${REOPENED}";
const REOPENED_TRANSCRIPT = [
  M.user(R, [{ type: "text", text: "Review the notes." }], T0 - MIN),
  M.assistant(R, [M.spawn("toolu_r1", AGENT.failed.desc)], T0),
  M.user(R, [M.launched("toolu_r1", AGENT.failed.id)], T0 + 100),
  M.assistant(R, [M.spawn("toolu_r2", AGENT.done.desc)], T0 + MIN),
  M.user(R, [M.launched("toolu_r2", AGENT.done.id)], T0 + MIN + 100),
  M.notice(R, AGENT.done, "toolu_r2", "completed", 2 * MIN, T0 + 3 * MIN),
  M.notice(R, AGENT.failed, "toolu_r1", "completed", 10 * MIN, T0 + 10 * MIN),
  M.assistant(R, [M.wake("toolu_w1", AGENT.failed.id)], T0 + 5 * HOUR),
  M.user(R, [M.resumed("toolu_w1", AGENT.failed.id)], T0 + 5 * HOUR + 100),
  M.assistant(R, [M.wake("toolu_w2", AGENT.done.id)], T0 + 5 * HOUR + MIN),
  M.user(R, [M.resumed("toolu_w2", AGENT.done.id)], T0 + 5 * HOUR + MIN + 100),
  M.notice(R, AGENT.done, "toolu_w2", "completed", 4 * MIN, T0 + 5 * HOUR + 5 * MIN),
  M.notice(R, AGENT.failed, "toolu_w1", "failed", undefined, T0 + 5 * HOUR + 7 * MIN),
];
const deliver = window.deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message }, origin: location.origin }));
window.__io = (sid, message) => deliver({ type: "io_message",
  channelId: window.__chans[sid], message, done: false });
const respond = (requestId, response) => deliver({ type: "response", requestId, response });
const MODEL = { value: "default", label: "Default", resolvedModel: "claude-fable-5",
  supportsAutoMode: true, supportsFastMode: false, supportedEffortLevels: [] };
window.acquireVsCodeApi = () => ({
  getState() { return undefined; },
  setState() {},
  postMessage(msg) {
    if (msg && msg.type === "launch_claude") window.__chans[msg.resume] = msg.channelId;
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
        resp = { type: "get_session_response", sessionDiffs: [],
          messages: r.sessionId === R ? REOPENED_TRANSCRIPT : [] };
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

// A row's time, "<m>m <s>s" or "<s>s" ahead of any " · " part, in seconds,
// or null when the row shows none.
function seconds(meta) {
  const m = /^(?:(\d+)m )?(\d+)s$/.exec((meta ?? "").split(" · ")[0]);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : null;
}

export async function run(ctx) {
  const dir = liveBundleDir();
  const web = readFileSync(join(dir, "index.js"), "utf8");
  const bundles = {
    native: web.replace(FRAG_RE, ""),
    patched: loadPatcher().agentRunClockWebview(web),
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
  if (!check("the patcher locates both sites", bundles.patched !== null))
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
      let body;
      try {
        body = readFileSync(join(dir, url.pathname.slice(4)));
      } catch {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, {
          "content-type":
            TYPES[extname(url.pathname)] ?? "application/octet-stream",
        })
        .end(body);
    } else {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(page(url.searchParams));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const ev = (expr) => ctx.evaluate(expr);
  const until = async (expr, ms = 6000) => {
    for (let t = 0; t < ms; t += 50) {
      const v = await ev(expr);
      if (v) return v;
      await ctx.sleep(50);
    }
    return null;
  };
  const boot = async (tag, mode, sid) => {
    await ctx.navigate(`${base}?mode=${mode}&session=${sid}`);
    const mounted = await until(
      `!!document.querySelector('[aria-label="Session history"]')`,
    );
    const chan = await until(`window.__chans[${JSON.stringify(sid)}]`);
    const err = await ev(`document.getElementById("claude-error").textContent`);
    return check(
      `${tag}: chat mounted on ${TITLE[sid]}`,
      !!mounted && !!chan,
      err || undefined,
    );
  };
  // The Agent map, opened from the composer's agents pill.
  const MAP = `[...document.querySelectorAll('[role="dialog"]')].find((d) =>
    d.textContent.includes("click an agent for details"))`;
  const openMap = async () => {
    await until(`!!document.querySelector("button[data-agents-dot]")`);
    await ev(`document.querySelector("button[data-agents-dot]")?.click()`);
    return !!(await until(`!!(${MAP})`));
  };
  const meta = (desc) =>
    ev(`(() => {
      const row = [...((${MAP})?.querySelectorAll("button[title]") ?? [])]
        .find((b) => b.title === ${JSON.stringify(desc)});
      return row?.querySelector('[class*="rowMeta_"]')?.textContent ?? null;
    })()`);
  // One CLI message on the live session's channel.
  const io = (expr) => ev(`window.__io(${JSON.stringify(LIVE)}, ${expr})`);
  const sys = (subtype, fields) =>
    io(
      JSON.stringify({
        type: "system",
        subtype,
        session_id: LIVE,
        uuid: crypto.randomUUID(),
        ...fields,
      }),
    );
  const A = AGENT.live;
  const started = (toolUseId) =>
    sys("task_started", {
      task_id: A.id,
      tool_use_id: toolUseId,
      description: A.desc,
      task_type: "local_agent",
      is_backgrounded: true,
      prompt: "Read the note.",
      subagent_type: "general-purpose",
    });
  const notified = (toolUseId, status, durationMs) =>
    sys("task_notification", {
      task_id: A.id,
      tool_use_id: toolUseId,
      status,
      summary: `Agent "${A.desc}" ${status === "completed" ? "finished" : "failed"}`,
      output_file: `/tmp/${A.id}.output`,
      ...(durationMs !== undefined && {
        usage: { total_tokens: 1000, tool_uses: 3, duration_ms: durationMs },
      }),
    });
  const wake = async (toolUseId) => {
    await io(
      `window.__msg.assistant(${JSON.stringify(LIVE)}, [window.__msg.wake(${JSON.stringify(toolUseId)}, ${JSON.stringify(A.id)})])`,
    );
    await io(
      `window.__msg.user(${JSON.stringify(LIVE)}, [window.__msg.resumed(${JSON.stringify(toolUseId)}, ${JSON.stringify(A.id)})])`,
    );
    await started(toolUseId);
  };
  // Wait for a row's time to satisfy a test, returning the last one read.
  const timeIs = async (desc, test, ms = 4000) => {
    let last = null;
    for (let t = 0; t < ms; t += 100) {
      last = await meta(desc);
      if (test(seconds(last))) return { ok: true, last };
      await ctx.sleep(100);
    }
    return { ok: false, last };
  };

  try {
    for (const mode of ["native", "patched"]) {
      const P_ = mode === "patched";
      let tag = `${mode} live`;
      if (!(await boot(tag, mode, LIVE))) return false;
      await sys("init", {
        model: "claude-fable-5",
        permissionMode: "default",
        tools: [],
        mcp_servers: [],
        slash_commands: [],
      });
      await io(
        `window.__msg.assistant(${JSON.stringify(LIVE)}, [window.__msg.spawn("toolu_l0", ${JSON.stringify(A.desc)})])`,
      );
      await io(
        `window.__msg.user(${JSON.stringify(LIVE)}, [window.__msg.launched("toolu_l0", ${JSON.stringify(A.id)})])`,
      );
      await started("toolu_l0");
      await notified("toolu_l0", "completed", 65000);
      if (
        !check(`${tag}: the agents pill opens the Agent map`, await openMap())
      )
        continue;
      let r = await timeIs(A.desc, (s) => s === 65);
      check(
        `${tag}: the first run reads its notification's 1m 5s`,
        r.ok,
        r.last,
      );

      // Three hours on, SendMessage wakes it.
      await ev(`window.__skew = ${3 * HOUR}`);
      await wake("toolu_l1");
      await ctx.sleep(1500);
      r = await timeIs(A.desc, (s) =>
        P_ ? s !== null && s < 60 : s !== null && s >= 3 * 3600,
      );
      check(
        P_
          ? `${tag}: the running wake counts from the wake`
          : `${tag}: the running wake counts from the first spawn (the bug)`,
        r.ok,
        r.last,
      );
      if (P_) await ctx.shot("live-wake-running");
      await notified("toolu_l1", "completed", 90000);
      r = await timeIs(A.desc, (s) => s === 90);
      check(
        `${tag}: the finished wake reads its notification's 1m 30s`,
        r.ok,
        r.last,
      );

      // An hour later a second wake fails 2.5 seconds in.
      await ev(`window.__skew = ${4 * HOUR}`);
      await wake("toolu_l2");
      await ctx.sleep(2500);
      await notified("toolu_l2", "failed");
      r = await timeIs(A.desc, (s) =>
        P_ ? s !== null && s >= 2 && s < 60 : s !== null && s >= 4 * 3600,
      );
      check(
        P_
          ? `${tag}: the failed wake keeps its own 2s`
          : `${tag}: the failed wake keeps the span since the first spawn (the bug)`,
        r.ok,
        r.last,
      );
      let errors = await ev("window.__errors");
      check(
        `${tag}: no page errors`,
        errors.length === 0,
        JSON.stringify(errors),
      );

      // A session reopened from its transcript.
      tag = `${mode} reopened`;
      if (!(await boot(tag, mode, REOPENED))) return false;
      if (
        !check(`${tag}: the agents pill opens the Agent map`, await openMap())
      )
        continue;
      r = await timeIs(AGENT.failed.desc, (s) =>
        P_ ? s === 7 * 60 : s === 307 * 60,
      );
      check(
        P_
          ? `${tag}: the failed wake reads its own 7m 0s`
          : `${tag}: the failed wake reads 307m 0s since the spawn (the bug)`,
        r.ok,
        r.last,
      );
      r = await timeIs(AGENT.done.desc, (s) => s === 4 * 60);
      check(
        `${tag}: the finished wake reads its notification's 4m 0s`,
        r.ok,
        r.last,
      );
      if (P_) await ctx.shot("reopened");
      errors = await ev("window.__errors");
      check(
        `${tag}: no page errors`,
        errors.length === 0,
        JSON.stringify(errors),
      );
    }
  } finally {
    server.close();
  }
  return ok;
}
