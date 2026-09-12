// Scenario for scripts/cdp-driver.mjs: the always-on expandedHeader pair. Every
// user message is the sticky header of its turn, clamped at 250px behind "Show
// more"; natively, opening one changes nothing about the pinning, so a prompt
// taller than the chat pins over the whole scrollport and the response scrolls
// by hidden beneath it. The fix has two halves: a CSS line that takes an open
// header off sticky, and a JS line that keeps the view sensible around the
// click. (1) A prompt at the top opens from its top and reading continues down
// the prompt into the response, and "Show less" returns to the view from before
// the click, prompt stuck on top again. (2) A prompt further down opens in
// place, pushing what follows down, and "Show less" springs it back with the
// view from before the click. This first reproduces the native cover-up with
// the live stylesheet's own rules, then installs both halves and walks the two
// cases with real clicks.
//
//   node scripts/cdp-driver.mjs scripts/repro/expanded-header.mjs 900 700
//
// The regexes and both lines mirror expandedHeaderBuild and
// expandedViewBuild in src/patcher.ts (keep in sync); they parse the live
// bundle, so they double as a drift canary. The live bundle is found under
// ~/.vscode/extensions (newest Claude Code install) or via $CCUP_BUNDLE (the
// webview directory).
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

// --- the points' anchors (mirror of src/patcher.ts) -------------------------
// CSS half, read from webview/index.css:
const STICKY_HEADER_RULE_RE =
  /\.message_([-\w]+)\.stickyHeader_([-\w]+)\{[^{}]*?position:sticky[^{}]*?\}/;
const COLLAPSE_BUTTON_RULE_RE = /\.collapseButton_([-\w]+)\{/;
// JS half, read from webview/index.js:
const MSGS_RE = /messagesContainer:"messagesContainer_([-\w]+)"/;
const STICKY_RE = /stickyHeader:"stickyHeader_([-\w]+)"/;
// The fix's own lines may already be in the live install; strip them so the
// native pass below is native.
const FIX_CSS_LINE_RE = /\n?\/\*cc-ui-patch:expandedHeader\*\/[^\n]*/g;

// --- CSS-module hashes the replica needs ------------------------------------
const STICKY_MODE_RE = /stickyMode:"stickyMode_([-\w]+)"/;
const TURN_RE = /turn:"turn_([-\w]+)"/;
const TIMELINE_RE = /timelineMessage:"timelineMessage_([-\w]+)"/;
const USER_MSG_RE = /userMessage:"userMessage_([-\w]+)"/;
const USER_CONT_RE = /userMessageContainer:"userMessageContainer_([-\w]+)"/;
// The expandable's whole class map, one hash end to end: another module also
// names an expandButton, so the buttons are read through their own map.
const EXPANDABLE_MAP_RE =
  /expandableContainer:"expandableContainer_([-\w]+)",content:"content_\1",collapsed:"collapsed_\1",truncationGradient:"truncationGradient_\1",expandButton:"expandButton_\1",buttonContainer:"buttonContainer_\1",collapseButton:"collapseButton_\1"/;

const CLAMP = 250; // xq0's maxHeight default

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

// expandedViewBuild's IIFE, minus the marker comment.
function viewJs(chat, sticky, box) {
  return (
    "(function(){try{" +
    "if(window.__ccupExpandedView)return;window.__ccupExpandedView=1;" +
    'var K="__ccupExpandedView";' +
    'function nat(h,t){var p=h.style.position;h.style.position="static";' +
    "var y=h.getBoundingClientRect().top-t.getBoundingClientRect().top+t.scrollTop;h.style.position=p;return y}" +
    'document.addEventListener("click",function(e){' +
    `var el=e.target,b=el&&el.closest?el.closest(".expandButton_${box},.collapseButton_${box}"):null;if(!b)return;` +
    `var h=b.closest(".stickyHeader_${sticky}"),t=h&&h.closest(".messagesContainer_${chat}");if(!t)return;` +
    `if(b.classList.contains("expandButton_${box}")){h[K]=t.scrollTop;` +
    "if(h.getBoundingClientRect().top<=t.getBoundingClientRect().top+1){var y=nat(h,t);requestAnimationFrame(function(){t.scrollTop=y})}}" +
    "else if(h[K]!==void 0){var s=h[K];delete h[K];requestAnimationFrame(function(){t.scrollTop=s})}" +
    "},!0)" +
    "}catch(e){}})();"
  );
}

const LONG_PROMPT = Array.from(
  { length: 40 },
  (_, i) =>
    `Line ${i + 1} of a prompt long enough that, opened with "Show more", the header ` +
    `it pins is taller than the chat itself.`,
).join("\n");
// Longer than the open header, so a turn is still running (its header still
// pinned, not yet pushed up by the turn's end) at the native probe depth.
const RESPONSE = (id) =>
  Array.from(
    { length: 80 },
    (_, i) =>
      `<p id="${id}-${i + 1}">Paragraph ${i + 1} of the response to that prompt.</p>`,
  ).join("");

export async function run(ctx) {
  const dir = liveBundleDir();
  const js = readFileSync(join(dir, "index.js"), "utf8");
  const rawCss = readFileSync(join(dir, "index.css"), "utf8");
  const css = rawCss.replace(FIX_CSS_LINE_RE, "");
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
  const sticky = js.match(STICKY_RE)?.[1];
  check(
    "class-map anchors of the JS half parse",
    Boolean(cont && sticky),
    `chat=${cont} sticky=${sticky}`,
  );
  const mode = js.match(STICKY_MODE_RE)?.[1];
  const turn = js.match(TURN_RE)?.[1];
  const msg = js.match(TIMELINE_RE)?.[1];
  const uMsg = js.match(USER_MSG_RE)?.[1];
  const uCont = js.match(USER_CONT_RE)?.[1];
  const exp = js.match(EXPANDABLE_MAP_RE)?.[1];
  if (
    !check(
      "css-module hashes parse",
      Boolean(
        stickyRule &&
        collapse &&
        cont &&
        sticky &&
        mode &&
        turn &&
        msg &&
        uMsg &&
        uCont &&
        exp,
      ),
      `turn=${turn} exp=${exp}`,
    )
  ) {
    return false;
  }
  check(
    "the stylesheet's collapse button is the class map's",
    exp === collapse,
    `map=${exp} css=${collapse}`,
  );

  // --- serve the live stylesheet, both halves switchable at runtime --------
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
    // Three turns, every header the expandable in its COLLAPSED state (250px
    // clamp, "Show more"), each over a long response. A bubble-phase click
    // handler toggles a header the way xq0's React state does, synchronously
    // and after the fix's capture-phase listener, so the order matches React.
    const built = await ctx.evaluate(`(() => {
      const cont = ${JSON.stringify(cont)}, mode = ${JSON.stringify(mode)};
      const turn = ${JSON.stringify(turn)}, msg = ${JSON.stringify(msg)};
      const uMsg = ${JSON.stringify(uMsg)}, uCont = ${JSON.stringify(uCont)};
      const exp = ${JSON.stringify(exp)}, sticky = ${JSON.stringify(sticky)};
      const prompt = ${JSON.stringify(LONG_PROMPT)};
      const responses = { a: ${JSON.stringify(RESPONSE("a"))}, b: ${JSON.stringify(RESPONSE("b"))}, c: ${JSON.stringify(RESPONSE("c"))} };
      const esc = (t) => t.replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const moreBtn = '<div class="buttonContainer_' + exp + '"><button type="button" class="expandButton_' + exp + '">Show more</button></div>';
      const lessBtn = '<div class="buttonContainer_' + exp + '"><button type="button" class="collapseButton_' + exp + '">Show less</button></div>';
      const gradient = '<div class="truncationGradient_' + exp + '"></div>';
      const expandable =
        '<div class="expandableContainer_' + exp + '"><div class="contentWrapper_' + exp + '">' +
          '<div class="content_' + exp + ' collapsed_' + exp + '" style="max-height:${CLAMP}px">' +
            '<span dir="auto">' + esc(prompt) + '</span>' + gradient + '</div>' + moreBtn +
        '</div></div>';
      const header = (id) =>
        '<div class="message_' + msg + ' ' + uCont + ' stickyHeader_' + sticky +
        '" id="' + id + '"><div class="userMessage_' + uMsg + '">' + expandable + '</div></div>';
      const resp = (id) =>
        '<div class="message_' + msg + ' timelineMessage_' + msg +
        '" data-testid="assistant-message" id="resp-' + id + '">' + responses[id] + '</div>';
      const asTurn = (id) => '<div class="turn_' + turn + '">' + header('head-' + id) + resp(id) + '</div>';
      document.getElementById('host').innerHTML =
        '<div class="messagesContainer_' + cont + ' stickyMode_' + mode + '" id="scroller">' +
        asTurn('a') + asTurn('b') + asTurn('c') + '</div>';
      // xq0's toggle, as DOM edits
      window.__toggle = (h, open) => {
        const box = h.querySelector('.expandableContainer_' + exp);
        const content = box.querySelector('.content_' + exp);
        const wrapper = content.parentElement;
        if (open) {
          content.classList.remove('collapsed_' + exp); content.style.maxHeight = '';
          content.querySelector('.truncationGradient_' + exp)?.remove();
          wrapper.querySelector('.buttonContainer_' + exp)?.remove();
          box.insertAdjacentHTML('beforeend', lessBtn);
        } else {
          content.classList.add('collapsed_' + exp); content.style.maxHeight = '${CLAMP}px';
          content.insertAdjacentHTML('beforeend', gradient);
          box.querySelector(':scope > .buttonContainer_' + exp)?.remove();
          wrapper.insertAdjacentHTML('beforeend', moreBtn);
        }
      };
      document.addEventListener('click', (e) => {
        const b = e.target.closest('.expandButton_' + exp + ', .collapseButton_' + exp);
        if (!b) return;
        window.__toggle(b.closest('.stickyHeader_' + sticky), b.classList.contains('expandButton_' + exp));
      });
      return true;
    })()`);
    check("replica built", built === true);

    const num = (v) => +(+v).toFixed(2);
    const probe = async () =>
      ctx.evaluate(`(() => {
        const num = (v) => +parseFloat(v).toFixed(2);
        const box = (el) => { const r = el.getBoundingClientRect();
          return { y: num(r.top), h: num(r.height), bottom: num(r.bottom) }; };
        const sc = document.getElementById('scroller');
        const s = box(sc);
        const hit = (y) => { const el = document.elementFromPoint(s.y + 60, y);
          if (!el) return null;
          const h = el.closest('.stickyHeader_${sticky}'); if (h) return h.id;
          const m = el.closest('[data-testid="assistant-message"]'); if (m) return m.id;
          return el.id || el.className || el.tagName; };
        const head = (id) => { const h = document.getElementById(id);
          return { ...box(h), position: getComputedStyle(h).position,
                   open: Boolean(h.querySelector('.collapseButton_${exp}')) }; };
        const p = (id) => box(document.getElementById(id));
        return {
          scroller: { ...s, scrollTop: num(sc.scrollTop), clientH: sc.clientHeight },
          a: head('head-a'), b: head('head-b'), c: head('head-c'),
          a1: p('a-1'), a6: p('a-6'), b1: p('b-1'), b3: p('b-3'),
          hitMid: hit(s.y + sc.clientHeight / 2), hitTop: hit(s.y + 30),
        };
      })()`);
    // Natural (unstuck) top of a header inside the scroller.
    const nat = (id) =>
      ctx.evaluate(`(() => {
        const sc = document.getElementById('scroller'), h = document.getElementById('${id}');
        const p = h.style.position; h.style.position = 'static';
        const y = h.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
        h.style.position = p; return +y.toFixed(2);
      })()`);
    const scrollTo = async (y) => {
      await ctx.evaluate(
        `(() => { document.getElementById('scroller').scrollTop = ${y}; return true })()`,
      );
      await ctx.sleep(80);
      return probe();
    };
    // A real click on a header's visible expand/collapse button.
    const click = async (headId, which) => {
      const c = await ctx.evaluate(`(() => {
        const b = document.querySelector('#${headId} .${which === "more" ? "expandButton" : "collapseButton"}_${exp}');
        if (!b) return null;
        const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      if (!c) throw new Error(`no ${which} button on ${headId}`);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await ctx.cdp("Input.dispatchMouseEvent", {
          type,
          x: c.x,
          y: c.y,
          button: "left",
          clickCount: 1,
        });
      }
      await ctx.sleep(120); // the click's rAF and a paint
      return probe();
    };
    const natA = await nat("head-a");
    const natB = await nat("head-b");

    // --- native: an open header taller than the chat pins over it ----------
    let r = await probe();
    check(
      "headers start collapsed and sticky",
      !r.a.open && r.a.position === "sticky",
      `${r.a.position} open=${r.a.open}`,
    );
    r = await scrollTo(natA);
    r = await click("head-a", "more");
    check(
      "natively the header opens taller than the chat",
      r.a.open && r.a.h > r.scroller.clientH + 100,
      `open=${r.a.open} h=${r.a.h}`,
    );
    r = await scrollTo(natA + r.a.h + 120);
    check(
      "natively the open header stays pinned over the whole chat",
      Math.abs(r.a.y - r.scroller.y) < 1 && r.a.bottom > r.scroller.bottom,
      `head ${r.a.y}..${r.a.bottom} chat ${r.scroller.y}..${r.scroller.bottom}`,
    );
    check(
      "natively the response scrolls by hidden beneath it",
      r.hitMid === "head-a" &&
        r.a6.y > r.scroller.y &&
        r.a6.y < r.scroller.bottom,
      `hit=${r.hitMid} a6 top=${r.a6.y}`,
    );
    await ctx.shot("native-covered");
    // back to collapsed, both halves installed
    await ctx.evaluate(`(() => { window.__toggle(document.getElementById('head-a'), false);
      document.getElementById('fix').textContent = ${JSON.stringify(fixCss(stickyRule[1], stickyRule[2], collapse))}; return true })()`);
    await ctx.evaluate(viewJs(cont, sticky, exp));

    // --- case 1a: the prompt sits at the top (a jump put it there) ---------
    r = await scrollTo(natA);
    check(
      "1a: prompt collapsed at the top",
      !r.a.open && Math.abs(r.a.y - r.scroller.y) < 1,
      `y=${r.a.y}`,
    );
    r = await click("head-a", "more");
    check(
      "1a: opens off sticky, top edge still at the top",
      r.a.open &&
        r.a.position === "relative" &&
        Math.abs(r.a.y - r.scroller.y) < 1,
      `${r.a.position} y=${r.a.y}`,
    );
    check(
      "1a: the view did not move",
      r.scroller.scrollTop === natA,
      `scrollTop=${r.scroller.scrollTop} nat=${natA}`,
    );
    const bottomA = r.a.bottom;
    r = await scrollTo(natA + 300);
    check(
      "1a: scrolling reads down the prompt",
      Math.abs(r.a.y - (r.scroller.y - 300)) < 1,
      `head y=${r.a.y}`,
    );
    r = await scrollTo(natA + bottomA - r.scroller.y - 200);
    check(
      "1a: then on into the response",
      r.a1.y > r.scroller.y &&
        r.a1.y < r.scroller.bottom &&
        r.hitTop === "head-a",
      `a1 y=${r.a1.y} top hit=${r.hitTop}`,
    );
    r = await click("head-a", "less");
    check(
      "1a: Show less restores the view, prompt stuck on top",
      !r.a.open &&
        r.a.position === "sticky" &&
        r.scroller.scrollTop === natA &&
        Math.abs(r.a.y - r.scroller.y) < 1,
      `scrollTop=${r.scroller.scrollTop} y=${r.a.y}`,
    );
    await ctx.shot("case-1a");

    // --- case 1b: the prompt is stuck, deep in its response ----------------
    r = await scrollTo(natA + 900);
    check(
      "1b: prompt stuck at the top over the response",
      Math.abs(r.a.y - r.scroller.y) < 1 && r.a.position === "sticky",
      `y=${r.a.y}`,
    );
    const before1b = r;
    r = await click("head-a", "more");
    check(
      "1b: opens from its top, off sticky",
      r.a.open &&
        r.a.position === "relative" &&
        r.scroller.scrollTop === natA &&
        Math.abs(r.a.y - r.scroller.y) < 1,
      `scrollTop=${r.scroller.scrollTop} y=${r.a.y}`,
    );
    check(
      "1b: the response now follows the prompt, not behind it",
      r.a1.y >= r.a.bottom - 1,
      `a1 y=${r.a1.y} head bottom=${r.a.bottom}`,
    );
    r = await scrollTo(natA + r.a.h - 300); // the Show less button into view
    r = await click("head-a", "less");
    check(
      "1b: Show less restores the view from before the click",
      r.scroller.scrollTop === before1b.scroller.scrollTop &&
        !r.a.open &&
        r.a.position === "sticky" &&
        Math.abs(r.a.y - r.scroller.y) < 1,
      `scrollTop=${r.scroller.scrollTop} want=${before1b.scroller.scrollTop}`,
    );
    check(
      "1b: the response is back where it was",
      Math.abs(r.a6.y - before1b.a6.y) < 1,
      `a6 y=${r.a6.y} was ${before1b.a6.y}`,
    );
    await ctx.shot("case-1b");

    // --- case 2: a prompt further down the view --------------------------
    r = await scrollTo(natB - 150);
    check(
      "2: prompt collapsed 150px below the top, not stuck",
      Math.abs(r.b.y - r.scroller.y - 150) < 1 && !r.b.open,
      `y=${r.b.y}`,
    );
    const before2 = r;
    r = await click("head-b", "more");
    const grew = r.b.h - before2.b.h;
    check(
      "2: opens in place, the view unmoved",
      r.b.open &&
        r.scroller.scrollTop === before2.scroller.scrollTop &&
        Math.abs(r.b.y - before2.b.y) < 1,
      `scrollTop=${r.scroller.scrollTop} y=${r.b.y}`,
    );
    check(
      "2: what follows is pushed down by the growth",
      grew > 500 && Math.abs(r.b1.y - before2.b1.y - grew) < 1,
      `grew=${grew} b1 moved ${num(r.b1.y - before2.b1.y)}`,
    );
    r = await scrollTo(natB - 150 + grew); // the Show less button into view
    r = await click("head-b", "less");
    check(
      "2: Show less springs it back, the view from before the click",
      !r.b.open &&
        r.scroller.scrollTop === before2.scroller.scrollTop &&
        Math.abs(r.b.y - before2.b.y) < 1,
      `scrollTop=${r.scroller.scrollTop} y=${r.b.y}`,
    );
    check(
      "2: what follows is back where it was",
      Math.abs(r.b1.y - before2.b1.y) < 1 &&
        Math.abs(r.b3.y - before2.b3.y) < 1,
      `b1 y=${r.b1.y} was ${before2.b1.y}`,
    );
    await ctx.shot("case-2");

    // --- a collapsed header keeps pinning --------------------------------
    r = await scrollTo(natB + 900);
    check(
      "collapsed headers still pin",
      r.b.position === "sticky" &&
        Math.abs(r.b.y - r.scroller.y) < 1 &&
        r.b.h < 300,
      `y=${r.b.y} h=${r.b.h}`,
    );

    console.log(ok ? "\nall green" : "\nFAILURES above");
    return ok;
  } finally {
    server.close();
  }
}
