// Scenario for scripts/cdp-driver.mjs: the always-on digit-led inline math fix,
// on the REAL webview bundle booted against a stub host into a transcript of two
// responses. The first mixes digit-led spans ($0$, $1/2$, $0.5$, $1 - p$, the
// $1$ of $1$-Lipschitz) with controls that must read the same either way:
// letter-led and TeX spans that render natively, and currency and shell text
// that must stay text. The second holds only digit-led spans the native
// precheck cannot see ($0$, $3.14$), so it renders only with the precheck
// fragment in. Each row reads back as its text with every typeset span as
// [[tex]], and the checks assert:
//   native   the digit-led spans keep their dollar signs (the bug the point
//            fixes; once this stops, Claude Code has fixed it itself and the
//            point can be retired), and the controls read as expected
//   patched  the digit-led spans typeset, the second response's included,
//            and every control reads exactly as it did natively
//
//   node scripts/cdp-driver.mjs scripts/repro/math-digits.mjs 760 900
//
// The patched bundle served is the compiled patcher's own output for the live
// install (mathDigitsWebview, out/, so compile first), so the scenario runs
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

const R = "44444444-4444-4444-8444-444444444444";
const FRAG_RE =
  /\/\*ccup:mathDigits:[-\w]+\*\/[\s\S]*?\/\*ccup:mathDigitsEnd\*\//g;

// Each row is one paragraph, with the TeX of the spans it typesets in each
// mode. A control lists the same spans for both. The first row is the report
// that started this point, soft line break included.
const FIRST = [
  {
    md: "written $\\max X \\cap W_i$, has size $0$ or $1$.\nand both of your candidates are readings of it.",
    native: ["\\max X \\cap W_i"],
    patched: ["\\max X \\cap W_i", "0", "1"],
  },
  {
    md: "with probability $1/2$, so $0.5$ overall, and $1 - p$ otherwise.",
    native: [],
    patched: ["1/2", "0.5", "1 - p"],
  },
  {
    md: "a $1$-Lipschitz map on a $3$-dimensional space.",
    native: [],
    patched: ["1", "3"],
  },
  {
    md: "$n$ and $n-1$ and $2^n$ and $O(n)$ and $1+1=2$.",
    control: ["n", "n-1", "2^n", "O(n)", "1+1=2"],
  },
  {
    md: "It costs $5 and $10, or $5-$10, or $1.50/$2.00, and US$5.",
    control: [],
  },
  { md: "Set $PATH:$HOME, then echo $1 $2 and $?.", control: [] },
];
const SECOND = [
  {
    md: "The empty set has size $0$, and pi is about $3.14$.",
    native: [],
    patched: ["0", "3.14"],
  },
];
const want = (row, mode) => row.control ?? row[mode];

// The stub host: just enough of the init state for the chat to mount (see the
// real-webview-mock notes), one session on disk and its transcript in SDK
// message form. The root names the session, so the view opens it at boot, and
// the host reports no plugins, without which every row stays hidden as
// "Waiting for your plugins". Responses go out synchronously, or the first
// render races ahead of get_claude_state.
const page = (mode) => `<!doctype html><html><head><meta charset="utf-8">
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
const REPLIES = ${JSON.stringify([FIRST, SECOND].map((rows) => rows.map((r) => r.md).join("\n\n")))};
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
<script type="module" src="/wv/index.js?mode=${mode}"></script>
</body></html>`;

const TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

// Every response's paragraphs, each read back as its text with every typeset
// span replaced by [[<its TeX annotation>]].
const READBACK = `JSON.stringify([...document.querySelectorAll(
  '[data-testid="assistant-message"]')].map((m) => [...m.querySelectorAll("p")].map((p) => {
  const rd = (n) => {
    if (n.nodeType === 3) return n.nodeValue;
    if (n.nodeType !== 1) return "";
    if (n.classList.contains("katex"))
      return "[[" + (n.querySelector("annotation")?.textContent ?? "?") + "]]";
    return [...n.childNodes].map(rd).join("");
  };
  return rd(p);
})))`;
const spansOf = (text) =>
  [...text.matchAll(/\[\[([\s\S]*?)\]\]/g)].map((m) => m[1]);

export async function run(ctx) {
  const dir = liveBundleDir();
  const web = readFileSync(join(dir, "index.js"), "utf8");
  const bundles = {
    native: web.replace(FRAG_RE, ""),
    patched: loadPatcher().mathDigitsWebview(web),
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
        .end(page(url.searchParams.get("mode")));
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  const read = async () => JSON.parse(await ctx.evaluate(READBACK));
  // Math loads lazily, so wait for the first response's \max span, which
  // typesets in both modes, and then for the second response where it should
  // typeset too. A response the native pass leaves as text never qualifies,
  // so that wait just runs out.
  const until = async (pred, ms) => {
    let got = await read();
    for (let t = 0; t < ms && !pred(got); t += 100) {
      await ctx.sleep(100);
      got = await read();
    }
    return got;
  };

  try {
    const seen = {};
    for (const mode of ["native", "patched"]) {
      await ctx.navigate(`${base}?mode=${mode}`);
      let rows = await until(
        (r) => r.length === 2 && (r[0][0] ?? "").includes("[["),
        10000,
      );
      const err = await ctx.evaluate(
        `document.getElementById("claude-error").textContent`,
      );
      const mounted =
        rows.length === 2 &&
        rows[0].length === FIRST.length &&
        rows[1].length === SECOND.length &&
        rows[0][0].includes("[[");
      if (
        !check(
          `${mode}: both responses rendered, math loaded`,
          mounted,
          mounted ? undefined : err || JSON.stringify(rows),
        )
      )
        return false;
      if (mode === "patched") {
        rows = await until((r) => (r[1][0] ?? "").includes("[["), 3000);
        await ctx.shot("math-digits");
      } else {
        await ctx.sleep(600);
        rows = await read();
      }
      seen[mode] = rows;
      for (const [k, list] of [FIRST, SECOND].entries()) {
        list.forEach((row, i) => {
          const got = rows[k][i];
          const spans = spansOf(got);
          const label = row.control ? "control" : mode;
          check(
            `${mode} response ${k + 1} row ${i + 1} (${label}): ${JSON.stringify(want(row, mode))}`,
            JSON.stringify(spans) === JSON.stringify(want(row, mode)),
            got.replace(/\n/g, "\\n"),
          );
          // A row with nothing typeset reads back as its own source, every
          // dollar sign in place.
          if (!spans.length)
            check(
              `${mode} response ${k + 1} row ${i + 1}: text intact`,
              got === row.md,
            );
        });
      }
    }
    FIRST.forEach((row, i) => {
      if (row.control)
        check(
          `control row ${i + 1} reads the same in both modes`,
          seen.native[0][i] === seen.patched[0][i],
        );
    });
  } finally {
    server.close();
  }
  return ok;
}
