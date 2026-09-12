// Scenario for scripts/cdp-driver.mjs: verify the raw-markdown toggle's hover
// button and raw block against the LIVE bundle's own stylesheet: that the
// button paints only on an agent response (never on tool-result text or a
// thinking block), that it anchors to the response's top-right corner without
// drifting with the content, that the <div> host the patch wraps around the
// markdown root is layout-inert, and that the raw block inherits the chat's
// code font with none of a code block's chrome.
//
//   node scripts/cdp-driver.mjs scripts/repro/raw-markdown.mjs 900 700
//
// The CSS mirrors rawMdCssBuild in src/patcher.ts and the DOM mirrors the shape
// its four inline fragments produce; keep all of it in sync. The anchor checks
// parse the live bundle, so they double as a drift canary for the point. The
// live bundle is found under ~/.vscode/extensions (newest Claude Code install)
// or via $CCUP_BUNDLE (the webview directory).
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

// --- the point's anchors in webview/index.js (mirror of src/patcher.ts) -----
const HOOK_RE =
  /(\(\{content:([\w$]+),context:[\w$]+,isPartialText:([\w$]+)\}\)\{let [\w$]+=[^;]{0,600}?,\[[\w$]+,[\w$]+\]=([\w$]+)\(null\))(,)/;
const RET_RE =
  /(return )(([\w$]+)\("span",\{className:[\w$]+\.root,children:\[)(?=([\w$]+)\()/;
const TAIL_RE =
  /(,([\w$]+)&&([\w$]+)\([\w$]+,\{href:\2\.href,x:\2\.x,y:\2\.y,onClose:[\w$]+\}\)\]\}\))(\})/;
const TESTID_RE = /"data-testid":"assistant-message"/;

// --- CSS-module hashes the replica needs ------------------------------------
const MD_ROOT_RE = /\.root_([-\w]+) code\{font-family/; // stylesheet, not js
const TIMELINE_RE = /timelineMessage:"timelineMessage_([-\w]+)"/;
const MSGS_RE = /messagesContainer:"messagesContainer_([-\w]+)"/;
const TOOL_RESULT_RE = /toolResult:"toolResult_([-\w]+)"/;
const THINKING_RE = /thinkingContent:"thinkingContent_([-\w]+)"/;
// The native paragraph rule the spacing knob rewrites, whose `>:first-child`
// reset is the reason the button hangs off a host div instead of the root span.
const PARA_RE =
  /\.root_([-\w]+) p\{white-space:pre-wrap;margin-top:([\d.]+)em;margin-bottom:([\d.]+)em\}/;

const PARA_MULT = 3; // an off-native chatHistoryParagraphSpacing, for the reset check

function liveBundleDir() {
  if (process.env.CCUP_BUNDLE) return process.env.CCUP_BUNDLE;
  const root = join(homedir(), ".vscode", "extensions");
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("anthropic.claude-code-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!dirs.length) throw new Error(`no Claude Code install under ${root}`);
  return join(root, dirs[dirs.length - 1], "webview");
}

// rawMdCssBuild's output, minus the marker comment.
function rawMdCss() {
  const btn =
    "box-sizing:border-box;display:none;position:absolute;top:0;right:0;" +
    "align-items:center;justify-content:center;width:22px;height:22px;margin:0;padding:0;" +
    "border:1px solid var(--app-input-border);border-radius:5px;" +
    "background:var(--app-input-secondary-background);color:var(--app-secondary-foreground);" +
    "box-shadow:0 1px 3px #00000033;cursor:pointer;opacity:0;pointer-events:none;" +
    "transition:opacity .15s ease";
  return (
    ".ccup-rawmd-host{position:relative}" +
    '[data-testid="assistant-message"]>.ccup-rawmd-host{align-self:stretch}' +
    ".ccup-rawmd{margin:0;white-space:pre-wrap;overflow-wrap:break-word;tab-size:4}" +
    `.ccup-rawmd-btn{${btn}}` +
    '[data-testid="assistant-message"]>.ccup-rawmd-host>.ccup-rawmd-btn{display:flex}' +
    ".ccup-rawmd-host:hover>.ccup-rawmd-btn,.ccup-rawmd-btn:focus-visible," +
    ".ccup-rawmd-btn[aria-pressed=true]{opacity:1;pointer-events:auto}" +
    ".ccup-rawmd-btn:hover,.ccup-rawmd-btn[aria-pressed=true]" +
    "{color:var(--app-primary-foreground);border-color:var(--app-secondary-foreground)}" +
    ".ccup-rawmd-btn svg{display:block;width:14px;height:14px}"
  );
}

// The spacing knob's line at PARA_MULT, so the first-child reset is under test
// in the form that actually competes with it (both halves !important).
function paraCss(hash, top, bottom) {
  const m = PARA_MULT;
  return (
    `.root_${hash} p{margin-top:calc(${top}em * ${m}) !important;` +
    `margin-bottom:max(0em, calc(${bottom}em * ${m} + (${m} - 1) * (1lh - 1em))) !important}` +
    `.root_${hash}>:first-child{margin-top:0 !important}`
  );
}

const PROSE = [
  "<p>Here are the seven calls, each with the principle it rests on and why the read's own text forces it.</p>",
  "<p>Section names refer to <a href='#'>seam-protocol.md</a> throughout.</p>",
].join("");
const RAW = [
  "Here are the seven calls, each with the principle it rests on.",
  "",
  "1. **The regime is two directed matches, each read alone.**",
  "   - Principle: the Nutshell says a standing declaration",
  '     "is published by one principal alone".',
  "",
  "| column | meaning |",
  "| ------ | ------- |",
  "| `flow` | the pathway a declaration takes |",
].join("\n");

export async function run(ctx) {
  const dir = liveBundleDir();
  const js = readFileSync(join(dir, "index.js"), "utf8");
  const css = readFileSync(join(dir, "index.css"), "utf8");
  console.log(`live bundle: ${dir}`);

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };

  // --- live-bundle anchors -------------------------------------------------
  const hook = js.match(HOOK_RE);
  check("markdown component hook chain parses", Boolean(hook), hook?.[2]);
  check("root span return parses", RET_RE.test(js));
  check("link-context-menu tail parses", TAIL_RE.test(js));
  check("assistant-message testid present", TESTID_RE.test(js));

  const md = css.match(MD_ROOT_RE)?.[1];
  const msg = js.match(TIMELINE_RE)?.[1];
  const cont = js.match(MSGS_RE)?.[1];
  const tool = js.match(TOOL_RESULT_RE)?.[1];
  const think = js.match(THINKING_RE)?.[1];
  const para = css.match(PARA_RE);
  if (
    !check(
      "css-module hashes parse",
      Boolean(md && msg && cont && tool && think && para),
      `md=${md} msg=${msg} tool=${tool} thinking=${think}`,
    )
  ) {
    return false;
  }
  check(
    "markdown root is an inline span natively",
    !/display:/.test(
      (css.match(new RegExp(`\\.root_${md}\\{([^}]*)\\}`)) ?? ["", ""])[1],
    ),
  );

  // --- serve the live stylesheet plus the point's own line ----------------
  const sheet = `${css}\n${rawMdCss()}`;
  const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/index.css">
<style>
:root{--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;
--vscode-sideBar-background:#181818;--vscode-editor-background:#1f1f1f;
--vscode-menu-background:#1f1f1f;--vscode-input-border:#3c3c3c;
--vscode-editor-font-family:"SF Mono",monospace;--vscode-editor-font-size:12px;
--vscode-textCodeBlock-background:#7f7f7f26;--vscode-inputOption-activeBorder:#2488db;
--vscode-sideBarActivityBarTop-border:#2b2b2b;--vscode-chat-font-size:13px;
--vscode-font-family:system-ui;color-scheme:dark}
body{margin:0;padding:12px;width:420px;background:var(--vscode-sideBar-background);
color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px;line-height:1.5}
</style></head><body class="vscode-dark"><div id="host"></div></body></html>`;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/index.css")) {
      res.writeHead(200, { "content-type": "text/css" }).end(sheet);
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(page);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    await ctx.navigate(`http://127.0.0.1:${port}/`);
    // One .message_ per case. `native` is the shape the bundle renders on its
    // own; `patched` is the same content behind the host div; `counter` puts the
    // button inside the root span instead, which is what the host div exists to
    // avoid.
    const built = await ctx.evaluate(`(() => {
      const md = ${JSON.stringify(md)}, msg = ${JSON.stringify(msg)};
      const cont = ${JSON.stringify(cont)}, tool = ${JSON.stringify(tool)};
      const think = ${JSON.stringify(think)};
      const prose = ${JSON.stringify(PROSE)}, raw = ${JSON.stringify(RAW)};
      const btn = (pressed) =>
        '<button type="button" class="ccup-rawmd-btn"' +
        (pressed ? ' aria-pressed="true"' : ' aria-pressed="false"') +
        '><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"></svg></button>';
      const root = (inner) => '<span class="root_' + md + '">' + inner + '</span>';
      const turn = (id, inner) =>
        '<div class="message_' + msg + ' timelineMessage_' + msg +
        '" data-testid="assistant-message" data-transcript-message="" id="' + id + '">' +
        inner + '</div>';
      const host = (inner, pressed) =>
        '<div class="ccup-rawmd-host">' + inner + btn(pressed) + '</div>';
      document.getElementById('host').innerHTML =
        '<div class="messagesContainer_' + cont + '">' +
        turn('native', root(prose)) +
        turn('patched', host(root(prose), false)) +
        turn('rawon', host(root('<pre class="ccup-rawmd"><code>' +
          raw.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</code></pre>'), true)) +
        turn('nested', '<div class="toolResult_' + tool + '">' +
          host(root('<p>Tool result text, same component, deeper in the tree.</p>'), false) +
          '</div>') +
        turn('thinking', '<div class="thinkingContent_' + think + '">' +
          host(root('<p>A thinking block, same component.</p>'), false) + '</div>') +
        turn('counter', '<span class="root_' + md + '">' + btn(false) + prose + '</span>') +
        '</div>';
      return true;
    })()`);
    check("replica built", built === true);

    // Mount the spacing knob's line last, so it competes with the stock reset
    // exactly as it does on a patched install.
    await ctx.evaluate(`(() => {
      const s = document.createElement('style');
      s.textContent = ${JSON.stringify(paraCss(md, para[2], para[3]))};
      document.head.appendChild(s);
      return true;
    })()`);

    const probe = async () =>
      ctx.evaluate(`(() => {
        const num = (v) => +parseFloat(v).toFixed(2);
        const box = (el) => { const r = el.getBoundingClientRect();
          return { x: num(r.left), y: num(r.top), w: num(r.width), h: num(r.height),
                   right: num(r.right), bottom: num(r.bottom) }; };
        const pad = (el) => num(getComputedStyle(el).paddingTop);
        const read = (id) => {
          const turn = document.getElementById(id);
          const b = turn.querySelector('.ccup-rawmd-btn');
          const s = getComputedStyle(b);
          const hostEl = turn.querySelector('.ccup-rawmd-host');
          const p = turn.querySelector('p');
          const code = turn.querySelector('pre.ccup-rawmd code');
          const pre = turn.querySelector('pre.ccup-rawmd');
          const q = box(b);
          return {
            display: s.display, opacity: num(s.opacity), pe: s.pointerEvents,
            btn: q, turn: box(turn), turnPad: pad(turn),
            host: hostEl ? box(hostEl) : null,
            para: p ? { box: box(p), marginTop: getComputedStyle(p).marginTop } : null,
            hit: (() => { const el = document.elementFromPoint(q.x + q.w/2, q.y + q.h/2);
              if (!el) return null;
              if (el.closest && el.closest('.ccup-rawmd-btn')) return 'ccup-rawmd-btn';
              return typeof el.className === 'string' && el.className ? el.className : el.tagName; })(),
            code: code ? { family: getComputedStyle(code).fontFamily,
              size: getComputedStyle(code).fontSize,
              bg: getComputedStyle(code).backgroundColor,
              pad: getComputedStyle(code).padding } : null,
            pre: pre ? { ws: getComputedStyle(pre).whiteSpace,
              scrollW: pre.scrollWidth, clientW: pre.clientWidth } : null,
          };
        };
        const ids = ['native','patched','rawon','nested','thinking','counter'];
        const out = {};
        for (const id of ids) { try { out[id] = read(id); } catch (e) { out[id] = String(e); } }
        out.native = (() => { const t = document.getElementById('native');
          const p = t.querySelector('p');
          return { turn: box(t), turnPad: pad(t),
                   para: { box: box(p), marginTop: getComputedStyle(p).marginTop },
                   rootW: num(t.querySelector('span').getBoundingClientRect().width) }; })();
        return out;
      })()`);

    let r = await probe();
    // --- scope: only a response's own text block gets a button -------------
    check(
      "response button is laid out",
      r.patched.display === "flex",
      r.patched.display,
    );
    check(
      "tool-result text gets no button",
      r.nested.display === "none",
      r.nested.display,
    );
    check(
      "thinking block gets no button",
      r.thinking.display === "none",
      r.thinking.display,
    );
    check(
      "button is invisible at rest",
      r.patched.opacity === 0 && r.patched.pe === "none",
      `opacity=${r.patched.opacity} pointer-events=${r.patched.pe}`,
    );
    check(
      "nothing under the resting button intercepts the pointer",
      r.patched.hit !== "ccup-rawmd-btn",
      r.patched.hit,
    );

    // --- geometry ----------------------------------------------------------
    check(
      "host stretches to the response's full width",
      Math.abs(r.patched.host.w - r.native.rootW) < 1.5 ||
        r.patched.host.w >= r.native.rootW,
      `host=${r.patched.host.w} native root=${r.native.rootW}`,
    );
    check(
      "button sits at the host's top-right corner",
      Math.abs(r.patched.btn.right - r.patched.host.right) < 0.6 &&
        Math.abs(r.patched.btn.y - r.patched.host.y) < 0.6,
      `btn right=${r.patched.btn.right}/${r.patched.host.right} top=${r.patched.btn.y}/${r.patched.host.y}`,
    );
    check(
      "button stays inside the turn box",
      r.patched.btn.right <= r.patched.turn.right + 0.5 &&
        r.patched.btn.y >= r.patched.turn.y - 0.5,
      `btn=${JSON.stringify(r.patched.btn)} turn=${JSON.stringify(r.patched.turn)}`,
    );

    // --- the host div is layout-inert --------------------------------------
    // Against each turn's CONTENT box: only the first .message_ in a container
    // zeroes --message-padding-top, and the replica stacks several turns.
    const inTurn = (m) => ({
      x: m.para.box.x - m.turn.x,
      y: m.para.box.y - m.turn.y - m.turnPad,
    });
    const dx = inTurn(r.patched).x - inTurn(r.native).x;
    const dy = inTurn(r.patched).y - inTurn(r.native).y;
    check(
      "first paragraph keeps its native offset in the turn",
      Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6,
      `dx=${dx} dy=${dy}`,
    );
    check(
      "first paragraph keeps its native box",
      Math.abs(r.patched.para.box.w - r.native.para.box.w) < 0.6 &&
        Math.abs(r.patched.para.box.h - r.native.para.box.h) < 0.6,
      `w ${r.patched.para.box.w}/${r.native.para.box.w} h ${r.patched.para.box.h}/${r.native.para.box.h}`,
    );
    check(
      "first-child margin reset still reaches the paragraph",
      r.patched.para.marginTop === "0px" && r.native.para.marginTop === "0px",
      `patched=${r.patched.para.marginTop} native=${r.native.para.marginTop}`,
    );
    // Why the host exists: inside the root span the button would take the
    // :first-child reset for itself and the paragraph would gain the scaled
    // margin back (3x the native .1em here).
    check(
      "a button inside the root span would break that reset",
      r.counter.para.marginTop !== "0px",
      `counter=${r.counter.para.marginTop}`,
    );

    // --- hover -------------------------------------------------------------
    const c = { x: r.patched.host.x + 40, y: r.patched.host.y + 8 };
    await ctx.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: c.x,
      y: c.y,
      buttons: 0,
    });
    await ctx.sleep(250);
    r = await probe();
    check(
      "hovering the response lights the button",
      r.patched.opacity === 1 && r.patched.pe === "auto",
      `opacity=${r.patched.opacity} pointer-events=${r.patched.pe}`,
    );
    check(
      "the lit button is clickable",
      r.patched.hit === "ccup-rawmd-btn",
      r.patched.hit,
    );
    check(
      "hovering one response leaves the others dark",
      r.nested.opacity === 0 || r.nested.display === "none",
      `nested opacity=${r.nested.opacity}`,
    );
    await ctx.shot("hover");

    // --- raw mode ----------------------------------------------------------
    await ctx.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 5,
      y: 5,
      buttons: 0,
    });
    await ctx.sleep(250);
    r = await probe();
    check(
      "a response in raw mode keeps its button lit unhovered",
      r.rawon.opacity === 1,
      `opacity=${r.rawon.opacity}`,
    );
    check(
      "raw block is monospace",
      /mono|SF Mono/i.test(r.rawon.code.family),
      r.rawon.code.family,
    );
    check(
      "raw block carries no code-block chrome",
      r.rawon.code.bg === "rgba(0, 0, 0, 0)" && r.rawon.code.pad === "0px",
      `bg=${r.rawon.code.bg} padding=${r.rawon.code.pad}`,
    );
    check(
      "raw block preserves whitespace and wraps",
      r.rawon.pre.ws === "pre-wrap" &&
        r.rawon.pre.scrollW <= r.rawon.pre.clientW + 1,
      `white-space=${r.rawon.pre.ws} scrollW=${r.rawon.pre.scrollW} clientW=${r.rawon.pre.clientW}`,
    );
    check(
      "raw block follows the chat's code size",
      r.rawon.code.size !== "0px" && parseFloat(r.rawon.code.size) > 6,
      r.rawon.code.size,
    );
    await ctx.shot("raw");

    console.log(ok ? "\nall green" : "\nFAILURES above");
    return ok;
  } finally {
    server.close();
  }
}
