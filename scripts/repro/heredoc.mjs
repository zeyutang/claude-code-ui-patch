// Scenario for scripts/cdp-driver.mjs: the always-on shell here-document fix,
// on the REAL webview bundle booted against a stub host into a transcript of
// one response holding bash code blocks. Each block reads back as its lines,
// every character with its computed color, and the checks assert:
//   native   the bug: the commit message's body lexes as shell code, so its
//            first line is not in the string color and the `in` of its last
//            line reads as a keyword (a block that starts reading as text
//            means Monaco's grammar has gained a body state of its own)
//   patched  every body reads in the string color through its closing line,
//            an unquoted body colors its expansions as variables, a `<<-` body
//            closes on a tab-indented word and a `<<` body does not close on a
//            space-indented one, an unclosed body runs to the block's end, a
//            line after a closing line reads as it does on its own, and the
//            opener lines and the control block read exactly as natively
//
//   node scripts/cdp-driver.mjs scripts/repro/heredoc.mjs 760 900
//
// The patched bundle served is the compiled patcher's own output for the live
// install (heredocWebview, out/, so compile first), so the scenario runs
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

const R = "55555555-5555-4555-8555-555555555555";
const FRAG_RE = /\/\*ccup:heredoc:[-\w]+\*\/[\s\S]*?\/\*ccup:heredocEnd\*\//g;

// The blocks, in response order. `body` lists the lines that must read in the
// string color once patched (the closing line included), `vars` the
// expansions in them that must read as variables instead, and `same` pairs a
// line after the here-document with the control line it must match.
const BLOCKS = [
  {
    name: "commit",
    lines: [
      "git add .markdownlint.jsonc docs/corroborate-note.md",
      "git commit -F- <<'EOF'",
      "Sharpen the Corroborate note's modes and figures",
      "",
      "* one block per mode in Figure 1, the cover edges labeled",
      "* modes as anchors fixed by their instrument, contracts a companion cut",
      "* native mode's verdict standing enforced, staging a knob",
      "* Table 2 reads existing products on the axes with a per-row maximum",
      "* record by mode shows the means of each report, no dashed box",
      "* table captions above the tables, legends beside the last block",
      "* every figure reflowed by wrappingWidth, no reflow line breaks",
      "* allow span in markdownlint for the colored table patches",
      "EOF",
    ],
    openers: [0, 1],
    body: [2, 12],
  },
  {
    name: "unquoted",
    lines: [
      "cat <<EOF > notes.txt",
      "it's $HOME and ${USER} on $(date), not \\$PATH",
      'for x in a b; do echo "$x"; done',
      "EOF",
      "echo done",
    ],
    openers: [0],
    body: [1, 3],
    vars: { 1: ["$HOME", "${USER}", "$(date)"], 2: ["$x"] },
    same: [[4, 0]],
  },
  // An unquoted word that ends its line, where the closing-quote group of the
  // opener matches nothing.
  {
    name: "unquoted at line end",
    lines: ["cat <<EOF", "it's $HOME", "EOF", "ls"],
    openers: [0],
    body: [1, 2],
    vars: { 1: ["$HOME"] },
    same: [[3, 5]],
  },
  {
    name: "double-quoted",
    lines: ['cat <<"END" | wc -l', "it's $HOME as written", "END", "ls"],
    openers: [0],
    body: [1, 2],
    same: [[3, 5]],
  },
  // A backslash quotes the word as quotes do, so nothing in the body expands.
  // The opener is not compared: natively `<<\EOF` matches no heredoc rule.
  {
    name: "escaped",
    lines: ["cat <<\\EOF", "$HOME and ${USER} stay as written", "EOF"],
    body: [1, 2],
  },
  {
    name: "tabs",
    lines: ["cat <<-'EOF'", "\tit's indented with a tab", "\tEOF", "ls"],
    openers: [0],
    body: [1, 2],
    same: [[3, 5]],
  },
  {
    name: "exact",
    lines: ["cat <<'EOF'", "  EOF", "it's still the body", "EOF", "ls"],
    openers: [0],
    body: [1, 3],
    same: [[4, 5]],
  },
  {
    name: "unclosed",
    lines: ["python3 - <<'PY'", 'print("it\'s")', "for x in range(3): pass"],
    openers: [0],
    body: [1, 2],
  },
  // The form Claude Code's own commits use: inside double quotes the grammar
  // reads the whole span as one string, here-document included, natively and
  // patched alike.
  {
    name: "quoted substitution",
    lines: [
      "git commit -m \"$(cat <<'EOF'",
      "Fix the note's figures",
      "EOF",
      ')"',
    ],
    openers: [0, 1, 2, 3],
  },
  {
    name: "control",
    lines: [
      "echo done",
      "echo $HOME",
      'cat <<< "$HOME"',
      "cat <<<word",
      "(( n = 1 << 2 ))",
      "ls",
    ],
    openers: [0, 1, 2, 3, 4, 5],
  },
];
const CONTROL = BLOCKS.length - 1;
const REPLY = BLOCKS.map(
  (b) => "```bash\n" + b.lines.join("\n") + "\n```",
).join("\n\nNext:\n\n");

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
const R = "${R}", NOW = Date.now(), at = new Date(NOW - 60e3).toISOString();
const MESSAGES = [
  { type: "user", uuid: "u0-0000-4000-8000-000000000000", session_id: R,
    parent_tool_use_id: null, timestamp: at,
    message: { role: "user", content: [{ type: "text", text: "Suggest a commit" }] } },
  { type: "assistant", uuid: "a0-0000-4000-8000-000000000000", session_id: R,
    parent_tool_use_id: null, timestamp: at,
    message: { id: "msg_0", type: "message", role: "assistant", model: "claude-fable-5",
      content: [{ type: "text", text: ${JSON.stringify(REPLY)} }], stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 } } },
];
const SESSION = { id: R, summary: "Heredoc", customTitle: "Heredoc", lastModified: NOW,
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

// Every code block of the response: whether the colorizer has reached it (a
// colored block carries token spans), and its lines, each as its text and the
// computed color of every character.
const READBACK = `JSON.stringify([...document.querySelectorAll(
  '[data-testid="assistant-message"] code[class*="language-"]')].map((code) => {
  const base = getComputedStyle(code).color, lines = [[]];
  for (const n of code.childNodes) {
    const color = n.nodeType === 1 ? getComputedStyle(n).color : base;
    for (const ch of n.textContent) {
      if (ch === "\\n") lines.push([]);
      else lines[lines.length - 1].push([ch, color]);
    }
  }
  if (lines.length > 1 && !lines[lines.length - 1].length) lines.pop();
  return { colored: !!code.querySelector("span"),
    lines: lines.map((l) => ({ text: l.map((x) => x[0]).join(""), colors: l.map((x) => x[1]) })) };
}))`;

// The color of the characters of `text` at its first occurrence in a line.
function colorAt(line, text) {
  const i = line.text.indexOf(text);
  return i < 0 ? undefined : line.colors[i];
}
// The characters of a line that are not whitespace, each with its color and
// whether it falls inside one of the listed expansions.
function inked(line, vars = []) {
  const inVar = new Array(line.text.length).fill(false);
  let from = 0;
  for (const v of vars) {
    const i = line.text.indexOf(v, from);
    if (i < 0) return null;
    inVar.fill(true, i, i + v.length);
    from = i + v.length;
  }
  return [...line.text]
    .map((ch, i) => ({ ch, color: line.colors[i], inVar: inVar[i] }))
    .filter((x) => !/\s/.test(x.ch));
}
const sameColors = (a, b) =>
  a.text === b.text && JSON.stringify(a.colors) === JSON.stringify(b.colors);

export async function run(ctx) {
  const dir = liveBundleDir();
  const web = readFileSync(join(dir, "index.js"), "utf8");
  const bundles = {
    native: web.replace(FRAG_RE, ""),
    patched: loadPatcher().heredocWebview(web),
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
  if (!check("the patcher locates the site", bundles.patched !== null))
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
  // The colorizer runs after the first render, one block at a time.
  const until = async (pred, ms) => {
    let got = await read();
    for (let t = 0; t < ms && !pred(got); t += 100) {
      await ctx.sleep(100);
      got = await read();
    }
    return got;
  };
  const allColored = (r) =>
    r.length === BLOCKS.length && r.every((b) => b.colored);

  try {
    const seen = {};
    for (const mode of ["native", "patched"]) {
      await ctx.navigate(`${base}?mode=${mode}`);
      const got = await until(allColored, 15000);
      const err = await ctx.evaluate(
        `document.getElementById("claude-error").textContent`,
      );
      if (
        !check(
          `${mode}: every block rendered and colored`,
          allColored(got),
          allColored(got)
            ? undefined
            : err || JSON.stringify(got.map((b) => b.colored)),
        )
      )
        return false;
      const intact = got.every(
        (b, k) =>
          JSON.stringify(b.lines.map((l) => l.text)) ===
          JSON.stringify(BLOCKS[k].lines),
      );
      if (!check(`${mode}: every block reads back as its source`, intact))
        return false;
      // The commit block, the report that started this point, in view.
      await ctx.evaluate(`document.querySelector(
        '[data-testid="assistant-message"] code[class*="language-"]').scrollIntoView()`);
      await ctx.sleep(200);
      await ctx.shot(`heredoc-${mode}`);
      seen[mode] = got;
    }

    const { native, patched } = seen;
    const commitN = native[0].lines;
    const ctlN = native[CONTROL].lines;
    // Reference colors, all from lines that read the same in both modes.
    const STRING = colorAt(commitN[1], "'EOF'");
    const VARIABLE = colorAt(ctlN[1], "$HOME");
    const KEYWORD = colorAt(ctlN[0], "done");
    const DEFAULT = colorAt(ctlN[0], " ");
    console.log(
      `colors: string ${STRING}, variable ${VARIABLE}, keyword ${KEYWORD}, default ${DEFAULT}`,
    );
    check(
      "the reference colors are distinct",
      new Set([STRING, VARIABLE, KEYWORD, DEFAULT]).size === 4,
    );

    // The bug, natively.
    check(
      "native: the commit body's first line is not in the string color",
      colorAt(commitN[2], "Sharpen") !== STRING,
      colorAt(commitN[2], "Sharpen"),
    );
    check(
      "native: the commit body's last line reads `in` as a keyword",
      colorAt(commitN[11], " in ") !== undefined &&
        commitN[11].colors[commitN[11].text.indexOf(" in ") + 1] === KEYWORD,
    );

    BLOCKS.forEach((b, k) => {
      const nl = native[k].lines;
      const pl = patched[k].lines;
      for (const i of b.openers ?? [])
        check(
          `${b.name} line ${i + 1} reads as natively: ${JSON.stringify(b.lines[i])}`,
          sameColors(nl[i], pl[i]),
        );
      if (b.body) {
        const [from, to] = b.body;
        for (let i = from; i <= to; i++) {
          const ink = inked(pl[i], b.vars?.[i]);
          const bad = ink?.filter(
            (x) => x.color !== (x.inVar ? VARIABLE : STRING),
          );
          check(
            `${b.name} line ${i + 1} reads as ${b.vars?.[i] ? "text with variables" : "text"}: ${JSON.stringify(b.lines[i])}`,
            !!ink && bad.length === 0,
            bad?.length ? bad.map((x) => x.ch).join("") : undefined,
          );
        }
      }
      for (const [i, j] of b.same ?? [])
        check(
          `${b.name} line ${i + 1} reads as the control's ${JSON.stringify(BLOCKS[CONTROL].lines[j])}`,
          sameColors(pl[i], patched[CONTROL].lines[j]),
        );
    });
  } finally {
    server.close();
  }
  return ok;
}
