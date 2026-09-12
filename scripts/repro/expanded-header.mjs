// Scenario for scripts/cdp-driver.mjs: the always-on expandedHeader fix. Every
// user message is the sticky header of its turn, clamped at 250px behind "Show
// more"; expanding one changes nothing about the pinning, so a prompt taller
// than the chat pins over the whole scrollport and the response scrolls by
// hidden beneath it. This first reproduces that with the LIVE stylesheet's own
// rules, then adds the fix's line and checks that the expanded header scrolls
// away like content while a collapsed one still pins.
//
//   node scripts/cdp-driver.mjs scripts/repro/expanded-header.mjs 900 700
//
// The regexes and the line mirror expandedHeaderBuild in src/patcher.ts (keep
// in sync); they parse the live stylesheet, so they double as a drift canary.
// The live stylesheet is found under ~/.vscode/extensions (newest Claude Code
// install) or via $CCUP_BUNDLE (the webview directory).
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

// --- the point's anchors in webview/index.css (mirror of src/patcher.ts) ----
const STICKY_HEADER_RULE_RE =
  /\.message_([-\w]+)\.stickyHeader_([-\w]+)\{[^{}]*?position:sticky[^{}]*?\}/;
const COLLAPSE_BUTTON_RULE_RE = /\.collapseButton_([-\w]+)\{/;
// The fix's own line may already be in the live sheet; strip it so the native
// pass below is native.
const FIX_LINE_RE = /\n?\/\*cc-ui-patch:expandedHeader\*\/[^\n]*/g;

// --- CSS-module hashes the replica needs ------------------------------------
const MSGS_RE = /messagesContainer:"messagesContainer_([-\w]+)"/;
const STICKY_MODE_RE = /stickyMode:"stickyMode_([-\w]+)"/;
const TURN_RE = /turn:"turn_([-\w]+)"/;
const TIMELINE_RE = /timelineMessage:"timelineMessage_([-\w]+)"/;
const USER_MSG_RE = /userMessage:"userMessage_([-\w]+)"/;
const USER_CONT_RE = /userMessageContainer:"userMessageContainer_([-\w]+)"/;
const EXPANDABLE_RE =
  /expandableContainer:"expandableContainer_([-\w]+)",content:"content_\1",collapsed:"collapsed_\1"/;

function liveBundleDir() {
  if (process.env.CCUP_BUNDLE) return process.env.CCUP_BUNDLE;
  const root = join(homedir(), ".vscode", "extensions");
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("anthropic.claude-code-"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!dirs.length) throw new Error(`no Claude Code install under ${root}`);
  return join(root, dirs[dirs.length - 1], "webview");
}

// expandedHeaderBuild's line, minus the marker comment.
function fixCss(msg, sticky, collapse) {
  return `.message_${msg}.stickyHeader_${sticky}:has(.collapseButton_${collapse}){position:relative}`;
}

const LONG_PROMPT = Array.from(
  { length: 40 },
  (_, i) =>
    `Line ${i + 1} of a prompt long enough that, opened with "Show more", the header ` +
    `it pins is taller than the chat itself.`,
).join("\n");
// Longer than the expanded header, so the turn is still running (the header
// still pinned, not yet pushed up by the turn's end) at the probe depth.
const RESPONSE = Array.from(
  { length: 80 },
  (_, i) =>
    `<p id="resp-${i + 1}">Paragraph ${i + 1} of the response to that prompt.</p>`,
).join("");

export async function run(ctx) {
  const dir = liveBundleDir();
  const js = readFileSync(join(dir, "index.js"), "utf8");
  const rawCss = readFileSync(join(dir, "index.css"), "utf8");
  const css = rawCss.replace(FIX_LINE_RE, "");
  console.log(
    `live bundle: ${dir}${rawCss === css ? "" : " (fix applied; stripped for the native pass)"}`,
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
  const stickyRule = css.match(STICKY_HEADER_RULE_RE);
  const collapse = css.match(COLLAPSE_BUTTON_RULE_RE)?.[1];
  check(
    "sticky header rule parses",
    Boolean(stickyRule),
    stickyRule?.[0].slice(0, 60),
  );
  check("collapse button rule parses", Boolean(collapse), collapse);
  const cont = js.match(MSGS_RE)?.[1];
  const mode = js.match(STICKY_MODE_RE)?.[1];
  const turn = js.match(TURN_RE)?.[1];
  const msg = js.match(TIMELINE_RE)?.[1];
  const uMsg = js.match(USER_MSG_RE)?.[1];
  const uCont = js.match(USER_CONT_RE)?.[1];
  const exp = js.match(EXPANDABLE_RE)?.[1];
  if (
    !check(
      "css-module hashes parse",
      Boolean(
        stickyRule &&
        collapse &&
        cont &&
        mode &&
        turn &&
        msg &&
        uMsg &&
        uCont &&
        exp,
      ),
      `cont=${cont} turn=${turn} exp=${exp}`,
    )
  ) {
    return false;
  }
  check(
    "the collapse button lives in the expandable's own module",
    exp === collapse,
    `expandable=${exp} button=${collapse}`,
  );

  // --- serve the live stylesheet, the fix's line switchable at runtime -----
  const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/index.css">
<style>
:root{--vscode-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;
--vscode-sideBar-background:#181818;--vscode-editor-background:#1f1f1f;
--vscode-menu-background:#1f1f1f;--vscode-menu-foreground:#cccccc;--vscode-input-border:#3c3c3c;
--vscode-input-background:#262626;--vscode-editor-font-family:"SF Mono",monospace;
--vscode-editor-font-size:12px;--vscode-chat-font-size:13px;--vscode-font-family:system-ui;
color-scheme:dark}
body{margin:0;padding:0;background:var(--vscode-sideBar-background);
color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px;line-height:1.5}
/* The panel's own frame (width on the host: the live sheet gives body flex:1). */
#host{display:flex;flex-direction:column;flex:none;width:420px;height:520px}
</style></head><body class="vscode-dark"><div id="host"></div>
<style id="fix"></style></body></html>`;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/index.css")) {
      res.writeHead(200, { "content-type": "text/css" }).end(css);
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(page);
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  try {
    await ctx.navigate(`http://127.0.0.1:${port}/`);
    // Two turns. Turn one's header is the expandable in its EXPANDED state
    // (no collapsed class, no max-height, the "Show less" button rendered),
    // holding a prompt far taller than the 520px chat; turn two's header is
    // the same prompt COLLAPSED (250px clamp, "Show more"), the shape that
    // must keep pinning.
    const built = await ctx.evaluate(`(() => {
      const cont = ${JSON.stringify(cont)}, mode = ${JSON.stringify(mode)};
      const turn = ${JSON.stringify(turn)}, msg = ${JSON.stringify(msg)};
      const uMsg = ${JSON.stringify(uMsg)}, uCont = ${JSON.stringify(uCont)};
      const exp = ${JSON.stringify(exp)};
      const prompt = ${JSON.stringify(LONG_PROMPT)}, response = ${JSON.stringify(RESPONSE)};
      const esc = (t) => t.replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const expandable = (open) =>
        '<div class="expandableContainer_' + exp + '">' +
          '<div class="contentWrapper_' + exp + '">' +
            '<div class="content_' + exp + (open ? '' : ' collapsed_' + exp) + '"' +
              (open ? '' : ' style="max-height:250px"') + '>' +
              '<span dir="auto">' + esc(prompt) + '</span>' +
              (open ? '' : '<div class="truncationGradient_' + exp + '"></div>') +
            '</div>' +
            (open ? '' : '<div class="buttonContainer_' + exp + '"><button type="button" class="expandButton_' + exp + '">Show more</button></div>') +
          '</div>' +
          (open ? '<div class="buttonContainer_' + exp + '"><button type="button" class="collapseButton_' + exp + '">Show less</button></div>' : '') +
        '</div>';
      const header = (id, open) =>
        '<div class="message_' + msg + ' ' + uCont + ' stickyHeader_' + msg +
        '" id="' + id + '"><div class="userMessage_' + uMsg + '">' + expandable(open) + '</div></div>';
      const resp = (id) =>
        '<div class="message_' + msg + ' timelineMessage_' + msg +
        '" data-testid="assistant-message" id="' + id + '">' + response.replace(/resp-/g, id + '-') + '</div>';
      document.getElementById('host').innerHTML =
        '<div class="messagesContainer_' + cont + ' stickyMode_' + mode + '" id="scroller">' +
        '<div class="turn_' + turn + '">' + header('head-open', true) + resp('open') + '</div>' +
        '<div class="turn_' + turn + '">' + header('head-closed', false) + resp('closed') + '</div>' +
        '</div>';
      return true;
    })()`);
    check("replica built", built === true);

    const probe = async () =>
      ctx.evaluate(`(() => {
        const num = (v) => +parseFloat(v).toFixed(2);
        const box = (el) => { const r = el.getBoundingClientRect();
          return { y: num(r.top), h: num(r.height), bottom: num(r.bottom) }; };
        const sc = document.getElementById('scroller');
        const s = box(sc);
        const hit = (y) => { const el = document.elementFromPoint(s.y + 0 + 60, y);
          if (!el) return null;
          const h = el.closest('#head-open, #head-closed'); if (h) return h.id;
          const m = el.closest('[data-testid="assistant-message"]'); if (m) return m.id;
          return el.id || el.className || el.tagName; };
        return {
          scroller: { ...s, scrollTop: num(sc.scrollTop), clientH: sc.clientHeight, maxScroll: sc.scrollHeight - sc.clientHeight },
          open: { head: box(document.getElementById('head-open')),
                  position: getComputedStyle(document.getElementById('head-open')).position,
                  p1: box(document.getElementById('open-1')), p6: box(document.getElementById('open-6')) },
          closed: { head: box(document.getElementById('head-closed')),
                    position: getComputedStyle(document.getElementById('head-closed')).position,
                    p1: box(document.getElementById('closed-1')) },
          hitMid: hit(s.y + sc.clientHeight / 2),
          hitTop: hit(s.y + 30),
        };
      })()`);
    const scrollTo = async (expr) => {
      await ctx.evaluate(
        `(() => { const sc = document.getElementById('scroller'); sc.scrollTop = ${expr}; return true })()`,
      );
      await ctx.sleep(80);
      return probe();
    };
    const openHeadTop = await ctx.evaluate(`(() => {
      const sc = document.getElementById('scroller');
      return +(document.getElementById('head-open').getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop).toFixed(2);
    })()`);

    // --- native: the expanded header is taller than the chat and pins -----
    let r = await probe();
    check(
      "expanded header is taller than the chat",
      r.open.head.h > r.scroller.clientH + 100,
      `header=${r.open.head.h} chat=${r.scroller.clientH}`,
    );
    check(
      "natively the expanded header is sticky",
      r.open.position === "sticky",
      r.open.position,
    );
    // Scroll to where the response's sixth paragraph would sit mid-view.
    r = await scrollTo(`${openHeadTop} + ${r.open.head.h} + 120`);
    check(
      "natively the expanded header stays pinned over the whole chat",
      Math.abs(r.open.head.y - r.scroller.y) < 1 &&
        r.open.head.bottom > r.scroller.bottom,
      `head top=${r.open.head.y} bottom=${r.open.head.bottom} chat=${r.scroller.y}..${r.scroller.bottom}`,
    );
    check(
      "natively the response scrolls by hidden beneath it",
      r.hitMid === "head-open" &&
        r.open.p6.y > r.scroller.y &&
        r.open.p6.y < r.scroller.bottom,
      `hit=${r.hitMid} p6 top=${r.open.p6.y}`,
    );
    await ctx.shot("native-covered");

    // --- with the fix: the expanded header scrolls away, the collapsed pins --
    await ctx.evaluate(
      `(() => { document.getElementById('fix').textContent = ${JSON.stringify(fixCss(stickyRule[1], stickyRule[2], collapse))}; return true })()`,
    );
    await ctx.sleep(80);
    r = await probe();
    check(
      "fix: the expanded header is no longer sticky",
      r.open.position === "relative",
      r.open.position,
    );
    check(
      "fix: the expanded header has scrolled away with the chat",
      r.open.head.bottom <= r.scroller.y + 1,
      `head bottom=${r.open.head.bottom} chat top=${r.scroller.y}`,
    );
    check(
      "fix: the response is what the reader sees",
      r.hitMid === "open" && r.hitTop === "open",
      `mid=${r.hitMid} top=${r.hitTop}`,
    );
    await ctx.shot("fixed-visible");
    check(
      "fix: the collapsed header keeps pinning",
      r.closed.position === "sticky",
      r.closed.position,
    );
    // Deep into turn two: its collapsed header is the one stuck to the top.
    r = await scrollTo(`document.getElementById('scroller').scrollHeight`);
    check(
      "fix: scrolled into turn two, the collapsed header is stuck to the top",
      Math.abs(r.closed.head.y - r.scroller.y) < 1 && r.closed.head.h < 300,
      `head top=${r.closed.head.y} chat top=${r.scroller.y} height=${r.closed.head.h}`,
    );
    check(
      "fix: the expanded header of turn one is gone above",
      r.open.head.bottom < r.scroller.y,
      `open head bottom=${r.open.head.bottom}`,
    );
    await ctx.shot("collapsed-pins");

    console.log(ok ? "\nall green" : "\nFAILURES above");
    return ok;
  } finally {
    server.close();
  }
}
