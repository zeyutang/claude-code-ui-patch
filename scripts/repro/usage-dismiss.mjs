// Scenario for scripts/cdp-driver.mjs: the always-on usage warning dismissal,
// both halves. The host half runs first, in Node: the comms base's
// processRequest and the comms subclass's send are cut out of the patched host
// bundle and rebuilt in a with-scope, then fed dismissal reports and
// rate_limit_event frames, checking the level the host keeps and the stamp
// its frames carry. The webview half runs on the REAL webview bundle booted
// against a stub host with two sessions, whose CLI frames the scenario
// delivers itself: a warning shows the banner, Dismiss closes it, and later
// frames (the same limit again, another limit, the same limit in the other
// session, a reached limit) show or stay away. Each mode runs:
//   native   the stock bundle, which has to reproduce the complaint: the banner
//            comes back for another limit, in the other session, and stays up
//            in a session where it was not dismissed
//   patched  the bundle with this point's fragments, against a stub host that
//            answers the report as the patched host does
// and the patched mode adds a reloaded view, which takes the window's level
// from a stamped frame and starts at none without one, and a host still
// running its pre-patch code, which answers the report with an error the
// close must swallow.
//
//   node scripts/cdp-driver.mjs scripts/repro/usage-dismiss.mjs 600 700
//
// Once the native mode stops reproducing, Claude Code itself keeps dismissals
// across sessions and limits, and the point can be retired. The patched
// bundles are the compiled patcher's own output for the live install
// (usageDismissWebview and usageDismissHost, out/, so compile first), so the
// scenario runs exactly what an apply writes and doubles as the drift canary.
// The live install is found under ~/.vscode/extensions (newest Claude Code
// install) or via $CCUP_BUNDLE (the webview directory, with extension.js
// beside it).
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
const FRAG_RE = /\/\*ccup:udis:[-\w]+\*\/[\s\S]*?\/\*ccup:udisEnd\*\//g;
const REQ = "ccup_usage_dismiss";
const HOST_LEVEL = "__ccupUsageDismissLevel";
const STAMP = "ccupUsageDismissed";

// The host half, run on its own code. A method is rebuilt from its source in
// a with-scope whose names fall back to Node's globals, which is all the
// paths exercised here reach: the request switch jumps straight to the route
// (its case tests are literals) or falls out to the native error, and send
// touches only its this.
async function hostChecks(P, host, check) {
  const D = require(join(ROOT, "out", "derive.js"));
  const patched = P.usageDismissHost(host);
  if (!check("host: the patcher locates both host sites", patched !== null))
    return;
  const native = patched.replace(FRAG_RE, "");
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
  const route = method(patched, "/*ccup:udis:route*/", "processRequest");
  const nativeRoute = method(native, 'case"rewind_code":', "processRequest");
  const send = method(patched, "/*ccup:udis:send*/", "send");
  const posted = [];
  const self = {
    sendQueue: Promise.resolve(),
    webview: { postMessage: async (m) => void posted.push(m.message) },
    checkAndUpdateReviewUpsellBanner() {},
  };
  const out = async (frame) => {
    send.call(self, frame);
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
    message:
      type === "rate_limit_event"
        ? { type, rate_limit_info: { status: "allowed_warning" } }
        : { type },
  });
  delete globalThis[HOST_LEVEL];
  try {
    const old = await nativeRoute
      .call(self, { request: { type: REQ, level: 1 } })
      .then(
        () => "answered",
        (e) => e.message,
      );
    check(
      "host: a pre-patch host answers the report with its error",
      old === "Unknown request type.",
      old,
    );
    const f0 = frame("rate_limit_event");
    check(
      "host: before any report a rate_limit_event goes out as it came",
      (await out(f0)) === f0 && !(STAMP in f0.message),
    );
    const r1 = await ask({ type: REQ, level: 1 });
    check(
      "host: a report of 1 is answered and sets the level",
      r1?.type === `${REQ}_response` && globalThis[HOST_LEVEL] === 1,
      JSON.stringify({ r1, level: globalThis[HOST_LEVEL] }),
    );
    const f1 = frame("rate_limit_event");
    const o1 = await out(f1);
    check(
      "host: then a rate_limit_event goes out stamped 1, as a copy",
      o1 !== f1 &&
        o1.message[STAMP] === 1 &&
        o1.message.rate_limit_info === f1.message.rate_limit_info &&
        !(STAMP in f1.message),
      JSON.stringify(o1),
    );
    await ask({ type: REQ, level: 2 });
    const l2 = globalThis[HOST_LEVEL];
    for (const level of [1, 0, 3, "2", null]) await ask({ type: REQ, level });
    await ask({ type: REQ });
    check(
      "host: a report of 2 raises it, and no later report lowers or garbles it",
      l2 === 2 && globalThis[HOST_LEVEL] === 2,
      JSON.stringify({ l2, after: globalThis[HOST_LEVEL] }),
    );
    check(
      "host: the next rate_limit_event carries 2",
      (await out(frame("rate_limit_event"))).message[STAMP] === 2,
    );
    const others = [
      frame("stream_event"),
      { type: "response", requestId: "x" },
    ];
    const same = [];
    for (const f of others) same.push((await out(f)) === f);
    check(
      "host: every other message goes out as it came",
      same.every(Boolean),
      JSON.stringify(same),
    );
    const unknown = await ask({ type: "ccup_no_such_request" });
    check(
      "host: an unknown request still fails with the native error",
      unknown?.error === "Unknown request type.",
      JSON.stringify(unknown),
    );
  } finally {
    delete globalThis[HOST_LEVEL];
  }
}

// The stub host: the init state the chat needs to mount (see the
// real-webview-mock notes) and two sessions on disk with empty transcripts.
// It records each launch's channel under the session it resumes, answers
// the dismissal report as the patched host does (?host=patched) or as a
// pre-patch one does (?host=old), and keeps the levels reported. Page errors
// and unhandled rejections land in window.__errors.
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
const NOW = Date.now();
const SESSIONS = ${JSON.stringify([
  [A, TITLE[A], 2],
  [B, TITLE[B], 30],
])}.map(([id, t, age]) => ({ id, summary: t, customTitle: t,
  lastModified: NOW - age * 60e3, lastActivity: NOW - age * 60e3, archived: false,
  fileSize: 2048, gitBranch: "develop", isCurrentWorkspace: true }));
const deliver = window.deliver = (message) => window.dispatchEvent(
  new MessageEvent("message", { data: { type: "from-extension", message } }));
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
        resp = { type: "get_session_response", messages: [], sessionDiffs: [] };
        break;
      case "${REQ}":
        window.__reports.push(r.level);
        resp = HOST === "old" ? { type: "error", error: "Unknown request type." }
          : { type: "${REQ}_response" };
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

// The limits the scenario reports, as the CLI's rate_limit_info carries them:
// the user's Fable warning, a five-hour one, a weekly one, and the weekly
// limit reached.
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
    text: "91% of your 5-hour limit",
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
};

export async function run(ctx) {
  const dir = liveBundleDir();
  const P = loadPatcher();
  const web = readFileSync(join(dir, "index.js"), "utf8");
  const host = readFileSync(join(dirname(dir), "extension.js"), "utf8");
  const bundles = {
    native: web.replace(FRAG_RE, ""),
    patched: P.usageDismissWebview(web),
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

  await hostChecks(P, host, check);
  if (!check("webview: the patcher locates the four sites", !!bundles.patched))
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
  const DLG = `[role=dialog][aria-label="Past conversations"]`;
  const TITLE_EXPR = `document.querySelector('[class*="titleText_"]')?.getAttribute("title")`;
  // The usage banner: the notice carrying a View usage link.
  const BANNER = `[...document.querySelectorAll('[class*="banner_"]')].find((b) =>
    [...b.querySelectorAll("button")].some((x) => x.textContent === "View usage"))`;
  const bannerText = () => ev(`(${BANNER})?.textContent ?? null`);
  const boot = async (tag, q) => {
    await ctx.navigate(`${base}?${q}`);
    const mounted = await until(
      `!!document.querySelector('[aria-label="Session history"]')`,
    );
    const chan = await until(`window.__chans[${JSON.stringify(A)}]`);
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
        .find((b) => b.textContent.includes(${JSON.stringify(TITLE[id])}));
      if (row) row.click();
    })()`);
    const titled = await until(
      `${TITLE_EXPR} === ${JSON.stringify(TITLE[id])}`,
    );
    const chan = await until(`window.__chans[${JSON.stringify(id)}]`);
    return !!titled && !!chan;
  };
  // One CLI frame on a session's channel, optionally with the host's stamp.
  // A limit's reset time is fixed for the run, as a window's end is: native
  // keys a dismissal by it, so a time read per frame would bring the banner
  // back whenever two frames straddle a second.
  const T0 = Math.floor(Date.now() / 1000);
  const report = async (id, name, stamp) => {
    const L = LIMITS[name];
    const info = {
      status: L.status,
      rateLimitType: L.rateLimitType,
      resetsAt: Math.floor(T0 + L.days * DAY),
      ...(L.utilization !== undefined && { utilization: L.utilization }),
      ...(L.overageStatus !== undefined && { overageStatus: L.overageStatus }),
    };
    const message = {
      type: "rate_limit_event",
      rate_limit_info: info,
      uuid: crypto.randomUUID(),
      session_id: id,
      ...(stamp !== undefined && { [STAMP]: stamp }),
    };
    await ev(`deliver({ type: "io_message", done: false,
      channelId: window.__chans[${JSON.stringify(id)}],
      message: ${JSON.stringify(message)} })`);
  };
  // Whether the banner shows the limit within a moment, or stays away for
  // one.
  const shows = async (name) =>
    !!(await until(
      `((${BANNER})?.textContent ?? "").includes(${JSON.stringify(LIMITS[name].text)})`,
      3000,
    ));
  const away = async () => {
    await ctx.sleep(400);
    return (await bannerText()) === null;
  };
  const dismiss = () =>
    ev(`(() => {
      const b = (${BANNER})?.querySelector('button[aria-label^="Dismiss"]');
      if (b) b.click();
      return !!b;
    })()`);

  try {
    for (const mode of ["native", "patched"]) {
      const P_ = mode === "patched";
      // One view, both sessions, every kind of report.
      let tag = `${mode} one view`;
      if (!(await boot(tag, `mode=${mode}`))) return false;
      await report(A, "fable");
      check(
        `${tag}: the Fable warning shows in ${TITLE[A]}`,
        await shows("fable"),
        await bannerText(),
      );
      if (P_) await ctx.shot("fable-warning");
      check(`${tag}: Dismiss closes it`, (await dismiss()) && (await away()));
      const reports = await ev("window.__reports");
      check(
        P_
          ? `${tag}: the close reports level 1 to the host`
          : `${tag}: the close reports nothing to the host`,
        JSON.stringify(reports) === (P_ ? "[1]" : "[]"),
        JSON.stringify(reports),
      );
      await report(A, "fableLater");
      check(
        `${tag}: the same limit at a higher percentage stays away`,
        await away(),
        await bannerText(),
      );
      await report(A, "fiveHour");
      if (P_)
        check(
          `${tag}: a five-hour warning stays away`,
          await away(),
          await bannerText(),
        );
      else
        check(
          `${tag}: a five-hour warning shows again (the complaint)`,
          await shows("fiveHour"),
          await bannerText(),
        );
      if (!P_) await dismiss();
      if (!check(`${tag}: ${TITLE[B]} opens`, await open(B))) continue;
      await report(B, "fable");
      if (P_)
        check(
          `${tag}: the Fable warning stays away in ${TITLE[B]}`,
          await away(),
          await bannerText(),
        );
      else
        check(
          `${tag}: the Fable warning shows again in ${TITLE[B]} (the complaint)`,
          await shows("fable"),
          await bannerText(),
        );
      if (P_) {
        await report(B, "reached");
        check(
          `${tag}: a reached limit still shows`,
          await shows("reached"),
          await bannerText(),
        );
        await ctx.shot("limit-reached");
        check(`${tag}: Dismiss closes it`, (await dismiss()) && (await away()));
        check(
          `${tag}: the close reports level 2`,
          JSON.stringify(await ev("window.__reports")) === "[1,2]",
          JSON.stringify(await ev("window.__reports")),
        );
        await report(B, "reached");
        await report(B, "weekly");
        check(
          `${tag}: neither a reached limit nor a warning shows after that`,
          await away(),
          await bannerText(),
        );
      }

      // A banner up in one session while another session dismisses its own.
      tag = `${mode} two banners`;
      if (!(await boot(tag, `mode=${mode}`))) return false;
      await report(A, "weekly");
      check(
        `${tag}: the weekly warning shows in ${TITLE[A]}`,
        await shows("weekly"),
      );
      if (!check(`${tag}: ${TITLE[B]} opens`, await open(B))) continue;
      await report(B, "fable");
      check(
        `${tag}: the Fable warning shows in ${TITLE[B]}`,
        await shows("fable"),
      );
      check(
        `${tag}: Dismiss in ${TITLE[B]} closes it`,
        (await dismiss()) && (await away()),
      );
      if (!check(`${tag}: back to ${TITLE[A]}`, await open(A))) continue;
      if (P_)
        check(
          `${tag}: ${TITLE[A]}'s banner is gone too`,
          await away(),
          await bannerText(),
        );
      else
        check(
          `${tag}: ${TITLE[A]}'s banner is still up (the complaint)`,
          await shows("weekly"),
          await bannerText(),
        );
    }

    // A reloaded view starts at no level, and takes the window's from the
    // host's stamp.
    let tag = "patched reload";
    if (!(await boot(`${tag} unstamped`, "mode=patched"))) return false;
    await report(A, "weekly");
    check(
      `${tag}: an unstamped warning shows (the view's level starts at none)`,
      await shows("weekly"),
    );
    if (!(await boot(`${tag} stamped`, "mode=patched"))) return false;
    await report(A, "weekly", 1);
    check(
      `${tag}: a warning stamped 1 stays away`,
      await away(),
      await bannerText(),
    );
    await report(A, "fiveHour");
    check(
      `${tag}: and the view keeps that level for an unstamped one`,
      await away(),
      await bannerText(),
    );
    await report(A, "reached", 1);
    check(
      `${tag}: a reached limit stamped 1 still shows`,
      await shows("reached"),
      await bannerText(),
    );
    await report(A, "reached", 2);
    check(
      `${tag}: and stamped 2 it goes away`,
      await away(),
      await bannerText(),
    );

    // A host still on its pre-patch code answers the report with an error.
    tag = "patched, pre-patch host";
    if (!(await boot(tag, "mode=patched&host=old"))) return false;
    await report(A, "fable");
    check(`${tag}: the Fable warning shows`, await shows("fable"));
    check(`${tag}: Dismiss closes it`, (await dismiss()) && (await away()));
    await ctx.sleep(300);
    const errors = await ev("window.__errors");
    check(
      `${tag}: the refused report raises no page error`,
      JSON.stringify(await ev("window.__reports")) === "[1]" &&
        errors.length === 0,
      JSON.stringify(errors),
    );
    if (check(`${tag}: ${TITLE[B]} opens`, await open(B))) {
      await report(B, "fable");
      check(
        `${tag}: the view still keeps it away in ${TITLE[B]}`,
        await away(),
        await bannerText(),
      );
    }
  } finally {
    server.close();
  }
  return ok;
}
