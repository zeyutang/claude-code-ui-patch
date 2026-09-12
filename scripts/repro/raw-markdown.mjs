// Scenario for scripts/cdp-driver.mjs: verify the raw-markdown toggle's hover
// button and raw block against the LIVE bundle's own stylesheet: that the
// button paints only on an agent response (never on tool-result text or a
// thinking block), that the <div> host the patch wraps around the markdown root
// and the rail it hangs off are both layout-inert, that the button pins under
// the turn header stuck to the top of the chat once its response scrolls past,
// and that the raw block inherits the chat's code font with none of a code
// block's chrome.
//
//   node scripts/cdp-driver.mjs scripts/repro/raw-markdown.mjs 900 700
//
// The CSS mirrors rawMdCssBuild in src/patcher.ts, the DOM mirrors the shape
// its four inline fragments produce, and measureTurns mirrors what the rail's
// ref callback publishes; keep all of it in sync. The anchor checks parse the
// live bundle, so they double as a drift canary for the point. The live bundle
// is found under ~/.vscode/extensions (newest Claude Code install) or via
// $CCUP_BUNDLE (the webview directory).
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
// The live install may already have the point applied, and three of those
// anchors sit exactly where the fragments land. The patcher matches them on a
// stripped bundle, so strip the same way before testing them here.
const FRAG_RE =
  /\/\*ccup:rawMd(?:Hook|WrapA|Pre|WrapB)\*\/[\s\S]*?\/\*ccup:rawMdEnd\*\//g;

// --- CSS-module hashes the replica needs ------------------------------------
const MD_ROOT_RE = /\.root_([-\w]+) code\{font-family/; // stylesheet, not js
const TIMELINE_RE = /timelineMessage:"timelineMessage_([-\w]+)"/;
const MSGS_RE = /messagesContainer:"messagesContainer_([-\w]+)"/;
const STICKY_MODE_RE = /stickyMode:"stickyMode_([-\w]+)"/;
const TOOL_RESULT_RE = /toolResult:"toolResult_([-\w]+)"/;
const THINKING_RE = /thinkingContent:"thinkingContent_([-\w]+)"/;
// The two the rail's ref callback walks to find the header it measures; both
// are anchors of the point, so a rename has to show up here as well.
const TURN_RE = /turn:"turn_([-\w]+)"/;
const STICKY_RE = /stickyHeader:"stickyHeader_([-\w]+)"/;
const USER_MSG_RE = /userMessage:"userMessage_([-\w]+)"/;
const USER_CONT_RE = /userMessageContainer:"userMessageContainer_([-\w]+)"/;
// The native paragraph rule the spacing knob rewrites, whose `>:first-child`
// reset is the reason the button hangs off a host div instead of the root span.
const PARA_RE =
  /\.root_([-\w]+) p\{white-space:pre-wrap;margin-top:([\d.]+)em;margin-bottom:([\d.]+)em\}/;

const PARA_MULT = 3; // an off-native chatHistoryParagraphSpacing, for the reset check
const GAP = 6; // rawMdCssBuild's RAWMD_GAP
const SIZE = 26; // rawMdCssBuild's RAWMD_BTN_SIZE

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
  const rail =
    "display:none;position:absolute;top:0;right:0;bottom:0;" +
    `width:${SIZE}px;pointer-events:none`;
  const btn =
    "box-sizing:border-box;display:flex;position:sticky;" +
    `top:calc(var(--ccup-rawmd-top,0px) + ${GAP}px);` +
    "align-items:center;justify-content:center;" +
    `width:${SIZE}px;height:${SIZE}px;margin:0;padding:0;` +
    "border:1px solid var(--app-input-border);border-radius:5px;" +
    "background:var(--app-input-secondary-background);color:var(--app-secondary-foreground);" +
    "box-shadow:0 1px 3px #00000033;cursor:pointer;opacity:0;pointer-events:none;" +
    "transition:opacity .15s ease;z-index:2";
  return (
    ".ccup-rawmd-host{position:relative}" +
    '[data-testid="assistant-message"]>.ccup-rawmd-host{align-self:stretch}' +
    ".ccup-rawmd{margin:0;white-space:pre-wrap;overflow-wrap:break-word;tab-size:4}" +
    `.ccup-rawmd-rail{${rail}}` +
    '[data-testid="assistant-message"]>.ccup-rawmd-host>.ccup-rawmd-rail{display:block}' +
    `.ccup-rawmd-btn{${btn}}` +
    ".ccup-rawmd-host:hover .ccup-rawmd-btn,.ccup-rawmd-btn:focus-visible," +
    ".ccup-rawmd-btn[aria-pressed=true]{opacity:1;pointer-events:auto}" +
    ".ccup-rawmd-btn:hover,.ccup-rawmd-btn[aria-pressed=true]" +
    "{color:var(--app-primary-foreground);border-color:var(--app-secondary-foreground)}" +
    ".ccup-rawmd-btn svg{display:block;width:16px;height:16px}"
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
// A response tall enough to scroll through, so the pinned button has somewhere
// to ride: its top-right corner leaves the view long before its bottom does.
const LONG = Array.from(
  { length: 14 },
  (_, i) =>
    `<p>Paragraph ${i + 1} of a response long enough that its own top scrolls ` +
    `out of view while the rest of it is still being read, which is the whole ` +
    `case the pinned button exists for.</p>`,
).join("");
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
  const raw = readFileSync(join(dir, "index.js"), "utf8");
  const js = raw.replace(FRAG_RE, "");
  const css = readFileSync(join(dir, "index.css"), "utf8");
  console.log(
    `live bundle: ${dir}${raw === js ? "" : " (rawMd applied; anchors read stripped)"}`,
  );

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
  const mode = js.match(STICKY_MODE_RE)?.[1];
  const tool = js.match(TOOL_RESULT_RE)?.[1];
  const think = js.match(THINKING_RE)?.[1];
  const turn = js.match(TURN_RE)?.[1];
  const sticky = js.match(STICKY_RE)?.[1];
  const uMsg = js.match(USER_MSG_RE)?.[1];
  const uCont = js.match(USER_CONT_RE)?.[1];
  const para = css.match(PARA_RE);
  if (
    !check(
      "css-module hashes parse",
      Boolean(
        md &&
        msg &&
        cont &&
        mode &&
        tool &&
        think &&
        turn &&
        sticky &&
        uMsg &&
        uCont &&
        para,
      ),
      `md=${md} msg=${msg} turn=${turn} sticky=${sticky} tool=${tool} thinking=${think}`,
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
  check(
    "turn headers are what pins to the top of the chat",
    /position:sticky/.test(
      (css.match(new RegExp(`\\.stickyHeader_${sticky}\\{([^}]*)\\}`)) ?? [
        "",
        "",
      ])[1],
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
body{margin:0;padding:0;background:var(--vscode-sideBar-background);
color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px;line-height:1.5}
/* The panel's own frame: the chat is a flex column, the messages its scroller.
   The width belongs here, not on body: the live sheet gives body flex:1, whose
   flex-basis beats any width of ours. */
#host{display:flex;flex-direction:column;flex:none;width:420px;height:520px}
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
    // Three turns in a real scroller. Turn one holds one .message_ per case:
    // `native` is the shape the bundle renders on its own; `patched` is the
    // same content behind the host div; `counter` puts the button inside the
    // root span instead, which is what the host div exists to avoid. Turn two
    // is the pinning case (a two-line header, a response taller than the
    // scrollport), turn three only gives turn two something to scroll past.
    const built = await ctx.evaluate(`(() => {
      const md = ${JSON.stringify(md)}, msg = ${JSON.stringify(msg)};
      const cont = ${JSON.stringify(cont)}, mode = ${JSON.stringify(mode)};
      const tool = ${JSON.stringify(tool)}, think = ${JSON.stringify(think)};
      const turn = ${JSON.stringify(turn)}, sticky = ${JSON.stringify(sticky)};
      const uMsg = ${JSON.stringify(uMsg)}, uCont = ${JSON.stringify(uCont)};
      const prose = ${JSON.stringify(PROSE)}, long = ${JSON.stringify(LONG)};
      const raw = ${JSON.stringify(RAW)};
      const btn = (pressed) =>
        '<button type="button" class="ccup-rawmd-btn"' +
        (pressed ? ' aria-pressed="true"' : ' aria-pressed="false"') +
        '><svg viewBox="0 0 16 16" fill="none" stroke="currentColor"></svg></button>';
      const root = (inner) => '<span class="root_' + md + '">' + inner + '</span>';
      const resp = (id, inner) =>
        '<div class="message_' + msg + ' timelineMessage_' + msg +
        '" data-testid="assistant-message" data-transcript-message="" id="' + id + '">' +
        inner + '</div>';
      const host = (inner, pressed) =>
        '<div class="ccup-rawmd-host">' + inner +
        '<div class="ccup-rawmd-rail">' + btn(pressed) + '</div></div>';
      const header = (id, text) =>
        '<div class="message_' + msg + ' ' + uCont + ' stickyHeader_' + sticky +
        '" id="' + id + '"><div class="userMessage_' + uMsg + '">' + text + '</div></div>';
      const asTurn = (id, inner) =>
        '<div class="turn_' + turn + '" id="' + id + '">' + inner + '</div>';
      document.getElementById('host').innerHTML =
        '<div class="messagesContainer_' + cont + ' stickyMode_' + mode + '" id="scroller">' +
        asTurn('turn-cases',
          header('head-cases', 'One line of prompt.') +
          resp('native', root(prose)) +
          resp('patched', host(root(prose), false)) +
          resp('rawon', host(root('<pre class="ccup-rawmd"><code>' +
            raw.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</code></pre>'), true)) +
          resp('nested', '<div class="toolResult_' + tool + '">' +
            host(root('<p>Tool result text, same component, deeper in the tree.</p>'), false) +
            '</div>') +
          resp('thinking', '<div class="thinkingContent_' + think + '">' +
            host(root('<p>A thinking block, same component.</p>'), false) + '</div>') +
          resp('counter', '<span class="root_' + md + '">' + btn(false) + prose + '</span>')) +
        asTurn('turn-long',
          header('head-long', 'A prompt long enough to wrap onto several lines, ' +
            'so that the header it pins is plainly taller than a one-liner and ' +
            'no hardcoded offset could have stood in for measuring it.') +
          resp('long', host(root(long), false))) +
        asTurn('turn-tail',
          header('head-tail', 'A later prompt.') +
          resp('tail', host(root(long), false))) +
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

    // Mirror of the rail's ref callback: each turn publishes its own header's
    // border-box height, which the rails inside inherit as their pinned offset.
    const measureTurns = () =>
      ctx.evaluate(`(() => {
        const out = {};
        for (const t of document.querySelectorAll('.turn_${turn}')) {
          const h = t.querySelector('.stickyHeader_${sticky}');
          if (!h) continue;
          const v = h.getBoundingClientRect().height;
          t.style.setProperty('--ccup-rawmd-top', v + 'px');
          out[t.id] = +v.toFixed(2);
        }
        return out;
      })()`);
    const heads = await measureTurns();
    check(
      "each turn publishes its own header height",
      heads["turn-cases"] > 20 && heads["turn-long"] > heads["turn-cases"],
      `cases=${heads["turn-cases"]} long=${heads["turn-long"]}`,
    );

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
          const railEl = turn.querySelector('.ccup-rawmd-rail');
          const p = turn.querySelector('p');
          const code = turn.querySelector('pre.ccup-rawmd code');
          const pre = turn.querySelector('pre.ccup-rawmd');
          const q = box(b);
          return {
            display: s.display, opacity: num(s.opacity), pe: s.pointerEvents,
            position: s.position, top: s.top, zIndex: s.zIndex,
            btn: q, turn: box(turn), turnPad: pad(turn),
            host: hostEl ? box(hostEl) : null,
            rail: railEl ? box(railEl) : null,
            railDisplay: railEl ? getComputedStyle(railEl).display : null,
            railPe: railEl ? getComputedStyle(railEl).pointerEvents : null,
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
        const ids = ['native','patched','rawon','nested','thinking','counter','long','tail'];
        const out = {};
        for (const id of ids) { try { out[id] = read(id); } catch (e) { out[id] = String(e); } }
        out.native = (() => { const t = document.getElementById('native');
          const p = t.querySelector('p');
          return { turn: box(t), turnPad: pad(t),
                   para: { box: box(p), marginTop: getComputedStyle(p).marginTop },
                   rootW: num(t.querySelector('span').getBoundingClientRect().width) }; })();
        const sc = document.getElementById('scroller');
        out.scroller = { ...box(sc), scrollTop: num(sc.scrollTop),
                         scrollH: sc.scrollHeight, clientH: sc.clientHeight };
        out.headLong = box(document.getElementById('head-long'));
        return out;
      })()`);

    let r = await probe();
    // --- scope: only a response's own text block gets a rail --------------
    check(
      "response rail is laid out",
      r.patched.railDisplay === "block",
      r.patched.railDisplay,
    );
    check(
      "tool-result text gets no rail",
      r.nested.railDisplay === "none",
      r.nested.railDisplay,
    );
    check(
      "thinking block gets no rail",
      r.thinking.railDisplay === "none",
      r.thinking.railDisplay,
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
    check(
      "the rail itself never takes the pointer",
      r.patched.railPe === "none",
      r.patched.railPe,
    );

    // --- geometry ----------------------------------------------------------
    check(
      "host stretches to the response's full width",
      Math.abs(r.patched.host.w - r.native.rootW) < 1.5 ||
        r.patched.host.w >= r.native.rootW,
      `host=${r.patched.host.w} native root=${r.native.rootW}`,
    );
    check(
      "rail hangs down the host's right edge",
      Math.abs(r.patched.rail.right - r.patched.host.right) < 0.6 &&
        Math.abs(r.patched.rail.h - r.patched.host.h) < 0.6 &&
        r.patched.rail.w === SIZE,
      `rail=${JSON.stringify(r.patched.rail)} host h=${r.patched.host.h}`,
    );
    check(
      "button matches the jump pair's square",
      r.patched.btn.w === SIZE && r.patched.btn.h === SIZE,
      `${r.patched.btn.w}x${r.patched.btn.h}`,
    );
    check(
      "button sits at the host's top-right corner while that corner is in view",
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
    check(
      "button is pinned in the header's own paint layer",
      r.patched.position === "sticky" && r.patched.zIndex === "2",
      `position=${r.patched.position} z-index=${r.patched.zIndex}`,
    );

    // --- the host div and the rail are layout-inert ------------------------
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
      r.nested.opacity === 0 || r.nested.railDisplay === "none",
      `nested opacity=${r.nested.opacity}`,
    );
    await ctx.shot("hover");

    // --- pinning: scroll into the long response ---------------------------
    // Deep enough that the long block's own top-right corner is well above the
    // scrollport, with its bottom still far below it.
    const midway = await ctx.evaluate(`(() => {
      const sc = document.getElementById('scroller');
      const host = document.querySelector('#long .ccup-rawmd-host');
      sc.scrollTop += host.getBoundingClientRect().top - sc.getBoundingClientRect().top + 200;
      return +sc.scrollTop.toFixed(2);
    })()`);
    // Keep the pointer inside the long response so the button stays lit.
    r = await probe();
    await ctx.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: r.long.host.x + 40,
      y: r.scroller.y + r.scroller.clientH / 2,
      buttons: 0,
    });
    await ctx.sleep(250);
    r = await probe();
    const wantTop = r.scroller.y + heads["turn-long"] + GAP;
    check(
      "the long response's own top is above the scrollport",
      r.long.host.y < r.scroller.y - 100,
      `host top=${r.long.host.y} scrollport top=${r.scroller.y} scrollTop=${midway}`,
    );
    check(
      "button pins under the header stuck to the top of the chat",
      Math.abs(r.long.btn.y - wantTop) < 1,
      `btn top=${r.long.btn.y} want=${wantTop} (header=${heads["turn-long"]} + gap=${GAP})`,
    );
    check(
      "the gap is measured off the pinned header, not guessed",
      Math.abs(r.long.btn.y - r.headLong.bottom - GAP) < 1,
      `btn top=${r.long.btn.y} header bottom=${r.headLong.bottom}`,
    );
    check(
      "the pinned button keeps the response's right edge",
      Math.abs(r.long.btn.right - r.long.host.right) < 0.6,
      `btn right=${r.long.btn.right} host right=${r.long.host.right}`,
    );
    check(
      "the pinned button is on top, not behind the header",
      r.long.hit === "ccup-rawmd-btn",
      r.long.hit,
    );
    check(
      "earlier responses' buttons stay with their own blocks",
      r.patched.btn.bottom < r.scroller.y + 1,
      `patched btn bottom=${r.patched.btn.bottom} scrollport top=${r.scroller.y}`,
    );
    await ctx.shot("pinned");

    // Past the end of the long response: the button rode to the block's bottom
    // and left with it.
    await ctx.evaluate(`(() => {
      const sc = document.getElementById('scroller');
      const host = document.querySelector('#long .ccup-rawmd-host');
      sc.scrollTop += host.getBoundingClientRect().bottom - sc.getBoundingClientRect().top + 40;
      return true;
    })()`);
    await ctx.sleep(120);
    r = await probe();
    check(
      "the button leaves with its own block",
      r.long.btn.bottom <= r.scroller.y + 1,
      `btn bottom=${r.long.btn.bottom} scrollport top=${r.scroller.y}`,
    );
    check(
      "the next turn's own button pins under its own header",
      r.tail.btn.y >= r.scroller.y - 0.5,
      `tail btn top=${r.tail.btn.y} scrollport top=${r.scroller.y}`,
    );

    // --- raw mode ----------------------------------------------------------
    await ctx.evaluate(
      `(() => { document.getElementById('scroller').scrollTop = 0; return true })()`,
    );
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
