// Scenario for scripts/cdp-driver.mjs: the always-on banner dismissals, every
// banner and both halves. The host half runs first, in Node: the comms base's
// processRequest and the comms subclass's send are cut out of the patched host
// bundle and rebuilt in a with-scope, then fed dismissal reports and messages,
// checking the record the host keeps and the stamp its messages carry. The
// webview half runs on the REAL webview bundle booted against a stub host with
// two sessions, which raises each banner the way the host would (a rate-limit
// frame for the usage banner and the wrap-up notice, the settings errors in the
// view's state, the credential conflict in its config), and the scenario
// dismisses each and checks where it shows again. Each mode runs:
//   native   the stock bundle, which has to reproduce the complaint: each
//            banner comes back in the other session, the usage banner for
//            another limit, the credential banner after a config reload
//   patched  the bundle with every banner point, against a stub host that
//            answers the report as the patched host does
// and the patched mode adds a reloaded view, which takes the window's
// dismissals from stamped messages and starts with none without them, a
// settings error and a conflict that name something new, and a host still
// running its pre-patch code, which answers the report with an error the
// store must swallow.
//
//   node scripts/cdp-driver.mjs scripts/repro/banner-dismiss.mjs 600 700
//
// Once the native mode stops reproducing for a banner, Claude Code itself
// keeps that dismissal across sessions, and its point can be retired. The
// patched bundles are the compiled patcher's own output for the live install
// (bannerDismissWebview and bannerDismissHost, out/, so compile first), so the
// scenario runs exactly what an apply writes and doubles as the drift canary.
// The live install is found under ~/.vscode/extensions (newest Claude Code
// install) or via $CCUP_BUNDLE (the webview directory, with extension.js
// beside it); one older than 2.1.322 has no credential banner, and its checks
// are skipped.
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// The compiled patcher. It reads vscode only inside functions, so an empty
// stand-in is enough to load the module.
function loadPatcher() {
  const Module = require("node:module");
  const load = Module._load;
  Module._load = (request, ...rest) =>
    request === "vscode" ? {} : load(request, ...rest);
  try {
    return require(join(ROOT, "out", "patcher.js"));
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

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const TITLE = { [A]: "Alpha task", [B]: "Beta task" };
const WEB_FRAG_RE =
  /\/\*ccup:(?:udis|sdis|cdis|wdis):[-\w]+\*\/[\s\S]*?\/\*ccup:(?:udis|sdis|cdis|wdis)End\*\//g;
const HOST_FRAG_RE =
  /\/\*ccup:(?:bdis|udis):[-\w]+\*\/[\s\S]*?\/\*ccup:(?:bdis|udis)End\*\//g;
const STORE_LINE_RE = /\n?\/\*ccup:bannerStore\*\/[^\n]*/;
const REQ = "ccup_banner_dismiss";
const HOST_RECORD = "__ccupBannerDismissals";
const STAMP = "ccupBanners";

// What the stub host raises: two sets of settings errors and two conflicts,
// and the keys the store records for the first of each.
const ERRORS = [
  {
    file: "/work/.claude/settings.json",
    message: "Unexpected token } in JSON at position 42",
  },
];
const OTHER_ERRORS = [
  {
    file: "/work/.claude/settings.local.json",
    message: "Unexpected end of JSON input",
  },
];
const CONFLICT = {
  token_source: "claude.ai",
  api_key_source: "ANTHROPIC_API_KEY",
};
const OTHER_CONFLICT = {
  token_source: "claude.ai",
  api_key_source: "apiKeyHelper",
};
const KEY = {
  settings: `settings:${JSON.stringify(ERRORS)}`,
  credential: `credential:${JSON.stringify(CONFLICT)}`,
  wrapUp: "wrap-up:*",
};
// Each banner by the text it opens with or carries.
const TEXT = {
  settings: "Settings file failed to parse",
  credential: "Claude Code has both",
  wrapUp: "Usage limit reached",
};

// The host half, run on its own code. A method is rebuilt from its source in
// a with-scope whose names fall back to Node's globals, which is all the
// paths exercised here reach: the request switch jumps straight to the route
// (its case tests are literals) or falls out to the native error, and send
// touches only its this.
async function hostChecks(P, host, check) {
  const D = require(join(ROOT, "out", "derive.js"));
  const patched = P.bannerDismissHost(host);
  if (!check("host: the patcher locates both host sites", patched !== null))
    return;
  const native = patched.replace(HOST_FRAG_RE, "");
  const scope = new Proxy(
    {},
    {
      has: () => true,
      get: (_, k) => (k in globalThis ? globalThis[k] : undefined),
    },
  );
  const method = (c, token, name) => {
    const [cls] = D.unitsWith(c, token, "class ", D.isClass, 400000);
    const m = cls?.body.body.find(
      (x) => x.type === "MethodDefinition" && x.key.name === name,
    );
    if (!m) throw new Error(`no ${name} around ${token}`);
    return new Function(
      "scope",
      `with(scope){return ({${c.slice(m.start, m.end)}}).${name}}`,
    )(scope);
  };
  const route = method(patched, "/*ccup:bdis:route*/", "processRequest");
  const nativeRoute = method(native, 'case"rewind_code":', "processRequest");
  const send = method(patched, "/*ccup:bdis:send*/", "send");
  const posted = [];
  const self = {
    sendQueue: Promise.resolve(),
    webview: { postMessage: async (m) => void posted.push(m.message) },
    checkAndUpdateReviewUpsellBanner() {},
  };
  const out = async (msg) => {
    send.call(self, msg);
    await self.sendQueue;
    return posted.at(-1);
  };
  const ask = (request) =>
    route.call(self, { request }).then(
      (r) => r,
      (e) => ({ error: e.message }),
    );
  const frame = (type) => ({
    type: "io_message",
    channelId: "c1",
    done: false,
    message: {
      type,
      ...(type === "rate_limit_event" && { rate_limit_info: {} }),
    },
  });
  const response = () => ({ type: "response", requestId: "r", response: {} });
  const record = () => JSON.stringify(globalThis[HOST_RECORD] ?? null);
  delete globalThis[HOST_RECORD];
  try {
    for (const type of [REQ, "ccup_usage_dismiss"]) {
      const old = await nativeRoute
        .call(self, { request: { type, level: 1 } })
        .then(
          () => "answered",
          (e) => e.message,
        );
      check(
        `host: a pre-patch host answers ${type} with its error`,
        old === "Unknown request type.",
        old,
      );
    }
    const m0 = response();
    const f0 = frame("rate_limit_event");
    check(
      "host: before any report every message goes out as it came",
      (await out(m0)) === m0 && (await out(f0)) === f0,
    );
    const r1 = await ask({ type: REQ, level: 1 });
    check(
      "host: a report of a level is answered and recorded",
      r1?.type === `${REQ}_response` && record() === '{"u":1,"k":[]}',
      JSON.stringify({ r1, record: record() }),
    );
    const m1 = response();
    const o1 = await out(m1);
    const f1 = frame("rate_limit_event");
    const p1 = await out(f1);
    const s1 = frame("stream_event");
    check(
      "host: then a response and a rate_limit_event go out stamped, as copies, and a streamed frame as it came",
      o1 !== m1 &&
        o1[STAMP]?.u === 1 &&
        !(STAMP in m1) &&
        p1 !== f1 &&
        p1[STAMP]?.u === 1 &&
        p1.message === f1.message &&
        (await out(s1)) === s1,
      JSON.stringify({ o1, p1 }),
    );
    await ask({ type: REQ, key: KEY.settings });
    await ask({ type: REQ, key: KEY.settings });
    await ask({ type: REQ, key: "x".repeat(9000) });
    await ask({ type: REQ, key: 7 });
    await ask({ type: REQ, level: 2 });
    for (const level of [1, 0, 3, "2", null]) await ask({ type: REQ, level });
    check(
      "host: keys are recorded once, overlong or non-string ones dropped, and the level only rises",
      record() === JSON.stringify({ u: 2, k: [KEY.settings] }),
      record(),
    );
    check(
      "host: the next message carries all of it",
      JSON.stringify((await out(response()))[STAMP]) ===
        JSON.stringify({ u: 2, k: [KEY.settings] }),
    );
    const unknown = await ask({ type: "ccup_no_such_request" });
    check(
      "host: an unknown request still fails with the native error",
      unknown?.error === "Unknown request type.",
      JSON.stringify(unknown),
    );
  } finally {
    delete globalThis[HOST_RECORD];
  }
}

// The stub host: the init state the chat needs to mount (see the
// real-webview-mock notes), two sessions on disk with empty transcripts, and
// per query: the settings errors in the view's state (?settings=1), the
// credential conflict in its config (?cred=1), the wrap-up notice's gate
// (?wrap=1), the stamp every message but a streamed one carries (?stamp=), and
// whether it answers the dismissal report as the patched host does or as a
// pre-patch one (?host=old). It records each launch's channel under the
// session it resumes, and the reports. Page errors and unhandled rejections
// land in window.__errors. window.__STATE and window.__CONFIG are what an
// update_state push sends.
const page = (q) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/wv/index.css">
<style>
:root{--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px;
--vscode-chat-font-size:13px;--vscode-font-family:system-ui;--vscode-font-size:13px;
--vscode-foreground:#cccccc;--vscode-sideBar-background:#181818;color-scheme:dark}
body{background:var(--vscode-sideBar-background);color:var(--vscode-foreground)}
</style></head><body class="vscode-dark">
<pre id="claude-error"></pre>
<div id="root" data-initial-auth-status='{"authMethod":"claude_ai"}' data-initial-session="${A}"></div>
<script>
window.IS_SIDEBAR = true; window.IS_FULL_EDITOR = false; window.IS_SESSION_LIST_ONLY = false;
window.__chans = {}; window.__reports = []; window.__errors = [];
window.addEventListener("error", (e) => window.__errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) => window.__errors.push(String(e.reason)));
const HOST = ${JSON.stringify(q.get("host") || "patched")};
window.__stamp = ${q.get("stamp") || "null"};
const MODEL = { value: "default", label: "Default", resolvedModel: "claude-fable-5",
  supportsAutoMode: true, supportsFastMode: false, supportedEffortLevels: [] };
window.__STATE = { sweptStaleChannels: false, authStatus: { authMethod: "claude_ai" },
  claudeSettings: { effective: {}, errors: ${q.get("settings") === "1" ? JSON.stringify(ERRORS) : "[]"} },
  experimentGates: ${q.get("wrap") === "1" ? '{ "tengu_lantern_sconce": true }' : "{}"},
  useCtrlEnterToSend: false, speechToTextEnabled: false };
window.__CONFIG = { experimentGates: {}, models: [MODEL], unavailable_models: [],
  ${q.get("cred") === "1" ? `auth_conflict: ${JSON.stringify(CONFLICT)}` : ""} };
const NOW = Date.now();
const SESSIONS = ${JSON.stringify([
  [A, TITLE[A], 2],
  [B, TITLE[B], 30],
])}.map(([id, t, age]) => ({ id, summary: t, customTitle: t,
  lastModified: NOW - age * 60e3, lastActivity: NOW - age * 60e3, archived: false,
  fileSize: 2048, gitBranch: "develop", isCurrentWorkspace: true }));
const deliver = window.deliver = (message) => {
  const streamed = message.type === "io_message" && message.message?.type !== "rate_limit_event";
  if (window.__stamp && !streamed) message = { ...message, ${STAMP}: window.__stamp };
  window.dispatchEvent(new MessageEvent("message", { data: { type: "from-extension", message } }));
};
const respond = (requestId, response) => deliver({ type: "response", requestId, response });
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
        resp = { type: "init_response", state: window.__STATE };
        break;
      case "get_claude_state":
        resp = { type: "get_claude_state_response", config: window.__CONFIG };
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
        resp = { type: "get_session_response", messages: [], sessionDiffs: [] };
        break;
      case "${REQ}":
        window.__reports.push(r.key ?? r.level);
        resp = HOST === "old" ? { type: "error", error: "Unknown request type." }
          : { type: "${REQ}_response" };
        break;
    }
    respond(msg.requestId, resp);
  },
});
// A state push, as the host sends one after a change: config undefined is
// the push that follows the host dropping its config cache.
window.pushState = (state, config) => deliver({ type: "request", channelId: "",
  requestId: "u" + Math.random().toString(36).slice(2),
  request: { type: "update_state", state, config } });
</script>
<script type="module" src="/wv/index.js?mode=${q.get("mode")}"></script>
</body></html>`;

const TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

// The rate-limit frames the scenario reports, as the CLI's rate_limit_info
// carries them: the user's Fable warning, a five-hour one, a weekly one, the
// weekly limit reached, and a grace frame that raises the wrap-up notice. The
// five-hour limit is matched by its percentage alone, since through 2.1.300
// the banner calls it the session limit, and the grace frame carries usage
// credits, whose wrap-up state ("covered") every build words, while one
// without them ("stopped") gets no notice through 2.1.270.
const DAY = 86400;
const LIMITS = {
  fable: {
    status: "allowed_warning",
    rateLimitType: "seven_day_overage_included",
    utilization: 0.94,
    overageStatus: "allowed",
    days: 2,
    text: "94% of your Fable limit",
  },
  fableLater: {
    status: "allowed_warning",
    rateLimitType: "seven_day_overage_included",
    utilization: 0.96,
    overageStatus: "allowed",
    days: 2,
    text: "96% of your Fable limit",
  },
  fiveHour: {
    status: "allowed_warning",
    rateLimitType: "five_hour",
    utilization: 0.91,
    days: 0.1,
    text: "91% of your",
  },
  weekly: {
    status: "allowed_warning",
    rateLimitType: "seven_day",
    utilization: 0.88,
    days: 3,
    text: "88% of your weekly limit",
  },
  reached: {
    status: "rejected",
    rateLimitType: "seven_day",
    overageStatus: "rejected",
    days: 3,
    text: "hit your weekly limit",
  },
  grace: {
    status: "allowed_warning",
    rateLimitType: "seven_day",
    utilization: 0.99,
    overageStatus: "allowed",
    rateLimitGraceActive: true,
    days: 3,
    text: TEXT.wrapUp,
  },
};

export async function run(ctx) {
  const dir = liveBundleDir();
  const P = loadPatcher();
  const web = readFileSync(join(dir, "index.js"), "utf8");
  const host = readFileSync(join(dirname(dir), "extension.js"), "utf8");
  const bundles = {
    native: web.replace(WEB_FRAG_RE, "").replace(STORE_LINE_RE, ""),
    patched: P.bannerDismissWebview(web),
  };
  const hasCredential = web.includes("dismissAuthConflictWarning(");
  console.log(
    `live bundle: ${dir}${hasCredential ? "" : "  (no credential banner)"}`,
  );

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };

  await hostChecks(P, host, check);
  if (
    !check("webview: the patcher writes every banner point", !!bundles.patched)
  )
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

  const J = JSON.stringify;
  const ev = (expr) => ctx.evaluate(expr);
  const until = async (expr, ms = 6000) => {
    for (let t = 0; t < ms; t += 50) {
      const v = await ev(expr);
      if (v) return v;
      await ctx.sleep(50);
    }
    return null;
  };
  const DLG = `[role=dialog][aria-label="Past conversations"]`;
  const TITLE_EXPR = `document.querySelector('[class*="titleText_"]')?.getAttribute("title")`;
  // Every banner showing above the input box, by its text.
  const BANNERS = `[...document.querySelectorAll('[class*="inputWrapper_"] [class*="banner_"]')]`;
  const banners = () => ev(`${BANNERS}.map((b) => b.textContent)`);
  const bannerWith = (text) =>
    `${BANNERS}.find((b) => b.textContent.includes(${J(text)}))`;
  const boot = async (tag, q) => {
    await ctx.navigate(`${base}?${q}`);
    const mounted = await until(
      `!!document.querySelector('[aria-label="Session history"]')`,
    );
    const chan = await until(`window.__chans[${J(A)}]`);
    const err = await ev(`document.getElementById("claude-error").textContent`);
    return check(
      `${tag}: chat mounted on ${TITLE[A]}`,
      !!mounted && !!chan,
      err || undefined,
    );
  };
  const open = async (id) => {
    await ev(
      `document.querySelector('[aria-label="Session history"]').click()`,
    );
    await until(`!!document.querySelector('${DLG}')`);
    await ev(`(() => {
      const row = [...document.querySelectorAll('${DLG} button[id]')]
        .find((b) => b.textContent.includes(${J(TITLE[id])}));
      if (row) row.click();
    })()`);
    const titled = await until(`${TITLE_EXPR} === ${J(TITLE[id])}`);
    const chan = await until(`window.__chans[${J(id)}]`);
    return !!titled && !!chan;
  };
  // One rate-limit frame on a session's channel. A limit's reset time is fixed
  // for the run, as a window's end is: native keys a dismissal by it, so a
  // time read per frame would bring the banner back whenever two frames
  // straddle a second.
  const T0 = Math.floor(Date.now() / 1000);
  const report = async (id, name) => {
    const L = LIMITS[name];
    const info = {
      status: L.status,
      rateLimitType: L.rateLimitType,
      resetsAt: Math.floor(T0 + L.days * DAY),
      ...(L.utilization !== undefined && { utilization: L.utilization }),
      ...(L.overageStatus !== undefined && { overageStatus: L.overageStatus }),
      ...(L.rateLimitGraceActive && { rateLimitGraceActive: true }),
    };
    const message = {
      type: "rate_limit_event",
      rate_limit_info: info,
      uuid: crypto.randomUUID(),
      session_id: id,
    };
    await ev(`deliver({ type: "io_message", done: false,
      channelId: window.__chans[${J(id)}], message: ${J(message)} })`);
  };
  // Whether a banner with this text shows within a moment, or none does for
  // one (or none at all, given no text).
  const shows = async (text) => !!(await until(`!!${bannerWith(text)}`, 3000));
  const away = async (text) => {
    await ctx.sleep(400);
    const now = await banners();
    return text === undefined
      ? now.length === 0
      : !now.some((t) => t.includes(text));
  };
  const dismiss = (text) =>
    ev(`(() => {
      const b = ${bannerWith(text)}?.querySelector('button[aria-label^="Dismiss"]');
      if (b) b.click();
      return !!b;
    })()`);
  const closes = async (text) => (await dismiss(text)) && (await away(text));
  const reports = () => ev("window.__reports");
  const shown = async () => J(await banners());

  try {
    for (const mode of ["native", "patched"]) {
      const PATCHED = mode === "patched";

      // The usage banner: every kind of report, in one view.
      let tag = `${mode} usage`;
      if (!(await boot(tag, `mode=${mode}`))) return false;
      await report(A, "fable");
      check(
        `${tag}: the Fable warning shows in ${TITLE[A]}`,
        await shows(LIMITS.fable.text),
        await shown(),
      );
      if (PATCHED) await ctx.shot("fable-warning");
      check(`${tag}: Dismiss closes it`, await closes(LIMITS.fable.text));
      check(
        `${tag}: the close reports ${PATCHED ? "level 1" : "nothing"} to the host`,
        J(await reports()) === (PATCHED ? "[1]" : "[]"),
        J(await reports()),
      );
      await report(A, "fableLater");
      check(
        `${tag}: the same limit at a higher percentage stays away`,
        await away(),
        await shown(),
      );
      await report(A, "fiveHour");
      if (PATCHED)
        check(
          `${tag}: a five-hour warning stays away`,
          await away(),
          await shown(),
        );
      else {
        check(
          `${tag}: a five-hour warning shows again (the complaint)`,
          await shows(LIMITS.fiveHour.text),
          await shown(),
        );
        await dismiss(LIMITS.fiveHour.text);
      }
      if (!check(`${tag}: ${TITLE[B]} opens`, await open(B))) continue;
      await report(B, "fable");
      if (PATCHED)
        check(
          `${tag}: the Fable warning stays away in ${TITLE[B]}`,
          await away(),
          await shown(),
        );
      else
        check(
          `${tag}: the Fable warning shows again in ${TITLE[B]} (the complaint)`,
          await shows(LIMITS.fable.text),
          await shown(),
        );
      if (PATCHED) {
        await report(B, "reached");
        check(
          `${tag}: a reached limit still shows`,
          await shows(LIMITS.reached.text),
          await shown(),
        );
        check(`${tag}: Dismiss closes it`, await closes(LIMITS.reached.text));
        check(
          `${tag}: the close reports level 2`,
          J(await reports()) === "[1,2]",
          J(await reports()),
        );
        await report(B, "reached");
        await report(B, "weekly");
        check(
          `${tag}: neither a reached limit nor a warning shows after that`,
          await away(),
          await shown(),
        );
      }

      // A banner up in one session while another session dismisses its own.
      tag = `${mode} usage, two banners`;
      if (!(await boot(tag, `mode=${mode}`))) return false;
      await report(A, "weekly");
      check(
        `${tag}: the weekly warning shows in ${TITLE[A]}`,
        await shows(LIMITS.weekly.text),
      );
      if (!check(`${tag}: ${TITLE[B]} opens`, await open(B))) continue;
      await report(B, "fable");
      check(
        `${tag}: the Fable warning shows in ${TITLE[B]}`,
        await shows(LIMITS.fable.text),
      );
      check(
        `${tag}: Dismiss in ${TITLE[B]} closes it`,
        await closes(LIMITS.fable.text),
      );
      if (!check(`${tag}: back to ${TITLE[A]}`, await open(A))) continue;
      if (PATCHED)
        check(
          `${tag}: ${TITLE[A]}'s banner is gone too`,
          await away(),
          await shown(),
        );
      else
        check(
          `${tag}: ${TITLE[A]}'s banner is still up (the complaint)`,
          await shows(LIMITS.weekly.text),
          await shown(),
        );

      // The settings file banner.
      tag = `${mode} settings`;
      if (!(await boot(tag, `mode=${mode}&settings=1`))) return false;
      check(
        `${tag}: the settings error shows in ${TITLE[A]}`,
        await shows(TEXT.settings),
        await shown(),
      );
      if (PATCHED) await ctx.shot("settings-error");
      check(`${tag}: Dismiss closes it`, await closes(TEXT.settings));
      check(
        `${tag}: the close reports ${PATCHED ? "its errors" : "nothing"} to the host`,
        J(await reports()) === (PATCHED ? J([KEY.settings]) : "[]"),
        J(await reports()),
      );
      if (!check(`${tag}: ${TITLE[B]} opens`, await open(B))) continue;
      if (PATCHED)
        check(
          `${tag}: it stays away in ${TITLE[B]}`,
          await away(TEXT.settings),
          await shown(),
        );
      else
        check(
          `${tag}: it shows again in ${TITLE[B]} (the complaint)`,
          await shows(TEXT.settings),
          await shown(),
        );
      if (PATCHED) {
        await ev(`pushState({ ...window.__STATE, claudeSettings: { effective: {},
          errors: ${J(OTHER_ERRORS)} } }, window.__CONFIG)`);
        check(
          `${tag}: a different settings error shows`,
          await shows(OTHER_ERRORS[0].file),
          await shown(),
        );
      }

      // The credential banner.
      if (hasCredential) {
        tag = `${mode} credential`;
        if (!(await boot(tag, `mode=${mode}&cred=1`))) return false;
        check(
          `${tag}: the credential warning shows in ${TITLE[A]}`,
          await shows(TEXT.credential),
          await shown(),
        );
        if (PATCHED) await ctx.shot("credential-warning");
        check(`${tag}: Dismiss closes it`, await closes(TEXT.credential));
        check(
          `${tag}: the close reports ${PATCHED ? "its conflict" : "nothing"} to the host`,
          J(await reports()) === (PATCHED ? J([KEY.credential]) : "[]"),
          J(await reports()),
        );
        // The host drops its config cache, pushes a state without a config,
        // then the reloaded config.
        await ev("pushState(window.__STATE, undefined)");
        await ctx.sleep(200);
        await ev("pushState(window.__STATE, window.__CONFIG)");
        if (PATCHED)
          check(
            `${tag}: a config reload leaves it away`,
            await away(TEXT.credential),
            await shown(),
          );
        else
          check(
            `${tag}: a config reload brings it back in ${TITLE[A]} (the complaint)`,
            await shows(TEXT.credential),
            await shown(),
          );
        if (!PATCHED) await dismiss(TEXT.credential);
        if (!check(`${tag}: ${TITLE[B]} opens`, await open(B))) continue;
        if (PATCHED)
          check(
            `${tag}: it stays away in ${TITLE[B]}`,
            await away(TEXT.credential),
            await shown(),
          );
        else
          check(
            `${tag}: it shows again in ${TITLE[B]} (the complaint)`,
            await shows(TEXT.credential),
            await shown(),
          );
        if (PATCHED) {
          await ev(`pushState(window.__STATE, { ...window.__CONFIG,
            auth_conflict: ${J(OTHER_CONFLICT)} })`);
          check(
            `${tag}: a different conflict shows`,
            await shows(OTHER_CONFLICT.api_key_source),
            await shown(),
          );
        }

        // Only one of these shows at a time: the settings error ahead of the
        // credential warning.
        tag = `${mode} settings and credential`;
        if (!(await boot(tag, `mode=${mode}&settings=1&cred=1`))) return false;
        const first = await shows(TEXT.settings);
        check(
          `${tag}: the settings error shows, the credential warning behind it`,
          first && (await away(TEXT.credential)),
          await shown(),
        );
        await dismiss(TEXT.settings);
        check(
          `${tag}: dismissing it brings up the credential warning`,
          await shows(TEXT.credential),
          await shown(),
        );
      }

      // The wrap-up notice.
      tag = `${mode} wrap-up`;
      if (!(await boot(tag, `mode=${mode}&wrap=1`))) return false;
      await report(A, "grace");
      check(
        `${tag}: the wrap-up notice shows in ${TITLE[A]}`,
        await shows(TEXT.wrapUp),
        await shown(),
      );
      if (PATCHED) await ctx.shot("wrap-up-notice");
      check(`${tag}: Dismiss closes it`, await closes(TEXT.wrapUp));
      if (PATCHED)
        check(
          `${tag}: the close reports it to the host`,
          (await reports()).includes(KEY.wrapUp),
          J(await reports()),
        );
      if (!check(`${tag}: ${TITLE[B]} opens`, await open(B))) continue;
      await report(B, "grace");
      if (PATCHED)
        check(
          `${tag}: nothing shows in ${TITLE[B]}`,
          await away(),
          await shown(),
        );
      else
        check(
          `${tag}: it shows again in ${TITLE[B]} (the complaint)`,
          await shows(TEXT.wrapUp),
          await shown(),
        );
    }

    // A reloaded view starts with no dismissals, and takes the window's from
    // the host's stamp.
    const ALL = `mode=patched&settings=1&wrap=1${hasCredential ? "&cred=1" : ""}`;
    let tag = "patched reload";
    if (!(await boot(`${tag} unstamped`, ALL))) return false;
    check(
      `${tag}: without a stamp the settings error shows`,
      await shows(TEXT.settings),
      await shown(),
    );
    const stamp = encodeURIComponent(
      J({ u: 1, k: [KEY.settings, KEY.credential, KEY.wrapUp] }),
    );
    if (!(await boot(`${tag} stamped`, `${ALL}&stamp=${stamp}`))) return false;
    check(
      `${tag}: stamped, neither the settings error nor the credential warning shows`,
      await away(),
      await shown(),
    );
    await report(A, "grace");
    check(`${tag}: nor the wrap-up notice`, await away(), await shown());
    await report(A, "fiveHour");
    check(`${tag}: nor a warning`, await away(), await shown());
    await report(A, "reached");
    check(
      `${tag}: a reached limit still shows at level 1`,
      await shows(LIMITS.reached.text),
      await shown(),
    );

    // A host still on its pre-patch code answers the report with an error.
    tag = "patched, pre-patch host";
    if (!(await boot(tag, "mode=patched&host=old&settings=1"))) return false;
    check(`${tag}: the settings error shows`, await shows(TEXT.settings));
    check(`${tag}: Dismiss closes it`, await closes(TEXT.settings));
    await ctx.sleep(300);
    const errors = await ev("window.__errors");
    check(
      `${tag}: the refused report raises no page error`,
      J(await reports()) === J([KEY.settings]) && errors.length === 0,
      J(errors),
    );
    if (check(`${tag}: ${TITLE[B]} opens`, await open(B)))
      check(
        `${tag}: the view still keeps it away in ${TITLE[B]}`,
        await away(TEXT.settings),
        await shown(),
      );
  } finally {
    server.close();
  }
  return ok;
}
