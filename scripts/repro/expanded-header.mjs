// Scenario for scripts/cdp-driver.mjs: the always-on expandedHeader pair. Every
// user message is the sticky header of its turn, clamped behind "Show more".
// Up to 2.1.306, opening one changes nothing about the pinning, so a prompt
// taller than the chat pins over the whole scrollport, the response scrolls by
// hidden beneath it, and a wheel over the prompt moves that hidden response
// while the prompt stays put. From 2.1.307 the build caps the header's bubble
// itself (40vh, its own scroller), with "Show less" at that scroller's end, out
// of view until the prompt is read to its end, and a wheel past the end spills
// into the transcript. The fix keeps the header pinned in both states and
// gives an open prompt a ceiling with its own scroller: the content capped at
// half the chat with "Show less" below it, or, where the build caps the bubble,
// the bubble with "Show less" stuck to its bottom edge. While it overflows, a
// wheel over the prompt reads the prompt and never spills into the transcript;
// the response is scrolled by pointing at the response.
// This first reproduces the native behavior of the stylesheet served, then
// installs both halves and checks, with real clicks and wheels: the stuck case
// (the transcript freezes on screen under the growing header, Chromium's
// scroll anchoring), the wheel layering, "Show less" in view at every step of
// the read and clear of the prompt's last line at its end, "Show less" (view
// back, preview at the prompt's start), that the open prompt keeps pinning,
// the in-place case for a prompt further down, and that a short open prompt is
// no dead zone.
//
//   node scripts/cdp-driver.mjs scripts/repro/expanded-header.mjs 900 700
//
// Both lines come from the compiled patcher (expandedHeaderWebview, out/, so
// compile first), so the scenario runs exactly what an apply writes and
// doubles as the drift canary for both halves. The bundle is found under
// ~/.vscode/extensions (newest Claude Code install) or via $CCUP_BUNDLE (the
// webview directory); a pristine 2.1.306 or older exercises the first form.
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The fix's own lines may already be in the live install; strip them so the
// native pass below is native.
const FIX_CSS_LINE_RE = /\n?\/\*cc-ui-patch:expandedHeader\*\/[^\n]*/g;
const FIX_JS_LINE_RE = /\n?\/\*cc-ui-patch:expandedView\*\/[^\n]*/g;
const CSS_MARKER = "/*cc-ui-patch:expandedHeader*/";
const JS_MARKER = "/*cc-ui-patch:expandedView*/";

// --- CSS-module hashes the replica needs ------------------------------------
const EXPANDABLE_MAP_RE =
  /expandableContainer:"expandableContainer_([-\w]+)",content:"content_\1"/;
const STICKY_RE = /stickyHeader:"stickyHeader_([-\w]+)"/;
const MSGS_RE = /messagesContainer:"messagesContainer_([-\w]+)"/;
const STICKY_MODE_RE = /stickyMode:"stickyMode_([-\w]+)"/;
const TURN_RE = /turn:"turn_([-\w]+)"/;
const TIMELINE_RE = /timelineMessage:"timelineMessage_([-\w]+)"/;
const USER_MSG_RE = /userMessage:"userMessage_([-\w]+)"/;
const USER_CONT_RE = /userMessageContainer:"userMessageContainer_([-\w]+)"/;
const ATTACH_RE = /userMessageAttachments:"userMessageAttachments_([-\w]+)"/;

const CLAMP = 60; // the user message's maxHeight prop on current builds
const FLOOR = 250; // the first form's floor
const CAP_VH = 50; // the first form's ceiling, in vh

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

// The marked line out of a patched file.
const markedLine = (text, marker) => {
  const i = text.indexOf(marker);
  if (i < 0) return undefined;
  const end = text.indexOf("\n", i);
  return text.slice(i, end < 0 ? undefined : end);
};

const prompt = (lines, tag) =>
  Array.from(
    { length: lines },
    (_, i) =>
      `Line ${i + 1} of ${tag}, kept long enough to wrap onto a second line in the panel.`,
  ).join("\n");
const LONG_PROMPT = prompt(40, "a prompt far taller than the chat once opened");
// Unwrapped lines, so its height is a line count: above the clamp, and with
// its button row under either form's ceiling in a 700px-tall window.
const SHORT_PROMPT = Array.from(
  { length: 8 },
  (_, i) => `Line ${i + 1} of a short prompt.`,
).join("\n");
// Longer than the open header, so a turn is still running (its header still
// pinned, not yet pushed up by the turn's end) at the probe depths.
const RESPONSE = (id) =>
  Array.from(
    { length: 80 },
    (_, i) =>
      `<p id="${id}-${i + 1}">Paragraph ${i + 1} of the response to that prompt.</p>`,
  ).join("");

export async function run(ctx) {
  const dir = liveBundleDir();
  const rawJs = readFileSync(join(dir, "index.js"), "utf8");
  const rawCss = readFileSync(join(dir, "index.css"), "utf8");
  const js = rawJs.replace(FIX_JS_LINE_RE, "");
  const css = rawCss.replace(FIX_CSS_LINE_RE, "");
  console.log(
    `bundle: ${dir}${rawCss === css && rawJs === js ? "" : " (fix applied; stripped for the native pass)"}`,
  );

  let ok = true;
  const check = (name, cond, detail) => {
    console.log(
      `${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
    );
    if (!cond) ok = false;
    return cond;
  };

  // --- the patcher's lines and the replica's hashes ------------------------
  const built = loadPatcher().expandedHeaderWebview(js, css);
  if (!check("the patcher builds both halves", Boolean(built))) return false;
  const fixCss = markedLine(built.css, CSS_MARKER);
  const viewJs = markedLine(built.js, JS_MARKER);
  // The second form pins the button row; the first caps the content.
  const FORM = fixCss.includes("position:sticky") ? "bubble" : "content";
  console.log(
    `form: ${FORM === "bubble" ? "the build's bubble scroller" : "a capped content box"}`,
  );
  const exp = js.match(EXPANDABLE_MAP_RE)?.[1];
  const sticky = js.match(STICKY_RE)?.[1];
  const cont = js.match(MSGS_RE)?.[1];
  const mode = js.match(STICKY_MODE_RE)?.[1];
  const turn = js.match(TURN_RE)?.[1];
  const msg = js.match(TIMELINE_RE)?.[1];
  const uMsg = js.match(USER_MSG_RE)?.[1];
  const uCont = js.match(USER_CONT_RE)?.[1];
  const attach = js.match(ATTACH_RE)?.[1]; // optional: the chip row
  if (
    !check(
      "css-module hashes parse",
      Boolean(exp && sticky && cont && mode && turn && msg && uMsg && uCont),
      `turn=${turn} exp=${exp}`,
    )
  ) {
    return false;
  }

  // --- serve the stylesheet, the fix switchable at runtime -----------------
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
    // Three turns, every header the expandable in its COLLAPSED state (the
    // clamp, "Show more") over a long response: a long prompt carrying an
    // attachment chip, as an editor selection does, a long one, and a short
    // one. A bubble-phase click handler toggles a header the way the
    // expandable's React state does, synchronously and after the fix's
    // capture-phase listener, so the order matches React; the content element
    // persists across the toggle as it does under React.
    const replica = await ctx.evaluate(`(() => {
      const cont = ${JSON.stringify(cont)}, mode = ${JSON.stringify(mode)};
      const turn = ${JSON.stringify(turn)}, msg = ${JSON.stringify(msg)};
      const uMsg = ${JSON.stringify(uMsg)}, uCont = ${JSON.stringify(uCont)};
      const attach = ${JSON.stringify(attach ?? null)};
      const exp = ${JSON.stringify(exp)}, sticky = ${JSON.stringify(sticky)};
      const prompts = { a: ${JSON.stringify(LONG_PROMPT)}, b: ${JSON.stringify(LONG_PROMPT)}, c: ${JSON.stringify(SHORT_PROMPT)} };
      const responses = { a: ${JSON.stringify(RESPONSE("a"))}, b: ${JSON.stringify(RESPONSE("b"))}, c: ${JSON.stringify(RESPONSE("c"))} };
      const esc = (t) => t.replace(/&/g,'&amp;').replace(/</g,'&lt;');
      const moreBtn = '<div class="buttonContainer_' + exp + '"><button type="button" class="expandButton_' + exp + '">Show more</button></div>';
      const lessBtn = '<div class="buttonContainer_' + exp + '"><button type="button" class="collapseButton_' + exp + '">Show less</button></div>';
      const gradient = '<div class="truncationGradient_' + exp + '"></div>';
      const chips = attach ? '<div class="userMessageAttachments_' + attach + '"><span style="display:inline-block;padding:4px 8px;border:1px solid var(--vscode-input-border);border-radius:4px">kilo.jsonc#89-174</span></div>' : '';
      const expandable = (text) =>
        '<div class="expandableContainer_' + exp + '"><div>' +
          '<div class="content_' + exp + ' collapsed_' + exp + '" style="max-height:${CLAMP}px">' +
            '<div><span dir="auto">' + esc(text) + '</span></div>' + gradient + '</div>' + moreBtn +
        '</div></div>';
      const header = (id) =>
        '<div class="message_' + msg + ' ' + uCont + ' stickyHeader_' + sticky + '" id="head-' + id + '">' +
        '<div class="' + uCont + '"><div class="userMessage_' + uMsg + '">' +
        (id === 'a' ? chips : '') + expandable(prompts[id]) + '</div></div></div>';
      const resp = (id) =>
        '<div class="message_' + msg + ' timelineMessage_' + msg +
        '" data-testid="assistant-message" id="resp-' + id + '">' + responses[id] + '</div>';
      const asTurn = (id) => '<div class="turn_' + turn + '">' + header(id) + resp(id) + '</div>';
      document.getElementById('host').innerHTML =
        '<div class="messagesContainer_' + cont + ' stickyMode_' + mode + '" id="scroller">' +
        asTurn('a') + asTurn('b') + asTurn('c') + '</div>';
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
    check("replica built", replica === true);

    // Both possible scrollers of a header (its content box and its bubble),
    // "Show less", and the prompt's last glyph, judged against every clip
    // between it and the header.
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
        const metrics = (el, cap) => { const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return { h: num(r.height), cap: num(cap(cs)), scrollTop: num(el.scrollTop),
                   max: el.scrollHeight - el.clientHeight, maxH: cs.maxHeight,
                   own: el.hasAttribute('data-ccup-own'), overscroll: cs.overscrollBehaviorY }; };
        const head = (id) => { const h = document.getElementById(id);
          const c = h.querySelector('.content_${exp}'), u = h.querySelector('.userMessage_${uMsg}');
          const less = h.querySelector('.collapseButton_${exp}');
          const us = getComputedStyle(u);
          // The bubble's visible band, inside its border and padding.
          const ur = u.getBoundingClientRect(), cr = c.getBoundingClientRect();
          const top = Math.max(cr.top, ur.top + parseFloat(us.borderTopWidth) + parseFloat(us.paddingTop));
          const bot = Math.min(cr.bottom, ur.bottom - parseFloat(us.borderBottomWidth) - parseFloat(us.paddingBottom));
          const t = c.querySelector('span').firstChild, end = t.data.length;
          const rg = document.createRange(); rg.setStart(t, end - 1); rg.setEnd(t, end);
          const g = rg.getBoundingClientRect();
          let lessBox = null, lessHit = false;
          if (less) { const l = less.getBoundingClientRect(); lessBox = { y: num(l.top), bottom: num(l.bottom) };
            const e = document.elementFromPoint(l.left + l.width / 2, l.top + l.height / 2);
            lessHit = !!e && (e === less || less.contains(e)); }
          return { ...box(h), position: getComputedStyle(h).position, open: Boolean(less),
                   content: metrics(c, (cs) => cs.maxHeight === 'none' ? NaN : parseFloat(cs.maxHeight)),
                   bubble: metrics(u, (cs) => cs.maxHeight === 'none' ? NaN : parseFloat(cs.maxHeight) +
                     parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
                     parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)),
                   less: lessBox, lessHit,
                   lastVisible: g.top >= top - 0.5 && g.bottom <= bot + 0.5,
                   lastClearsLess: lessBox ? g.bottom <= lessBox.y + 0.5 : null }; };
        const p = (id) => box(document.getElementById(id));
        return {
          scroller: { ...s, scrollTop: num(sc.scrollTop), clientH: sc.clientHeight },
          a: head('head-a'), b: head('head-b'), c: head('head-c'),
          a6: p('a-6'), a20: p('a-20'), a30: p('a-30'), b1: p('b-1'), b3: p('b-3'),
          hitMid: hit(s.y + sc.clientHeight / 2), hitTop: hit(s.y + 30),
        };
      })()`);
    // The open prompt's scroller in this form, and where the read is in it.
    const S = (h) => (FORM === "bubble" ? h.bubble : h.content);
    const atEnd = (h) => S(h).scrollTop >= S(h).max;
    // Natural (unstuck) top of a header inside the scroller.
    const nat = (id) =>
      ctx.evaluate(`(() => {
        const sc = document.getElementById('scroller'), h = document.getElementById('${id}');
        const p = h.style.position; h.style.position = 'static';
        const y = h.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
        h.style.position = p; return +y.toFixed(2);
      })()`);
    const settle = 150; // a frame for React and the observer; open and close are instant
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
      await ctx.sleep(settle);
      return probe();
    };
    // Real wheel ticks at a point.
    const wheel = async (x, y, ticks) => {
      for (let i = 0; i < ticks; i++) {
        await ctx.cdp("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x,
          y,
          deltaX: 0,
          deltaY: 120,
        });
      }
      await ctx.sleep(300);
      return probe();
    };
    const natA = await nat("head-a");
    const natB = await nat("head-b");
    const natC = await nat("head-c");
    const capFirst = Math.max(FLOOR, (CAP_VH / 100) * ctx.viewport.height);

    // --- native --------------------------------------------------------------
    let r = await probe();
    check(
      "headers start collapsed and sticky",
      !r.a.open && r.a.position === "sticky",
      `${r.a.position} open=${r.a.open}`,
    );
    check(
      "the stylesheet's bubble rule matches the form",
      (r.a.bubble.maxH !== "none") === (FORM === "bubble"),
      `bubble max-height ${r.a.bubble.maxH}`,
    );
    r = await scrollTo(natA);
    r = await click("head-a", "more");
    if (FORM === "content") {
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
      const nativeTop = r.scroller.scrollTop;
      r = await wheel(r.scroller.y + 200, r.scroller.y + 150, 3);
      check(
        "natively a wheel over the prompt moves the hidden response, not the prompt",
        r.scroller.scrollTop > nativeTop && Math.abs(r.a.y - r.scroller.y) < 1,
        `scrollTop ${nativeTop} -> ${r.scroller.scrollTop}, head y=${r.a.y}`,
      );
    } else {
      r = await scrollTo(natA + 900);
      check(
        "natively the open prompt scrolls inside its capped bubble",
        r.a.open &&
          Math.abs(r.a.bubble.h - r.a.bubble.cap) < 1 &&
          r.a.bubble.max > 100 &&
          r.a.bottom < r.scroller.bottom,
        `bubble h=${r.a.bubble.h} cap=${r.a.bubble.cap} head bottom=${r.a.bottom}`,
      );
      check(
        "natively Show less is out of view until the prompt's end",
        !r.a.lessHit,
        `less ${r.a.less?.y}..${r.a.less?.bottom}`,
      );
      const nativeTop = r.scroller.scrollTop;
      r = await wheel(r.scroller.y + 200, r.scroller.y + 150, 60);
      check(
        "natively a wheel past the prompt's end moves the transcript",
        r.a.bubble.scrollTop === r.a.bubble.max &&
          r.scroller.scrollTop > nativeTop,
        `bubble ${r.a.bubble.scrollTop}/${r.a.bubble.max} scrollTop ${nativeTop} -> ${r.scroller.scrollTop}`,
      );
    }
    await ctx.shot("native");
    // back to collapsed, both halves installed
    await ctx.evaluate(`(() => { window.__toggle(document.getElementById('head-a'), false);
      document.getElementById('fix').textContent = ${JSON.stringify(fixCss)}; return true })()`);
    await ctx.evaluate(viewJs);

    // --- stuck: the prompt is pinned deep in its response ------------------
    r = await scrollTo(natA + 900);
    check(
      "stuck: prompt collapsed and pinned over the response",
      !r.a.open &&
        r.a.position === "sticky" &&
        Math.abs(r.a.y - r.scroller.y) < 1 &&
        r.a20.y > r.a.y + CLAMP &&
        r.a20.y < r.scroller.bottom,
      `y=${r.a.y} a20=${r.a20.y}`,
    );
    const before = r;
    r = await click("head-a", "more");
    check(
      "stuck: still pinned when open",
      r.a.open &&
        r.a.position === "sticky" &&
        Math.abs(r.a.y - r.scroller.y) < 1,
      `${r.a.position} y=${r.a.y}`,
    );
    const cap = FORM === "bubble" ? r.a.bubble.cap : capFirst;
    check(
      "stuck: the open prompt is capped",
      Math.abs(S(r.a).h - cap) < 1 && S(r.a).max > 100,
      `${FORM} h=${S(r.a).h} cap=${cap} max scroll=${S(r.a).max}`,
    );
    check(
      "stuck: the response froze on screen, the header covers more of it",
      Math.abs(r.a20.y - before.a20.y) < 1 &&
        Math.abs(r.a30.y - before.a30.y) < 1 &&
        r.a.bottom > before.a.bottom + 50,
      `a20 ${before.a20.y} -> ${r.a20.y}, head bottom ${before.a.bottom} -> ${r.a.bottom}`,
    );
    check(
      "stuck: the scroller followed the growth (scroll anchoring)",
      Math.abs(
        r.scroller.scrollTop - before.scroller.scrollTop - (r.a.h - before.a.h),
      ) < 1,
      `scrollTop ${before.scroller.scrollTop} -> ${r.scroller.scrollTop}, grew ${r.a.h - before.a.h}`,
    );
    check(
      "stuck: an overflowing open prompt is its own layer",
      S(r.a).own && S(r.a).overscroll === "contain",
      `own=${S(r.a).own} overscroll=${S(r.a).overscroll}`,
    );
    check(
      "stuck: the open prompt starts at its beginning",
      r.a.content.scrollTop === 0 && r.a.bubble.scrollTop === 0,
      `content ${r.a.content.scrollTop}, bubble ${r.a.bubble.scrollTop}`,
    );
    check("stuck: Show less in view", r.a.lessHit, `less y=${r.a.less?.y}`);
    await ctx.shot("stuck-open");
    // wheel over the prompt: the prompt scrolls, the transcript does not
    let t0 = r.scroller.scrollTop;
    r = await wheel(r.scroller.y + 200, r.scroller.y + 150, 3);
    check(
      "stuck: a wheel over the prompt scrolls the prompt",
      S(r.a).scrollTop > 200,
      `${FORM} scrollTop=${S(r.a).scrollTop}`,
    );
    check(
      "stuck: and leaves the transcript where it was",
      r.scroller.scrollTop === t0 && Math.abs(r.a20.y - before.a20.y) < 1,
      `scrollTop=${r.scroller.scrollTop}`,
    );
    // read on to the end, two ticks at a time, with Show less in view throughout
    let inView = r.a.lessHit;
    let steps = 0;
    while (!atEnd(r.a) && steps < 40) {
      r = await wheel(r.scroller.y + 200, r.scroller.y + 150, 2);
      inView = inView && r.a.lessHit;
      steps++;
    }
    check(
      "stuck: Show less stays in view all the way through the read",
      atEnd(r.a) && inView,
      `${steps} steps, at end ${atEnd(r.a)}`,
    );
    check(
      "stuck: at the end the last line shows, clear of Show less",
      r.a.lastVisible && r.a.lastClearsLess && r.a.lessHit,
      `last visible=${r.a.lastVisible} clears=${r.a.lastClearsLess}`,
    );
    await ctx.shot("stuck-end");
    r = await wheel(r.scroller.y + 200, r.scroller.y + 150, 20);
    check(
      "stuck: past the prompt's end the transcript still does not move",
      atEnd(r.a) && r.scroller.scrollTop === t0,
      `${FORM}=${S(r.a).scrollTop}/${S(r.a).max} scrollTop=${r.scroller.scrollTop}`,
    );
    // wheel over the response area: the transcript scrolls under the pinned prompt
    r = await wheel(r.scroller.y + 200, r.a.bottom + 40, 3);
    check(
      "stuck: a wheel over the response scrolls the transcript",
      r.scroller.scrollTop > t0 && r.a20.y < before.a20.y,
      `scrollTop ${t0} -> ${r.scroller.scrollTop}`,
    );
    check(
      "stuck: the open prompt keeps pinning while its response scrolls",
      r.a.open && Math.abs(r.a.y - r.scroller.y) < 1,
      `y=${r.a.y}`,
    );
    await ctx.shot("stuck-wheeled");
    r = await scrollTo(t0);
    r = await click("head-a", "less");
    check(
      "less: collapsed again, pinned, transcript back where it was",
      !r.a.open &&
        r.a.position === "sticky" &&
        Math.abs(r.a.y - r.scroller.y) < 1 &&
        Math.abs(r.a20.y - before.a20.y) < 1 &&
        r.scroller.scrollTop === before.scroller.scrollTop,
      `scrollTop=${r.scroller.scrollTop} want=${before.scroller.scrollTop} a20=${r.a20.y}`,
    );
    check(
      "less: the preview shows the prompt's start again",
      r.a.content.scrollTop === 0 && r.a.bubble.scrollTop === 0,
      `content ${r.a.content.scrollTop}, bubble ${r.a.bubble.scrollTop}`,
    );
    check(
      "less: no contain lingers on the collapsed prompt",
      !r.a.content.own &&
        !r.a.bubble.own &&
        r.a.content.overscroll === "auto" &&
        r.a.bubble.overscroll === "auto",
      `own=${r.a.content.own}/${r.a.bubble.own} overscroll=${r.a.content.overscroll}/${r.a.bubble.overscroll}`,
    );
    // still pinned at the end of its turn, pushed up only when the turn ends
    r = await scrollTo(natB - 60);
    check(
      "a collapsed header is pushed up only by its turn's end",
      r.a.bottom > r.scroller.y &&
        r.a.bottom < r.scroller.y + 300 &&
        r.a.y < r.scroller.y,
      `a ${r.a.y}..${r.a.bottom}`,
    );

    // --- in place: a prompt further down the view --------------------------
    r = await scrollTo(natB - 60);
    check(
      "in place: prompt collapsed 60px below the top, not stuck",
      Math.abs(r.b.y - r.scroller.y - 60) < 1 && !r.b.open,
      `y=${r.b.y}`,
    );
    const before2 = r;
    r = await click("head-b", "more");
    const grew = r.b.h - before2.b.h;
    check(
      "in place: opens where it is, the view unmoved",
      r.b.open &&
        r.scroller.scrollTop === before2.scroller.scrollTop &&
        Math.abs(r.b.y - before2.b.y) < 1,
      `scrollTop=${r.scroller.scrollTop} y=${r.b.y}`,
    );
    const capB = FORM === "bubble" ? r.b.bubble.cap : capFirst;
    check(
      "in place: capped, what follows pushed down by the growth",
      Math.abs(S(r.b).h - capB) < 1 &&
        grew > 50 &&
        Math.abs(r.b1.y - before2.b1.y - grew) < 1,
      `grew=${grew} b1 moved ${+(r.b1.y - before2.b1.y).toFixed(2)}`,
    );
    check("in place: Show less in view", r.b.lessHit, `less y=${r.b.less?.y}`);
    r = await click("head-b", "less");
    check(
      "in place: Show less springs it back",
      !r.b.open &&
        r.scroller.scrollTop === before2.scroller.scrollTop &&
        Math.abs(r.b1.y - before2.b1.y) < 1 &&
        Math.abs(r.b3.y - before2.b3.y) < 1,
      `scrollTop=${r.scroller.scrollTop} b1 y=${r.b1.y} was ${before2.b1.y}`,
    );
    await ctx.shot("in-place");

    // --- a short open prompt is no dead zone --------------------------------
    r = await scrollTo(natC + 600);
    r = await click("head-c", "more");
    check(
      "short: opens pinned, under the cap, with no contain",
      r.c.open &&
        Math.abs(r.c.y - r.scroller.y) < 1 &&
        r.c.content.max <= 1 &&
        r.c.bubble.max <= 1 &&
        !r.c.content.own &&
        !r.c.bubble.own &&
        S(r.c).overscroll === "auto",
      `max scroll ${r.c.content.max}/${r.c.bubble.max} own=${r.c.content.own}/${r.c.bubble.own}`,
    );
    t0 = r.scroller.scrollTop;
    r = await wheel(r.scroller.y + 200, r.scroller.y + 100, 3);
    check(
      "short: a wheel over it scrolls the transcript",
      r.scroller.scrollTop > t0,
      `scrollTop ${t0} -> ${r.scroller.scrollTop}`,
    );
    await ctx.shot("short-open");

    console.log(ok ? "\nall green" : "\nFAILURES above");
    return ok;
  } finally {
    server.close();
  }
}
