// Minimal CDP harness for chrome-headless-shell. No dependencies: Node >= 22
// (built-in WebSocket, fetch) plus the Chrome for Testing binary that
// puppeteer caches under ~/.cache/puppeteer (never the installed
// /Applications Chrome). Dev-only tooling: git-tracked for UI
// investigations, excluded from the VSIX via .vscodeignore (scripts/**),
// and intentionally absent from the README.
//
// Usage:
//   node scripts/cdp-driver.mjs <scenario.mjs> [width] [height]
//
// A scenario module exports `run(ctx)` and drives the page through ctx:
//   ctx.navigate(url)      load a page (file:// or http://)
//   ctx.evaluate(expr)     Runtime.evaluate with returnByValue
//   ctx.insertText(text)   Input.insertText into the focused editable; goes
//                          through the editing pipeline, so caret reveal and
//                          input events fire like real typing
//   ctx.shot(name)         PNG screenshot into the run's output dir
//   ctx.cdp(method, params) raw protocol access
//   ctx.sleep(ms), ctx.dir (scenario's directory), ctx.outDir, ctx.viewport
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function findHeadlessShell() {
  const root = join(homedir(), ".cache", "puppeteer", "chrome-headless-shell");
  let versions = [];
  try {
    versions = readdirSync(root).filter((d) => !d.startsWith("."));
  } catch {
    /* fall through to the error below */
  }
  // Version dirs look like mac_arm-150.0.7871.24; numeric-aware sort, newest last
  versions.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
  for (const v of versions.reverse()) {
    const dir = join(root, v);
    for (const sub of readdirSync(dir)) {
      const bin = join(dir, sub, "chrome-headless-shell");
      try {
        readdirSync(join(dir, sub));
        return bin;
      } catch {
        /* not the platform dir; keep looking */
      }
    }
  }
  throw new Error(
    `no chrome-headless-shell under ${root}; install one with: npx puppeteer browsers install chrome-headless-shell`,
  );
}

const scenarioPath = process.argv[2];
if (!scenarioPath) {
  console.error("usage: node scripts/cdp-driver.mjs <scenario.mjs> [w] [h]");
  process.exit(2);
}
const viewport = {
  width: Number(process.argv[3] || 760),
  height: Number(process.argv[4] || 520),
};

const outDir = join(tmpdir(), `ccup-cdp-${process.pid}`);
const profileDir = join(outDir, "profile");
mkdirSync(profileDir, { recursive: true });

const PORT = 9300 + (process.pid % 500);
const proc = spawn(
  findHeadlessShell(),
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    } catch {
      await sleep(100);
    }
  }
  throw new Error("devtools endpoint never came up");
}

let list = await targets();
let page = list.find((t) => t.type === "page");
if (!page) {
  await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, {
    method: "PUT",
  });
  list = await targets();
  page = list.find((t) => t.type === "page");
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve: res, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : res(msg.result);
  }
};
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, reject) => pending.set(id, { resolve: res, reject }));
}
async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

await cdp("Page.enable");
// --window-size is unreliable in headless shell; device metrics are exact
await cdp("Emulation.setDeviceMetricsOverride", {
  ...viewport,
  deviceScaleFactor: 2,
  mobile: false,
});

const ctx = {
  cdp,
  evaluate,
  sleep,
  viewport,
  outDir,
  dir: dirname(resolve(scenarioPath)),
  navigate: async (url) => {
    await cdp("Page.navigate", { url });
    await sleep(400);
  },
  insertText: (text) => cdp("Input.insertText", { text }),
  shot: async (name) => {
    const r = await cdp("Page.captureScreenshot", { format: "png" });
    const path = join(outDir, `${name}.png`);
    writeFileSync(path, Buffer.from(r.data, "base64"));
    console.log(`  shot: ${path}`);
  },
};

let failed = false;
try {
  const scenario = await import(pathToFileURL(resolve(scenarioPath)));
  failed = (await scenario.run(ctx)) === false;
} finally {
  ws.close();
  const gone = new Promise((r) => proc.on("exit", r));
  proc.kill();
  await gone;
  rmSync(profileDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
process.exit(failed ? 1 : 0);
